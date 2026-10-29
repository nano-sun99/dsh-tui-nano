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
import { EDGE, NESTED } from '../theme/spacing.ts'
import { type Row, type Span, textSpan, wrapSpans } from './spans.ts'

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
        const table = token as Tokens.Table
        const header = table.header.map((cell) => cell.text).join(' │ ')
        rows.push(...wrapSpans([textSpan(header, 'accent', { bold: true })], width))
        for (const row of table.rows) {
          rows.push(
            ...wrapSpans([textSpan(row.map((cell) => cell.text).join(' │ '), 'normal')], width),
          )
        }
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

function inlineSpans(
  tokens: Token[],
  defaults: { bold?: boolean; italic?: boolean; tone?: Span['tone'] } = {},
): Span[] {
  const spans: Span[] = []
  for (const token of tokens) {
    switch (token.type) {
      case 'text':
      case 'escape': {
        const textToken = token as Tokens.Text
        if (textToken.tokens && textToken.tokens.length > 0) {
          spans.push(...inlineSpans(textToken.tokens, defaults))
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
        spans.push(...inlineSpans(strong.tokens, { ...defaults, bold: true }))
        break
      }
      case 'em': {
        const em = token as Tokens.Em
        spans.push(...inlineSpans(em.tokens, { ...defaults, italic: true }))
        break
      }
      case 'codespan': {
        const code = token as Tokens.Codespan
        spans.push(textSpan(` ${code.text} `, 'code', { bold: defaults.bold }))
        break
      }
      case 'link': {
        const link = token as Tokens.Link
        const label =
          link.tokens.length > 0
            ? inlineSpans(link.tokens, defaults)
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
        spans.push(...inlineSpans(del.tokens, defaults).map((span) => ({ ...span, strike: true })))
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
