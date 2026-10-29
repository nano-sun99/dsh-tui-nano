/**
 * 任务面板（S02 spec §3.2）：官方 jobs 只读视角。
 *
 * 只做四件事：列任务、按绝对偏移看输出、请求停止并区分结果、显示裁剪/缺口。
 * 不维护第二份任务表；`readAt` 用绝对偏移，不推进模型的消费游标。
 */
import { createElement, type ReactNode } from 'react'
import type { Key } from '../input/parser.ts'
import { Box, Text } from '../render/components.ts'

export interface JobsPanelOptions {
  readonly ctx: any
  readonly sessionId: string
  readonly onChange: () => void
  readonly writeDiagnostic: (line: string) => void
}

export interface JobRow {
  readonly id: string
  readonly label: string
  readonly status: string
  readonly progress?: string
  readonly detail?: string
}

/** 停止结果：`job/not-found` 与 `already-finished` 分开报。 */
export type StopOutcome = 'requested' | 'already-finished' | 'job/not-found'

export function classifyStop(id: string, caller: string, jobs: any): StopOutcome {
  try {
    const outcome = jobs.stop(id, caller)
    return outcome === 'requested' ? 'requested' : 'already-finished'
  } catch (error) {
    const message = String((error as Error)?.message ?? error)
    if (/not found|unknown/i.test(message)) return 'job/not-found'
    return 'already-finished'
  }
}

export class JobsPanel {
  private readonly options: JobsPanelOptions
  private rows: JobRow[] = []
  private selected = 0
  private open = false
  private output: string[] = []
  private lossy = false
  private notice: string | undefined

  constructor(options: JobsPanelOptions) {
    this.options = options
  }

  get visible(): boolean {
    return this.open
  }

  toggle(): void {
    this.open = !this.open
    if (this.open) this.refresh()
    else this.output = []
    this.options.onChange()
  }

  hide(): void {
    this.open = false
    this.output = []
    this.options.onChange()
  }

  /** 重新列任务；顺带把选中任务输出按绝对偏移读一段（不推进游标）。 */
  refresh(): void {
    const jobs = this.options.ctx.get('jobs')
    if (!jobs) {
      this.rows = []
      this.notice = 'jobs 服务不可用'
      this.options.onChange()
      return
    }
    try {
      const views = jobs.list(this.options.sessionId) as any[]
      this.rows = views.map((view) => ({
        id: String(view.id),
        label: String(view.label ?? ''),
        status: String(view.status ?? ''),
        ...(view.progress ? { progress: String(view.progress) } : {}),
        ...(view.detail ? { detail: String(view.detail) } : {}),
      }))
      this.selected = Math.min(this.selected, Math.max(0, this.rows.length - 1))
      this.notice = undefined
      this.readSelected()
    } catch (error) {
      this.notice = `任务列表失败：${String((error as Error)?.message ?? error)}`
      this.options.writeDiagnostic(`nano: ${this.notice}`)
    }
    this.options.onChange()
  }

  private readSelected(): void {
    const row = this.rows[this.selected]
    const jobs = this.options.ctx.get('jobs')
    if (!row || !jobs) {
      this.output = []
      return
    }
    try {
      const read = jobs.readAt(row.id, 0, this.options.sessionId) as {
        chunks?: Array<{ text: string; gapBefore?: true }>
        lossy?: boolean
      }
      this.lossy = read.lossy === true
      const text = (read.chunks ?? []).map((chunk) => (chunk.gapBefore ? '…（有缺口）\n' : '') + chunk.text).join('')
      this.output = text.split('\n').slice(-8)
    } catch {
      this.output = []
    }
  }

  /** 面板聚焦时的按键；返回 true 表示已消费。 */
  handleKey(key: Key): boolean {
    if (!this.open) return false
    if (key.name === 'escape') {
      this.hide()
      return true
    }
    if (key.name === 'up') {
      this.selected = Math.max(0, this.selected - 1)
      this.readSelected()
      this.options.onChange()
      return true
    }
    if (key.name === 'down') {
      this.selected = Math.min(Math.max(0, this.rows.length - 1), this.selected + 1)
      this.readSelected()
      this.options.onChange()
      return true
    }
    if (key.name === 'char' && key.text === 's' && !key.ctrl) {
      const row = this.rows[this.selected]
      const jobs = this.options.ctx.get('jobs')
      if (row && jobs) {
        const outcome = classifyStop(row.id, this.options.sessionId, jobs)
        this.notice =
          outcome === 'requested'
            ? '已请求停止'
            : outcome === 'already-finished'
              ? '任务已结束'
              : '任务不存在（job/not-found）'
        this.refresh()
      }
      return true
    }
    return false
  }

  render(width: number, height: number): ReactNode {
    if (!this.open) return null
    const lines: ReactNode[] = []
    lines.push(
      createElement(Text, { dim: true }, `任务 · ↑↓ 选择 · s 停止 · Esc 关闭${this.lossy ? ' · 输出已裁剪' : ''}`),
    )
    if (this.rows.length === 0) {
      lines.push(createElement(Text, { dim: true }, '  （没有任务）'))
    }
    this.rows.slice(0, Math.max(1, height - 5)).forEach((row, index) => {
      const selected = index === this.selected
      const meta = row.detail ?? row.progress ?? ''
      lines.push(
        createElement(
          Text,
          selected ? { reverse: true } : {},
          `  ${statusWord(row.status)} ${row.label}${meta ? `  ${meta}` : ''}`,
        ),
      )
    })
    if (this.notice) lines.push(createElement(Text, { dim: true }, `  ${this.notice}`))
    for (const line of this.output.slice(0, 4)) {
      lines.push(createElement(Text, {}, `  ${line}`))
    }
    return createElement(Box, { flexDirection: 'column', width }, ...lines)
  }
}

/** 状态词：官方状态码翻成中文，不发明新状态。 */
export function statusWord(status: string): string {
  switch (status) {
    case 'running':
      return '运行中'
    case 'stopping':
      return '停止中'
    case 'completed':
      return '已完成'
    case 'killed':
      return '已停止'
    case 'failed':
      return '失败'
    default:
      return status
  }
}
