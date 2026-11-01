/** Question-card layout shared by rendering, height budgeting and paging. */
import type { QuestionPrompt } from '../decisions/manager.ts'
import { displayWidth, truncateText } from '../render/text.ts'
import { renderMarkdown } from '../transcript/markdown.ts'
import { type Row, rowText, type Span, textSpan, wrapSpans } from '../transcript/spans.ts'

export interface QuestionCardParts {
  readonly tabs: readonly Row[]
  readonly header: readonly Row[]
  readonly body: readonly Row[]
  readonly footer: readonly Row[]
  readonly focusBodyRow: number
}

const blank = (): Row => ({ spans: [textSpan(' ')] })
const line = (text: string, tone: Span['tone'] = 'normal', bold = false): Row => ({
  spans: [textSpan(text, tone, { bold })],
})

function prefixed(prefix: Span[], content: Span[], width: number): Row[] {
  const indent = prefix.reduce((sum, span) => sum + displayWidth(span.text), 0)
  return wrapSpans(content, Math.max(1, width - indent)).map((row, index) => ({
    spans: [...(index === 0 ? prefix : [textSpan(' '.repeat(indent))]), ...row.spans],
  }))
}

function tabs(prompt: QuestionPrompt, width: number): Row[] {
  if (prompt.questions.length <= 1) return []
  const labels = prompt.questions.map((question, index) => question.header ?? `Q${index + 1}`)
  const overhead = labels.length * 4 + 4 + labels.length * 2
  let budgets = labels.map(displayWidth)
  if (overhead + budgets.reduce((a, b) => a + b, 0) > width) {
    budgets = budgets.map(() => 6)
    let remaining = width - overhead - budgets.reduce((a, b) => a + b, 0)
    const order = [
      prompt.current,
      ...labels.map((_, index) => index).filter((index) => index !== prompt.current),
    ]
    for (const index of order) {
      if (index >= labels.length) continue
      const extra = Math.min(Math.max(0, displayWidth(labels[index]!) - 6), Math.max(0, remaining))
      budgets[index]! += extra
      remaining -= extra
    }
  }
  let indexes = labels.map((_, index) => index)
  if (overhead + budgets.reduce((a, b) => a + b, 0) > width) {
    indexes = prompt.current < labels.length ? [prompt.current] : []
    if (indexes[0] !== undefined) budgets[indexes[0]] = Math.max(1, width - 10)
  }
  const rows = indexes.map((index) => {
    const question = prompt.questions[index]!
    const draft = prompt.drafts.get(question.id)
    const done = Boolean(draft && (draft.skipped || draft.selected.size || draft.custom.trim()))
    const active = prompt.current === index
    const label = truncateText(labels[index]!, budgets[index]!)
    return {
      spans: [
        textSpan(`${done ? '[x]' : '[ ]'} ${label}`, active ? 'accent' : 'muted', { bold: active }),
      ],
      pressId: `decision:tab:${index}`,
    }
  })
  rows.push({
    spans: [
      textSpan('提交', prompt.current === labels.length ? 'accent' : 'muted', {
        bold: prompt.current === labels.length,
      }),
    ],
    pressId: `decision:tab:${labels.length}`,
  })
  return rows
}

function titleRows(prompt: QuestionPrompt, width: number): Row[] {
  if (prompt.current >= prompt.questions.length) {
    const missing = prompt.questions.filter((question) => {
      const draft = prompt.drafts.get(question.id)
      return !draft || (!draft.skipped && !draft.selected.size && !draft.custom.trim())
    }).length
    return wrapSpans(
      [
        textSpan('提交这组答案', 'normal', { bold: true }),
        ...(missing ? [textSpan(`  还差 ${missing} 题`, 'warning')] : []),
      ],
      width,
    )
  }
  const question = prompt.questions[prompt.current]
  if (!question) return []
  const plan = question.intent?.kind === 'plan-review'
  const rows = wrapSpans(
    [
      textSpan(plan ? (question.header ?? '计划审阅') : question.question, 'normal', {
        bold: true,
      }),
    ],
    width,
  )
  if (plan) rows.push(...wrapSpans([textSpan(question.question)], width))
  if (question.detail?.trim()) {
    const detail = renderMarkdown(question.detail, width)
    rows.push(...detail.slice(0, 14))
    if (detail.length > 14) rows.push(line(`还有 ${detail.length - 14} 行`, 'muted'))
  }
  return rows
}

