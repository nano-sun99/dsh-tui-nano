/**
 * Styled-row primitives shared by Markdown, diffs and tool cards. Wrapping is
 * span-aware so inline emphasis never splits a grapheme or loses its style.
 */
import { graphemes, graphemeWidth, isWideBreakable } from '../render/text.ts'

export type Tone =
  | 'normal'
  | 'muted'
  | 'faint'
  | 'user'
  | 'assistant'
  | 'success'
  | 'warning'
  | 'danger'
  | 'info'
  | 'accent'
  | 'tool'
  | 'code'
  | 'diffAdd'
  | 'diffDel'

export interface Span {
  readonly text: string
  readonly tone: Tone
  readonly bold?: boolean
  readonly italic?: boolean
  readonly underline?: boolean
  readonly strike?: boolean
  readonly reverse?: boolean
}

export interface Row {
  readonly spans: readonly Span[]
  readonly indent?: number
  readonly pressId?: string
}

export function textSpan(text: string, tone: Tone = 'normal', extra: Partial<Span> = {}): Span {
  return { text, tone, ...extra }
}

export function rowText(row: Row): string {
  return row.spans.map((span) => span.text).join('')
}

export function plainRows(lines: readonly string[], tone: Tone = 'normal'): Row[] {
  return lines.map((line) => ({ spans: [textSpan(line, tone)] }))
}

export function rowsFromLines(lines: readonly string[], tone: Tone): Row[] {
  return lines.map((line) => ({ spans: [textSpan(line, tone)] }))
}

interface StyledGrapheme {
  readonly g: string
  readonly span: Span
}

/**
 * Word-aware, span-preserving wrap. Break opportunities are spaces and
 * boundaries around wide (CJK/emoji) graphemes; overlong words hard-break.
 */
export function wrapSpans(spans: readonly Span[], width: number): Row[] {
  const maxWidth = Math.max(1, Math.floor(width))
  const stream: StyledGrapheme[] = []
  for (const span of spans) {
    const parts = span.text.split('\n')
    parts.forEach((part, index) => {
      if (index > 0) stream.push({ g: '\n', span })
      for (const g of graphemes(part)) stream.push({ g, span })
    })
  }
  const rows: Row[] = []
  let line: StyledGrapheme[] = []
  let lineWidth = 0
  let breakIndex = -1

  const emit = () => {
    rows.push({ spans: toSpans(trimTrailing(line)) })
    line = []
    lineWidth = 0
    breakIndex = -1
  }

  for (const item of stream) {
    if (item.g === '\n') {
      emit()
      continue
    }
    const gw = graphemeWidth(item.g)
    if (gw === 0) {
      line.push(item)
      continue
    }
    if (lineWidth + gw > maxWidth && line.length > 0) {
      if (item.g === ' ') {
        emit()
        continue
      }
      if (breakIndex > 0 && breakIndex < line.length) {
        const carried = line.slice(breakIndex)
        const head = line.slice(0, breakIndex)
        rows.push({ spans: toSpans(trimTrailing(head)) })
        line = trimLeading(carried)
        lineWidth = line.reduce((sum, entry) => sum + graphemeWidth(entry.g), 0)
        breakIndex = -1
      } else {
        emit()
      }
      if (item.g === ' ') {
        continue
      }
    }
    line.push(item)
    lineWidth += gw
    if (isWideBreakable(item.g)) breakIndex = line.length
    else if (item.g === ' ') breakIndex = line.length
  }
  if (line.length > 0 || rows.length === 0) rows.push({ spans: toSpans(trimTrailing(line)) })
  return rows
}

function toSpans(line: readonly StyledGrapheme[]): Span[] {
  const spans: Span[] = []
  for (const entry of line) {
    const last = spans[spans.length - 1]
    if (
      last &&
      last.tone === entry.span.tone &&
      last.bold === entry.span.bold &&
      last.italic === entry.span.italic &&
      last.underline === entry.span.underline &&
      last.strike === entry.span.strike &&
      last.reverse === entry.span.reverse
    ) {
      spans[spans.length - 1] = { ...last, text: last.text + entry.g }
    } else {
      spans.push({
        text: entry.g,
        tone: entry.span.tone,
        ...(entry.span.bold ? { bold: true } : {}),
        ...(entry.span.italic ? { italic: true } : {}),
        ...(entry.span.underline ? { underline: true } : {}),
        ...(entry.span.strike ? { strike: true } : {}),
        ...(entry.span.reverse ? { reverse: true } : {}),
      })
    }
  }
  return spans
}

function trimTrailing(line: readonly StyledGrapheme[]): StyledGrapheme[] {
  let end = line.length
  while (end > 0) {
    const item = line[end - 1] as StyledGrapheme
    if (item.g === ' ' && item.span.tone !== 'diffDel') end--
    else break
  }
  return line.slice(0, end)
}

function trimLeading(line: readonly StyledGrapheme[]): StyledGrapheme[] {
  let start = 0
  while (start < line.length && (line[start] as StyledGrapheme).g === ' ') start++
  return line.slice(start)
}
