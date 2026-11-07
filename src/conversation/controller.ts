/**
 * Conversation control (spec §4): one root agent on the official core, with
 * local echo retired by the official `user/message`, live previews that never
 * become history, and queue/steer/stop/clear semantics.
 */
import { randomUUID } from 'node:crypto'
import { ActivityState } from '../activity/state.ts'
import type { OfficialModules } from '../boot/official.ts'
import type { HistoryStore } from '../input/history.ts'
import { sanitizeText } from '../render/text.ts'
import { type Block, TranscriptModel } from '../transcript/model.ts'

export interface ConversationOptions {
  readonly ctx: any
  readonly official: OfficialModules
  readonly rootId: string
  readonly cwd: string
  readonly history: HistoryStore
  readonly onTitle?: (title: string) => void
  /** `-c` / `-r <id>`：目标不存在时必须报错，不得 create。 */
  readonly resumeOnly?: boolean
  /** resume-only 目标在启动时消失时给用户看的文案。 */
  readonly notFoundMessage?: string
}

export interface SubmitResult {
  readonly requestId: string
  /** 运行中投到下一 step，空闲投到下一回合（spec 2026-10-30）。 */
  readonly delivery: 'steer' | 'followup'
}

/** 运行中提交后的统一 notice；空闲不提示。 */
export const STEER_NOTICE = '已插入（下一 step 或新回合生效）'

export function deliveryNotice(delivery: SubmitResult['delivery']): string | undefined {
  return delivery === 'steer' ? STEER_NOTICE : undefined
}

/** 根 agent 的委派纪律；与官方 tool:jobs 的措辞先例一致。 */
const DELEGATION_GUIDANCE =
  "Delegated subagents run in the background. The runtime notifies you when one finishes; do not sleep, poll `list_agents`, or read a subagent's output file to check its progress. If you have no useful work left while they run, end your turn — the user can keep talking to you, and the completion notice will wake you in a later turn."

/** 提问纪律（ADR-20261103-question-trigger-discipline），与 Claude Code 同义。 */
const QUESTION_DISCIPLINE = `# Bias toward action
Act on your best judgment rather than asking for confirmation.
- Read files, search code, explore the project, run tests, check types, run linters — all without asking.
- If you're unsure between two reasonable approaches, pick one and go. You can always course-correct.
- Use ask_user_question only when the answer changes what gets built and cannot be derived from the code, config, or defaults.
- Do not use ask_user_question for confirmations ("Should I proceed?"), plan approval, or trivial implementation details. If you already asked, don't ask again.
- Prefer stating a recommendation and proceeding over asking.
- If you do not understand why the user denied a tool call, use ask_user_question to ask them.`

/** Bash live 预览合并窗口（spec §3.5）。 */
const LIVE_OUTPUT_MERGE_MS = 120

/** 有序提交内容（spec §1 第 5 条接缝）：官方 content 段 + 阅读面显示文字。 */
export interface PromptContent {
  readonly content: readonly any[]
  /** 阅读面与历史里显示的文字；只有图时可为空串。 */
  readonly displayText: string
}

function hasAttachment(content: readonly any[]): boolean {
  return content.some((part) => part?.type !== undefined && part.type !== 'text')
}

function assertContent(display: string, content: readonly any[]): void {
  // 官方拒绝既无文本又无附件的 prompt；这里先拦，避免发出去再失败。
  if (display === '' && !hasAttachment(content)) throw new Error('nano: 空输入')
}

export interface ModelSelection {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/**
 * 写官方默认模型；返回错误字符串而不是抛出：
 * 会话内切换仍应生效，profile 写失败只影响重启后的记忆。
 * 官方在无 entry / 无 configEditor 时会静默 return，这里无法区分。
 */
export async function saveDefaultSelection(
  ctx: any,
  next: ModelSelection,
): Promise<string | undefined> {
  const defaultModel = ctx.get('agentDefaultModel')
  if (typeof defaultModel?.saveSelection !== 'function') return undefined
  try {
    await defaultModel.saveSelection(next)
    return undefined
  } catch (error) {
    return String((error as Error)?.message ?? error)
  }
}

export class ConversationController {
  readonly model = new TranscriptModel()
  readonly activity = new ActivityState()
  private sessionSeq = -1
  private readonly options: ConversationOptions
  private handle: any
  private statusValue: 'idle' | 'running' = 'idle'
  private selection: ModelSelection | undefined
  private disposers: Array<() => void> = []
  private disposed = false
  /** callId → jobId（session `job/registered` 建立）与反向映射。 */
  private readonly liveJobs = new Map<string, string>()
  private readonly liveCalls = new Map<string, string>()
  private readonly liveOffsets = new Map<string, number>()
  private readonly liveBuffers = new Map<string, string>()
  private readonly liveDirty = new Set<string>()
  private liveTimer: ReturnType<typeof setTimeout> | undefined

