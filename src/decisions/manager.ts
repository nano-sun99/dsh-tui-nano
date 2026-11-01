/**
 * Approval and user-question seams (spec §4): two independent answerers, each
 * registered exactly once. Approvals fail closed with the reject option
 * focused; questions follow the design-draft card model (spec
 * `2026-11-01-nano-question-card-parity`): numbered options, a separate focus
 * pointer, an always-present "其他" row, per-question review and a submit page
 * that refuses incomplete batches.
 */
import { graphemes } from '../render/text.ts'
import type {
  AskUserQuestionAnswer,
  AskUserQuestionItem,
  QuestionDraft,
  QuestionPrompt,
} from './types.ts'

export type { QuestionDraft, QuestionPrompt } from './types.ts'

export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

export const APPROVAL_OPTIONS: ReadonlyArray<{ outcome: ApprovalOutcome; label: string }> = [
  { outcome: 'allowed-once', label: '允许一次' },
  { outcome: 'rejected', label: '拒绝' },
  { outcome: 'cancelled', label: '取消请求' },
  { outcome: 'unavailable', label: '无法回答（按失败关闭处理）' },
]

export const QUESTION_ERRORS = {
  emptySelection: '请至少选择一项。',
  emptyCustom: '请填写其他答案，或选择一个选项。',
  unanswered: '请先回答这一题。',
} as const

/** Answerer-side abort: the official service restores this shape into `UserQuestionError`. */
export function questionAbortedError(): Error {
  const error = new Error('ask_user_question was aborted before the user answered')
  error.name = 'UserQuestionError'
  Object.assign(error, { code: 'ASK_ABORTED' })
  return error
}

