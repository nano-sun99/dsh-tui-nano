/**
 * Approval and user-question seams (spec §4): two independent answerers, each
 * registered exactly once. Approvals fail closed with the reject option
 * focused; questions keep single/multi-select semantics and skipped items.
 */
import type { AskUserQuestionAnswer, AskUserQuestionItem } from './types.ts'

export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

export const APPROVAL_OPTIONS: ReadonlyArray<{ outcome: ApprovalOutcome; label: string }> = [
  { outcome: 'allowed-once', label: '允许一次' },
  { outcome: 'rejected', label: '拒绝' },
  { outcome: 'cancelled', label: '取消请求' },
  { outcome: 'unavailable', label: '无法回答（按失败关闭处理）' },
]

export interface ApprovalPrompt {
  readonly kind: 'approval'
  /** Owning agent session, so S02 can keep per-address approvals apart. */
  readonly address: string
  readonly toolName: string
  readonly reason?: string
  readonly callId?: string
  readonly selected: number
}

export interface QuestionDraft {
  readonly selected: Set<string>
  custom: string
  customMode: boolean
}

export interface QuestionPrompt {
  readonly kind: 'question'
  readonly address: string
  readonly questions: readonly AskUserQuestionItem[]
  readonly current: number
  readonly focusedOption: number
  readonly drafts: Map<string, QuestionDraft>
  readonly planReview: boolean
}

export type DecisionPrompt = ApprovalPrompt | QuestionPrompt

type ApprovalWaiter = {
  resolve: (outcome: ApprovalOutcome) => void
  reject: (error: unknown) => void
}

type QuestionWaiter = {
  resolve: (answer: AskUserQuestionAnswer) => void
  reject: (error: unknown) => void
}