  constructor(options: ConversationOptions) {
    this.options = options
  }

  get status(): 'idle' | 'running' {
    return this.activity.isWorking ? 'running' : this.statusValue
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
      | ModelSelection
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
      // 0.2.2 起模型选择由 Agent 自己持有（agent.model），这里只装「换模型」提示。
      official.agent.installModelSelection(agentCtx)
      const disposeQuestion = agentCtx.systemPrompt.section({
        name: 'nano:question-discipline',
        order: 10145,
        interpolate: false,
        text: QUESTION_DISCIPLINE,
      })
      if (typeof disposeQuestion === 'function') this.disposers.push(disposeQuestion)
      const disposeSection = agentCtx.systemPrompt.section({
        name: 'nano:delegation-responsiveness',
        order: 10150,
        interpolate: false,
        text: DELEGATION_GUIDANCE,
      })
      if (typeof disposeSection === 'function') this.disposers.push(disposeSection)
    }
    // A persisted log makes `create` fail by design, so resume first and fall
    // back to create only when persistence reports NotFound.
    let resumed = false
    try {
      this.handle = await ctx.agents.resume({ resumeSessionId: sessionId, agentOptions, setup })
      resumed = true
    } catch (error) {
      if (!isNotFound(error)) throw error
      if (this.options.resumeOnly === true) {
        throw new Error(
          this.options.notFoundMessage ?? `nano: 会话 ${rootId} 不存在；已停止，不创建替代会话。`,
        )
      }
      this.handle = await ctx.agents.create({ sessionId, meta: { cwd }, agentOptions, setup })
    }
    const actualId = this.handle?.agent?.session?.id
    if (actualId !== rootId) {
      throw new Error(
        `nano: 根身份不一致：期望 ${rootId}，官方返回 ${String(actualId)}；已停止，不创建替代会话。`,
      )
    }
    if (resumed) this.replay(this.handle.agent.session)
    await this.reconcileModelSelection(selection)
    this.attach()
  }

