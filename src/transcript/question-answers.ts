/**
 * `ask_user_question` 的显示投影（ADR-20261103-question-answer-visible-in-transcript）：
 * 官方结果是一段 JSON 文本；这里把 args 的题目和 result 的答案按 id 配对，
 * 得到正文可直接渲染的「问题 → 答案」行。解析失败返回 undefined，调用方
 * 退回现有工具行，不抛错。
 */

export interface QuestionAnswerLine {
  readonly question: string
  readonly answer: string
  /** 该题没有任何选择或自定义答案。 */
  readonly skipped: boolean
}

export type QuestionOutcome = 'answered' | 'skipped' | 'cancelled' | 'pending'

export interface QuestionProjection {
  readonly answers: readonly QuestionAnswerLine[]
  readonly outcome: QuestionOutcome
}

interface QuestionArg {
  readonly id: string
  readonly question: string
}

interface AnswerValue {
  readonly id: string
  readonly selected: readonly string[]
  readonly custom?: string
}

const ABORTED = /aborted before the user answered|ASK_ABORTED/iu

/** 从 args / result 原始文本投影问卷记录；不可识别时返回 undefined。 */
export function projectQuestionResult(
  argsText: string,
  resultText: string,
  isError: boolean,
): QuestionProjection | undefined {
  if (isError && ABORTED.test(resultText)) {
    return { answers: [], outcome: 'cancelled' }
  }
  const result = parseObject(resultText)
  if (result === undefined) return undefined
  if (result.pending === true || result.status === 'pending') {
    return { answers: [], outcome: 'pending' }
  }
  const questions = parseQuestions(argsText)
  if (questions === undefined) return undefined
  const rawAnswers = result.answers
  if (!Array.isArray(rawAnswers)) return undefined
  const answers = rawAnswers.filter(isAnswer)
  const byId = new Map(answers.map((answer) => [answer.id, answer]))
  const lines = questions.map((question) => {
    const answer = byId.get(question.id)
    const selected = answer?.selected ?? []
    const custom = answer?.custom ?? ''
    const text = [...selected, ...(custom !== '' ? [custom] : [])].join('、')
    // 没有对应答案项 ≠ 用户跳过：前者是 `（未回答）`，后者是 `（已跳过）`。
    const empty = answer === undefined ? '（未回答）' : '（已跳过）'
    return {
      question: question.question,
      answer: text === '' ? empty : text,
      skipped: text === '',
    }
  })
  const outcome: QuestionOutcome = lines.some((line) => !line.skipped) ? 'answered' : 'skipped'
  return { answers: lines, outcome }
}

function parseObject(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text)
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

function parseQuestions(text: string): QuestionArg[] | undefined {
  const value = parseObject(text)
  const raw = value?.questions
  if (!Array.isArray(raw)) return undefined
  const questions: QuestionArg[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) return undefined
    const entry = item as Record<string, unknown>
    if (typeof entry.id !== 'string' || typeof entry.question !== 'string') return undefined
    questions.push({ id: entry.id, question: entry.question })
  }
  return questions
}

function isAnswer(value: unknown): value is AnswerValue {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Record<string, unknown>
  return (
    typeof entry.id === 'string' &&
    Array.isArray(entry.selected) &&
    entry.selected.every((item) => typeof item === 'string') &&
    (entry.custom === undefined || typeof entry.custom === 'string')
  )
}
