import { describe, expect, it, vi } from 'vitest'
import { toneColor } from '../../src/app/App.tsx'
import { darkTheme, lightTheme } from '../../src/theme/theme.ts'
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

  it('colors the process mark by status, keeping failures in danger', () => {
    const ok = new TranscriptModel()
    ok.appendTool('c1', 'bash', JSON.stringify({ command: 'ls' }))
    ok.completeTool('c1', 'a', false)
    const okSpans = ok
      .units({ width: 60, expanded: new Set() })[0]!
      .rows.flatMap((row) => row.spans)
    expect(okSpans.some((span) => span.tone === 'success' && span.text === '⏺ ')).toBe(true)
    expect(okSpans.some((span) => span.tone === 'danger')).toBe(false)

    const reads = new TranscriptModel()
    reads.appendTool('c2', 'read_file', JSON.stringify({ file_path: 'a.ts' }))
    reads.completeTool('c2', 'x', false)
    const readSpans = reads
      .units({ width: 60, expanded: new Set() })[0]!
      .rows.flatMap((row) => row.spans)
    expect(readSpans.some((span) => span.tone === 'success' && span.text === '⏺ ')).toBe(true)

    const bad = new TranscriptModel()
    bad.appendTool('c3', 'bash', JSON.stringify({ command: 'false' }))
    bad.completeTool('c3', 'e1', true)
    const badSpans = bad
      .units({ width: 60, expanded: new Set() })[0]!
      .rows.flatMap((row) => row.spans)
    expect(badSpans.some((span) => span.tone === 'danger' && span.text === '⏺ ')).toBe(true)
  })

  it('maps status marks to the theme success / danger colors in both themes and widths', () => {
    for (const theme of [darkTheme, lightTheme]) {
      for (const width of [100, 60]) {
        const model = new TranscriptModel()
        model.appendTool('c1', 'bash', JSON.stringify({ command: 'ls -la' }))
        model.completeTool('c1', 'a', false)
        model.appendTool('c2', 'bash', JSON.stringify({ command: 'false' }))
        model.completeTool('c2', 'boom', true)
        const spans = model
          .units({ width, expanded: new Set() })
          .flatMap((unit) => unit.rows.flatMap((row) => row.spans))
        expect(
          spans.some(
            (span) =>
              span.tone === 'success' &&
              toneColor(span.tone, theme).join() === theme.success.join(),
          ),
        ).toBe(true)
        expect(
          spans.some(
            (span) =>
              span.tone === 'danger' && toneColor(span.tone, theme).join() === theme.danger.join(),
          ),
        ).toBe(true)
      }
    }
  })

  it('keeps the expanded command and result body unchanged', () => {
    const ok = new TranscriptModel()
    ok.appendTool('c1', 'bash', JSON.stringify({ command: 'echo hi' }))
    ok.completeTool('c1', 'hi', false)
    const okSpans = ok
      .units({ width: 60, expanded: new Set(['tool-c1']) })[0]!
      .rows.flatMap((row) => row.spans)
    expect(okSpans.some((span) => span.tone === 'code' && span.text.includes('echo hi'))).toBe(true)
    expect(okSpans.some((span) => span.tone === 'muted' && span.text === 'hi')).toBe(true)

    const bad = new TranscriptModel()
    bad.appendTool('c2', 'bash', JSON.stringify({ command: 'false' }))
    bad.completeTool('c2', 'boom', true)
    const badSpans = bad
      .units({ width: 60, expanded: new Set(['tool-c2']) })[0]!
      .rows.flatMap((row) => row.spans)
    expect(badSpans.some((span) => span.tone === 'code')).toBe(true)
    expect(badSpans.some((span) => span.tone === 'danger' && span.text === 'boom')).toBe(true)
  })

  it('shows a two-row thinking tail while streaming and keeps it after commit', () => {
    const model = new TranscriptModel()
    model.setPreview({ attemptId: 'a1', revision: 1, reasoning: 'step one\nstep two', text: '' })
    const units = model.units({ width: 60, expanded: new Set() })
    expect(units).toHaveLength(1)
    expect(units[0]!.rows).toHaveLength(2)
    expect(rowText(units[0]!.rows[0]!)).toContain('∴ 思考中')
    expect(rowText(units[0]!.rows[1]!)).toContain('step two')

    model.appendThinking(1, 'step one\nstep two')
    model.appendAssistant(1, [{ type: 'text', text: 'answer' }])
    const committed = model.units({ width: 60, expanded: new Set() })
    const text = committed.flatMap((unit) => unit.rows.map(rowText)).join('\n')
    expect(text).toContain('answer')
    expect(text).toContain('∴ 思考')
    expect(text).toContain('step two')
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

describe('tool result projection', () => {
  function numberedLines(count: number): string {
    return Array.from({ length: count }, (_, index) => `row ${index} ${'x'.repeat(40)}`).join('\n')
  }

  function storedResult(model: TranscriptModel): string {
    const entry = model.all.find((item) => item.kind === 'tool')
    if (entry?.kind !== 'tool' || entry.resultText === undefined) {
      throw new Error('missing tool result')
    }
    return entry.resultText
  }

  it('bounds a 1 MB result before it enters the transcript', () => {
    const model = new TranscriptModel()
    model.appendTool('c1', 'bash', JSON.stringify({ command: 'cat big' }))
    const large = numberedLines(20_000)
    expect(large.length).toBeGreaterThan(1_000_000)

    model.completeTool('c1', large, false)

    const stored = storedResult(model)
    expect(stored.length).toBeLessThan(21_000)
    const lines = stored.split('\n')
    expect(lines).toHaveLength(41)
    expect(lines[0]).toBe(`row 0 ${'x'.repeat(40)}`)
    expect(lines[24]).toBe('… 省略 19960 行 …')
    expect(lines[40]).toBe(`row 19999 ${'x'.repeat(40)}`)
  })

  it('renders the preview head, marker and tail when expanded', () => {
    const model = new TranscriptModel()
    model.appendTool('c1', 'bash', JSON.stringify({ command: 'seq 100' }))
    model.completeTool(
      'c1',
      Array.from({ length: 100 }, (_, index) => `line ${index}`).join('\n'),
      false,
    )

    const rows = model.units({ width: 60, expanded: new Set(['tool-c1']) })[0]!.rows
    const text = rows.map(rowText).join('\n')
    expect(text).toContain('line 0')
    expect(text).toContain('… 省略 60 行 …')
    expect(text).toContain('line 99')
    expect(text).not.toContain('line 50')
  })

  it('keeps the collapsed failure summary to the first three preview lines', () => {
    const model = new TranscriptModel()
    model.appendTool('c1', 'bash', JSON.stringify({ command: 'false' }))
    model.completeTool(
      'c1',
      Array.from({ length: 100 }, (_, index) => `err ${index}`).join('\n'),
      true,
    )

    const rows = model.units({ width: 60, expanded: new Set() })[0]!.rows
    const text = rows.map(rowText).join('\n')
    expect(text).toContain('err 0')
    expect(text).toContain('err 1')
    expect(text).toContain('err 2')
    expect(text).not.toContain('err 3')
  })

  it('keeps subagent activation from the first preview line', () => {
    const model = new TranscriptModel()
    model.appendTool('c1', 'subagent', JSON.stringify({ description: 'x' }))
    model.completeTool('c1', `started subagent child-9\n${'noise\n'.repeat(100)}`, false)

    const unit = model.units({ width: 60, expanded: new Set() })[0]!
    expect(unit.pressId).toBe('subagent:result:child-9')
  })

  it('skips a preview made only of whitespace and markers', () => {
    const model = new TranscriptModel()
    model.appendTool('c1', 'bash', JSON.stringify({ command: 'true' }))
    model.completeTool('c1', '\n'.repeat(99), false)

    const rows = model.units({ width: 60, expanded: new Set(['tool-c1']) })[0]!.rows
    const text = rows.map(rowText).join('\n')
    expect(text).not.toContain('省略')
    expect(rows).toHaveLength(2)
  })

  it('skips a whitespace-only line that carries an inline truncation marker', () => {
    const model = new TranscriptModel()
    model.appendTool('c1', 'bash', JSON.stringify({ command: 'true' }))
    model.completeTool('c1', ' '.repeat(600), false)

    const rows = model.units({ width: 60, expanded: new Set(['tool-c1']) })[0]!.rows
    expect(rows).toHaveLength(2)
  })

  it('keeps rendering a preview with visible content', () => {
    const model = new TranscriptModel()
    model.appendTool('c1', 'bash', JSON.stringify({ command: 'echo hi' }))
    model.completeTool('c1', `visible\n${'\n'.repeat(99)}`, false)

    const rows = model.units({ width: 60, expanded: new Set(['tool-c1']) })[0]!.rows
    expect(rows.map(rowText).join('\n')).toContain('visible')
  })

  it('bumps rev for every content change', () => {
    const model = new TranscriptModel()
    model.appendTool('c1', 'bash', JSON.stringify({ command: 'ls' }))
    const rev = (): number => {
      const entry = model.all.find((item) => item.kind === 'tool')
      return entry?.kind === 'tool' ? entry.rev : -1
    }

    expect(rev()).toBe(0)
    model.completeTool('c1', 'out', false)
    expect(rev()).toBe(1)
    model.markApprovalDecision('c1', 'rejected')
    expect(rev()).toBe(2)
  })

  it('reuses cached rows without splitting again on a cache hit', () => {
    const model = new TranscriptModel()
    model.appendTool('c1', 'bash', JSON.stringify({ command: 'echo hi' }))
    model.completeTool('c1', 'a\nb\nc', false)
    const options = { width: 60, expanded: new Set(['tool-c1']) }
    const first = model.units(options)[0]!.rows

    const split = vi.spyOn(String.prototype, 'split')
    const second = model.units(options)[0]!.rows
    expect(second).toBe(first)
    expect(split).not.toHaveBeenCalled()
    split.mockRestore()
  })

  it('invalidates cached rows when a same-length result changes', () => {
    const model = new TranscriptModel()
    model.appendTool('c1', 'bash', JSON.stringify({ command: 'echo hi' }))
    model.completeTool('c1', 'first', false)
    const options = { width: 60, expanded: new Set(['tool-c1']) }
    expect(model.units(options)[0]!.rows.map(rowText).join('\n')).toContain('first')

    model.completeTool('c1', 'secnd', false)
    expect(model.units(options)[0]!.rows.map(rowText).join('\n')).toContain('secnd')
  })

  it('invalidates cached rows when an approval decision lands', () => {
    const model = new TranscriptModel()
    model.appendTool('c1', 'bash', JSON.stringify({ command: 'echo hi' }))
    model.completeTool('c1', 'ok', false)
    const options = { width: 60, expanded: new Set(['tool-c1']) }
    expect(model.units(options)[0]!.rows.map(rowText).join('\n')).not.toContain('已拒绝')

    model.markApprovalDecision('c1', 'rejected')
    expect(model.units(options)[0]!.rows.map(rowText).join('\n')).toContain('已拒绝')
  })
})