  /**
   * 恢复会话时官方优先用会话日志里的模型选择；provider 被移除或模型下架后，
   * 它会让每个回合都在请求阶段失败。启动后做一次有界的失效对账：
   * 明确不可用才回退到 profile 默认，并留一条可见提示；超时不改。
   */
  private async reconcileModelSelection(fallback: ModelSelection): Promise<void> {
    const recorded = this.agent?.model?.current?.() as ModelSelection | undefined
    if (!recorded?.provider || !recorded?.model) return
    if (recorded.provider === fallback.provider && recorded.model === fallback.model) return
    const llm = this.options.ctx.get('llm')
    if (typeof llm?.resolveModelInfo !== 'function') return
    try {
      await llm.resolveModelInfo(recorded.provider, recorded.model, AbortSignal.timeout(2000))
    } catch (error) {
      const name = (error as { name?: string } | undefined)?.name
      if (name === 'TimeoutError' || name === 'AbortError') return
      const agent = this.agent
      if (typeof agent?.model?.select !== 'function') return
      agent.model.select(fallback)
      this.selection = fallback
      this.model.appendNotice(
        `会话记录的模型 ${recorded.provider}/${recorded.model} 不可用，已回退到默认模型 ${fallback.provider}/${fallback.model}。`,
        'warning',
      )
    }
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
        const reasoning: string[] = []
        for (const block of message.content ?? []) {
          if (block.type === 'text') blocks.push({ type: 'text', text: block.text })
          else if (block.type === 'reasoning') reasoning.push(block.text)
          else if (block.type === 'tool-call')
            this.model.appendTool(block.id, block.name, block.arguments)
        }
        if (reasoning.length > 0) this.model.appendThinking(-seq, reasoning.join('\n'))
        if (blocks.length > 0) this.model.appendAssistant(-seq, blocks)
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

  onChange(listener: () => void): () => void {
    this.statusListeners.add(listener)
    return () => this.statusListeners.delete(listener)
  }

  private readonly statusListeners = new Set<() => void>()

  private notifyStatus(): void {
    for (const listener of [...this.statusListeners]) listener()
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
      if (this.statusValue === 'running') this.activity.running()
      else this.activity.endTurn()
      this.notifyStatus()
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
    const jobs = ctx.get('jobs')
    if (typeof jobs?.events?.subscribe === 'function') {
      const off = jobs.events.subscribe({ owner: session.id }, (event: any) =>
        this.handleJobEvent(event),
      )
      if (typeof off === 'function') this.disposers.push(off)
    }
    this.disposers.push(
      () => ctx.off?.('session/event', onSessionEvent),
      () => ctx.off?.('agent/assistant-stream', onStream),
      () => ctx.off?.('agent/status', onStatus),
      () => ctx.off?.('agent/error', onError),
    )
    this.statusValue = agent.status === 'running' ? 'running' : 'idle'
    if (this.statusValue === 'running') this.activity.running()
  }

  private handleSessionEvent(event: any): void {
    const data = event.data ?? {}
    if (typeof event.seq === 'number') {
      if (event.seq <= this.sessionSeq) return
      this.sessionSeq = event.seq
    }
    if (
      typeof data.turn === 'number' &&
      event.type !== 'turn/start' &&
      !this.activity.acceptsTurn(data.turn) &&
      event.type !== 'session/title'
    )
      return
    switch (event.type) {
      case 'turn/start':
        if (!this.activity.startTurn(data.turn)) return
        this.statusValue = 'running'
        this.notifyStatus()
        break
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
        const reasoning: string[] = []
        for (const block of data.message?.content ?? []) {
          if (block.type === 'text') blocks.push({ type: 'text', text: block.text })
          else if (block.type === 'reasoning') reasoning.push(block.text)
        }
        // Latch visibility across preview -> durable message; end is emitted after this append.
        for (const block of blocks) if (block.type === 'text') this.activity.body(block.text)
        if (reasoning.length > 0) this.model.appendThinking(event.seq, reasoning.join('\n'))
        this.model.appendAssistant(event.seq, blocks)
        break
      }
      case 'assistant/attempt':
        this.model.clearPreview()
        if (!data.interrupted)
          this.model.appendNotice('本次回复未确认（没有产生可见消息）。', 'warning')
        break
      case 'tool/call': {
        this.activity.toolStart(data.callId, data.name, data.turn)
        this.model.appendTool(data.callId, data.name, data.arguments ?? '')
        // `job/registered` 可能早于 tool/call：那时先记映射，等条目建立再绑；
        // 早到的 output 没有被消费，这里补读一次（F7）。
        const jobId = this.liveJobs.get(data.callId)
        if (jobId !== undefined) {
          this.model.attachLiveJob(data.callId, jobId)
          this.readLive(jobId)
        }
        break
      }
      case 'job/registered': {
        const jobId = typeof data.jobId === 'string' ? data.jobId : undefined
        const callId = data.toolCall?.callId
        if (jobId !== undefined && typeof callId === 'string') {
          this.bindLiveJob(callId, jobId)
        }
        break
      }
      case 'job/settled': {
        const jobId = typeof data.jobId === 'string' ? data.jobId : undefined
        if (jobId !== undefined) {
          // 结算前的最后一段输出：读一次再清映射，已显示的 5 行不撤回。
          this.readLive(jobId, true)
          this.dropLiveJob(jobId)
        }
        break
      }
      case 'tool/result': {
        const callId = data.message?.toolCallId ?? data.message?.source?.callId
        this.activity.toolEnd(callId, data.turn)
        const text = textOf(data.message?.content)
        const isError = data.message?.isError === true || data.error !== undefined
        const reason =
          typeof data.error?.reason === 'string' && data.error.reason !== ''
            ? data.error.reason
            : undefined
        this.model.completeTool(callId, reason ? `${reason}\n${text}` : text, isError, data.meta)
        // 前台调用结束（含超时转后台）：补读最后一段并停更，后台输出归任务面板（F2）。
        if (typeof callId === 'string') this.finalizeLiveJob(callId)
        break
      }
      case 'turn/end':
        if (!this.activity.endTurn(data.turn)) return
        this.statusValue = 'idle'
        this.notifyStatus()
        break
      case 'session/title':
        if (typeof data.title === 'string') this.options.onTitle?.(data.title)
        break
      default:
        break
    }
    this.notifyStatus()
  }

