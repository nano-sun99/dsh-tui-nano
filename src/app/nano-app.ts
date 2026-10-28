/**
 * Application orchestrator: wires the terminal, renderer, conversation,
 * decision seams and the lifecycle together. One instance owns one root.
 */
import { createElement } from 'react'
import type { CoreBoot } from '../boot/assemble.ts'
import type { OfficialModules } from '../boot/official.ts'
import { type MountClaim, releaseMountClaim } from '../boot/root.ts'
import type { ConversationController } from '../conversation/controller.ts'
import { APPROVAL_OPTIONS, type ApprovalOutcome, DecisionManager } from '../decisions/manager.ts'
import type { HistoryStore } from '../input/history.ts'
import { resolveKey } from '../input/keymap.ts'
import type { InputEvent, Key } from '../input/parser.ts'
import type { Renderer } from '../render/renderer.ts'
import { formatShutdownReport, Lifecycle } from '../runtime/lifecycle.ts'
import type { Terminal } from '../runtime/terminal.ts'
import { activeTheme } from '../theme/theme.ts'
import { App, type AppSnapshot } from './App.tsx'
import { InputModel } from './input-model.ts'

export interface NanoAppOptions {
  readonly core: CoreBoot
  readonly official: OfficialModules
  readonly terminal: Terminal
  readonly renderer: Renderer
  readonly claim: MountClaim
  readonly dataRoot: string
  readonly cwd: string
  readonly rootId: string
  readonly conversation: ConversationController
  readonly history: HistoryStore
  readonly writeDiagnostic: (line: string) => void
}

export class NanoApp {
  private readonly options: NanoAppOptions
  private readonly theme = activeTheme()
  private readonly input = new InputModel()
  private readonly decisions = new DecisionManager()
  private readonly lifecycle = new Lifecycle()
  private readonly expanded = new Set<string>()
  private scrollOffset = 0
  private stickBottom = true
  private selectionStart: { row: number; col: number } | undefined
  private selectionActive = false
  private notice: string | undefined
  private renderScheduled = false
  private stopping = false
  private shutdownStartedAt = 0
  private exitCode = 0
  private cleanupFailed = false
  private unknownInputs = 0
  private lastUnknownLog = 0
  private finishResolve: ((code: number) => void) | undefined
  private coreDisposed = false

  constructor(options: NanoAppOptions) {
    this.options = options
  }

  get decisionsManager(): DecisionManager {
    return this.decisions
  }

  get conversation(): ConversationController {
    return this.options.conversation
  }

  async start(): Promise<void> {
    const { core, conversation, history } = this.options
    this.decisions.register(core.ctx)
    this.input.setHistory(history.entries().map((entry) => entry.display))
    this.options.terminal.refreshSize()
    this.options.renderer.resize(this.options.terminal.width, this.options.terminal.height)
    this.render()
    const finish = new Promise<number>((resolve) => {
      this.finishResolve = resolve
    })
    this.registerSignals()
    void conversation.model.onChange(() => this.scheduleRender())
    this.decisions.onChange(() => this.scheduleRender())
    return finish.then((code) => {
      throw new AppExit(code)
    })
  }

  private registerSignals(): void {
    const onSignal = (signal: NodeJS.Signals) => {
      this.exitCode = 0
      void this.shutdown(`signal ${signal}`)
    }
    this.signalHandlers = {
      SIGINT: () => onSignal('SIGINT'),
      SIGTERM: () => onSignal('SIGTERM'),
      SIGHUP: () => onSignal('SIGHUP'),
    }
    for (const [signal, handler] of Object.entries(this.signalHandlers)) {
      process.on(signal as NodeJS.Signals, handler)
    }
    process.on('uncaughtException', this.onUncaught)
    process.on('unhandledRejection', this.onUnhandledRejection)
  }

  private signalHandlers: Record<string, () => void> = {}

  private onUncaught = (error: unknown): void => {
    this.exitCode = 1
    this.options.writeDiagnostic(`nano: 未捕获异常：${String(error)}`)
    void this.shutdown('uncaughtException')
  }

