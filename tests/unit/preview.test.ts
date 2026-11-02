import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_PREVIEW_LINES,
  MAX_PREVIEW_LINES,
  MIN_PREVIEW_LINES,
  previewToolResult,
  resolvePreviewLines,
} from '../../src/transcript/preview.ts'

function numbered(count: number, prefix = 'line'): string {
  return Array.from({ length: count }, (_, index) => `${prefix} ${index}`).join('\n')
}

describe('resolvePreviewLines', () => {
  const original = process.env.NANO_TOOL_PREVIEW_LINES

  afterEach(() => {
    if (original === undefined) delete process.env.NANO_TOOL_PREVIEW_LINES
    else process.env.NANO_TOOL_PREVIEW_LINES = original
  })

  it('defaults to 40 without the environment variable', () => {
    delete process.env.NANO_TOOL_PREVIEW_LINES
    expect(DEFAULT_PREVIEW_LINES).toBe(40)
    expect(resolvePreviewLines()).toBe(DEFAULT_PREVIEW_LINES)
  })

  it('reads a valid integer in range', () => {
    process.env.NANO_TOOL_PREVIEW_LINES = '120'
    expect(resolvePreviewLines()).toBe(120)
  })

  it('accepts both range bounds', () => {
    process.env.NANO_TOOL_PREVIEW_LINES = String(MIN_PREVIEW_LINES)
    expect(resolvePreviewLines()).toBe(MIN_PREVIEW_LINES)
    process.env.NANO_TOOL_PREVIEW_LINES = String(MAX_PREVIEW_LINES)
    expect(resolvePreviewLines()).toBe(MAX_PREVIEW_LINES)
  })

  it.each(['0', '-3', '4.5', 'abc', '', '2001'])('falls back to the default for %s', (value) => {
    process.env.NANO_TOOL_PREVIEW_LINES = value
    expect(resolvePreviewLines()).toBe(DEFAULT_PREVIEW_LINES)
  })
})

describe('previewToolResult', () => {
  it('keeps a small result unchanged', () => {
    const text = 'alpha\nbeta\ngamma'
    expect(previewToolResult(text, 40)).toBe(text)
  })

  it('returns an empty string unchanged', () => {
    expect(previewToolResult('', 40)).toBe('')
  })

  it('keeps all lines when the result exactly fits the budget', () => {
    const text = numbered(40)
    expect(previewToolResult(text, 40)).toBe(text)
  })

  it('keeps 24 head lines, a marker, and 16 tail lines by default', () => {
    const text = numbered(100)
    const lines = previewToolResult(text, 40).split('\n')
    expect(lines).toHaveLength(41)
    expect(lines[0]).toBe('line 0')
    expect(lines[23]).toBe('line 23')
    expect(lines[24]).toBe('… 省略 60 行 …')
    expect(lines[25]).toBe('line 84')
    expect(lines[40]).toBe('line 99')
  })

  it('rounds the head up for an odd budget', () => {
    const text = numbered(10)
    const lines = previewToolResult(text, 5).split('\n')
    expect(lines).toHaveLength(6)
    expect(lines.slice(0, 3)).toEqual(['line 0', 'line 1', 'line 2'])
    expect(lines[3]).toBe('… 省略 5 行 …')
    expect(lines.slice(4)).toEqual(['line 8', 'line 9'])
  })

  it('caps a single long line at 500 code units with a marker', () => {
    const long = 'x'.repeat(600)
    expect(previewToolResult(long, 40)).toBe(`${'x'.repeat(500)}…（本行已截断）`)
  })

  it('caps each retained line independently', () => {
    const long = 'y'.repeat(600)
    const lines = previewToolResult(`${long}\nshort`, 40).split('\n')
    expect(lines[0]).toBe(`${'y'.repeat(500)}…（本行已截断）`)
    expect(lines[1]).toBe('short')
  })

  it('does not split a surrogate pair at the 500-unit boundary', () => {
    const line = `${'a'.repeat(499)}😀`
    expect(previewToolResult(line, 40)).toBe(`${'a'.repeat(499)}…（本行已截断）`)
  })

  it('keeps the trailing empty line semantics of split', () => {
    const text = `${numbered(40)}\n`
    const lines = previewToolResult(text, 40).split('\n')
    expect(lines).toHaveLength(41)
    expect(lines[24]).toBe('… 省略 1 行 …')
    expect(lines[40]).toBe('')
  })

  it('keeps CRLF carriage returns on retained lines', () => {
    const text = 'a\r\nb\r\nc\r\nd\r\ne'
    const lines = previewToolResult(text, 4).split('\n')
    expect(lines).toEqual(['a\r', 'b\r', 'c\r', '… 省略 1 行 …', 'e'])
  })

  it('reads the default budget from the environment', () => {
    process.env.NANO_TOOL_PREVIEW_LINES = '10'
    try {
      const lines = previewToolResult(numbered(20)).split('\n')
      expect(lines).toHaveLength(11)
      expect(lines[6]).toBe('… 省略 10 行 …')
    } finally {
      delete process.env.NANO_TOOL_PREVIEW_LINES
    }
  })
})
