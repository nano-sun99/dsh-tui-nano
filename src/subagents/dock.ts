/**
 * 子代理 dock（spec 2026-10-30 §4.1 / §4.5）。
 *
 * 官方目录是 append-only 账本，不记运行状态；这里只把「事件看到的运行」
 * 投影成有限展示窗口：事件入列、`stopReason` 定终态、30 秒出列、出列不复活。
 */
import { createElement, type ReactNode } from 'react'
import { Box, Text } from '../render/components.ts'
import { displayWidth, truncateText } from '../render/text.ts'
import { activeTheme, type Theme } from '../theme/theme.ts'

export const DOCK_GRACE_MS = 30_000
const BLINK_MS = 400

export type DockStatus = 'running' | 'done' | 'killed' | 'error' | 'idle'

export interface DockRow {
  readonly id: string
  readonly name: string
  readonly mode: string
  readonly local: boolean
  readonly status: DockStatus
  /** 首次进入终态的时间；refresh 不得重置。 */
  readonly terminalAt?: number
}

export interface DockWindow {
  readonly visible: readonly DockRow[]
  readonly extra: number
}

export interface SubagentDockOptions {
  readonly ctx: any
  readonly rootId: string
  readonly onChange: () => void
  readonly writeDiagnostic?: (line: string) => void
  readonly pollMs?: number
  /** 测试注入时钟；生产用 Date.now。 */
  readonly now?: () => number
}

/** 官方 `stopReason` → 五个状态词；未知并入未运行（仍保留 30 秒）。 */
export function stopReasonStatus(reason: unknown): DockStatus {
  switch (reason) {
    case 'completed':
      return 'done'
    case 'aborted':
    case 'refusal':
    case 'max-tokens':
      return 'killed'
    case 'error':
      return 'error'
    default:
      return 'idle'
  }
}

/** 兼容旧名：终态映射只认 stopReason。 */
export function endStatus(info: any): DockStatus {
  return stopReasonStatus(info?.stopReason)
}

/** 活对象状态（只有 idle / running 这一类粗状态）。 */
export function deriveStatus(view: any): DockStatus {
  const status = String(view?.status ?? '')
  if (status === 'running') return 'running'
  if (status === 'failed' || status === 'error') return 'error'
  if (status === 'killed' || status === 'cancelled') return 'killed'
  if (status === 'completed' || status === 'done') return 'done'
  return 'idle'
}

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

/** 终态行保留 30 秒；terminalAt 只由事件或首次终态写入。 */
export function pruneRows(
  rows: readonly DockRow[],
  now: number,
  graceMs = DOCK_GRACE_MS,
): DockRow[] {
  return rows.filter((row) => row.terminalAt === undefined || now - row.terminalAt < graceMs)
}

function rowId(info: any): string {
  return String(info?.childSessionId ?? info?.child?.id ?? info?.id ?? '')
}

export class SubagentDock {
  private readonly options: SubagentDockOptions
  private rows: DockRow[] = []
  private readonly dismissed = new Set<string>()
  private readonly started = new Set<string>()
  private readonly terminal = new Map<string, { status: DockStatus; at: number }>()
  private readonly statuses = new Map<string, DockStatus>()
  private timer: NodeJS.Timeout | undefined
  private blinkTimer: NodeJS.Timeout | undefined
  private blinkOn = true
  private refreshing = false
  private pendingRefresh = false
  private readonly disposers: Array<() => void> = []

  constructor(options: SubagentDockOptions) {
    this.options = options
  }

  private now(): number {
    return (this.options.now ?? Date.now)()
  }

  get visible(): boolean {
    return this.rows.some((row) => !this.dismissed.has(row.id))
  }

