import { describe, expect, it } from 'vitest'
import { wrapSpans } from '../../src/transcript/spans.ts'

describe('caret span wrapping', () => {
  it('keeps the reverse caret at the end of the line', () => {
    const rows = wrapSpans(
      [
        { text: 'hello', tone: 'normal' },
        { text: ' ', tone: 'normal', reverse: true, caret: true },
      ],
      40,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.spans.some((span) => span.caret === true && span.reverse === true)).toBe(true)
  })

  it('wraps the caret onto the next line when the text fills the line', () => {
    const rows = wrapSpans(
      [
        { text: 'a'.repeat(74), tone: 'normal' },
        { text: ' ', tone: 'normal', reverse: true, caret: true },
      ],
      74,
    )
    expect(rows).toHaveLength(2)
    expect(rows[0]?.spans.some((span) => span.caret === true)).toBe(false)
    expect(rows[1]?.spans.some((span) => span.caret === true)).toBe(true)
  })

  it('does not merge the caret into an adjacent span with the same style', () => {
    const rows = wrapSpans(
      [
        { text: 'ab', tone: 'normal', reverse: true },
        { text: ' ', tone: 'normal', reverse: true, caret: true },
        { text: 'cd', tone: 'normal', reverse: true },
      ],
      40,
    )
    const spans = rows[0]?.spans ?? []
    expect(spans.find((span) => span.caret === true)?.text).toBe(' ')
    expect(spans.map((span) => span.text).join('')).toBe('ab cd')
  })
})
