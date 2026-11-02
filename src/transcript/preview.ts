/**
 * Tool-result display projection (ADR-20261102-transcript-display-projection):
 * keep only what the UI can render. Head + tail lines plus an omission marker,
 * each retained line capped at 500 UTF-16 code units. Any truncation rebuilds
 * the string so V8 cannot keep the original payload alive via SlicedString.
 */

export const DEFAULT_PREVIEW_LINES = 40
export const MIN_PREVIEW_LINES = 4
export const MAX_PREVIEW_LINES = 2000
export const PREVIEW_LINE_CHARS = 500

const HEAD_RATIO = 0.6
const LINE_TRUNCATED = '…（本行已截断）'

export function resolvePreviewLines(): number {
  const raw = process.env.NANO_TOOL_PREVIEW_LINES
  if (raw === undefined) return DEFAULT_PREVIEW_LINES
  const value = Number(raw)
  if (!Number.isInteger(value) || value < MIN_PREVIEW_LINES || value > MAX_PREVIEW_LINES) {
    return DEFAULT_PREVIEW_LINES
  }
  return value
}

export function previewToolResult(text: string, maxLines: number = resolvePreviewLines()): string {
  if (text === '') return text
  const limit = Math.max(1, Math.floor(maxLines))
  const totalLines = countLines(text)
  const middleOmitted = totalLines > limit
  const headLines = middleOmitted ? Math.ceil(limit * HEAD_RATIO) : totalLines
  const tailLines = middleOmitted ? limit - headLines : 0

  let truncated = middleOmitted
  const renderLine = (line: string): string => {
    if (line.length <= PREVIEW_LINE_CHARS) return line
    truncated = true
    return `${truncateLine(line)}${LINE_TRUNCATED}`
  }

  const headBlock = sliceHead(text, headLines)
  const tailBlock = tailLines > 0 ? sliceTail(text, tailLines) : []
  const lines = headBlock.map(renderLine)
  if (middleOmitted) lines.push(`… 省略 ${totalLines - limit} 行 …`)
  lines.push(...tailBlock.map(renderLine))

  // Small results keep the original string; truncation rebuilds a flat copy
  // so the original payload is not kept alive through V8 sliced strings.
  return truncated ? Array.from(lines.join('\n')).join('') : text
}

function countLines(text: string): number {
  let count = 1
  let index = text.indexOf('\n')
  while (index !== -1) {
    count++
    index = text.indexOf('\n', index + 1)
  }
  return count
}

/** The first `lines` lines, without splitting the whole payload. */
function sliceHead(text: string, lines: number): string[] {
  let end = -1
  for (let index = 0; index < lines; index++) {
    end = text.indexOf('\n', end + 1)
    if (end === -1) return text.split('\n')
  }
  return text.slice(0, end).split('\n')
}

/** The last `lines` lines, without splitting the whole payload. */
function sliceTail(text: string, lines: number): string[] {
  let start = text.length
  for (let index = 0; index < lines; index++) {
    const newline = text.lastIndexOf('\n', start - 1)
    if (newline === -1) return text.split('\n')
    start = newline
  }
  return text.slice(start + 1).split('\n')
}

/** Cap a line at 500 code units without leaving a lone surrogate. */
function truncateLine(line: string): string {
  let cut = PREVIEW_LINE_CHARS
  const high = line.charCodeAt(cut - 1)
  const low = line.charCodeAt(cut)
  if (high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff) cut--
  return line.slice(0, cut)
}
