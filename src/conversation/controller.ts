/**
 * Conversation control (spec §4): one root agent on the official core, with
 * local echo retired by the official `user/message`, live previews that never
 * become history, and queue/steer/stop/clear semantics.
 */
import { randomUUID } from 'node:crypto'
import type { OfficialModules } from '../boot/official.ts'
import type { HistoryStore } from '../input/history.ts'
import { type Block, TranscriptModel } from '../transcript/model.ts'

export interface ConversationOptions {
  readonly ctx: any
  readonly official: OfficialModules
  readonly rootId: string
  readonly cwd: string
  readonly history: HistoryStore
  readonly onTitle?: (title: string) => void
}

export interface SubmitResult {
  readonly requestId: string
  readonly queued: boolean
}

export class ConversationController {
  readonly model = new TranscriptModel()
  private readonly options: ConversationOptions
  private handle: any
  private statusValue: 'idle' | 'running' = 'idle'
  private selection: { provider: string; model: string; reasoningEffort?: string } | undefined
  private disposers: Array<() => void> = []
  private disposed = false

  constructor(options: ConversationOptions) {
    this.options = options
  }

  get status(): 'idle' | 'running' {
    return this.statusValue
  }

  get agent(): any {
    return this.handle?.agent
  }

  get sessionId(): string {
    return this.options.rootId
  }

  /** Create the root agent and attach event listeners. */
  async start(): Promise<void> {
    const { ctx, official, rootId, cwd } = this.options
    const selection = ctx.get('agentDefaultModel')?.currentSelection?.() as
      | { provider: string; model: string; reasoningEffort?: string }
      | undefined
    if (!selection?.provider || !selection?.model) {
      throw new Error('nano: 没有可用的默认模型；请先在官方 DSH 中配置 provider/model。')
    }
    this.selection = selection
    const sessionId = official.session.SessionId(rootId)
    const agentOptions = {
      provider: selection.provider,
      model: selection.model,
      ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
    }
    const setup = (agentCtx: any) => {
      official.agent.installModelSelection(agentCtx, { current: selection, assembled: undefined })
    }
    // A persisted log makes `create` fail by design, so resume first and fall
    // back to create only when persistence reports NotFound.
    let resumed = false
    try {
      this.handle = await ctx.agents.resume({ resumeSessionId: sessionId, agentOptions, setup })
      resumed = true
    } catch (error) {
      if (isNotFound(error)) {
        this.handle = await ctx.agents.create({ sessionId, meta: { cwd }, agentOptions, setup })
      } else {
        throw error
      }
    }
    const actualId = this.handle?.agent?.session?.id
    if (actualId !== rootId) {
      throw new Error(
        `nano: 根身份不一致：期望 ${rootId}，官方返回 ${String(actualId)}；已停止，不创建替代会话。`,
      )
    }
    if (resumed) this.replay(this.handle.agent.session)
    this.attach()
  }

  /** Rebuild the reading surface from the official message projection. */
  private replay(session: any): void {
    let messages: any[]
    try {
      messages = session.deriveMessages()
    } catch {
      return
    }
    let seq = 0
    for (const message of messages) {
      seq++
      if (message.role === 'user') {
        const text = textOf(message.content)
        if (message.source?.kind === 'user' && text.trim() !== '') {
          this.model.confirmUser(-seq, text)
        }
        continue
      }
      if (message.role === 'assistant') {
        const blocks: Block[] = []
        for (const block of message.content ?? []) {
          if (block.type === 'text') blocks.push({ type: 'text', text: block.text })
          else if (block.type === 'reasoning') blocks.push({ type: 'reasoning', text: block.text })
          else if (block.type === 'tool-call')
            this.model.appendTool(block.id, block.name, block.arguments)
        }
        if (blocks.some((block) => block.type === 'text')) this.model.appendAssistant(-seq, blocks)
        continue
      }
      if (message.role === 'tool') {
        this.model.completeTool(
          message.toolCallId,
          textOf(message.content),
          message.isError === true,
          undefined,
        )
      }
    }
  }

  private attach(): void {
    const ctx = this.options.ctx
    const agent = this.agent
    const session = agent.session
    const onSessionEvent = (subject: any, event: any) => {
      if (subject !== session) return
      this.handleSessionEvent(event)
    }
    const onStream = (payload: any) => {
      if (payload?.agent !== agent) return
      this.handleStreamFrame(payload.frame)
    }
    const onStatus = (payload: any) => {
      if (payload?.agent !== agent) return
      this.statusValue = payload.status === 'running' ? 'running' : 'idle'
    }
    const onError = (payload: any) => {
      if (payload?.agent !== agent) return
      const text = payload.error instanceof Error ? payload.error.message : String(payload.error)
      this.model.appendNotice(`回合出错：${text}`, 'danger')
    }
    ctx.on('session/event', onSessionEvent)
    ctx.on('agent/assistant-stream', onStream)
    ctx.on('agent/status', onStatus)
    ctx.on('agent/error', onError)
    this.disposers.push(
      () => ctx.off?.('session/event', onSessionEvent),
      () => ctx.off?.('agent/assistant-stream', onStream),
      () => ctx.off?.('agent/status', onStatus),
      () => ctx.off?.('agent/error', onError),
    )
    this.statusValue = agent.status === 'running' ? 'running' : 'idle'
  }

