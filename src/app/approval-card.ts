/**
 * Approval card rows for the transcript (spec 2026-11-01-nano-approval-card-in-transcript).
 *
 * The card is appended after the last transcript line, so it shares the
 * transcript's scrolling, paging and pressable rows. It never uses an overlay.
 */
import { APPROVAL_OPTIONS, type ApprovalPrompt } from '../decisions/manager.ts'
import { EDGE, NESTED } from '../theme/spacing.ts'
import { type Row, textSpan, wrapSpans } from '../transcript/spans.ts'

export interface ApprovalCardParts {
  readonly rows: readonly Row[]
  /** Index into `rows` of the focused option's first row (-1 when impossible). */
  readonly focusRow: number
}

const DESCRIPTION_INDENT = NESTED + 1
const COMMAND_LINES = 8

const blank = (): Row => ({ spans: [textSpan(' ')], indent: EDGE })

function indent(rows: Row[], amount = EDGE): Row[] {
  return rows.map((row) => ({ ...row, indent: amount }))
}

function title(prompt: ApprovalPrompt): string {
  return prompt.toolName.toLowerCase() === 'bash'
    ? '是否运行这条检查命令？'
    : `是否允许 ${prompt.toolName} 执行？`
}

function commandRows(command: string, width: number): Row[] {
  const wrapped: Row[] = []
  for (const line of command.split('\n')) {
    wrapped.push(...wrapSpans([textSpan(line, 'muted')], width))
  }
  const visible = wrapped.slice(0, COMMAND_LINES)
  const hidden = wrapped.length - visible.length
  if (hidden > 0) {
    visible.push({ spans: [textSpan(`…还有 ${hidden} 行`, 'muted')] })
  }
  return indent(visible)
}

/** `command` comes from the tool entry's args; undefined renders no block. */
export function buildApprovalCard(
  prompt: ApprovalPrompt,
  command: string | undefined,
  width: number,
): ApprovalCardParts {
  const contentWidth = Math.max(1, width - EDGE)
  const rows: Row[] = []
  rows.push({ spans: [textSpan('─'.repeat(contentWidth), 'accent')], indent: EDGE })
  rows.push(...indent(wrapSpans([textSpan(title(prompt), 'normal', { bold: true })], contentWidth)))
  if (prompt.reason?.trim()) {
    rows.push(blank())
    rows.push(...indent(wrapSpans([textSpan(prompt.reason.trim(), 'muted')], contentWidth)))
  }
  if (command !== undefined && command.trim() !== '') {
    rows.push(blank())
    rows.push(...commandRows(command, contentWidth))
  }
  rows.push(blank())
  let focusRow = -1
  APPROVAL_OPTIONS.forEach((option, index) => {
    const focused = index === prompt.selected
    if (focused) focusRow = rows.length
    const label = [
      textSpan(focused ? '>' : ' ', focused ? 'accent' : 'muted'),
      textSpan(' '),
      textSpan(`${index + 1}.`, 'muted'),
      textSpan(' '),
      textSpan(option.label, focused ? 'accent' : 'normal', { bold: focused }),
    ]
    const pressId = `decision:approval:${index}`
    rows.push(...indent(wrapSpans(label, contentWidth)).map((row) => ({ ...row, pressId })))
    if (option.description !== undefined) {
      rows.push(
        ...wrapSpans(
          [textSpan(option.description, 'muted')],
          contentWidth - DESCRIPTION_INDENT,
        ).map((row) => ({ ...row, indent: EDGE + DESCRIPTION_INDENT, pressId })),
      )
    }
  })
  rows.push(blank())
  rows.push(
    ...indent(
      wrapSpans(
        [textSpan('↑↓ 移动 · Enter 确认 · 1–4 直选 · Esc 取消请求', 'faint')],
        contentWidth,
      ),
    ),
  )
  return { rows, focusRow }
}
