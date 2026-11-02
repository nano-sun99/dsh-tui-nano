/**
 * 会话列表（S02 spec §2）。
 *
 * 列表来自官方 `sessionQuery.listSessions`，标题读官方 `readTitle`；
 * 默认只列当前 cwd 的顶层会话，`a` 切全部目录；切换/冷改名走受控重启。
 */
import { createElement, type ReactNode } from 'react'
import type { Key } from '../input/parser.ts'
import { Box, Text } from '../render/components.ts'
import { cwdVariants, isTopLevelSession, type SessionRecordView, sameCwd } from './filters.ts'

export interface SessionRow {
  readonly id: string
  readonly title: string
  readonly cwd: string
  readonly createdAt: number
  readonly current: boolean
}

export interface SessionsPanelOptions {
  readonly ctx: any
  readonly rootId: string
  readonly cwd: string
  readonly onChange: () => void
  readonly writeDiagnostic: (line: string) => void
  /** 切根：交给受控重启；失败由 S01 的失败矩阵处理。 */
  readonly onSwitch?: (rootId: string) => void
  /** 冷改名：切到目标根后在新进程里写官方标题（受控重启）。 */
  readonly onRename?: (rootId: string, title: string) => void
}

export class SessionsPanel {
  private readonly options: SessionsPanelOptions
  private rows: SessionRow[] = []
  private selected = 0
  private open = false
  private notice: string | undefined
  private loading = false
  private renaming: string | undefined
  /** 默认只看当前 cwd；`a` 切全部目录。子代理会话始终不列出。 */
  private allDirectories = false

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
      const records = (await query.listSessions(
        new AbortController().signal,
      )) as SessionRecordView[]
      const variants = cwdVariants(this.options.cwd)
      const visible = records.filter(
        (record) =>
          isTopLevelSession(record.header) &&
          (this.allDirectories || sameCwd(record.header.cwd, variants)),
      )
      const rows: SessionRow[] = []
      for (const record of visible) {
        const id = String(record.header.id)
        let title = ''
        try {
          const snapshot = await query.readTitle?.(id)
          title = typeof snapshot === 'string' ? snapshot : String((snapshot as any)?.title ?? '')
        } catch {
          title = ''
        }
        rows.push({
          id,
          title,
          cwd: String(record.header.cwd ?? ''),
          createdAt: Number(record.header.createdAt ?? 0),
          current: id === this.options.rootId,
        })
      }
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
    if (this.renaming !== undefined) {
      if (key.name === 'escape') {
        this.renaming = undefined
        this.options.onChange()
        return true
      }
      if (key.name === 'enter') {
        const row = this.rows[this.selected]
        const title = this.renaming.trim()
        this.renaming = undefined
        if (row && title !== '' && this.options.onRename) this.options.onRename(row.id, title)
        else if (row && title === '') this.notice = '标题不能为空'
        this.options.onChange()
        return true
      }
      if (key.name === 'backspace') {
        this.renaming = [...this.renaming].slice(0, -1).join('')
        this.options.onChange()
        return true
      }
      if (key.name === 'char' && key.text && !key.ctrl && !key.alt) {
        this.renaming += key.text
        this.options.onChange()
        return true
      }
      return true
    }
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
    if (key.name === 'char' && key.text === 'a' && !key.ctrl && !key.alt) {
      this.allDirectories = !this.allDirectories
      this.selected = 0
      this.notice = undefined
      void this.refresh()
      return true
    }
    if (key.name === 'char' && key.text === 'r' && !key.ctrl) {
      const row = this.rows[this.selected]
      if (row) {
        this.renaming = row.title !== '' ? row.title : ''
        this.notice = '输入新标题，Enter 提交，Esc 取消'
      }
      this.options.onChange()
      return true
    }
    if (key.name === 'enter') {
      const row = this.rows[this.selected]
      if (row && !row.current) {
        // 跨目录不静默用启动 cwd；首版直接拒绝并指路。
        if (row.cwd !== '' && !sameCwd(row.cwd, cwdVariants(this.options.cwd))) {
          this.notice = `该会话属于 ${row.cwd}；请在该目录启动 nano。`
          this.options.onChange()
          return true
        }
        if (this.options.onSwitch) {
          this.notice = `正在切换到 ${row.id}…`
          this.options.onSwitch(row.id)
        } else {
          this.notice = '切换会话需要受控重启，当前会话不变'
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
      createElement(
        Text,
        { dim: true },
        `会话 · ↑↓ 选择 · Enter 切换（受控重启） · ${this.allDirectories ? 'a 当前目录' : 'a 全部目录'} · r 改名 · Esc 关闭${this.loading ? ' · 加载中…' : ''}`,
      ),
    )
    // `-r` 先建当前新会话，所以「列表里只有它自己」就是没有可恢复会话的形态。
    const recoverable = this.rows.some((row) => !row.current)
    if (!recoverable && !this.loading) {
      lines.push(
        createElement(
          Text,
          { dim: true },
          '  没有可恢复的会话；直接在新会话里开始，或按 a 看全部目录',
        ),
      )
    }
    this.rows.slice(0, Math.max(1, height - 4)).forEach((row, index) => {
      const selected = index === this.selected
      const marker = row.current ? '● ' : '  '
      const title = row.title !== '' ? row.title : row.id
      const details = [
        row.cwd !== '' ? row.cwd : undefined,
        row.createdAt > 0 ? `创建 ${formatTime(row.createdAt)}` : undefined,
      ]
        .filter((part): part is string => part !== undefined)
        .join(' · ')
      lines.push(
        createElement(
          Text,
          selected ? { reverse: true } : {},
          `${marker}${title}${row.current ? '（当前）' : ''}${details !== '' ? ` · ${details}` : ''}`,
        ),
      )
    })
    if (this.renaming !== undefined) {
      lines.push(createElement(Text, { reverse: true }, `  新标题：${this.renaming}`))
    }
    if (this.notice) lines.push(createElement(Text, { dim: true }, `  ${this.notice}`))
    return createElement(Box, { flexDirection: 'column', width }, ...lines)
  }
}

/** 官方 header 只有 createdAt；显示成短时间，不冒充「最近使用」。 */
function formatTime(timestamp: number): string {
  const date = new Date(timestamp)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}
