/**
 * Markdown subset renderer: headings, paragraphs, lists, quotes, rules, code
 * fences and tables become styled rows. Inline emphasis keeps its style
 * through wrapping. Raw HTML is shown as plain text; nothing is interpreted.
 */
import { Lexer, type Token, type Tokens } from 'marked'
import Prism from 'prismjs'
import 'prismjs/components/prism-typescript.js'
import 'prismjs/components/prism-jsx.js'
import 'prismjs/components/prism-tsx.js'
import 'prismjs/components/prism-json.js'
import 'prismjs/components/prism-bash.js'
import 'prismjs/components/prism-python.js'
import 'prismjs/components/prism-rust.js'
import 'prismjs/components/prism-yaml.js'
import 'prismjs/components/prism-markdown.js'
import 'prismjs/components/prism-diff.js'
import { displayWidth, graphemes, graphemeWidth, isWideBreakable } from '../render/text.ts'
import { EDGE, GapRole, INDENT, INLINE, NESTED } from '../theme/spacing.ts'
import { type Row, rowText, type Span, textSpan, wrapSpans } from './spans.ts'

export interface MarkdownOptions {
  readonly indent?: number
}

export function renderMarkdown(text: string, width: number, options: MarkdownOptions = {}): Row[] {
  const indent = options.indent ?? 0
  const tokens = new Lexer({ gfm: true }).lex(text)
  const rows = renderBlocks(tokens, Math.max(1, width - indent))
  return trimBlankRows(rows).map((row) => ({ ...row, indent: (row.indent ?? 0) + indent }))
}

function renderBlocks(tokens: Token[], width: number): Row[] {
  const rows: Row[] = []
  for (const token of tokens) {
    switch (token.type) {
      case 'space':
        rows.push(blank())
        break
      case 'heading': {
        const heading = token as Tokens.Heading
        const spans = inlineSpans(heading.tokens, { bold: true, tone: 'accent' })
        rows.push(...wrapSpans(spans, width))
        rows.push(blank())
        break
      }
      case 'paragraph': {
        const paragraph = token as Tokens.Paragraph
        rows.push(...wrapSpans(inlineSpans(paragraph.tokens), width))
        break
      }
      case 'text': {
        const textToken = token as Tokens.Text
        rows.push(...wrapSpans(inlineSpans(textToken.tokens ?? []), width))
        break
      }
      case 'code': {
        const code = token as Tokens.Code
        rows.push(...renderCode(code.text, code.lang, width))
        break
      }
      case 'blockquote': {
        const quote = token as Tokens.Blockquote
        const inner = renderBlocks(quote.tokens, Math.max(1, width - 2))
        for (const row of inner) {
          rows.push({
            spans: [textSpan('│ ', 'faint'), ...row.spans],
            indent: row.indent,
          })
        }
        break
      }
      case 'list': {
        const list = token as Tokens.List
        for (let i = 0; i < list.items.length; i++) {
          const item = list.items[i] as Tokens.ListItem
          const marker = list.ordered ? `${(Number(list.start) || 1) + i}. ` : '• '
          const itemRows = renderBlocks(item.tokens, Math.max(1, width - marker.length))
          if (itemRows.length === 0) {
            rows.push({ spans: [textSpan(marker, 'muted')] })
            continue
          }
          const [first, ...rest] = itemRows
          rows.push({
            spans: [textSpan(marker, 'muted'), ...(first?.spans ?? [])],
            indent: first?.indent ?? 0,
          })
          for (const row of rest) {
            rows.push({ ...row, indent: (row.indent ?? 0) + marker.length })
          }
        }
        break
      }
      case 'hr':
        rows.push({ spans: [textSpan('─'.repeat(Math.max(1, width)), 'faint')] })
        break
      case 'table': {
        const gap = () => Array.from({ length: GapRole.Block }, blank)
        rows.push(...gap(), ...renderTable(token as Tokens.Table, width), ...gap())
        break
      }
      case 'html': {
        const html = token as Tokens.HTML
        const plain = html.text.replace(/<[^>]*>/gu, '')
        if (plain.trim() !== '') rows.push(...wrapSpans([textSpan(plain, 'muted')], width))
        break
      }
      default:
        if ('text' in token && typeof (token as { text?: unknown }).text === 'string') {
          rows.push(...wrapSpans([textSpan((token as { text: string }).text)], width))
        }
    }
  }
  return rows
}

const MIN_TABLE_COLUMN = 3
const MAX_TABLE_CELL_LINES = 3