  private onUnhandledRejection = (reason: unknown): void => {
    this.exitCode = 1
    this.options.writeDiagnostic(`nano: 未处理的 Promise 拒绝：${String(reason)}`)
    void this.shutdown('unhandledRejection')
  }

  handleInput(events: readonly InputEvent[]): void {
    if (this.stopping) return
    for (const event of events) {
      switch (event.type) {
        case 'paste':
          if (this.decisions.hasDecision) {
            this.decisions.typeCustom(event.text)
          } else {
            this.input.insert(event.text)
          }
          break
        case 'focus':
          break
        case 'mouse':
          this.handleMouse(event.event)
          break
        case 'key':
          this.handleKey(event.key)
          break
      }
    }
    this.scheduleRender()
  }

  handleResize(width: number, height: number): void {
    this.options.renderer.resize(width, height)
    this.scheduleRender()
  }

  private handleKey(key: Key): void {
    if (this.decisions.hasDecision) {
      this.handleDecisionKey(key)
      return
    }
    const scopes = [
      this.input.text !== '' ? 'input' : 'input',
      this.conversation.status === 'running' ? 'running' : 'idle',
    ]
    const action = resolveKey(key, scopes as any)
    switch (action) {
      case 'conversation.submit': {
        const text = this.input.text
        if (text.trim() !== '') {
          try {
            this.options.conversation.submit(text)
            this.input.take()
            this.stickBottom = true
            this.scrollOffset = 0
            this.notice = undefined
          } catch (error) {
            this.notice = `发送失败：${message(error)}`
          }
        }
        return
      }
      case 'input.newline':
        this.input.insert('\n')
        return
      case 'conversation.cancel':
        this.options.conversation.stop()
        this.notice = '已停止当前回合（队列保留）'
        return
      case 'conversation.steer': {
        const text = this.input.text
        if (text.trim() !== '') {
          this.options.conversation.steer(text)
          this.input.take()
          this.notice = '已插入引导（下一 step 生效）'
        }
        return
      }
      case 'conversation.clear':
        this.options.conversation.clear()
        this.notice = '已停止并清空队列'
        return
      case 'app.exit':
        if (key.ctrl && key.text === 'c' && this.input.text !== '') {
          this.input.clear()
          return
        }
        this.exitCode = 0
        void this.shutdown('user exit')
        return
      case 'input.backspace':
        this.input.backspace()
        return
      case 'input.delete':
        this.input.deleteForward()
        return
      case 'input.deleteWord':
        this.input.deleteWord()
        return
      case 'input.clear':
        this.input.clear()
        return
      case 'cursor.left':
        this.input.left()
        return
      case 'cursor.right':
        this.input.right()
        return
      case 'cursor.wordLeft':
        this.input.wordLeft()
        return
      case 'cursor.wordRight':
        this.input.wordRight()
        return
      case 'cursor.home':
        this.input.home()
        return
      case 'cursor.end':
        this.input.end()
        return
      case 'history.prev':
        this.input.previousHistory()
        return
      case 'history.next':
        this.input.nextHistory()
        return
      case 'transcript.scrollUp':
        this.scrollBy(3)
        return
      case 'transcript.scrollDown':
        this.scrollBy(-3)
        return
      case 'transcript.scrollBottom':
        this.stickBottom = true
        this.scrollOffset = 0
        return
      default:
        break
    }
    if (key.name === 'escape') {
      this.selectionActive = false
      this.options.renderer.selection = undefined
      return
    }
    if (key.name === 'char' && key.text && !key.ctrl && !key.alt && !key.meta) {
      this.input.insert(key.text)
      return
    }
    if (key.alt && key.name === 'char' && key.text) {
      this.input.insert(key.text)
      return
    }
    this.noteUnknownInput(key)
  }