export class DecisionManager {
  private approval:
    | { prompt: ApprovalPrompt; waiter: ApprovalWaiter; signal?: AbortSignal }
    | undefined
  private question:
    | { prompt: QuestionPrompt; waiter: QuestionWaiter; signal?: AbortSignal }
    | undefined
  private readonly listeners = new Set<() => void>()

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener()
  }

  /** Register both answerers on the root context. */
  register(ctx: any): void {
    ctx.on('approval/request', async (request: any) => this.askApproval(request))
    ctx.on('user-questions/request', async (request: any) => this.askQuestions(request))
  }

  get prompt(): DecisionPrompt | undefined {
    return this.approval?.prompt ?? this.question?.prompt
  }

  get hasDecision(): boolean {
    return this.prompt !== undefined
  }

  askApproval(request: any): Promise<ApprovalOutcome> {
    return new Promise<ApprovalOutcome>((resolve, reject) => {
      const prompt: ApprovalPrompt = {
        kind: 'approval',
        address: String(request.agent?.session?.id ?? request.agent?.id ?? 'root'),
        toolName: String(request.toolName ?? '工具'),
        ...(typeof request.reason === 'string' ? { reason: request.reason } : {}),
        ...(typeof request.callId === 'string' ? { callId: request.callId } : {}),
        selected: 1,
      }
      const signal: AbortSignal | undefined = request.signal
      const abort = () => {
        if (this.approval?.waiter.resolve === resolve) this.approval = undefined
        resolve('cancelled')
        this.notify()
      }
      signal?.addEventListener('abort', abort, { once: true })
      this.approval = { prompt, waiter: { resolve, reject }, signal }
      this.notify()
    })
  }

  askQuestions(request: any): Promise<AskUserQuestionAnswer> {
    return new Promise<AskUserQuestionAnswer>((resolve, reject) => {
      const questions = Array.isArray(request.questions)
        ? (request.questions as AskUserQuestionItem[])
        : []
      const drafts = new Map<string, QuestionDraft>()
      for (const question of questions) {
        drafts.set(question.id, { selected: new Set<string>(), custom: '', customMode: false })
      }
      const planReview = questions.some((question) => question.intent?.kind === 'plan-review')
      const prompt: QuestionPrompt = {
        kind: 'question',
        address: String(request.agent?.session?.id ?? 'root'),
        questions,
        current: 0,
        focusedOption: 0,
        drafts,
        planReview,
      }
      const signal: AbortSignal | undefined = request.signal
      const abort = () => {
        if (this.question?.waiter.resolve === resolve) this.question = undefined
        resolve({ answers: questions.map((question) => ({ id: question.id, selected: [] })) })
        this.notify()
      }
      signal?.addEventListener('abort', abort, { once: true })
      this.question = { prompt, waiter: { resolve, reject }, signal }
      this.notify()
    })
  }

  /** Move the approval focus or the current question's option focus. */
  move(delta: number): void {
    if (this.approval) {
      const count = APPROVAL_OPTIONS.length
      const next = (this.approval.prompt.selected + delta + count) % count
      this.approval.prompt = { ...this.approval.prompt, selected: next }
      this.notify()
      return
    }
    if (!this.question) return
    const prompt = this.question.prompt
    const question = prompt.questions[prompt.current]
    if (!question) return
    const optionCount = question.options?.length ?? 0
    if (optionCount === 0) return
    const draft = prompt.drafts.get(question.id)
    const focusable = draft?.customMode ? optionCount : optionCount
    const next = (prompt.focusedOption + delta + focusable) % focusable
    this.question.prompt = { ...prompt, focusedOption: next }
    this.notify()
  }

  /** Enter on the focused approval option. */
  chooseApproval(): void {
    if (!this.approval) return
    const option = APPROVAL_OPTIONS[this.approval.prompt.selected]
    if (option) this.resolveApproval(option.outcome)
  }

  resolveApproval(outcome: ApprovalOutcome): void {
    const active = this.approval
    if (!active) return
    this.approval = undefined
    active.signal?.removeEventListener('abort', () => {})
    active.waiter.resolve(outcome)
    this.notify()
  }

  toggleOption(): void {
    const active = this.question
    if (!active) return
    const prompt = active.prompt
    const question = prompt.questions[prompt.current]
    if (!question?.options || question.options.length === 0) return
    const option = question.options[prompt.focusedOption]
    if (!option) return
    const draft = prompt.drafts.get(question.id)
    if (!draft) return
    if (question.multiSelect) {
      if (draft.selected.has(option.label)) draft.selected.delete(option.label)
      else draft.selected.add(option.label)
    } else {
      draft.selected.clear()
      draft.selected.add(option.label)
      draft.custom = ''
    }
    this.notify()
  }

  toggleCustom(): void {
    const active = this.question
    if (!active) return
    const prompt = active.prompt
    const question = prompt.questions[prompt.current]
    if (!question) return
    const draft = prompt.drafts.get(question.id)
    if (!draft) return
    draft.customMode = !draft.customMode
    this.notify()
  }

  typeCustom(text: string): void {
    const active = this.question
    if (!active) return
    const prompt = active.prompt
    const question = prompt.questions[prompt.current]
    if (!question) return
    const draft = prompt.drafts.get(question.id)
    if (!draft?.customMode) return
    draft.custom += text
    this.notify()
  }

  backspaceCustom(): void {
    const active = this.question
    if (!active) return
    const prompt = active.prompt
    const question = prompt.questions[prompt.current]
    if (!question) return
    const draft = prompt.drafts.get(question.id)
    if (!draft?.customMode) return
    draft.custom = [...draft.custom].slice(0, -1).join('')
    this.notify()
  }

  /** Enter: advance question or submit the batch on the last one. */
  advanceQuestion(): void {
    const active = this.question
    if (!active) return
    const prompt = active.prompt
    if (prompt.current < prompt.questions.length - 1) {
      active.prompt = { ...prompt, current: prompt.current + 1, focusedOption: 0 }
      this.notify()
      return
    }
    this.submitQuestions()
  }

  submitQuestions(): void {
    const active = this.question
    if (!active) return
    this.question = undefined
    const answers = active.prompt.questions.map((question) => {
      const draft = active.prompt.drafts.get(question.id)
      const selected = draft ? [...draft.selected] : []
      const custom = draft?.custom.trim() ?? ''
      if (question.multiSelect) {
        return { id: question.id, selected, ...(custom !== '' ? { custom } : {}) }
      }
      if (custom !== '') return { id: question.id, selected: [], custom }
      return { id: question.id, selected }
    })
    active.waiter.resolve({ answers })
    this.notify()
  }

  /** Escape closes the current overlay; approvals settle as cancelled. */
  escape(): boolean {
    if (this.approval) {
      this.resolveApproval('cancelled')
      return true
    }
    if (this.question) {
      this.submitQuestions()
      return true
    }
    return false
  }

  /** Test hook: enqueue a synthetic prompt without the event bus. */
  async simulateApproval(toolName: string): Promise<ApprovalOutcome> {
    return this.askApproval({ toolName })
  }

  async simulateQuestion(questions: AskUserQuestionItem[]): Promise<AskUserQuestionAnswer> {
    return this.askQuestions({ questions })
  }

  get pendingCount(): number {
    return (this.approval ? 1 : 0) + (this.question ? 1 : 0)
  }
}
