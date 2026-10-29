/**
 * 子代理 dock（S02 spec §3.6，ADR-20261022-subagent-dock-lifecycle）。
 *
 * - 只显示本地直接子代理；external 不进 dock。
 * - 无标题、无用时、无 mode 后缀；行内容 = 指针 + 状态灯 + 名字 + 状态词。
 * - 官方终态一律保留 30 秒后从 dock 移除。
 * - 名字与目录来自官方 `subagents.listChildren`，不维护第二份清单。
 */
import { createElement, type ReactNode } from 'react'
import { Box, Text } from '../render/components.ts'

export type DockStatus = 'running' | 'done' | 'killed' | 'error' | 'idle'

export interface DockRow {
  readonly id: string
  readonly name: string
  readonly status: DockStatus
  /** 首次观察到终态的本地时间（ms），用于 30 秒清理。 */
  finishedAt?: number
}

export interface DockOptions {
  readonly ctx: any
  readonly rootId: string
  readonly onChange: () => void
  readonly writeDiagnostic: (line: string) => void
  readonly pollMs?: number
  readonly graceMs?: number
}

/** ADR 规定的 30 秒清理窗口。 */
export const DOCK_GRACE_MS = 30_000

/** 状态词：ADR 固定五个词，unknown 终态并入「未运行」。 */
export function statusWord(status: DockStatus): string {
  switch (status) {
    case 'running':
      return '执行中'
    case 'done':
      return '完成'
    case 'killed':
      return '终止'
    case 'error':
      return '错误'
    default:
      return '未运行'
  }
}

/** 状态灯：与状态词一一对应，不新增第六种。 */
export function statusLight(status: DockStatus): string {
  switch (status) {
    case 'running':
      return '●'
    case 'done':
      return '✓'
    case 'killed':
      return '■'
    case 'error':
      return '✕'
    default:
      return '○'
  }
}

/** 从官方子代理视角推出 dock 状态。 */
export function deriveStatus(view: any): DockStatus {
  const status = String(view?.status ?? '')
  if (status === 'running') return 'running'
  if (status === 'failed' || status === 'error') return 'error'
  if (status === 'killed' || status === 'cancelled') return 'killed'
  if (status === 'completed' || status === 'done') return 'done'
  return 'idle'
}

/** 30 秒清理：返回保留下来的行（纯函数，方便测试）。 */
export function pruneRows(rows: readonly DockRow[], now: number, graceMs = DOCK_GRACE_MS): DockRow[] {
  return rows.filter((row) => row.finishedAt === undefined || now - row.finishedAt < graceMs)
}

export class SubagentDock {
  private readonly options: DockOptions
  private rows: DockRow[] = []
  private timer: NodeJS.Timeout | undefined
  private refreshing = false

  constructor(options: DockOptions) {
    this.options = options
  }

  get visible(): boolean {
    return this.rows.length > 0
  }

  start(): void {
    if (this.timer) return
    const interval = this.options.pollMs ?? 2000
    void this.refresh()
    this.timer = setInterval(() => void this.refresh(), interval)
    this.timer.unref?.()
  }

  stop(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = undefined
  }

  /** 拉官方直接子代理；external 不进 dock。 */
  async refresh(): Promise<void> {
    if (this.refreshing) return
    const subagents = this.options.ctx.get('subagents')
    if (!subagents?.listChildren) return
    this.refreshing = true
    try {
      const entries = (await subagents.listChildren(this.options.rootId)) as Array<{
        id: string
        mode: string
        label?: string
      }>
      const now = Date.now()
      const next: DockRow[] = []
      for (const entry of entries) {
        if (entry.mode === 'external') continue
        const live = this.options.ctx.get('agents')?.get?.(entry.id)
        const status: DockStatus = live
          ? deriveStatus(live)
          : 'idle'
        const previous = this.rows.find((row) => row.id === String(entry.id))
        const terminal = status === 'done' || status === 'killed' || status === 'error'
        next.push({
          id: String(entry.id),
          name: String(entry.label ?? entry.id).slice(0, 40),
          status,
          ...(terminal
            ? { finishedAt: previous?.finishedAt ?? now }
            : {}),
        })
      }
      this.rows = pruneRows(next, now)
      this.options.onChange()
    } catch (error) {
      this.options.writeDiagnostic(
        `nano: 子代理目录读取失败：${String((error as Error)?.message ?? error)}`,
      )
    } finally {
      this.refreshing = false
    }
  }

  /** dock 行：一条顶边框，无标题、无用时。 */
  render(width: number): ReactNode {
    if (this.rows.length === 0) return null
    const lines: ReactNode[] = [createElement(Text, { dim: true }, '─'.repeat(Math.max(10, width)))]
    for (const row of this.rows) {
      lines.push(
        createElement(
          Text,
          row.status === 'error' ? { color: [244, 63, 94] as [number, number, number] } : {},
          ` ${statusLight(row.status)} ${row.name}  ${statusWord(row.status)}`,
        ),
      )
    }
    return createElement(Box, { flexDirection: 'column', width }, ...lines)
  }

  /** 「全部子代理」列表标题：计数只数本地直接子代理。 */
  renderAllTitle(): string {
    return `全部子代理 · ${this.rows.length}`
  }
}