  private handleDecisionKey(key: Key): void {
    const prompt = this.decisions.prompt
    if (!prompt) return
    if (prompt.kind === 'approval') {
      if (key.name === 'up') this.decisions.move(-1)
      else if (key.name === 'down') this.decisions.move(1)
      else if (key.name === 'enter') this.decisions.chooseApproval()
      else if (key.name === 'escape') this.decisions.escape()
      else if (key.name === 'char' && /^[1-4]$/u.test(key.text ?? '')) {
        const index = Number(key.text) - 1
        const option = APPROVAL_OPTIONS[index]
        if (option) this.decisions.resolveApproval(option.outcome)
      }
      return
    }
    // Question overlay
    if (key.name === 'up') this.decisions.move(-1)
    else if (key.name === 'down') this.decisions.move(1)
    else if (key.name === 'enter') this.decisions.advanceQuestion()
    else if (key.name === 'escape') this.decisions.escape()
    else if (key.name === 'tab') this.decisions.move(1)
    else if (key.name === 'char' && key.text === ' ') this.decisions.toggleOption()
    else if (key.name === 'char' && key.text === 'c' && !key.ctrl) this.decisions.toggleCustom()
    else if (key.name === 'backspace') this.decisions.backspaceCustom()
    else if (key.name === 'char' && key.text && !key.ctrl && !key.alt)
      this.decisions.typeCustom(key.text)
  }

  private handleMouse(event: {
    kind: string
    button: string
    x: number
    y: number
    wheel?: number
  }): void {
    const row = event.y - 1
    const col = event.x - 1
    if (event.kind === 'wheel') {
      this.scrollBy((event.wheel ?? 0) * -3)
      return
    }
    if (event.kind === 'press' && event.button === 'left') {
      const pressId = this.options.renderer.pressIdAt(col, row)
      if (pressId) {
        this.handlePress(pressId)
        return
      }
      this.selectionStart = { row, col }
      this.selectionActive = false
      return
    }
    if (event.kind === 'move' && this.selectionStart) {
      this.selectionActive = true
      this.options.renderer.selection = normalizeSelection(
        this.selectionStart.row,
        this.selectionStart.col,
        row,
        col,
      )
      return
    }
    if (event.kind === 'release') {
      if (this.selectionActive && this.selectionStart) {
        const range = normalizeSelection(this.selectionStart.row, this.selectionStart.col, row, col)
        const text = this.options.renderer.extractText(range)
        if (text.trim() !== '') this.options.terminal.copyToClipboard(text)
      }
      this.selectionStart = undefined
      this.selectionActive = false
      this.options.renderer.selection = undefined
    }
  }

  private handlePress(id: string): void {
    if (id.startsWith('decision:approval:')) {
      const index = Number(id.slice('decision:approval:'.length))
      const option = APPROVAL_OPTIONS[index]
      if (option) this.decisions.resolveApproval(option.outcome)
      return
    }
    if (id.startsWith('decision:option:')) {
      const index = Number(id.slice('decision:option:'.length))
      const prompt = this.decisions.prompt
      if (prompt?.kind === 'question') {
        this.decisions.move(index - prompt.focusedOption)
        this.decisions.toggleOption()
      }
      return
    }
    if (id === 'decision:custom') {
      this.decisions.toggleCustom()
      return
    }
    if (this.expanded.has(id)) this.expanded.delete(id)
    else this.expanded.add(id)
    this.scheduleRender()
  }

  private scrollBy(lines: number): void {
    this.stickBottom = false
    this.scrollOffset = Math.max(0, this.scrollOffset + lines)
    if (this.scrollOffset === 0) this.stickBottom = true
  }

  private noteUnknownInput(key: Key): void {
    this.unknownInputs++
    const now = Date.now()
    if (now - this.lastUnknownLog > 5000) {
      this.lastUnknownLog = now
      this.options.writeDiagnostic(
        `nano: 无法识别的输入 x${this.unknownInputs}: ${JSON.stringify(key.sequence)}`,
      )
      this.unknownInputs = 0
    }
  }