  start(): void {
    if (this.timer) return
    const ctx = this.options.ctx
    const on = ctx.on?.bind(ctx)
    if (on) {
      this.disposers.push(
        on('subagent/start', (info: any) => {
          const id = rowId(info)
          if (id === '') return
          this.started.add(id)
          this.dismissed.delete(id)
          this.terminal.delete(id)
          this.statuses.set(id, 'running')
          if (!this.rows.some((row) => row.id === id)) {
            this.rows.push({
              id,
              name: id,
              mode: 'unknown',
              local: true,
              status: 'running',
            })
          }
          void this.refresh()
          // 目录里的 label 可能晚一拍才持久化；补一次，别让 dock 长时间显示 id。
          const labelTimer = setTimeout(() => void this.refresh(), 500)
          labelTimer.unref?.()
        }),
      )
      this.disposers.push(
        on('subagent/end', (info: any) => {
          const id = rowId(info)
          if (id === '') return
          const status = stopReasonStatus(info?.stopReason)
          const at = this.now()
          this.terminal.set(id, { status, at })
          this.statuses.set(id, status)
          // 同步更新已在窗口里的行，别等下一轮 poll。
          this.rows = this.rows.map((row) =>
            row.id === id
              ? { ...row, status, ...(row.terminalAt === undefined ? { terminalAt: at } : {}) }
              : row,
          )
          void this.refresh()
        }),
      )
    }
    const poll = this.options.pollMs ?? 2000
    this.timer = setInterval(() => void this.refresh(), poll)
    this.timer.unref?.()
    this.ensureAnimation()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    if (this.blinkTimer) clearInterval(this.blinkTimer)
    this.blinkTimer = undefined
    for (const dispose of this.disposers) dispose()
    this.disposers.length = 0
  }

  /** 只有可见且含 running 行时才闪；reduced-motion 静止。 */
  private ensureAnimation(): void {
    const reduced =
      process.env.NANO_REDUCED_MOTION === '1' || process.env.NANO_REDUCED_MOTION === 'true'
    const needed = this.visible && !reduced && this.rows.some((row) => row.status === 'running')
    if (needed && !this.blinkTimer) {
      this.blinkTimer = setInterval(() => {
        this.blinkOn = !this.blinkOn
        this.options.onChange()
      }, BLINK_MS)
      this.blinkTimer.unref?.()
    } else if (!needed && this.blinkTimer) {
      clearInterval(this.blinkTimer)
      this.blinkTimer = undefined
      this.blinkOn = true
    }
  }

  async refresh(): Promise<void> {
    if (this.refreshing) {
      this.pendingRefresh = true
      return
    }
    const subagents = this.options.ctx.get?.('subagents')
    if (!subagents?.listChildren) return
    this.refreshing = true
    try {
      const entries = (await subagents.listChildren(this.options.rootId)) as Array<{
        id: string
        mode: string
        label?: string
      }>
      const now = this.now()
      const previous = new Map(this.rows.map((row) => [row.id, row]))
      const next: DockRow[] = []
      for (const entry of entries) {
        if (entry.mode === 'external') continue
        const id = String(entry.id)
        if (this.dismissed.has(id)) continue
        const old = previous.get(id)
        const ended = this.terminal.get(id)
        const live = this.options.ctx.get?.('agents')?.get?.(id)
        // 目录只提供身份；没有 start、没有活对象、也没有旧行时，不建行。
        // 单独收到 end 不建行（I1：入列只靠事件 / 首次观察到 running）。
        if (!old && !live && !this.started.has(id)) continue
        const status: DockStatus =
          ended?.status ?? (live ? deriveStatus(live) : (old?.status ?? 'running'))
        const terminalAt = ended?.at ?? old?.terminalAt
        this.statuses.set(id, status)
        next.push({
          id,
          name: String(entry.label ?? old?.name ?? id).slice(0, 80),
          mode: String(entry.mode),
          local: true,
          status,
          ...(terminalAt !== undefined ? { terminalAt } : {}),
        })
      }
      // 目录暂时读不到刚 start 的行时，保留占位行，等下一轮补 label。
      for (const row of this.rows) {
        if (next.some((item) => item.id === row.id)) continue
        if (this.dismissed.has(row.id)) continue
        if (this.started.has(row.id) && !this.terminal.has(row.id)) next.push(row)
      }
      const kept = pruneRows(next, now)
      for (const row of next) {
        if (!kept.some((item) => item.id === row.id)) this.dismissed.add(row.id)
      }
      this.rows = kept
      this.ensureAnimation()
      this.options.onChange()
    } catch (error) {
      this.options.writeDiagnostic?.(
        `nano: 子代理目录读取失败：${String((error as Error)?.message ?? error)}`,
      )
    } finally {
      this.refreshing = false
      if (this.pendingRefresh) {
        this.pendingRefresh = false
        void this.refresh()
      }
    }
  }

  /** 展示窗口：最多 4 行 + 1 个溢出入口。 */
  window(): DockWindow {
    const rows = this.rows.filter((row) => !this.dismissed.has(row.id))
    return { visible: rows.slice(0, 4), extra: Math.max(0, rows.length - 4) }
  }

