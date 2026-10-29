/**
 * Application orchestrator: wires the terminal, renderer, conversation,
 * decision seams and the lifecycle together. One instance owns one root.
 */

import type { ReactNode } from 'react'
import { createElement } from 'react'
import type { CoreBoot } from '../boot/assemble.ts'
import type { OfficialModules } from '../boot/official.ts'
import { type MountClaim, releaseMountClaim } from '../boot/root.ts'
import { occupancyRatio } from '../controls/info-panel.ts'
import type { ConversationController } from '../conversation/controller.ts'
import { APPROVAL_OPTIONS, type ApprovalOutcome, DecisionManager } from '../decisions/manager.ts'
import { HISTORY_LIMIT, type HistoryStore } from '../input/history.ts'
import { resolveKey } from '../input/keymap.ts'
import type { InputEvent, Key } from '../input/parser.ts'
import { INPUT_BYTE_LIMIT } from '../input/segments.ts'
import type { Renderer } from '../render/renderer.ts'
import { writeHandoff } from '../runtime/handoff.ts'
import { formatShutdownReport, Lifecycle } from '../runtime/lifecycle.ts'
import type { Terminal } from '../runtime/terminal.ts'
import { EDGE } from '../theme/spacing.ts'
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
  /** 接线接缝（S02 spec §1 接入点例外第 2/3 条）：不传时行为与 α 一致。 */
  readonly features?: FeatureHost
}

/** 受控重启请求（spec §1 第 6 条接缝）：只换根，不建替代会话。 */
export interface RestartRequest {
  readonly rootId: string
  readonly reason?: 'root-switch' | 'cold-rename'
  readonly payload?: Record<string, unknown>
}

/** 受控重启：main 捕获后交回 launcher 以 `--root <rootId>` 重新拉起。 */
export class AppRestart extends Error {
  readonly rootId: string
  constructor(rootId: string) {
    super(`nano: 受控重启到根 ${rootId}`)
    this.rootId = rootId
  }
}

/** S02 拿到的东西：官方根、渲染/终端句柄，以及回写 S01 状态的两个入口。 */
export interface FeatureContext {
  readonly core: CoreBoot
  readonly official: OfficialModules
  readonly terminal: Terminal
  readonly renderer: Renderer
  readonly conversation: ConversationController
  readonly decisions: DecisionManager
  /** S01 的输入框实例；S02 的补全/@/草稿读写它（spec §1 第 4 条接缝）。 */
  readonly input: InputModel
  readonly rootId: string
  readonly dataRoot: string
  readonly cwd: string
  /** 请求重画一帧（S02 自己的状态变化时调用）。 */
  requestRender(): void
  /** 写一行提示到状态栏；传 undefined 清掉。 */
  setNotice(text: string | undefined): void
  /** 受控重启：冻结输入 → 写 handoff → 既有关停 → 以新根重新拉起。 */
  requestRestart(request: RestartRequest): void
}

/**
 * S02 实现的接线对象。全部方法可选：没有 features 时 S01 走原路径。
 * - `start` 在首帧之前 await，失败即启动失败；
 * - `dispose` 在关停 drain 阶段调用；
 * - `handleKey` 先于 S01 处理按键，返回 true 表示已消费；
 * - `dispatchAction` 接 S01 没消费的 keymap action id；
 * - `body` 返回正文区内容（可为空）。
 */
