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
/** start 后目录尚未列出时的占位行保留窗口；避免键盘焦点竞态，也防止后代行常驻。 */
export const PROVISIONAL_MS = 10_000
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

/** 子会话 turn/end 的 reason → dock 状态；未知变体并入未运行。 */
export function turnEndStatus(reason: unknown): DockStatus {
  const kind =
    reason !== null && typeof reason === 'object' ? (reason as { kind?: unknown }).kind : undefined
  switch (kind) {
    case 'completed':
      return 'done'
    case 'aborted':
      return 'killed'
    case 'error':
      return 'error'
    case 'max-tokens':
      return 'killed'
    default:
      return 'idle'
  }
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
  private readonly startedAt = new Map<string, number>()
  private readonly terminal = new Map<string, { status: DockStatus; at: number }>()
  private readonly statuses = new Map<string, DockStatus>()
  private readonly childSubscriptions = new Map<string, () => void>()
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
          // external 激活共享同一事件，但 dock 只列本地直接子代理（ADR/§4.1）。
          // 直接父子关系由 refresh 的 listChildren 过滤；这里只记录 start 授权。
          if (info?.local === false) return
          this.started.add(id)
          this.startedAt.set(id, this.now())
          this.dismissed.delete(id)
          this.terminal.delete(id)
          this.statuses.set(id, 'running')
          // 新 activation 可能换了 agent ctx；旧订阅等 refresh 重挂。
          this.disposeChild(id)
          const startedLive = this.options.ctx.get?.('agents')?.get?.(id)
          if (startedLive !== undefined) this.watchChild(id, startedLive)
          // 行已存在时也必须复位 terminalAt：续聊会以同一 id 再次 start。
          const existing = this.rows.some((row) => row.id === id)
          this.rows = this.rows.map((row) => {
            if (row.id !== id) return row
            const { terminalAt: _terminalAt, ...rest } = row
            return { ...rest, status: 'running' }
          })
          // 目录可能晚一拍；先建占位行让 dock 焦点与按键立刻可用。
          if (!existing) {
            this.rows.push({ id, name: id, mode: 'unknown', local: true, status: 'running' })
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
          // turn/end 已经写过终态：turn 状态权威，activation end 只兜底。
          if (this.terminal.has(id)) {
            void this.refresh()
            return
          }
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
    for (const dispose of this.childSubscriptions.values()) dispose()
    this.childSubscriptions.clear()
  }

  private disposeChild(id: string): void {
    const dispose = this.childSubscriptions.get(id)
    if (dispose === undefined) return
    dispose()
    this.childSubscriptions.delete(id)
  }

  /** 订阅子 agent 的轮级事件；过滤 session，避免后代 scope 串行。 */
  private watchChild(id: string, agent: any): void {
    if (this.childSubscriptions.has(id)) return
    const ctx = agent?.ctx
    if (typeof ctx?.on !== 'function') return
    const session = agent.session
    const dispose = ctx.on('session/event', (subject: any, event: any) => {
      if (subject !== session) return
      if (event?.type === 'turn/start') this.onTurnStart(id)
      else if (event?.type === 'turn/end') this.onTurnEnd(id, event?.data?.reason)
    })
    this.childSubscriptions.set(id, dispose)
  }

  private onTurnStart(id: string): void {
    this.started.add(id)
    this.startedAt.set(id, this.now())
    this.dismissed.delete(id)
    this.terminal.delete(id)
    this.statuses.set(id, 'running')
    this.rows = this.rows.map((row) => {
      if (row.id !== id) return row
      const { terminalAt: _terminalAt, ...rest } = row
      return { ...rest, status: 'running' }
    })
    this.options.onChange()
    void this.refresh()
  }

  private onTurnEnd(id: string, reason: unknown): void {
    const status = turnEndStatus(reason)
    const at = this.now()
    const existing = this.terminal.get(id)
    const terminalAt = existing?.at ?? at
    this.terminal.set(id, { status, at: terminalAt })
    this.statuses.set(id, status)
    this.rows = this.rows.map((row) => (row.id === id ? { ...row, status, terminalAt } : row))
    this.options.onChange()
    void this.refresh()
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
      const agents = this.options.ctx.get?.('agents')
      for (const id of [...this.childSubscriptions.keys()]) {
        if (agents?.get?.(id) === undefined) this.disposeChild(id)
      }
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
        if (live !== undefined) this.watchChild(id, live)
        const liveRunning = live !== undefined && deriveStatus(live) === 'running'
        // 目录只提供身份；没有 start、没有「观察到的 running」、也没有旧行时，不建行。
        // 单独收到 end 不建行（I1：入列只靠事件 / 首次观察到 running）。
        if (!old && !this.started.has(id) && !liveRunning) continue
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
      // 目录是直接父子关系的唯一来源；但目录可能晚一拍。只给刚 start 的行
      // 一个短窗口（10 秒）兜底，避免键盘焦点竞态；后代 start 事件也会到达
      // 根作用域，窗口过后仍不在 listChildren(rootId) 里就丢弃。
      for (const row of this.rows) {
        if (next.some((item) => item.id === row.id)) continue
        if (this.dismissed.has(row.id)) continue
        const startedAt = this.startedAt.get(row.id)
        if (
          startedAt === undefined ||
          this.terminal.has(row.id) ||
          now - startedAt >= PROVISIONAL_MS
        ) {
          continue
        }
        next.push(row)
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
              {
                key: 'overflow',
                flexDirection: 'row',
                width,
                onPress: 'subagent:overflow',
                ...(focusId === 'overflow'
                  ? { backgroundColor: [...theme.focusBg] as [number, number, number] }
                  : {}),
              },
              createElement(
                Text,
                { color: [...theme.faint] as [number, number, number], wrap: false },
                focusId === 'overflow' ? '› ' : '  ',
              ),
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
