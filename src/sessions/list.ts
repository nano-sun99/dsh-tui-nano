/**
 * 会话列表（S02 spec §2）。
 *
 * 列表来自官方 `sessionQuery.listSessions`，标题读官方 `readTitle`；
 * 当前根高亮。恢复/冷改名需要受控重启（`requestRestart` 接缝尚未开放），
 * 所以这一版只读，切换动作明确提示「需要受控重启」而不是假装成功。
 */
import { createElement, type ReactNode } from 'react'
import type { Key } from '../input/parser.ts'
import { Box, Text } from '../render/components.ts'

export interface SessionRow {
  readonly id: string
  readonly title: string
  readonly cwd: string
  readonly current: boolean
}

export interface SessionsPanelOptions {
  readonly ctx: any
  readonly rootId: string
  readonly onChange: () => void
  readonly writeDiagnostic: (line: string) => void
  /** 切根：交给受控重启；失败由 S01 的失败矩阵处理。 */
  readonly onSwitch?: (rootId: string) => void
}

export class SessionsPanel {
  private readonly options: SessionsPanelOptions
  private rows: SessionRow[] = []
  private selected = 0
  private open = false
  private notice: string | undefined
  private loading = false

  constructor(options: SessionsPanelOptions) {
    this.options = options
  }

  get visible(): boolean {
    return this.open
  }

  toggle(): void {
    this.open = !this.open
    if (this.open) void this.refresh()
    this.options.onChange()
  }

  hide(): void {
    this.open = false
    this.options.onChange()
  }

  /** 读官方会话列表与标题；not-found / 损坏由官方错误原样上报。 */
  async refresh(): Promise<void> {
    const query = this.options.ctx.get('sessionQuery')
    if (!query?.listSessions) {
      this.notice = '会话查询服务不可用'
      this.options.onChange()
      return
    }
    this.loading = true
    this.options.onChange()
    try {
      const records = (await query.listSessions(new AbortController().signal)) as Array<{
        id: string
        header?: { cwd?: string }
      }>
      const rows: SessionRow[] = []
      for (const record of records) {
        let title = ''
        try {
          const snapshot = await query.readTitle?.(record.id)
          title = String((snapshot as any)?.title ?? '')
        } catch {
          title = ''
        }
        rows.push({
          id: String(record.id),
          title,
          cwd: String(record.header?.cwd ?? ''),
          current: String(record.id) === this.options.rootId,
        })
      }
      rows.sort((left, right) => Number(right.current) - Number(left.current))
      this.rows = rows
      this.selected = Math.min(this.selected, Math.max(0, rows.length - 1))
      this.notice = undefined
    } catch (error) {
      this.notice = `会话列表失败：${String((error as Error)?.message ?? error)}`
      this.options.writeDiagnostic(`nano: ${this.notice}`)
    } finally {
      this.loading = false
      this.options.onChange()
    }
  }

  handleKey(key: Key): boolean {
    if (!this.open) return false
    if (key.name === 'escape') {
      this.hide()
      return true
    }
    if (key.name === 'up') {
      this.selected = Math.max(0, this.selected - 1)
      this.options.onChange()
      return true
    }
    if (key.name === 'down') {
      this.selected = Math.min(Math.max(0, this.rows.length - 1), this.selected + 1)
      this.options.onChange()
      return true
    }
    if (key.name === 'enter') {
      const row = this.rows[this.selected]
      if (row && !row.current) {
        if (this.options.onSwitch) {
          this.notice = `正在切换到 ${row.id}…`
          this.options.onSwitch(row.id)
        } else {
          this.notice = '切换会话需要受控重启，当前根不变'
        }
      }
      return true
    }
    return false
  }

  render(width: number, height: number): ReactNode {
    if (!this.open) return null
    const lines: ReactNode[] = []
    lines.push(
      createElement(Text, { dim: true }, `会话 · ↑↓ 选择 · Enter 切换（需受控重启） · Esc 关闭${this.loading ? ' · 加载中…' : ''}`),
    )
    if (this.rows.length === 0 && !this.loading) {
      lines.push(createElement(Text, { dim: true }, '  （没有会话）'))
    }
    this.rows.slice(0, Math.max(1, height - 4)).forEach((row, index) => {
      const selected = index === this.selected
      const marker = row.current ? '● ' : '  '
      const title = row.title !== '' ? row.title : row.id
      lines.push(
        createElement(
          Text,
          selected ? { reverse: true } : {},
          `${marker}${title}${row.current ? '（当前）' : ''}`,
        ),
      )
    })
    if (this.notice) lines.push(createElement(Text, { dim: true }, `  ${this.notice}`))
    return createElement(Box, { flexDirection: 'column', width }, ...lines)
  }
}
