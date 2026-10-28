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