function renderTable(table: Tokens.Table, width: number): Row[] {
  const cells = [table.header, ...table.rows].map((row, index) =>
    row.map((cell) => tableCellSpans(cell, index === 0)),
  )
  const columnCount = table.header.length
  const available = width - (columnCount - 1) * (INLINE * 2 + 1)
  if (available < MIN_TABLE_COLUMN * columnCount) return renderVerticalTable(cells, width)

  const minimum = table.header.map((_, i) =>
    Math.max(
      MIN_TABLE_COLUMN,
      ...cells.map((row) => longestTableFragment(rowText({ spans: row[i] ?? [] }))),
    ),
  )
  const ideal = table.header.map((_, i) =>
    Math.max(
      MIN_TABLE_COLUMN,
      ...cells.map((row) => displayWidth(rowText({ spans: row[i] ?? [] }))),
    ),
  )
  const widths = tableColumnWidths(minimum, ideal, available)
  const wrapped = cells.map((row) => row.map((spans, i) => wrapTableSpans(spans, widths[i]!)))
  if (wrapped.some((row) => row.some((cell) => cell.length > MAX_TABLE_CELL_LINES))) {
    return renderVerticalTable(cells, width)
  }

  const rows: Row[] = []
  wrapped.forEach((row, index) => {
    const height = Math.max(...row.map((cell) => cell.length))
    for (let line = 0; line < height; line++) {
      const spans: Span[] = []
      row.forEach((cell, i) => {
        if (i > 0) spans.push(textSpan(`${' '.repeat(INLINE)}│${' '.repeat(INLINE)}`, 'faint'))
        const top = Math.floor((height - cell.length) / 2)
        const content = cell[line - top]?.spans ?? []
        spans.push(...alignTableCell(content, widths[i]!, table.align[i] ?? null))
      })
      rows.push({ spans: trimTableEnd(spans) })
    }
    if (index === 0) {
      const rule = widths
        .map((size, i) =>
          '─'.repeat(size + (i > 0 ? INLINE : 0) + (i < columnCount - 1 ? INLINE : 0)),
        )
        .join('┼')
      rows.push({ spans: [textSpan(rule, 'faint')] })
    }
  })
  return rows
}

function tableCellSpans(cell: Tokens.TableCell, header: boolean): Span[] {
  const defaults: { bold?: boolean; tone?: Span['tone'] } = header
    ? { bold: true, tone: 'accent' }
    : {}
  // Inline lexing normally excludes blocks; do not recurse if one is supplied.
  const blockTypes = new Set([
    'code',
    'list',
    'table',
    'blockquote',
    'heading',
    'paragraph',
    'hr',
    'space',
  ])
  if (cell.tokens.some((token) => blockTypes.has(token.type))) {
    return [textSpan(cell.text, defaults.tone ?? 'normal', defaults)]
  }
  return inlineSpans(cell.tokens, defaults, true)
}

function longestTableFragment(text: string): number {
  let longest = 0
  let word = 0
  for (const g of graphemes(text)) {
    if (/\s/u.test(g) || isWideBreakable(g)) {
      longest = Math.max(longest, word, isWideBreakable(g) ? graphemeWidth(g) : 0)
      word = 0
    } else {
      word += graphemeWidth(g)
    }
  }
  return Math.max(longest, word)
}

/** Rewrap an overwide carried fragment without changing the shared wrapper. */
function wrapTableSpans(spans: readonly Span[], width: number): Row[] {
  return wrapSpans(spans, width).flatMap((row) =>
    displayWidth(rowText(row)) > width ? wrapSpans(row.spans, width) : [row],
  )
}

function tableColumnWidths(minimum: number[], ideal: number[], available: number): number[] {
  if (ideal.reduce((sum, size) => sum + size, 0) <= available) return ideal
  const totalMinimum = minimum.reduce((sum, size) => sum + size, 0)
  if (totalMinimum <= available) {
    const extra = distributeTableWidth(
      ideal.map((size, i) => size - minimum[i]!),
      available - totalMinimum,
      0,
    )
    return minimum.map((size, i) => size + extra[i]!)
  }
  return distributeTableWidth(minimum, available, MIN_TABLE_COLUMN)
}

/** Proportional allocation with fixed lower bounds, then integer remainder. */
function distributeTableWidth(weights: number[], budget: number, floor: number): number[] {
  const sizes = weights.map(() => floor)
  let pending = weights.map((_, i) => i)
  while (pending.length > 0) {
    const total = pending.reduce((sum, i) => sum + weights[i]!, 0)
    const clamped = pending.filter((i) => budget * weights[i]! < floor * total)
    if (clamped.length > 0) {
      budget -= clamped.length * floor
      pending = pending.filter((i) => !clamped.includes(i))
      continue
    }
    for (const i of pending)
      sizes[i] = total === 0 ? floor : Math.floor((budget * weights[i]!) / total)
    let remainder = budget - pending.reduce((sum, i) => sum + sizes[i]!, 0)
    for (const i of pending.toSorted((a, b) => weights[b]! - weights[a]!)) {
      if (remainder-- <= 0) break
      sizes[i]!++
    }
    break
  }
  return sizes
}

