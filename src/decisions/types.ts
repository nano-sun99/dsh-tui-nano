/** Client-safe shapes for the two decision seams (approval + user questions). */

export interface AskUserQuestionOption {
  readonly label: string
  readonly description?: string
}

export interface AskUserQuestionIntent {
  readonly kind: 'plan-review'
  readonly approve: string
  readonly callId?: string
}

export interface AskUserQuestionItem {
  readonly id: string
  readonly question: string
  readonly detail?: string
  readonly header?: string
  readonly options?: readonly AskUserQuestionOption[]
  readonly multiSelect?: boolean
  readonly intent?: AskUserQuestionIntent
}

export interface AskUserQuestionAnswerItem {
  readonly id: string
  readonly selected: string[]
  readonly custom?: string
}

export interface AskUserQuestionAnswer {
  readonly answers: AskUserQuestionAnswerItem[]
}

export interface QuestionDraft {
  readonly selected: Set<string>
  custom: string
  customMode: boolean
  skipped: boolean
  focusedOption: number
}

export interface QuestionPrompt {
  readonly kind: 'question'
  readonly address: string
  readonly questions: readonly AskUserQuestionItem[]
  /** questions.length denotes the batch review/submit page. */
  readonly current: number
  /** options.length denotes the custom-answer row. */
  readonly focusedOption: number
  readonly drafts: Map<string, QuestionDraft>
  readonly scrollOffset: number
  /** Explicit paging pins the current focus while scrolling the surrounding text. */
  readonly manualScroll?: boolean
  readonly error?: string
  readonly planReview: boolean
}
