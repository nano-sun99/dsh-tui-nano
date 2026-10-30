import { Lexer, type Tokens } from 'marked'
import { describe, expect, it, vi } from 'vitest'
import { displayWidth } from '../../src/render/text.ts'
import { renderMarkdown } from '../../src/transcript/markdown.ts'
import { type Row, rowText } from '../../src/transcript/spans.ts'

const lines = (markdown: string, width = 80) => renderMarkdown(markdown, width).map(rowText)

function separatorColumns(row: Row): number[] {
  const text = rowText(row)
  return [...text.matchAll(/│/gu)].map((match) => displayWidth(text.slice(0, match.index)))
}

describe('Markdown tables', () => {
  it('uses ideal widths, one header rule and no outer or data-row borders', () => {
    expect(lines('| A | B |\n| - | - |\n| abc | x |\n| y | def |')).toEqual([
      'A   │ B',
      '────┼────',
      'abc │ x',
      'y   │ def',
    ])
  })

  it('allocates spare width proportionally and gives the remainder to the largest overflow', () => {
    expect(lines('| A | B |\n| - | - |\n| aa bb ccc | ddd eee |', 13)).toEqual([
      'A      │ B',
      '───────┼─────',
      'aa bb  │ ddd',
      'ccc    │ eee',
    ])
  })

  it('compresses below word widths without taking any column below three cells', () => {
    expect(lines('| A | B |\n| - | - |\n| abcdefgh | abcdefgh |', 10)).toEqual([
      'A    │ B',
      '─────┼────',
      'abcd │ abc',
      'efgh │ def',
      '     │ gh',
    ])
  })

  it('redistributes proportional compression when a small column hits the lower bound', () => {
    expect(lines('| A | B |\n| - | - |\n| x | abcdefghijklmno |', 11)).toEqual([
      'A   │ B',
      '────┼──────',
      '    │ abcde',
      'x   │ fghij',
      '    │ klmno',
    ])
  })

  it('keeps the grid exactly at the minimum-width budget', () => {
    expect(lines('| A | B |\n| - | - |\n| abc | def |', 9)).toEqual([
      'A   │ B',
      '────┼────',
      'abc │ def',
    ])
  })

  it('falls back for the entire table when the minimum-width budget does not fit', () => {
    expect(lines('| A | B |\n| - | - |\n| x | y |\n| z | w |', 8)).toEqual([
      'A  x',
      'B  y',
      '────────',
      'A  z',
      'B  w',
    ])
  })

  it('falls back when any cell needs four lines, but retains a three-line cell in the grid', () => {
    const table = (value: string) => `| A | B |\n| - | - |\n| ${value} | x |`
    expect(lines(table('abcdefghi'), 9)).toEqual([
      'A   │ B',
      '────┼────',
      'abc │',
      'def │ x',
      'ghi │',
    ])
    const rows = renderMarkdown(table('abcdefghij'), 9)
    expect(rows.map(rowText).join('\n')).not.toMatch(/[│┼]/u)
    expect(rows.map(rowText).join('')).toContain('abcdefghij'.slice(0, 3))
    expect(rows.filter((row) => (row.indent ?? 0) > 0).every((row) => row.indent === 2)).toBe(true)
    expect(rows.filter((row) => row.indent === 2).length).toBeGreaterThan(0)
    expect(rows.every((row) => displayWidth(rowText(row)) + (row.indent ?? 0) <= 9)).toBe(true)
    expect(
      rows
        .flatMap((row) => row.spans)
        .filter((span) => span.tone !== 'faint')
        .map((span) => span.text)
        .join('')
        .replace(/ /gu, ''),
    ).toBe('abcdefghijx')
  })

  it('measures mixed Chinese, emoji and combining characters in terminal cells', () => {
    const rows = renderMarkdown('| 名称 | 值 |\n| - | - |\n| 中文 | é |\n| nano | 👩‍💻 |', 13)
    expect(rows.map(rowText)).toEqual(['名称 │ 值', '─────┼────', '中文 │ é', 'nano │ 👩‍💻'])
    for (const row of rows.filter((row) => rowText(row).includes('│'))) {
      expect(separatorColumns(row)).toEqual([5])
    }
  })

  it('keeps wrapped Chinese content in its original column', () => {
    const rows = renderMarkdown('| A | B |\n| - | - |\n| 中文测试 | English |', 14)
    expect(rows.map(rowText)).toEqual(['A    │ B', '─────┼────────', '中文 │ English', '测试 │'])
    expect(rows.filter((row) => rowText(row).includes('│')).map(separatorColumns)).toEqual([
      [5],
      [5],
      [5],
    ])
  })

  it('honors left, center, right and implicit-left alignment for headers and body', () => {
    expect(lines('| L | C | R | D |\n| :-- | :-: | --: | --- |\n| a | b | c | d |')).toEqual([
      'L   │  C  │   R │ D',
      '────┼─────┼─────┼────',
      'a   │  b  │   c │ d',
    ])
  })

  it('puts odd horizontal padding on the right of centered content', () => {
    expect(lines('| A | B |\n| :-: | - |\n| abcd | x |')).toEqual([
      ' A   │ B',
      '─────┼────',
      'abcd │ x',
    ])
  })

  it('centers short cells vertically and puts an odd extra row below them', () => {
    expect(lines('| A | B | C |\n| - | - | - |\n| abcdefghi | x | abcdef |', 15)).toEqual([
      'A   │ B   │ C',
      '────┼─────┼────',
      'abc │     │ abc',
      'def │ x   │ def',
      'ghi │     │',
    ])
  })

  it('retains empty cells and their allocated column widths', () => {
    expect(lines('| A | B | C |\n| - | - | - |\n| | x | |\n| y | | z |')).toEqual([
      'A   │ B   │ C',
      '────┼─────┼────',
      '    │ x   │',
      'y   │     │ z',
    ])
  })

  it('preserves an empty single-column record instead of trimming it as block whitespace', () => {
    expect(lines('| A |\n| - |\n| |\n| x |')).toEqual(['A', '───', '', 'x'])
  })

  it('renders a header-only table with its header rule', () => {
    expect(lines('| A | B |\n| - | - |')).toEqual(['A   │ B', '────┼────'])
  })

  it('keeps header-only tables visible when the grid budget does not fit', () => {
    expect(lines('| A | B |\n| - | - |', 8)).toEqual(['A', 'B'])
  })

  it('styles inline content instead of printing Markdown syntax', () => {
    const rows = renderMarkdown(
      '| **Title** | B |\n| - | - |\n| **bold** *italic* ~~gone~~ `code` [link](url) | x |',
      100,
    )
    expect(rows.map(rowText).join('\n')).not.toMatch(/\*|~~|`|\]\(/u)
    const header = rows[0]!.spans.filter((span) => span.text.trim() && !span.text.includes('│'))
    expect(header.every((span) => span.tone === 'accent' && span.bold)).toBe(true)
    const body = rows.slice(2).flatMap((row) => row.spans)
    expect(body).toContainEqual(expect.objectContaining({ text: 'bold', bold: true }))
    expect(body).toContainEqual(expect.objectContaining({ text: 'italic', italic: true }))
    expect(body).toContainEqual(expect.objectContaining({ text: 'gone', strike: true }))
    expect(body).toContainEqual(expect.objectContaining({ text: 'code', tone: 'code' }))
    expect(body).toContainEqual(expect.objectContaining({ text: 'link', underline: true }))
    expect(rows.map(rowText).join('\n')).toContain('link (url)')
  })

  it('propagates table code mode through emphasis, strike and link tokens only', () => {
    const rows = renderMarkdown('| A |\n| - |\n| **`x`** *`y`* ~~`z`~~ [`q`](q) |', 80)
    expect(rows.map(rowText)).toEqual(['A', '───────────', 'x y z q (q)'])
    const spans = rows[2]!.spans
    expect(spans).toContainEqual(expect.objectContaining({ text: 'x', tone: 'code', bold: true }))
    expect(spans).toContainEqual(expect.objectContaining({ text: 'z', tone: 'code', strike: true }))
    expect(spans).toContainEqual(
      expect.objectContaining({ text: 'q', tone: 'code', underline: true }),
    )
    expect(lines('**`x`** *`y`* ~~`z`~~ [`q`](q)')).toEqual([' x   y   z   q  (q)'])
  })

  it('measures rendered inline code without the body-code padding', () => {
    expect(lines('| A | B |\n| - | - |\n| `abc` | x |')).toEqual([
      'A   │ B',
      '────┼────',
      'abc │ x',
    ])
    expect(lines('use `abc` now')).toEqual(['use  abc  now'])
  })

  it('preserves cell styles and faint labels in the vertical fallback', () => {
    const rows = renderMarkdown('| A | B |\n| - | - |\n| **x** | `y` |', 8)
    expect(rows.map(rowText)).toEqual(['A  x', 'B  y'])
    expect(rows[0]!.spans).toContainEqual(expect.objectContaining({ text: 'A', tone: 'faint' }))
    expect(rows[0]!.spans).toContainEqual(expect.objectContaining({ text: 'x', bold: true }))
    expect(rows[1]!.spans).toContainEqual(expect.objectContaining({ text: 'y', tone: 'code' }))
  })

  it('wraps long fallback labels and values without losing text or escaping the net width', () => {
    const rows = renderMarkdown('| 很长的名称 | B |\n| - | - |\n| abcdefghijk | **中文** |', 8)
    expect(rows.some((row) => row.indent === 2)).toBe(true)
    expect(rows.every((row) => displayWidth(rowText(row)) + (row.indent ?? 0) <= 8)).toBe(true)
    expect(rows.map(rowText).join('').replace(/ /gu, '')).toBe('很长的名称abcdefghijkB中文')
    expect(
      rows
        .flatMap((row) => row.spans)
        .filter((span) => span.bold)
        .map((span) => span.text)
        .join(''),
    ).toBe('中文')
  })

  it('uses raw cell text, without recursive rendering, for unexpected block tokens', () => {
    const tokens = new Lexer({ gfm: true }).lex('| A |\n| - |\n| original |')
    const table = tokens[0] as Tokens.Table
    table.rows[0]![0]!.text = '- **raw**'
    table.rows[0]![0]!.tokens = [
      { type: 'list', raw: '- **raw**', ordered: false, start: '', loose: false, items: [] },
    ]
    const lex = vi.spyOn(Lexer.prototype, 'lex').mockReturnValueOnce(tokens)
    try {
      expect(lines('table')).toEqual(['A', '─────────', '- **raw**'])
    } finally {
      lex.mockRestore()
    }
  })

  it('uses faint rules and strips line-end padding without shifting interior columns', () => {
    const rows = renderMarkdown('| A | B |\n| - | --: |\n| abc | |\n| x | y |', 80)
    expect(rows[1]!.spans.every((span) => span.tone === 'faint')).toBe(true)
    for (const row of rows) {
      expect(rowText(row)).not.toMatch(/ +$/u)
      for (const span of row.spans.filter((span) => /[│┼─]/u.test(span.text))) {
        expect(span.tone).toBe('faint')
      }
    }
    expect(rows.filter((row) => rowText(row).includes('│')).map(separatorColumns)).toEqual([
      [4],
      [4],
      [4],
    ])
  })

  it('subtracts the caller indent before allocating columns', () => {
    const rows = renderMarkdown('| A | B |\n| - | - |\n| x | y |', 11, { indent: 2 })
    expect(rows.map(rowText)).toEqual(['A   │ B', '────┼────', 'x   │ y'])
    expect(rows.every((row) => row.indent === 2)).toBe(true)
    expect(
      renderMarkdown('| A | B |\n| - | - |\n| x | y |', 10, { indent: 2 }).map(rowText),
    ).toEqual(['A  x', 'B  y'])
  })

  it('uses code-block spacing around tables without changing paragraph, list or quote rendering', () => {
    expect(lines('before\n\n| A |\n| - |\n| x |\n\nafter')).toEqual([
      'before',
      '',
      'A',
      '───',
      'x',
      '',
      'after',
    ])
    expect(lines('before\n\n```\nx\n```\nafter')).toEqual(['before', '', 'x', '', 'after'])
    expect(lines('- a\n  - b\n\n> **quoted**')).toEqual(['• a', '• b', '', '│ quoted'])
  })
})
