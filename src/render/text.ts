/**
 * Display-width aware text primitives: grapheme iteration, sanitization,
 * wrapping and truncation. Every string that reaches the cell buffer passes
 * through `sanitizeText` first so raw ESC/OSC bytes can never reach the tty.
 */
import stringWidth from 'string-width'

const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' })

/** Cache display widths per grapheme; transcripts repeat characters heavily. */
const widthCache = new Map<string, number>()

/**
 * `string-width` classifies the filled pointer U+25B6 as emoji-wide (2 cells),
 * while terminals and the design treat it as a 1ch pointer. Keep the terminal
 * grid aligned with the design instead of letting the row shift after it.
 */
const WIDTH_OVERRIDES: Readonly<Record<string, number>> = { '▶': 1 }

/**
 * Split text into user-perceived characters (grapheme clusters). Emoji ZWJ
 * sequences and combining marks stay intact.
 */
export function graphemes(text: string): string[] {
  const out: string[] = []
  for (const { segment } of segmenter.segment(text)) out.push(segment)
  return out
}

/** Display width (terminal cells) of one grapheme cluster. */
export function graphemeWidth(grapheme: string): number {
  const override = WIDTH_OVERRIDES[grapheme]
  if (override !== undefined) return override
  const cached = widthCache.get(grapheme)
  if (cached !== undefined) return cached
  const width = stringWidth(grapheme)
  if (widthCache.size > 8192) widthCache.clear()
  widthCache.set(grapheme, width)
  return width
}

/** Display width of an arbitrary string, newlines excluded. */
export function displayWidth(text: string): number {
  let width = 0
  for (const g of graphemes(text)) {
    if (g === '\n') continue
    width += graphemeWidth(g)
  }
  return width
}

/**
 * Strip C0/C1 control characters and every ESC-introduced sequence from text
 * destined for the terminal. Newlines and tabs survive; tabs are expanded by
 * the renderer. This is the single defense against cursor moves, clipboard
 * writes (OSC 52) and title changes smuggled through model or tool output.
 */
export function sanitizeText(text: string): string {
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string
    const code = text.charCodeAt(i)
    if (ch === '\n' || ch === '\t') {
      out += ch
      continue
    }
    if (ch === '\r') {
      if (text[i + 1] === '\n') continue
      out += '\n'
      continue
    }
    if (code === 0x1b) {
      i = skipEscape(text, i)
      continue
    }
    if (code < 0x20 || code === 0x7f) continue
    if (code >= 0x80 && code <= 0x9f) continue
    out += ch
  }
  return out
}

/** Consume one ESC sequence starting at `start`; returns the index of its last byte. */
function skipEscape(text: string, start: number): number {
  const next = text[start + 1]
  if (next === undefined) return start
  if (next === '[') {
    // CSI: parameter/intermediate bytes, then one final byte 0x40-0x7e.
    let i = start + 2
    while (i < text.length) {
      const code = text.charCodeAt(i)
      if (code >= 0x40 && code <= 0x7e) return i
      i++
    }
    return text.length - 1
  }
  if (next === ']') {
    // OSC: terminated by BEL or ST (ESC \).
    let i = start + 2
    while (i < text.length) {
      const code = text.charCodeAt(i)
      if (code === 0x07) return i
      if (code === 0x1b && text[i + 1] === '\\') return i + 1
      i++
    }
    return text.length - 1
  }
  if (next === 'P' || next === 'X' || next === '^' || next === '_') {
    let i = start + 2
    while (i < text.length) {
      if (text.charCodeAt(i) === 0x1b && text[i + 1] === '\\') return i + 1
      i++
    }
    return text.length - 1
  }
  // Two-byte escape (or a lone ESC).
  return start + 1
}

/**
 * Expand tabs to the next multiple of `tabSize` columns before wrapping.
 * Terminal tab stops are unreliable once we own the cell grid.
 */
export function expandTabs(text: string, tabSize = 2): string {
  if (!text.includes('\t')) return text
  let out = ''
  let column = 0
  for (const g of graphemes(text)) {
    if (g === '\n') {
      out += g
      column = 0
      continue
    }
    if (g === '\t') {
      const spaces = tabSize - (column % tabSize)
      out += ' '.repeat(spaces)
      column += spaces
      continue
    }
    out += g
    column += graphemeWidth(g)
  }
  return out
}

