import { describe, expect, it } from 'vitest'
import { diffLines, renderDiffs } from '../../src/transcript/diff.ts'
import { renderMarkdown } from '../../src/transcript/markdown.ts'
import { TranscriptModel } from '../../src/transcript/model.ts'
import { rowText } from '../../src/transcript/spans.ts'

describe('markdown', () => {
  it('renders headings and paragraphs', () => {
    const rows = renderMarkdown('# Title\n\nHello **world**', 40)
    expect(rowText(rows[0]!)).toBe('Title')
    const flat = rows.map(rowText).join('\n')
    expect(flat).toContain('Hello world')
  })

  it('keeps inline code and emphasis spans', () => {
    const rows = renderMarkdown('use `nano` now', 40)
    const spans = rows[0]!.spans
    expect(spans.some((span) => span.tone === 'code')).toBe(true)
  })

  it('renders fenced code with indentation', () => {
    const rows = renderMarkdown('```ts\nconst a = 1\n```', 40)
    const codeRow = rows.find((row) => rowText(row).includes('const a = 1'))
    expect(codeRow?.indent).toBe(2)
  })

  it('wraps long paragraphs', () => {
    const rows = renderMarkdown('alpha beta gamma delta', 10)
    expect(rows.length).toBeGreaterThan(1)
    for (const row of rows) expect(rowText(row).length).toBeLessThanOrEqual(10)
  })
})

describe('diff', () => {
  it('computes add/remove lines', () => {
    const lines = diffLines('a\nb\nc', 'a\nB\nc')
    expect(lines.map((line) => line.op).join('')).toBe(' -+ ')
  })

  it('renders a budget and hides the rest', () => {
    const oldText = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n')
    const newText = Array.from({ length: 40 }, (_, i) => `line ${i + 100}`).join('\n')
    const rows = renderDiffs([{ path: 'x.ts', oldText, newText }], 60, { budget: 8 })
    const text = rows.map(rowText).join('\n')
    expect(text).toContain('x.ts')
    expect(text).toContain('还有')
  })
})

describe('process display', () => {
  it('merges consecutive read calls into one counting row', () => {
    const model = new TranscriptModel()
    model.appendTool('c1', 'read_file', JSON.stringify({ file_path: 'a.ts' }))
    model.completeTool('c1', 'x', false)
    model.appendTool('c2', 'grep', JSON.stringify({ pattern: 'foo' }))
    model.completeTool('c2', 'y', false)
    const units = model.units({ width: 60, expanded: new Set() })
    expect(units).toHaveLength(1)
    expect(rowText(units[0]!.rows[0]!)).toContain('读取 2 项')
  })

  it('keeps zero result rows for a successful bash and three for a failure', () => {
    const ok = new TranscriptModel()
    ok.appendTool('c1', 'bash', JSON.stringify({ command: 'ls' }))
    ok.completeTool('c1', 'a\nb\nc\nd', false)
    const okRows = ok.units({ width: 60, expanded: new Set() })[0]!.rows
    expect(okRows).toHaveLength(1)

    const bad = new TranscriptModel()
    bad.appendTool('c1', 'bash', JSON.stringify({ command: 'false' }))
    bad.completeTool('c1', 'e1\ne2\ne3\ne4', true)
    const badRows = bad.units({ width: 60, expanded: new Set() })[0]!.rows
    expect(badRows).toHaveLength(4)
  })

  it('shows one thinking row while streaming and drops it after commit', () => {
    const model = new TranscriptModel()
    model.setPreview({ attemptId: 'a1', revision: 1, reasoning: 'step one\nstep two', text: '' })
    const units = model.units({ width: 60, expanded: new Set() })
    expect(units).toHaveLength(1)
    expect(units[0]!.rows).toHaveLength(1)

    model.appendAssistant(1, [
      { type: 'reasoning', text: 'step one\nstep two' },
      { type: 'text', text: 'answer' },
    ])
    const committed = model.units({ width: 60, expanded: new Set() })
    const text = committed.flatMap((unit) => unit.rows.map(rowText)).join('\n')
    expect(text).toContain('answer')
    expect(text).not.toContain('step one')
  })

  it('expands a failing tool beyond the three-line summary', () => {
    const model = new TranscriptModel()
    model.appendTool('c1', 'bash', JSON.stringify({ command: 'false' }))
    model.completeTool('c1', 'e1\ne2\ne3\ne4', true)
    const expanded = model.units({ width: 60, expanded: new Set(['tool-c1']) })
    const text = expanded[0]!.rows.map(rowText).join('\n')
    expect(text).toContain('e4')
  })
})
