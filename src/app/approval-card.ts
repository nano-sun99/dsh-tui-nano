/**
 * Approval card rows for the transcript (spec 2026-11-01-nano-approval-card-in-transcript).
 *
 * The card is appended after the last transcript line, so it shares the
 * transcript's scrolling, paging and pressable rows. It never uses an overlay.
 */
import {
  APPROVAL_OPTIONS,
  type ApprovalOutcome,
  type ApprovalPrompt,
  approvalDecisionText,
} from '../decisions/manager.ts'
import { truncateText } from '../render/text.ts'
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

/** Command block source (spec §3.3): `args.command` first, then one-line key: value. */
export function approvalCommandFromArgs(
  args: Record<string, unknown> | undefined,
): string | undefined {
  if (args === undefined) return undefined
  const command = args.command
  if (typeof command === 'string' && command.trim() !== '') return command
  const lines: string[] = []
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined) continue
    const text = `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`
    lines.push(truncateText(text.split('\n')[0] ?? '', 120))
  }
  return lines.length > 0 ? lines.join('\n') : undefined
}

/** Record an approval outcome on the transcript; unknown calls fall back to a notice. */
export function applyApprovalSettlement(
  model: {
    markApprovalDecision(callId: string, outcome: ApprovalOutcome): boolean
    appendNotice(text: string, tone: 'info'): void
  },
  prompt: { readonly callId?: string },
  outcome: ApprovalOutcome,
): boolean {
  const text = approvalDecisionText(outcome)
  if (text === undefined) return false
  if (prompt.callId !== undefined && model.markApprovalDecision(prompt.callId, outcome)) return true
  model.appendNotice(text, 'info')
  return false
}

/** Scroll offset that keeps `focus` inside the viewport (same math as the card renderer). */
export function focusScrollOffset(
  total: number,
  height: number,
  offset: number,
  focus: number,
): number {
  const maxScroll = Math.max(0, total - height)
  const start = Math.max(0, total - height - offset)
  if (focus < start) return Math.min(maxScroll, offset + start - focus)
  if (focus >= start + height) return Math.max(0, offset - (focus - (start + height - 1)))
  return offset
}