function alignTableCell(
  spans: readonly Span[],
  width: number,
  align: Tokens.Table['align'][number],
): Span[] {
  const padding = width - displayWidth(rowText({ spans }))
  const left = align === 'right' ? padding : align === 'center' ? Math.floor(padding / 2) : 0
  return [
    textSpan(' '.repeat(Math.max(0, left))),
    ...spans,
    textSpan(' '.repeat(Math.max(0, padding - left))),
  ]
}

/** Trim only the assembled row end, never the padding before a separator. */
function trimTableEnd(spans: Span[]): Span[] {
  while (spans.length > 0) {
    const last = spans[spans.length - 1]!
    const text = last.text.replace(/ +$/u, '')
    if (text !== '') {
      spans[spans.length - 1] = { ...last, text }
      break
    }
    spans.pop()
  }
  return spans
}

function renderVerticalTable(cells: Span[][][], width: number): Row[] {
  const [header = [], ...records] = cells
  const rows: Row[] = []
  const indent = Math.min(INDENT, Math.max(0, width - 1))
  const visibleRecords = records.length > 0 ? records : [header.map(() => [])]
  visibleRecords.forEach((record, index) => {
    if (index > 0) rows.push({ spans: [textSpan('─'.repeat(width), 'faint')] })
    record.forEach((value, i) => {
      const field = [
        textSpan(rowText({ spans: header[i] ?? [] }), 'faint'),
        textSpan(' '.repeat(INLINE * 2)),
        ...value,
      ]
      const first = wrapTableSpans(field, width)[0]!
      rows.push(first)
      // The first line owns the full width; only its unconsumed suffix needs
      // continuation indentation. Slice original spans to retain inline styles.
      const source = rowText({ spans: field })
      let consumed = rowText(first).length
      while (source[consumed] === ' ') consumed++
      if (source[consumed] === '\n') consumed++
      const rest: Span[] = []
      for (const span of field) {
        const text = span.text.slice(consumed)
        consumed = Math.max(0, consumed - span.text.length)
        if (text !== '') rest.push({ ...span, text })
      }
      if (rest.length > 0) {
        rows.push(
          ...wrapTableSpans(rest, Math.max(1, width - indent)).map((row) => ({ ...row, indent })),
        )
      }
    })
  })
  return rows
}

function inlineSpans(
  tokens: Token[],
  defaults: { bold?: boolean; italic?: boolean; tone?: Span['tone'] } = {},
  tableMode = false,
): Span[] {
  const spans: Span[] = []
  for (const token of tokens) {
    switch (token.type) {
      case 'text':
      case 'escape': {
        const textToken = token as Tokens.Text
        if (textToken.tokens && textToken.tokens.length > 0) {
          spans.push(...inlineSpans(textToken.tokens, defaults, tableMode))
        } else {
          spans.push(
            textSpan(textToken.text, defaults.tone ?? 'normal', {
              bold: defaults.bold,
              italic: defaults.italic,
            }),
          )
        }
        break
      }
      case 'strong': {
        const strong = token as Tokens.Strong
        spans.push(...inlineSpans(strong.tokens, { ...defaults, bold: true }, tableMode))
        break
      }
      case 'em': {
        const em = token as Tokens.Em
        spans.push(...inlineSpans(em.tokens, { ...defaults, italic: true }, tableMode))
        break
      }
      case 'codespan': {
        const code = token as Tokens.Codespan
        spans.push(
          textSpan(tableMode ? code.text : ` ${code.text} `, 'code', { bold: defaults.bold }),
        )
        break
      }
      case 'link': {
        const link = token as Tokens.Link
        const label =
          link.tokens.length > 0
            ? inlineSpans(link.tokens, defaults, tableMode)
            : [textSpan(link.text, defaults.tone ?? 'normal')]
        spans.push(...label.map((span) => ({ ...span, underline: true })))
        if (link.href && link.href !== link.text) {
          spans.push(textSpan(` (${link.href})`, 'muted'))
        }
        break
      }
      case 'br':
        spans.push(textSpan('\n', defaults.tone ?? 'normal'))
        break
      case 'del': {
        const del = token as Tokens.Del
        spans.push(
          ...inlineSpans(del.tokens, defaults, tableMode).map((span) => ({
            ...span,
            strike: true,
          })),
        )
        break
      }
      case 'html': {
        const html = token as Tokens.HTML
        spans.push(textSpan(html.text.replace(/<[^>]*>/gu, ''), 'muted'))
        break
      }
      case 'image': {
        const image = token as Tokens.Image
        spans.push(textSpan(`[图片: ${image.text}]`, 'muted'))
        break
      }
      default:
        if ('text' in token && typeof (token as { text?: unknown }).text === 'string') {
          spans.push(textSpan((token as { text: string }).text, defaults.tone ?? 'normal'))
        }
    }
  }
  return spans
}