export interface FeatureHost {
  start?(context: FeatureContext): void | Promise<void>
  dispose?(): void | Promise<void>
  handleKey?(key: Key): boolean
  dispatchAction?(action: string): boolean
  body?(): ReactNode
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
  private pendingPressId: string | undefined
  private lastTotalLines: number | undefined
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
  private pendingRestart: RestartRequest | undefined

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
    // S02 的接线先就位再画首帧；抛错即启动失败（main 走恢复终端 + 退出 1）。
    await this.options.features?.start?.({
      core,
      official: this.options.official,
      terminal: this.options.terminal,
      renderer: this.options.renderer,
      conversation,
      decisions: this.decisions,
      input: this.input,
      rootId: this.options.rootId,
      dataRoot: this.options.dataRoot,
      cwd: this.options.cwd,
      requestRender: () => this.scheduleRender(),
      setNotice: (text) => {
        this.notice = text
        this.scheduleRender()
      },
      requestRestart: (request) => this.requestRestart(request),
    })
    this.render()
    const finish = new Promise<number>((resolve) => {
      this.finishResolve = resolve
    })
    this.registerSignals()
    void conversation.model.onChange(() => this.scheduleRender())
    void conversation.onChange(() => this.scheduleRender())
    this.decisions.onChange(() => this.scheduleRender())
    return finish.then((code) => {
      if (this.pendingRestart) throw new AppRestart(this.pendingRestart.rootId)
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
    if (this.stopping) {
      for (const event of events) {
        if (event.type === 'key' && event.key.ctrl && event.key.text === 'c') {
          void this.lifecycle.requestShutdown('user force', true)
        }
      }
      return
    }
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
    // 接线接缝：S01 的模态优先，之后才轮到 S02 的界面（终端/面板输入）。
    if (this.options.features?.handleKey?.(key) === true) {
      this.scheduleRender()
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
          if (Buffer.byteLength(text, 'utf8') > INPUT_BYTE_LIMIT) {
            this.notice = '超过 32 KiB 上限，未发送（草稿保留）'
            return
          }
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
        if (Buffer.byteLength(text, 'utf8') > INPUT_BYTE_LIMIT) {
          this.notice = '超过 32 KiB 上限，未发送（草稿保留）'
          return
        }
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
        if (!this.input.isHistoryBrowsing) {
          this.input.setHistory(
            this.options.history.entries(HISTORY_LIMIT).map((entry) => entry.display),
          )
        }
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
        // 接线接缝：S01 不认识的 keymap action 交给 S02。
        if (action && this.options.features?.dispatchAction?.(action) === true) return
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
    // Question overlay: while typing a custom answer every printable key is
    // text, including space and the letter "c".
    const question = prompt.questions[prompt.current]
    const draft = question ? prompt.drafts.get(question.id) : undefined
    if (draft?.customMode) {
      if (key.name === 'escape') this.decisions.toggleCustom()
      else if (key.name === 'enter') this.decisions.advanceQuestion()
      else if (key.name === 'backspace') this.decisions.backspaceCustom()
      else if (key.name === 'char' && key.text && !key.ctrl && !key.alt) {
        this.decisions.typeCustom(key.text)
      }
      return
    }
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
      // Parser: wheel up is +1 and scrollBy(+n) moves towards older content.
      this.scrollBy((event.wheel ?? 0) * 3)
      return
    }
    if (event.kind === 'press' && event.button === 'left') {
      this.pendingPressId = this.options.renderer.pressIdAt(col, row)
      this.selectionStart = { row, col }
      this.selectionActive = false
      return
    }
    if (event.kind === 'move' && this.selectionStart) {
      if (row !== this.selectionStart.row || col !== this.selectionStart.col) {
        this.selectionActive = true
        this.options.renderer.selection = normalizeSelection(
          this.selectionStart.row,
          this.selectionStart.col,
          row,
          col,
        )
      }
      return
    }
    if (event.kind === 'release') {
      const start = this.selectionStart
      if (this.selectionActive && start) {
        const range = normalizeSelection(start.row, start.col, row, col)
        const text = this.options.renderer.extractText(range)
        if (text.trim() !== '') this.options.terminal.copyToClipboard(text)
      } else if (this.pendingPressId && start && start.row === row && start.col === col) {
        // A click without a drag activates the pressable row.
        this.handlePress(this.pendingPressId)
      }
      this.selectionStart = undefined
      this.selectionActive = false
      this.pendingPressId = undefined
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
    const width = this.options.terminal.width
    const lines = this.options.conversation.model.layout({
      width: Math.max(1, width - EDGE * 2),
      expanded: this.expanded,
    })
    const total = lines.length
    if (!this.stickBottom && this.lastTotalLines !== undefined && total > this.lastTotalLines) {
      this.scrollOffset += total - this.lastTotalLines
    }
    this.lastTotalLines = total
    const contextRatio = occupancyRatio(this.options.core.ctx, this.options.conversation.agent)
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
      ...(contextRatio !== undefined ? { contextRatio } : {}),
      ...(this.options.features?.body ? { featureBody: this.options.features.body() } : {}),
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

  /** 记录重启意图并走既有关停；关停里写 handoff，start() 结束时抛 AppRestart。 */
  private requestRestart(request: RestartRequest): void {
    if (this.pendingRestart) return
    try {
      // 先落盘 handoff：写不成就取消重启，应用继续跑，草稿留在输入框。
      writeHandoff(this.options.dataRoot, {
        rootId: request.rootId,
        sessionId: this.options.rootId,
        reason: request.reason ?? 'root-switch',
        ...(request.payload ? { payload: request.payload } : {}),
      })
    } catch (error) {
      this.notice = `切换失败（handoff 写入失败）：${String((error as Error)?.message ?? error)}`
      this.options.writeDiagnostic(`nano: handoff 写入失败，取消重启`)
      this.scheduleRender()
      return
    }
    this.pendingRestart = request
    this.exitCode = 0
    void this.shutdown(`restart ${request.rootId}`)
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
    this.lifecycle.register('drain', 'features', async () => {
      try {
        await this.options.features?.dispose?.()
      } catch (error) {
        this.cleanupFailed = true
        throw error
      }
    })
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
    this.lifecycle.onResult = (result) => {
      if (result.status !== 'stopped') this.cleanupFailed = true
    }
    this.lifecycle.register('release', 'mount-claim', async () => {
      if (this.cleanupFailed) throw new Error('清理失败，保留认领')
      releaseMountClaim(claim)
    })
    this.lifecycle.register('restore', 'terminal', async () => {
      terminal.restore()
    })
    const forceTimer = setTimeout(() => {
      terminal.restore()
      this.exitCode = this.exitCode || 1
    }, 3000)
    const report = await this.lifecycle.requestShutdown(reason)
    clearTimeout(forceTimer)
    this.removeProcessListeners()
    const failed = report.results.some((result) => result.status !== 'stopped')
    if (failed) this.exitCode = this.exitCode || 1
    if (failed && this.pendingRestart) {
      // 清理失败时不换根：claim 没释放，新进程只会报「被占用」。
      this.pendingRestart = undefined
      this.options.writeDiagnostic('nano: 清理未完成，取消受控重启')
    }
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