  private handleJobEvent(event: any): void {
    if (event?.type !== 'output') return
    const jobId = String(event.id)
    if (!this.liveCalls.has(jobId)) return
    this.liveDirty.add(jobId)
    this.scheduleLiveFlush()
  }

  private scheduleLiveFlush(): void {
    if (this.liveTimer !== undefined) return
    this.liveTimer = setTimeout(() => {
      this.liveTimer = undefined
      for (const jobId of [...this.liveDirty]) {
        this.liveDirty.delete(jobId)
        this.readLive(jobId)
      }
    }, LIVE_OUTPUT_MERGE_MS)
    this.liveTimer.unref?.()
  }

  private bindLiveJob(callId: string, jobId: string): void {
    this.liveJobs.set(callId, jobId)
    this.liveCalls.set(jobId, callId)
    if (!this.liveOffsets.has(jobId)) this.liveOffsets.set(jobId, 0)
    if (this.model.attachLiveJob(callId, jobId)) this.readLive(jobId)
  }

  /**
   * 读 job 的新增输出并追加到工具行；失败只清预览，不向用户报错。
   * 条目还没建立时先不读、不推进 offset，等 tool/call 后补读（F7）。
   * `final` 为 true 时把不完整的尾行也交给渲染（job 结算 / 调用结束）。
   */
  private readLive(jobId: string, final = false): void {
    const callId = this.liveCalls.get(jobId)
    const jobs = this.options.ctx.get('jobs')
    const sessionId = this.agent?.session?.id
    if (callId === undefined || jobs === undefined || sessionId === undefined) return
    if (this.model.toolEntryByCallId(callId) === undefined) return
    try {
      const read = jobs.readAt(jobId, this.liveOffsets.get(jobId) ?? 0, sessionId) as {
        chunks?: Array<{ text: string }>
        next?: number
      }
      this.liveOffsets.set(jobId, read.next ?? this.liveOffsets.get(jobId) ?? 0)
      const text = sanitizeText((read.chunks ?? []).map((chunk) => chunk.text).join(''))
      const combined = (this.liveBuffers.get(jobId) ?? '') + text
      const parts = combined.split('\n')
      const remainder = parts.pop() ?? ''
      const lines = parts
        .map((line) => line.replace(/\r/gu, '').trimEnd())
        .filter((line) => line.trim() !== '')
      if (final && remainder.trim() !== '') {
        lines.push(remainder.replace(/\r/gu, '').trimEnd())
      }
      this.liveBuffers.set(jobId, final ? '' : remainder)
      if (lines.length > 0) this.model.setLiveOutput(callId, lines)
    } catch {
      this.dropLiveJob(jobId)
    }
  }

  private finalizeLiveJob(callId: string): void {
    const jobId = this.liveJobs.get(callId)
    if (jobId === undefined) return
    this.readLive(jobId, true)
    this.dropLiveJob(jobId)
  }

  private dropLiveJob(jobId: string): void {
    const callId = this.liveCalls.get(jobId)
    this.liveCalls.delete(jobId)
    this.liveOffsets.delete(jobId)
    this.liveBuffers.delete(jobId)
    this.liveDirty.delete(jobId)
    if (callId !== undefined) {
      this.liveJobs.delete(callId)
      this.model.clearLiveJob(callId)
    }
  }

  private handleStreamFrame(frame: any): void {
    switch (frame.type) {
      case 'start':
        if (!this.activity.start(frame)) return
        this.model.setPreview({
          attemptId: String(frame.attemptId),
          revision: frame.revision,
          reasoning: '',
          text: '',
        })
        break
      case 'chunk': {
        const current = this.model.preview
        if (
          !current ||
          current.attemptId !== String(frame.attemptId) ||
          !this.activity.frame(frame)
        )
          return
        // Official frames carry a strictly increasing revision per frame, so it
        // orders frames within one attempt but never identifies the attempt.
        const chunk = frame.chunk
        if (chunk?.type === 'reasoning-delta') {
          this.activity.reasoning(chunk.text)
          this.model.setPreview({ ...current, reasoning: current.reasoning + chunk.text })
        } else if (chunk?.type === 'text-delta') {
          const text = current.text + chunk.text
          this.activity.body(text)
          this.model.setPreview({ ...current, text })
        } else if (chunk?.type === 'tool-call-delta') {
          this.activity.parameters()
        }
        break
      }
      case 'end':
        if (!this.activity.frame(frame)) return
        this.activity.endAttempt()
        this.model.clearPreview()
        break
      default:
        break
    }
    this.notifyStatus()
  }