  private handleSessionEvent(event: any): void {
    const data = event.data ?? {}
    switch (event.type) {
      case 'user/message': {
        const text = textOf(data.content)
        const sourceKind = data.source?.kind ?? 'unknown'
        if (sourceKind === 'user') {
          this.model.confirmUser(event.seq, text)
        } else if (data.source?.form === 'notice') {
          // Only one-line notices belong in the transcript; instruction and
          // runtime-context injections stay out of the reading surface.
          const summary = String(data.source.summary ?? text)
          if (summary.trim() !== '') this.model.appendNotice(summary, 'info')
        }
        break
      }
      case 'assistant/message': {
        const blocks: Block[] = []
        for (const block of data.message?.content ?? []) {
          if (block.type === 'text') blocks.push({ type: 'text', text: block.text })
          else if (block.type === 'reasoning') blocks.push({ type: 'reasoning', text: block.text })
        }
        this.model.appendAssistant(event.seq, blocks)
        break
      }
      case 'assistant/attempt':
        this.model.clearPreview()
        if (!data.interrupted)
          this.model.appendNotice('本次回复未确认（没有产生可见消息）。', 'warning')
        break
      case 'tool/call':
        this.model.appendTool(data.callId, data.name, data.arguments ?? '')
        break
      case 'tool/result': {
        const text = textOf(data.message?.content)
        const isError = data.message?.isError === true || data.error !== undefined
        const reason =
          typeof data.error?.reason === 'string' && data.error.reason !== ''
            ? data.error.reason
            : undefined
        this.model.completeTool(
          data.message?.toolCallId ?? data.message?.source?.callId,
          reason ? `${reason}\n${text}` : text,
          isError,
          data.meta,
        )
        break
      }
      case 'turn/end':
        this.statusValue = 'idle'
        break
      case 'session/title':
        if (typeof data.title === 'string') this.options.onTitle?.(data.title)
        break
      default:
        break
    }
  }

  private handleStreamFrame(frame: any): void {
    switch (frame.type) {
      case 'start':
        this.model.setPreview({
          attemptId: String(frame.attemptId),
          revision: frame.revision,
          reasoning: '',
          text: '',
        })
        break
      case 'chunk': {
        const current = this.model.preview
        if (!current || current.attemptId !== String(frame.attemptId)) return
        if (frame.revision !== current.revision) return
        const chunk = frame.chunk
        if (chunk?.type === 'reasoning-delta') {
          this.model.setPreview({ ...current, reasoning: current.reasoning + chunk.text })
        } else if (chunk?.type === 'text-delta') {
          this.model.setPreview({ ...current, text: current.text + chunk.text })
        }
        break
      }
      case 'end':
        this.model.clearPreview()
        break
      default:
        break
    }
  }

  /** Submit a prompt. While running, the official followup queues the next turn. */
  submit(text: string): SubmitResult {
    if (this.disposed) throw new Error('nano: 对话已关闭')
    const trimmed = text.trim()
    if (trimmed === '') throw new Error('nano: 空输入')
    const requestId = randomUUID()
    const queued = this.statusValue === 'running'
    this.model.appendUser(trimmed, requestId)
    this.options.history.record(trimmed)
    try {
      this.agent.followup(
        this.options.official.llm.createUserMessage({
          content: [{ type: 'text', text: trimmed }],
          source: { kind: 'user' },
        }),
      )
    } catch (error) {
      this.model.markUnconfirmed(requestId)
      this.model.appendNotice(`提交失败：${message(error)}`, 'danger')
      throw error
    }
    return { requestId, queued }
  }

  /** Steering goes to the nearest step boundary; an idle agent starts a turn. */
  steer(text: string): void {
    const trimmed = text.trim()
    if (trimmed === '') return
    this.model.appendUser(trimmed, randomUUID())
    this.options.history.record(trimmed)
    this.agent.steer(
      this.options.official.llm.createUserMessage({
        content: [{ type: 'text', text: trimmed }],
        source: { kind: 'user' },
      }),
    )
  }

  /** Stop keeps queued work (spec: 停止保留队列). */
  stop(): void {
    this.agent.cancel({ kind: 'user' }, { keepInbox: true })
    this.model.clearPreview()
  }

  /** Clear is a compound action: stop the active turn and drop queued work. */
  clear(): void {
    this.agent.cancel({ kind: 'user' })
    this.model.clearPreview()
    this.model.appendNotice('已停止当前回合并清空队列。', 'info')
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    for (const dispose of this.disposers) dispose()
    this.disposers = []
    try {
      await this.handle?.dispose?.()
    } catch {
      // Agent disposal failures are reported by the caller's shutdown report.
    }
  }

  get selectionInfo(): string {
    return this.selection ? `${this.selection.provider}/${this.selection.model}` : '未选择模型'
  }
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .filter((block): block is { type: string; text: string } => {
      return Boolean(block) && (block as { type?: string }).type === 'text'
    })
    .map((block) => block.text)
    .join('')
}

function _truncate(text: string, length: number): string {
  const line = text.replace(/\s+/gu, ' ').trim()
  return line.length > length ? `${line.slice(0, length - 1)}…` : line
}

function isNotFound(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const name = (error as { name?: unknown }).name
  if (name === 'SessionPersistenceNotFoundError') return true
  return /not found/iu.test(message(error))
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