const LANGUAGE_ALIASES: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'jsx',
  json: 'json',
  bash: 'bash',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  py: 'python',
  python: 'python',
  rust: 'rust',
  rs: 'rust',
  yaml: 'yaml',
  yml: 'yaml',
  md: 'markdown',
  css: 'css',
  html: 'markup',
  xml: 'markup',
  diff: 'diff',
}

const grammarCache = new Map<string, Prism.Grammar | undefined>()

function grammarFor(
  language: string | undefined,
): { name: string; grammar: Prism.Grammar } | undefined {
  if (!language) return undefined
  const canonical = LANGUAGE_ALIASES[language.toLowerCase()] ?? language.toLowerCase()
  if (grammarCache.has(canonical)) {
    const cached = grammarCache.get(canonical)
    return cached ? { name: canonical, grammar: cached } : undefined
  }
  const loaded = (Prism.languages as Record<string, Prism.Grammar | undefined>)[canonical]
  grammarCache.set(canonical, loaded)
  return loaded ? { name: canonical, grammar: loaded } : undefined
}

/** Tokenize code and map Prism tokens to tones; unknown languages render plain. */
export function highlightCode(code: string, language: string | undefined): Span[][] {
  const found = grammarFor(language)
  if (!found) return code.split('\n').map((line) => [textSpan(line, 'code')])
  let tokens: Array<string | Prism.Token>
  try {
    tokens = Prism.tokenize(code, found.grammar)
  } catch {
    return code.split('\n').map((line) => [textSpan(line, 'code')])
  }
  const lines: Span[][] = [[]]
  const pushText = (text: string, tone: Span['tone'], bold = false) => {
    const parts = text.split('\n')
    parts.forEach((part, index) => {
      if (index > 0) lines.push([])
      if (part !== '')
        (lines[lines.length - 1] as Span[]).push(textSpan(part, tone, bold ? { bold } : {}))
    })
  }
  const walk = (items: Array<string | Prism.Token>, inheritedTone: Span['tone'], bold: boolean) => {
    for (const item of items) {
      if (typeof item === 'string') {
        pushText(item, inheritedTone, bold)
        continue
      }
      const tone = tokenTone(item.type, inheritedTone)
      const content = Array.isArray(item.content) ? item.content : String(item.content)
      if (Array.isArray(content))
        walk(content as Array<string | Prism.Token>, tone, bold || item.type === 'bold')
      else pushText(content as string, tone, bold || item.type === 'bold')
    }
  }
  walk(tokens, 'code', false)
  return lines
}

function tokenTone(type: string, fallback: Span['tone']): Span['tone'] {
  switch (type) {
    case 'comment':
    case 'prolog':
    case 'doctype':
    case 'cdata':
      return 'faint'
    case 'keyword':
    case 'boolean':
    case 'important':
      return 'accent'
    case 'string':
    case 'char':
    case 'attr-value':
      return 'success'
    case 'number':
    case 'constant':
    case 'symbol':
    case 'inserted':
      return 'warning'
    case 'function':
    case 'class-name':
    case 'builtin':
      return 'info'
    case 'deleted':
      return 'danger'
    case 'operator':
    case 'punctuation':
      return 'muted'
    case 'property':
    case 'attr-name':
    case 'tag':
      return 'tool'
    default:
      return fallback
  }
}

function renderCode(code: string, language: string | undefined, width: number): Row[] {
  const rows: Row[] = []
  rows.push(blank())
  for (const line of highlightCode(code, language)) {
    const spans = line.length > 0 ? line : [textSpan('', 'code')]
    const wrapped = wrapSpans(spans, Math.max(1, width - EDGE))
    for (const row of wrapped) rows.push({ ...row, indent: EDGE })
  }
  rows.push(blank())
  return rows
}

function blank(): Row {
  return { spans: [textSpan('')] }
}

function trimBlankRows(rows: Row[]): Row[] {
  let start = 0
  let end = rows.length
  while (start < end && isBlank(rows[start])) start++
  while (end > start && isBlank(rows[end - 1])) end--
  const result: Row[] = []
  for (let i = start; i < end; i++) {
    const row = rows[i] as Row
    if (isBlank(row) && result.length > 0 && isBlank(result[result.length - 1] as Row)) continue
    result.push(row)
  }
  return result
}

function isBlank(row: Row | undefined): boolean {
  if (!row) return true
  return row.spans.every((span) => span.text.trim() === '')
}

export { EDGE, NESTED }