  /** Submit a prompt. Running steers the current turn; idle starts a new turn. */
  submit(text: string): SubmitResult {
    const trimmed = text.trim()
    return this.submitContent({
      content: [{ type: 'text', text: trimmed }],
      displayText: trimmed,
    })
  }

  /**
   * Submit an ordered content list (text + image + file reference). The text
   * path above is this method with a single text part. A running turn receives
   * the message at its next step (steer); an idle agent starts a new turn
   * (followup), so echo, history and attachment admission stay identical.
   */
  submitContent(prompt: PromptContent): SubmitResult {
    if (this.disposed) throw new Error('nano: 对话已关闭')
    const display = prompt.displayText.trim()
    assertContent(display, prompt.content)
    const requestId = randomUUID()
    const delivery = this.statusValue === 'running' ? 'steer' : 'followup'
    this.model.appendUser(display, requestId)
    if (display !== '') this.options.history.record(display)
    this.activity.accepted()
    this.notifyStatus()
    try {
      const userMessage = this.options.official.llm.createUserMessage({
        content: prompt.content,
        source: { kind: 'user' },
      })
      if (delivery === 'steer') this.agent.steer(userMessage)
      else this.agent.followup(userMessage)
    } catch (error) {
      this.activity.rejected()
      this.notifyStatus()
      this.model.markUnconfirmed(requestId)
      this.model.appendNotice(`提交失败：${message(error)}`, 'danger')
      throw error
    }
    return { requestId, delivery }
  }

  /** Steering goes to the nearest step boundary; an idle agent starts a turn. */
  steer(text: string): void {
    const trimmed = text.trim()
    this.steerContent({
      content: [{ type: 'text', text: trimmed }],
      displayText: trimmed,
    })
  }

  /** Steering with an ordered content list; same admission rule as submit. */
  steerContent(prompt: PromptContent): void {
    const display = prompt.displayText.trim()
    if (display === '' && !hasAttachment(prompt.content)) return
    this.model.appendUser(display, randomUUID())
    if (display !== '') this.options.history.record(display)
    this.activity.accepted()
    this.notifyStatus()
    this.agent.steer(
      this.options.official.llm.createUserMessage({
        content: prompt.content,
        source: { kind: 'user' },
      }),
    )
  }

  /** Stop keeps queued work (spec: 停止保留队列). */
  stop(): void {
    this.activity.stop()
    this.notifyStatus()
    this.agent.cancel({ kind: 'user' }, { keepInbox: true })
    this.model.clearPreview()
  }

  /** Clear is a compound action: stop the active turn and drop queued work. */
  clear(): void {
    this.activity.stop()
    this.notifyStatus()
    this.agent.cancel({ kind: 'user' })
    this.model.clearPreview()
    this.model.appendNotice('已发送停止请求并清空队列。', 'info')
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    if (this.liveTimer !== undefined) {
      clearTimeout(this.liveTimer)
      this.liveTimer = undefined
    }
    this.activity.endTurn()
    for (const dispose of this.disposers) dispose()
    this.disposers = []
    await this.handle?.dispose?.()
  }

  get selectionInfo(): string {
    const selection = this.modelSelection
    return selection ? `${selection.provider}/${selection.model}` : '未选择模型'
  }

  get modelSelection(): ModelSelection | undefined {
    // 0.2.2 的权威选择在 Agent 上：恢复会话时它可能来自会话日志，而不是启动默认值。
    const live = this.agent?.model?.current?.()
    if (live?.provider && live?.model) return live as ModelSelection
    return this.selection
  }

  /** 当前 provider 的官方模型目录（adapter 自报，可能为空）。 */
  async listModels(provider: string): Promise<any[]> {
    return (await this.listModelsResult(provider)).models
  }

