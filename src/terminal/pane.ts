/**
 * 终端面板（S02 spec §3.1）。
 *
 * 全部操作走官方 `terminalController`：创建/关闭是普通方法，附着与输入是
 * `terminal/attach` Remote 流——它要求 `ctx.invocation`，所以这里自建一个
 * owner Peer，经 `ctx.typertGateway.stream()` 打开（见 beta 证据 §1）。
 *
 * 输出只进本面板的 cell 网格，不进 transcript，也不进模型上下文。
 */
import { createElement, type ReactNode } from 'react'
import { Peer } from '@deepseek-ai/dsh-client-connection'
import type { Key } from '../input/parser.ts'
import { Box, Grid, Text } from '../render/components.ts'
import { CellGrid } from '../render/grid.ts'

export interface TerminalPaneOptions {
  readonly ctx: any
  readonly sessionId: string
  readonly getAgent: () => any | undefined
  readonly onChange: () => void
  readonly writeDiagnostic: (line: string) => void
}

export interface PaneScrollbackFrame {
  readonly type: 'snapshot' | 'output' | 'state' | 'ack'
  readonly sequence?: number
  readonly data?: string
  readonly screen?: string
  readonly [key: string]: unknown
}

export class TerminalPane {
  private readonly options: TerminalPaneOptions
  private grid = new CellGrid(80, 20)
  private peer: any
  private stream: any
  private info: any
  private abort: AbortController | undefined
  private uplinkQueue: unknown[] = []
  private wake: (() => void) | undefined
  private sequence = 0
  private closing = false
  private expectedSequence = 0
  private gapReported = false
  private state: 'closed' | 'opening' | 'open' | 'failed' | 'exited' = 'closed'
  private error: string | undefined
  private cols = 80
  private rows = 20

  constructor(options: TerminalPaneOptions) {
    this.options = options
  }

  get visible(): boolean {
    return this.state !== 'closed'
  }

  get focused(): boolean {
    return this.visible
  }

  get isOpen(): boolean {
    return this.state === 'open'
  }

  /** 打开并附着；已打开时只切换显示。 */
  async open(cols = this.cols, rows = this.rows): Promise<void> {
    this.cols = Math.max(20, Math.min(500, cols))
    this.rows = Math.max(6, Math.min(200, rows))
    if (this.state === 'open' || this.state === 'opening') return
    const agent = this.options.getAgent()
    if (!agent) {
      this.state = 'failed'
      this.error = '还没有可用的根会话'
      this.options.onChange()
      return
    }
    this.state = 'opening'
    this.error = undefined
    // 重新打开时复用同一个 terminal id 与网格：不新建 PTY，避免配额与画面串台。
    if (!this.info) this.grid = new CellGrid(this.cols, this.rows)
    this.options.onChange()
    try {
      const terminal = this.options.ctx.get('terminalController')
      if (!terminal) throw new Error('terminalController 不可用')
      const id = this.info?.id ?? `nano-term-${this.options.sessionId}`
      const control = new AbortController()
      // 先断旧流/旧 Peer，再附着；未确认输入不回放。
      this.abort?.abort()
      await this.peer?.dispose?.().catch?.(() => {})
      this.uplinkQueue = []
      this.sequence = 0
      this.expectedSequence = 0
      this.gapReported = false
      this.abort = control
      this.info = await terminal.create(agent, { id, cols: this.cols, rows: this.rows }, control.signal)
      await this.attach(id, agent, control.signal)
      this.state = 'open'
      this.options.onChange()
    } catch (error) {
      this.state = 'failed'
      this.error = String((error as { message?: string })?.message ?? error)
      this.options.writeDiagnostic(`nano: 终端打开失败：${this.error}`)
      this.options.onChange()
    }
  }

  private async attach(id: string, agent: any, signal: AbortSignal): Promise<void> {
    const uplink = (async function* push(this: TerminalPane) {
      for (;;) {
        const item = this.uplinkQueue.shift()
        if (item !== undefined) {
          yield item
          continue
        }
        await new Promise<void>((resolve) => {
          this.wake = resolve
        })
      }
    }).call(this)
    this.peer = new Peer(this.options.ctx, { principal: { kind: 'owner' }, interactions: 'none' })
    const gateway = this.options.ctx.get('typertGateway')
    if (!gateway) throw new Error('typertGateway 不可用')
    this.stream = await gateway.stream({
      namespace: 'terminal',
      method: 'attach',
      args: { agentId: this.options.sessionId, id },
      uplink,
      peer: this.peer,
      signal,
    })
    void this.pump()
    void agent
  }