function optionRows(prompt: QuestionPrompt, width: number): { rows: Row[]; focus: number } {
  const question = prompt.questions[prompt.current]
  if (!question) return { rows: [], focus: -1 }
  const draft = prompt.drafts.get(question.id)
  const rows: Row[] = []
  let focus = -1
  const options = question.options ?? []
  options.forEach((option, index) => {
    const focused = prompt.focusedOption === index
    const selected = draft?.selected.has(option.label) ?? false
    const tone = focused ? 'accent' : selected ? 'success' : 'normal'
    if (focused) focus = rows.length
    const prefix = [
      textSpan(`${focused ? '>' : ' '} ${index + 1}. `, tone, { bold: focused || selected }),
    ]
    if (question.multiSelect)
      prefix.push(textSpan(selected ? '[x] ' : '[ ] ', tone, { bold: focused || selected }))
    const spans = [textSpan(option.label, tone, { bold: focused || selected })]
    if (question.intent?.kind === 'plan-review' && question.intent.approve === option.label)
      spans.push(textSpan(' (批准)', tone, { bold: focused || selected }))
    if (!question.multiSelect && selected) spans.push(textSpan(' ✓', 'success', { bold: true }))
    rows.push(
      ...prefixed(prefix, spans, width).map((row) => ({
        ...row,
        pressId: `decision:option:${index}`,
      })),
    )
    if (option.description?.trim()) {
      rows.push(
        ...prefixed([textSpan('     ')], [textSpan(option.description, 'muted')], width).map(
          (row) => ({ ...row, pressId: `decision:option:${index}` }),
        ),
      )
    }
  })
  const focused = prompt.focusedOption === options.length
  const custom = draft?.custom ?? ''
  const tone = focused ? 'accent' : custom.trim() ? 'success' : 'muted'
  const prefix = [
    textSpan(`${focused ? '>' : ' '} ${options.length + 1}. 其他：`, tone, {
      bold: focused || Boolean(custom.trim()),
    }),
  ]
  const customRows = prefixed(
    prefix,
    [
      textSpan(custom || (focused ? '' : '直接输入'), tone, { bold: focused }),
      ...(focused ? [textSpan('▏', 'accent', { caret: true })] : []),
    ],
    width,
  )
  if (focused) focus = rows.length + customRows.length - 1
  rows.push(...customRows.map((row) => ({ ...row, pressId: 'decision:custom' })))
  return { rows, focus }
}

function reviewRows(prompt: QuestionPrompt, width: number): Row[] {
  return prompt.questions.flatMap((question, index) => {
    const draft = prompt.drafts.get(question.id)
    const done = Boolean(draft && (draft.skipped || draft.selected.size || draft.custom.trim()))
    const answer = draft?.skipped
      ? '已跳过'
      : [...(draft?.selected ?? []), draft?.custom.trim() ?? ''].filter(Boolean).join('、')
    return [
      ...wrapSpans(
        [
          textSpan(
            `${done ? '[x]' : '[ ]'} ${question.header ?? `Q${index + 1}`}`,
            done ? 'normal' : 'danger',
          ),
        ],
        width,
      ).map((row) => ({ ...row, pressId: `decision:tab:${index}` })),
      ...prefixed(
        [textSpan('    ')],
        [textSpan(done ? answer : '尚未回答', done ? 'muted' : 'danger')],
        width,
      ),
    ]
  })
}

function footerText(prompt: QuestionPrompt): string {
  if (prompt.current >= prompt.questions.length) return 'Enter 提交 · Tab / ←→ 回看 · Esc 取消'
  const text = prompt.questions[prompt.current]?.multiSelect
    ? '↑↓ 移动 · 空格勾选 · Enter 确认'
    : '↑↓ 移动 · Enter 选择 · 数字直选'
  return `${text}${prompt.questions.length > 1 ? ' · Tab 切题' : ''} · Esc 取消`
}

export function buildQuestionCard(
  prompt: QuestionPrompt,
  width: number,
  cap = 20,
): QuestionCardParts {
  const navigation = tabs(prompt, width)
  const atSubmit = prompt.current >= prompt.questions.length
  const title = titleRows(prompt, width)
  const options = atSubmit
    ? { rows: reviewRows(prompt, width), focus: -1 }
    : optionRows(prompt, width)
  const body = options.rows
  const footer: Row[] = []
  if (atSubmit || prompt.questions[prompt.current]?.multiSelect) {
    footer.push({
      ...line(
        `     ${atSubmit ? '提交答案' : prompt.questions.length === 1 ? '确认已选项' : '下一题'}`,
        'accent',
      ),
      pressId: 'decision:confirm',
    })
  }
  footer.push(blank())
  if (prompt.error) footer.push(line(truncateText(prompt.error, width), 'danger'))
  footer.push(line(truncateText(footerText(prompt), width), 'muted'))
  const titleBudget = Math.max(1, cap - 2 - (navigation.length ? 2 : 0) - footer.length - 1)
  const header =
    title.length <= titleBudget
      ? title
      : titleBudget === 1
        ? title.slice(0, 1)
        : [
            ...title.slice(0, titleBudget - 1),
            line(`还有 ${title.length - titleBudget + 1} 行`, 'muted'),
          ]
  return { tabs: navigation, header, body, footer, focusBodyRow: options.focus }
}

export function questionCardCap(height: number): number {
  return Math.max(1, Math.min(20, height - 12))
}

/** Top rule and its blank line are included in the same height budget. */
export function questionCardWindow(
  parts: QuestionCardParts,
  cap: number,
  offset: number,
  followFocus = true,
) {
  const fixed = 2 + (parts.tabs.length ? 2 : 0) + parts.header.length + parts.footer.length
  const room = Math.max(1, cap - fixed)
  const maxStart = Math.max(0, parts.body.length - room)
  let start = Math.max(0, Math.min(offset, maxStart))
  if (followFocus && parts.focusBodyRow >= 0) {
    if (parts.focusBodyRow < start) start = parts.focusBodyRow
    else if (parts.focusBodyRow >= start + room)
      start = Math.min(parts.focusBodyRow - room + 1, maxStart)
  }
  return {
    start,
    room,
    maxStart,
    body: parts.body.slice(start, start + room),
    total: fixed + Math.min(parts.body.length, room),
  }
}

export function cardRowTotal(parts: QuestionCardParts): number {
  return (
    2 + (parts.tabs.length ? 2 : 0) + parts.header.length + parts.body.length + parts.footer.length
  )
}

export function questionTabWidth(row: Row): number {
  return displayWidth(rowText(row))
}