  /** 目录读取失败要能显示在面板里，所以把失败原因一并带回。 */
  async listModelsResult(provider: string): Promise<{ models: any[]; error?: string }> {
    const llm = this.options.ctx.get('llm')
    if (!llm?.listModels) return { models: [], error: '模型服务不提供目录' }
    try {
      return { models: await llm.listModels(provider) }
    } catch (error) {
      return { models: [], error: String((error as Error)?.message ?? error) }
    }
  }

  /** 解析某个精确 provider/model 的官方档位（id + 展示名）与默认强度。 */
  async resolveModelMeta(
    provider: string,
    model: string,
  ): Promise<{ efforts: Array<{ id: string; name: string }>; defaultEffort?: string }> {
    const result = await this.resolveModelMetaResult(provider, model)
    return {
      efforts: result.efforts,
      ...(result.defaultEffort ? { defaultEffort: result.defaultEffort } : {}),
    }
  }

  /** 强度读取失败要能显示在面板里，所以把失败原因一并带回。 */
  async resolveModelMetaResult(
    provider: string,
    model: string,
  ): Promise<{
    efforts: Array<{ id: string; name: string }>
    defaultEffort?: string
    error?: string
  }> {
    const llm = this.options.ctx.get('llm')
    if (!llm?.resolveModelInfo) return { efforts: [], error: '模型服务不提供强度信息' }
    try {
      const info = await llm.resolveModelInfo(provider, model)
      const raw = info?.reasoning?.efforts
      const efforts = Array.isArray(raw)
        ? raw
            .map((effort: any) => ({
              id: String(effort?.id ?? effort?.name ?? effort),
              name: String(effort?.name ?? effort?.id ?? effort),
            }))
            .filter((effort: { id: string }) => effort.id !== '')
        : []
      const defaultEffort = info?.reasoning?.defaultEffort
        ? String(info.reasoning.defaultEffort)
        : undefined
      return { efforts, ...(defaultEffort ? { defaultEffort } : {}) }
    } catch (error) {
      return { efforts: [], error: String((error as Error)?.message ?? error) }
    }
  }

  async resolveModelEfforts(provider: string, model: string): Promise<string[]> {
    const meta = await this.resolveModelMeta(provider, model)
    return meta.efforts.map((effort) => effort.id)
  }

  /**
   * 切换模型/强度：只改下一次请求的组装，不触碰正在运行的步骤。
   * 先用官方 resolveModelInfo 校验，成功才交给 Agent 记录选择。
   */
  async selectModel(
    provider: string,
    model: string,
    effort?: string,
  ): Promise<{
    provider: string
    model: string
    reasoningEffort?: string
    efforts: string[]
    saveError?: string
  }> {
    const llm = this.options.ctx.get('llm')
    if (!llm?.resolveModelInfo) throw new Error('模型服务不可用')
    const catalog = await this.listModels(provider)
    const ids = catalog
      .map((entry: any) => String(entry?.id ?? entry?.model ?? entry?.name ?? ''))
      .filter(Boolean)
    const catalogValidated = ids.length > 0 && ids.includes(model)
    if (ids.length > 0 && !ids.includes(model)) {
      throw new Error(`模型不在目录：${provider}/${model}；可选：${ids.join(' / ')}`)
    }
    await llm.resolveModelInfo(provider, model)
    const efforts = await this.resolveModelEfforts(provider, model)
    if (effort && !efforts.includes(effort)) {
      throw new Error(
        `模型 ${provider}/${model} 没有强度 ${effort}；可选：${efforts.join(' / ') || '无'}`,
      )
    }
    const next: ModelSelection = {
      provider,
      model,
      ...(effort ? { reasoningEffort: effort } : {}),
    }
    const agent = this.agent
    if (!agent?.model?.select) throw new Error('会话尚未启动')
    // 0.2.2 起由 Agent 持有选择：写会话日志，下一步/下一回合按它组装请求。
    if (typeof llm.resolveCallConfig === 'function') await llm.resolveCallConfig(next)
    agent.model.select(next)
    // 会话内选择先生效；profile 写失败只影响重启后的记忆，不回滚本次切换。
    this.selection = next
    const saveError = catalogValidated
      ? await saveDefaultSelection(this.options.ctx, next)
      : '模型目录不可用，默认未写入'
    return { ...next, efforts, ...(saveError ? { saveError } : {}) }
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