  private async pump(): Promise<void> {
    try {
      for await (const frame of this.stream as AsyncIterable<PaneScrollbackFrame>) {
        if (frame.type === 'snapshot') {
          if (typeof frame.screen === 'string' && frame.screen !== '') this.grid.feed(frame.screen)
        } else if (frame.type === 'output' && typeof frame.data === 'string') {
          // 序号缺口：结束该附件并报错，不丢弃单条继续。
          const sequence = typeof frame.sequence === 'number' ? frame.sequence : undefined
          if (sequence !== undefined && sequence !== this.expectedSequence + 1 && !this.gapReported) {
            this.gapReported = true
            this.state = 'failed'
            this.error = `序列缺口（期望 ${this.expectedSequence + 1}，收到 ${sequence}）`
            this.options.writeDiagnostic(`nano: 终端序列缺口，已结束附件：${this.error}`)
            this.abort?.abort()
          } else {
            if (sequence !== undefined) this.expectedSequence = sequence
            this.grid.feed(frame.data)
          }
        } else if (frame.type === 'state') {
          const state = (frame as any).state
          if (state === 'exited' || state === 'failed') this.state = 'exited'
        }
        this.options.onChange()
      }
    } catch (error) {
      if (!this.closing && !this.abort?.signal.aborted) {
        this.state = 'failed'
        this.error = String((error as { message?: string })?.message ?? error)
        this.options.writeDiagnostic(`nano: 终端流中断：${this.error}`)
        this.options.onChange()
      }
    }
  }

  /** 隐藏但保留 PTY：断开输出流，重新打开时用同一 id 重新附着。 */
  hide(): void {
    this.abort?.abort()
    this.abort = undefined
    void this.peer?.dispose?.().catch?.(() => {})
    this.peer = undefined
    this.stream = undefined
    this.uplinkQueue = []
    this.sequence = 0
    this.state = 'closed'
    this.options.onChange()
  }

  /** 真正关闭：断流、释放声明、杀进程组。 */
  async close(): Promise<void> {
    this.closing = true
    const agent = this.options.getAgent()
    this.abort?.abort()
    this.abort = undefined
    await this.peer?.dispose?.().catch?.(() => {})
    this.peer = undefined
    this.stream = undefined
    this.state = 'closed'
    if (this.info && agent) {
      try {
        await this.options.ctx.get('terminalController')?.close?.(agent, this.info.id)
      } catch (error) {
        this.options.writeDiagnostic(`nano: 终端关闭失败：${String((error as Error)?.message ?? error)}`)
      }
    }
    this.info = undefined
    this.closing = false
    this.options.onChange()
  }

  resize(cols: number, rows: number): void {
    this.cols = Math.max(1, cols)
    this.rows = Math.max(1, rows)
    this.grid.resize(this.cols, this.rows)
    this.send({ type: 'resize', sequence: ++this.sequence, cols: this.cols, rows: this.rows })
  }

  private send(item: unknown): void {
    if (this.state !== 'open') return
    this.uplinkQueue.push(item)
    this.wake?.()
  }

  /**
   * 面板聚焦时把按键翻译成终端字节。返回 true 表示已消费，S01 不再处理。
   */
  handleKey(key: Key, toggleKey: boolean): boolean {
    if (toggleKey) {
      if (this.visible) this.hide()
      else void this.open()
      return true
    }
    if (this.state !== 'open') return false
    const data = keyToBytes(key)
    if (data === undefined) return false
    this.send({ type: 'write', sequence: ++this.sequence, data })
    return true
  }

  /** 正文区渲染：标题行 + cell 网格。 */
  render(width: number, height: number): ReactNode {
    if (!this.visible) return null
    const title =
      this.state === 'open'
        ? `终端 · ${this.info?.shell?.name ?? 'shell'} · Esc 隐藏 · Ctrl+T 关闭`
        : this.state === 'opening'
          ? '终端 · 启动中…'
          : `终端 · ${this.error ?? this.state}`
    const gridHeight = Math.max(3, height - 1)
    if (this.grid.width !== width || this.grid.height !== gridHeight) {
      this.grid.resize(Math.max(10, width), gridHeight)
      if (this.info) this.send({ type: 'resize', sequence: ++this.sequence, cols: this.grid.width, rows: gridHeight })
    }
    return createElement(
      Box,
      { flexDirection: 'column', width, height },
      createElement(Text, { dim: true }, title),
      createElement(Grid, { grid: this.grid, width: this.grid.width, height: this.grid.height }),
    )
  }
}

function keyToBytes(key: Key): string | undefined {
  if (key.name === 'char' && key.text) {
    if (key.ctrl) {
      const code = key.text.toLowerCase().charCodeAt(0)
      if (code >= 97 && code <= 122) return String.fromCharCode(code - 96)
      return undefined
    }
    if (key.alt) return `\u001b${key.text}`
    return key.text
  }
  switch (key.name) {
    case 'enter':
      return '\r'
    case 'tab':
      return '\t'
    case 'backspace':
      return '\u007f'
    case 'escape':
      return '\u001b'
    case 'up':
      return '\u001b[A'
    case 'down':
      return '\u001b[B'
    case 'right':
      return '\u001b[C'
    case 'left':
      return '\u001b[D'
    case 'home':
      return '\u001b[H'
    case 'end':
      return '\u001b[F'
    case 'pageup':
      return '\u001b[5~'
    case 'pagedown':
      return '\u001b[6~'
    case 'delete':
      return '\u001b[3~'
    default:
      return undefined
  }
}