export interface WrapOptions {
  /** Hard-break words longer than the line (URLs, long identifiers). Default true. */
  breakLongWords?: boolean
  /** Preserve all spaces instead of collapsing runs. Default false. */
  preserveSpaces?: boolean
}

/**
 * Wrap text to `width` display columns. Breaks between CJK characters and at
 * spaces, never inside a grapheme cluster. Returns at least one line.
 */
export function wrapText(text: string, width: number, options: WrapOptions = {}): string[] {
  const maxWidth = Math.max(1, Math.floor(width))
  const breakLongWords = options.breakLongWords ?? true
  const preserveSpaces = options.preserveSpaces ?? false
  const lines: string[] = []
  for (const rawLine of text.split('\n')) {
    const line = expandTabs(rawLine)
    if (line === '') {
      lines.push('')
      continue
    }
    let current = ''
    let currentWidth = 0
    const units = splitUnits(line, preserveSpaces)
    for (const unit of units) {
      if (current === '' && /^ +$/u.test(unit)) continue
      const unitWidth = displayWidth(unit)
      if (unitWidth === 0) {
        current += unit
        continue
      }
      if (currentWidth + unitWidth <= maxWidth) {
        current += unit
        currentWidth += unitWidth
        continue
      }
      if (current !== '') {
        lines.push(trimLineEnd(current))
        current = ''
        currentWidth = 0
      }
      if (/^ +$/u.test(unit)) continue
      if (unitWidth <= maxWidth) {
        current = unit
        currentWidth = unitWidth
        continue
      }
      if (!breakLongWords) {
        lines.push(truncateText(unit, maxWidth))
        continue
      }
      // Hard-break an overlong unit at grapheme boundaries.
      let chunk = ''
      let chunkWidth = 0
      for (const g of graphemes(unit)) {
        const gw = graphemeWidth(g)
        if (chunkWidth + gw > maxWidth) {
          lines.push(chunk)
          chunk = ''
          chunkWidth = 0
        }
        chunk += g
        chunkWidth += gw
      }
      current = chunk
      currentWidth = chunkWidth
    }
    lines.push(trimLineEnd(current))
  }
  return lines.length === 0 ? [''] : lines
}

/**
 * Split a line into breakable units: runs of spaces, single CJK/emoji
 * graphemes, and whitespace-free word runs. Trailing spaces live in the unit
 * so a wrap can drop them.
 */
function splitUnits(line: string, preserveSpaces: boolean): string[] {
  const units: string[] = []
  let word = ''
  const flush = () => {
    if (word !== '') {
      units.push(word)
      word = ''
    }
  }
  for (const g of graphemes(line)) {
    if (g === ' ') {
      flush()
      units.push(preserveSpaces ? ' ' : ' ')
      continue
    }
    if (isWideBreakable(g)) {
      flush()
      units.push(g)
      continue
    }
    word += g
  }
  flush()
  return units
}

/** CJK, kana and full-width punctuation may break between characters. */
export function isWideBreakable(grapheme: string): boolean {
  if (grapheme.length === 0) return false
  const code = grapheme.codePointAt(0) ?? 0
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0x303e) ||
    (code >= 0x3041 && code <= 0x33ff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xa000 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  )
}

function trimLineEnd(line: string): string {
  return line.replace(/ +$/u, '')
}

/**
 * Truncate to `width` columns with an ellipsis. Wide graphemes are never cut
 * in half; when the next grapheme would overflow, the line ends early.
 */
export function truncateText(text: string, width: number, ellipsis = '…'): string {
  const maxWidth = Math.max(0, Math.floor(width))
  if (maxWidth === 0) return ''
  if (displayWidth(text) <= maxWidth) return text
  const ellipsisWidth = displayWidth(ellipsis)
  const budget = Math.max(0, maxWidth - ellipsisWidth)
  let out = ''
  let used = 0
  for (const g of graphemes(text)) {
    const gw = graphemeWidth(g)
    if (used + gw > budget) break
    out += g
    used += gw
  }
  return out + ellipsis
}

/** Split a string into fixed-width chunks, used for diff gutters and copy. */
export function chunkByWidth(text: string, width: number): string[] {
  const chunks: string[] = []
  let current = ''
  let used = 0
  for (const g of graphemes(text)) {
    const gw = graphemeWidth(g)
    if (used + gw > width && current !== '') {
      chunks.push(current)
      current = ''
      used = 0
    }
    current += g
    used += gw
  }
  if (current !== '' || chunks.length === 0) chunks.push(current)
  return chunks
}