  /** 焦点候选：可见行 + overflow（若有）。 */
  entryIds(): string[] {
    const { visible, extra } = this.window()
    return [...visible.map((row) => row.id), ...(extra > 0 ? ['overflow'] : [])]
  }

  overflowCount(): number {
    return this.window().extra
  }

  statusOf(id: string): DockStatus {
    return this.terminal.get(id)?.status ?? this.statuses.get(id) ?? 'idle'
  }

  terminalAtOf(id: string): number | undefined {
    return this.terminal.get(id)?.at ?? this.rows.find((row) => row.id === id)?.terminalAt
  }

  isTerminal(id: string): boolean {
    return this.terminal.has(id) || this.terminalAtOf(id) !== undefined
  }

  modeOf(id: string): string | undefined {
    return this.rows.find((row) => row.id === id)?.mode
  }

  nameOf(id: string): string | undefined {
    return this.rows.find((row) => row.id === id)?.name
  }

  dismissedIds(): ReadonlySet<string> {
    return this.dismissed
  }

  /** `x`：只移除终态行；运行中行不响应。 */
  dismiss(id: string): void {
    if (!this.isTerminal(id)) return
    this.dismissed.add(id)
    this.rows = this.rows.filter((row) => row.id !== id)
    this.options.onChange()
  }

  render(width: number, focusId?: string, theme: Theme = activeTheme()): ReactNode {
    const { visible, extra } = this.window()
    if (visible.length === 0) return null
    return createElement(
      Box,
      { flexDirection: 'column', width },
      createElement(
        Text,
        { color: [...theme.rule] as [number, number, number], wrap: false },
        '─'.repeat(Math.max(1, width)),
      ),
      ...visible.map((row) => this.renderRow(row, width, theme, row.id === focusId)),
      ...(extra > 0
        ? [
            createElement(
              Box,
              { key: 'overflow', flexDirection: 'row', width, onPress: 'subagent:overflow' },
              createElement(
                Text,
                { color: [...theme.accent] as [number, number, number], wrap: false },
                '● ',
              ),
              createElement(
                Text,
                { color: [...theme.muted] as [number, number, number], wrap: false },
                truncateText(`还有 ${extra} 个子代理`, Math.max(1, width - 2)),
              ),
            ),
          ]
        : []),
    )
  }

  private renderRow(row: DockRow, width: number, theme: Theme, focused: boolean): ReactNode {
    const word = statusWord(row.status)
    const wordWidth = displayWidth(word)
    const budget = Math.max(1, width - (2 + 2 + 1 + wordWidth + 1))
    const light = statusLight(row.status)
    return createElement(
      Box,
      {
        key: row.id,
        flexDirection: 'row',
        width,
        ...(focused ? { backgroundColor: [...theme.focusBg] as [number, number, number] } : {}),
        onPress: `subagent:row:${row.id}`,
      },
      createElement(
        Text,
        { color: [...theme.faint] as [number, number, number], wrap: false },
        focused ? '› ' : '  ',
      ),
      createElement(Text, { color: this.lightColor(row.status, theme), wrap: false }, `${light} `),
      createElement(
        Text,
        { color: [...theme.fg] as [number, number, number], wrap: false },
        truncateText(row.name, budget),
      ),
      createElement(Box, { flexGrow: 1 }),
      createElement(Text, { color: this.statusColor(row.status, theme), wrap: false }, ` ${word}`),
    )
  }

  private lightColor(status: DockStatus, theme: Theme): [number, number, number] {
    switch (status) {
      case 'running':
        return (this.blinkOn ? [...theme.accent] : [...theme.faint]) as [number, number, number]
      case 'done':
        return [...theme.success] as [number, number, number]
      case 'killed':
        return [...theme.warning] as [number, number, number]
      case 'error':
        return [...theme.danger] as [number, number, number]
      default:
        return [...theme.muted] as [number, number, number]
    }
  }

  private statusColor(status: DockStatus, theme: Theme): [number, number, number] {
    switch (status) {
      case 'running':
        return [...theme.accent] as [number, number, number]
      case 'done':
        return [...theme.success] as [number, number, number]
      case 'killed':
        return [...theme.warning] as [number, number, number]
      case 'error':
        return [...theme.danger] as [number, number, number]
      default:
        return [...theme.muted] as [number, number, number]
    }
  }
}