  private snapshot(): AppSnapshot {
    return {
      transcript: this.options.conversation.model,
      decisions: this.decisions,
      text: this.input.text,
      cursor: this.input.cursor,
      theme: this.theme,
      width: this.options.terminal.width,
      height: this.options.terminal.height,
      rootId: this.options.rootId,
      modelLabel: this.options.conversation.selectionInfo,
      status: this.options.conversation.status,
      expanded: this.expanded,
      scrollOffset: this.scrollOffset,
      stickBottom: this.stickBottom,
      ...(this.notice ? { notice: this.notice } : {}),
      userName: '你',
    }
  }

  private scheduleRender(): void {
    if (this.renderScheduled || this.stopping) return
    this.renderScheduled = true
    setImmediate(() => {
      this.renderScheduled = false
      this.render()
    })
  }

  render(): void {
    if (this.stopping) return
    try {
      this.options.renderer.update(createElement(App, { snapshot: this.snapshot() }))
    } catch (error) {
      this.options.writeDiagnostic(`nano: 渲染失败：${String(error)}`)
    }
  }

  private async shutdown(reason: string): Promise<void> {
    if (this.stopping) {
      // The terminal delivers Ctrl+C to the launcher and the runtime; the
      // launcher forwards it too. Ignore that duplicate, force only a real
      // second press.
      const force = Date.now() - this.shutdownStartedAt > 150
      void this.lifecycle.requestShutdown(reason, force)
      return
    }
    this.stopping = true
    this.shutdownStartedAt = Date.now()
    this.options.writeDiagnostic(`nano: 开始关停（${reason}）`)
    const { core, conversation, claim, terminal } = this.options
    this.lifecycle.register('drain', 'conversation', async () => {
      try {
        conversation.stop()
      } catch (error) {
        this.cleanupFailed = true
        throw error
      }
    })
    this.lifecycle.register('flush', 'session', async () => {
      try {
        if (conversation.agent) await core.ctx.sessions.flush(conversation.agent.session)
      } catch (error) {
        this.cleanupFailed = true
        throw error
      }
    })
    this.lifecycle.register('flush', 'agent', async () => {
      try {
        await conversation.dispose()
      } catch (error) {
        this.cleanupFailed = true
        throw error
      }
    })
    this.lifecycle.register('flush', 'core', async () => {
      try {
        if (!this.coreDisposed) {
          this.coreDisposed = true
          await core.dispose()
        }
      } catch (error) {
        this.cleanupFailed = true
        throw error
      }
    })
    this.lifecycle.register('release', 'mount-claim', async () => {
      if (this.cleanupFailed) throw new Error('清理失败，保留认领')
      releaseMountClaim(claim)
    })
    this.lifecycle.register('restore', 'terminal', async () => {
      terminal.restore()
    })
    const report = await this.lifecycle.requestShutdown(reason)
    this.removeProcessListeners()
    const failed = report.results.some((result) => result.status !== 'stopped')
    if (failed) this.exitCode = this.exitCode || 1
    this.options.writeDiagnostic(formatShutdownReport(report))
    this.finishResolve?.(this.exitCode)
  }

  private removeProcessListeners(): void {
    for (const [signal, handler] of Object.entries(this.signalHandlers)) {
      process.off(signal as NodeJS.Signals, handler)
    }
    process.off('uncaughtException', this.onUncaught)
    process.off('unhandledRejection', this.onUnhandledRejection)
  }
}

/** Thrown once shutdown has finished so `main` can return the exit code. */
export class AppExit extends Error {
  readonly code: number
  constructor(code: number) {
    super('app exit')
    this.name = 'AppExit'
    this.code = code
  }
}

function normalizeSelection(
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
): { startRow: number; startCol: number; endRow: number; endCol: number } {
  if (endRow < startRow || (endRow === startRow && endCol < startCol)) {
    return { startRow: endRow, startCol: endCol, endRow: startRow, endCol: startCol }
  }
  return { startRow, startCol, endRow, endCol }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export type { ApprovalOutcome }