export interface ApprovalPrompt {
  readonly kind: 'approval'
  /** Owning agent session, so S02 can keep per-address approvals apart. */
  readonly address: string
  readonly toolName: string
  readonly reason?: string
  readonly callId?: string
  readonly selected: number
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
    | { prompt: QuestionPrompt; waiter: QuestionWaiter; cleanup: () => void }
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
        drafts.set(question.id, {
          selected: new Set<string>(),
          custom: '',
          customMode: false,
          skipped: false,
          focusedOption: 0,
        })
      }
      const planReview = questions.some((question) => question.intent?.kind === 'plan-review')
      const prompt: QuestionPrompt = {
        kind: 'question',
        address: String(request.agent?.session?.id ?? 'root'),
        questions,
        current: 0,
        focusedOption: 0,
        drafts,
        scrollOffset: 0,
        planReview,
      }
      const signal: AbortSignal | undefined = request.signal
      if (signal?.aborted) {
        reject(questionAbortedError())
        return
      }
      const abort = () => {
        if (this.question?.waiter.resolve === resolve) this.cancelQuestions()
        else {
          signal?.removeEventListener('abort', abort)
          reject(questionAbortedError())
        }
      }
      signal?.addEventListener('abort', abort, { once: true })
      this.question = {
        prompt,
        waiter: { resolve, reject },
        cleanup: () => signal?.removeEventListener('abort', abort),
      }
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
    const active = this.question
    if (!active) return
    const prompt = active.prompt
    const question = prompt.questions[prompt.current]
    if (!question) return
    const optionCount = question.options?.length ?? 0
    const focusable = optionCount + 1
    const next = (prompt.focusedOption + delta + focusable) % focusable
    this.setFocus(next)
  }

  focusCustom(): void {
    const found = this.currentQuestion()
    if (found) this.setFocus(found.question.options?.length ?? 0)
  }

  nextQuestion(): void {
    this.navigateQuestions(1)
  }
  prevQuestion(): void {
    this.navigateQuestions(-1)
  }
  selectOption(index: number): void {
    this.selectIndex(index)
  }

  private setFocus(focusedOption: number): void {
    const active = this.question
    if (!active) return
    const prompt = active.prompt
    const question = prompt.questions[prompt.current]
    if (!question) return
    const optionCount = question.options?.length ?? 0
    const draft = prompt.drafts.get(question.id)
    if (draft) {
      draft.customMode = focusedOption === optionCount
      draft.focusedOption = focusedOption
    }
    active.prompt = { ...prompt, focusedOption, scrollOffset: 0, ...clearError(prompt) }
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

  private currentQuestion(): { question: AskUserQuestionItem; draft: QuestionDraft } | undefined {
    const active = this.question
    if (!active) return undefined
    const prompt = active.prompt
    const question = prompt.questions[prompt.current]
    if (!question) return undefined
    const draft = prompt.drafts.get(question.id)
    if (!draft) return undefined
    return { question, draft }
  }

  /** Number key / click: select (single) or toggle (multi) at an index. */
  selectIndex(index: number): void {
    const active = this.question
    if (!active) return
    const prompt = active.prompt
    const found = this.currentQuestion()
    if (!found) return
    const { question, draft } = found
    const optionCount = question.options?.length ?? 0
    if (!Number.isInteger(index) || index < 0 || index > optionCount) return
    draft.focusedOption = index
    if (index === optionCount) {
      draft.customMode = true
      active.prompt = {
        ...prompt,
        focusedOption: optionCount,
        scrollOffset: 0,
        ...clearError(prompt),
      }
      this.notify()
      return
    }
    const option = question.options?.[index]
    if (!option) return
    draft.skipped = false
    active.prompt = { ...prompt, focusedOption: index, scrollOffset: 0, ...clearError(prompt) }
    if (question.multiSelect) {
      if (draft.selected.has(option.label)) draft.selected.delete(option.label)
      else draft.selected.add(option.label)
      draft.customMode = false
      this.notify()
      return
    }
    draft.selected.clear()
    draft.selected.add(option.label)
    draft.custom = ''
    draft.skipped = false
    draft.customMode = false
    this.notify()
    this.advanceQuestion()
  }

  /** Enter / Space on the focused row. */
  confirmFocused(): void {
    const active = this.question
    if (!active) return
    const prompt = active.prompt
    if (prompt.current >= prompt.questions.length) {
      this.submitQuestions()
      return
    }
    const found = this.currentQuestion()
    if (!found) return
    const { question, draft } = found
    const optionCount = question.options?.length ?? 0
    if (prompt.focusedOption >= optionCount) {
      this.commitCustom()
      return
    }
    if (question.multiSelect) {
      if (draft.selected.size === 0 && draft.custom.trim() === '') {
        this.validationError(QUESTION_ERRORS.emptySelection)
        return
      }
      this.advanceQuestion()
      return
    }
    this.selectIndex(prompt.focusedOption)
  }

  /** Confirm the "其他" row. */
  private commitCustom(): void {
    const found = this.currentQuestion()
    if (!found) return
    const { question, draft } = found
    const text = draft.custom.trim()
    if (text === '') {
      if (question.multiSelect && draft.selected.size > 0) {
        this.advanceQuestion()
        return
      }
      this.validationError(QUESTION_ERRORS.emptyCustom)
      return
    }
    draft.custom = text
    draft.skipped = false
    if (!question.multiSelect) draft.selected.clear()
    this.advanceQuestion()
  }

  /** Jump to a question page; `index === questions.length` is the submit page. */
  focusQuestion(index: number): void {
    const active = this.question
    if (!active) return
    const prompt = active.prompt
    const count = prompt.questions.length
    if (count <= 1) return
    const next = Math.max(0, Math.min(count, index))
    const question = prompt.questions[next]
    const draft = question ? prompt.drafts.get(question.id) : undefined
    active.prompt = {
      ...prompt,
      current: next,
      focusedOption: draft?.focusedOption ?? 0,
      scrollOffset: 0,
      ...clearError(prompt),
    }
    this.notify()
  }

  /** Tab / ←→ between questions and the submit page. */
  navigateQuestions(delta: number): void {
    const active = this.question
    if (!active) return
    const prompt = active.prompt
    const count = prompt.questions.length
    if (count <= 1) return
    const slots = count + 1
    const next = (prompt.current + delta + slots) % slots
    this.focusQuestion(next)
  }

  toggleOption(): void {
    const found = this.currentQuestion()
    const active = this.question
    if (!found || !active) return
    const { question, draft } = found
    const prompt = active.prompt
    const optionCount = question.options?.length ?? 0
    if (prompt.focusedOption >= optionCount) return
    const option = question.options?.[prompt.focusedOption]
    if (!option) return
    draft.skipped = false
    active.prompt = { ...prompt, ...clearError(prompt) }
    if (question.multiSelect) {
      if (draft.selected.has(option.label)) draft.selected.delete(option.label)
      else draft.selected.add(option.label)
      this.notify()
      return
    }
    draft.selected.clear()
    draft.selected.add(option.label)
    draft.custom = ''
    this.notify()
  }

  toggleCustom(): void {
    const active = this.question
    if (!active) return
    const prompt = active.prompt
    const found = this.currentQuestion()
    if (!found) return
    const optionCount = found.question.options?.length ?? 0
    this.setFocus(prompt.focusedOption === optionCount ? 0 : optionCount)
  }

  typeCustom(text: string): void {
    const found = this.currentQuestion()
    if (!found?.draft.customMode) return
    found.draft.custom += text
    if (!found.question.multiSelect && found.draft.custom.trim()) found.draft.selected.clear()
    found.draft.skipped = false
    if (this.question)
      this.question.prompt = { ...this.question.prompt, ...clearError(this.question.prompt) }
    this.notify()
  }

  backspaceCustom(): void {
    const found = this.currentQuestion()
    if (!found?.draft.customMode) return
    found.draft.custom = graphemes(found.draft.custom).slice(0, -1).join('')
    found.draft.skipped = false
    if (this.question)
      this.question.prompt = { ...this.question.prompt, ...clearError(this.question.prompt) }
    this.notify()
  }

  setScrollOffset(offset: number): void {
    const active = this.question
    if (!active) return
    active.prompt = { ...active.prompt, scrollOffset: Math.max(0, offset), manualScroll: true }
    this.notify()
  }

  scrollCard(delta: number): void {
    if (this.question) this.setScrollOffset(this.question.prompt.scrollOffset + delta)
  }

  /** Mark the current question as deliberately skipped and move on. */
  skipQuestion(): void {
    const active = this.question
    if (!active) return
    const prompt = active.prompt
    if (prompt.current >= prompt.questions.length) return
    const found = this.currentQuestion()
    if (!found) return
    found.draft.skipped = true
    found.draft.selected.clear()
    found.draft.custom = ''
    this.advanceQuestion()
  }

  /** Enter: next question, the submit page, or finish a single-question card. */
  advanceQuestion(): void {
    const active = this.question
    if (!active) return
    const prompt = active.prompt
    if (prompt.current < prompt.questions.length - 1) {
      active.prompt = {
        ...prompt,
        current: prompt.current + 1,
        focusedOption:
          prompt.drafts.get(prompt.questions[prompt.current + 1]?.id ?? '')?.focusedOption ?? 0,
        scrollOffset: 0,
        ...clearError(prompt),
      }
      this.notify()
      return
    }
    if (prompt.questions.length > 1) {
      active.prompt = {
        ...prompt,
        current: prompt.questions.length,
        focusedOption: 0,
        scrollOffset: 0,
        ...clearError(prompt),
      }
      this.notify()
      return
    }
    this.submitQuestions()
  }

  private validationError(error: string): void {
    const active = this.question
    const found = this.currentQuestion()
    if (!active || !found) return
    found.draft.focusedOption = 0
    found.draft.customMode = false
    active.prompt = {
      ...active.prompt,
      focusedOption: 0,
      scrollOffset: 0,
      manualScroll: false,
      error,
    }
    this.notify()
  }

  private isValid(draft: QuestionDraft): boolean {
    if (draft.skipped) return true
    return draft.selected.size > 0 || draft.custom.trim() !== ''
  }

  submitQuestions(): void {
    const active = this.question
    if (!active) return
    const prompt = active.prompt
    const missing = prompt.questions.findIndex((question) => {
      const draft = prompt.drafts.get(question.id)
      return !draft || !this.isValid(draft)
    })
    if (missing >= 0) {
      const draft = prompt.drafts.get(prompt.questions[missing]?.id ?? '')
      if (draft) {
        draft.focusedOption = 0
        draft.customMode = false
      }
      active.prompt = {
        ...prompt,
        current: missing,
        focusedOption: 0,
        scrollOffset: 0,
        manualScroll: false,
        error: QUESTION_ERRORS.unanswered,
      }
      this.notify()
      return
    }
    this.question = undefined
    active.cleanup()
    const answers = prompt.questions.map((question) => {
      const draft = prompt.drafts.get(question.id)
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

  /** Escape closes the current overlay; questions end as `ASK_ABORTED`. */
  escape(): boolean {
    if (this.approval) {
      this.resolveApproval('cancelled')
      return true
    }
    if (this.question) {
      this.cancelQuestions()
      return true
    }
    return false
  }

  /** User cancelled: answerer rejects; no half-finished answer is sent. */
  cancelQuestions(): void {
    const active = this.question
    if (!active) return
    this.question = undefined
    active.cleanup()
    active.waiter.reject(questionAbortedError())
    this.notify()
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

function clearError(prompt: QuestionPrompt): { error?: string; manualScroll: false } {
  return { ...(prompt.error === undefined ? {} : { error: undefined }), manualScroll: false }
}
