/** Regression tests for the findings of the first review round. */

import { createElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import Yoga from 'yoga-layout'
import { App } from '../../src/app/App.tsx'
import { InputModel } from '../../src/app/input-model.ts'
import { NanoApp } from '../../src/app/nano-app.ts'
import { ConversationController } from '../../src/conversation/controller.ts'
import { DecisionManager as Decisions } from '../../src/decisions/manager.ts'
import { InputParser } from '../../src/input/parser.ts'
import { CellGrid } from '../../src/render/grid.ts'
import { box, Renderer, text } from '../../src/render/renderer.ts'
import { darkTheme } from '../../src/theme/theme.ts'
import { diffLines } from '../../src/transcript/diff.ts'
import { TranscriptModel } from '../../src/transcript/model.ts'
import { textSpan, wrapSpans } from '../../src/transcript/spans.ts'

function fakeController() {
  const history = { record: () => {}, entries: () => [] }
  return new ConversationController({
    ctx: {},
    official: {},
    rootId: 'r',
    cwd: '/tmp',
    history: history as never,
  })
}

describe('streaming preview', () => {
  it('accepts chunks whose revision advances per frame', () => {
    const controller = fakeController()
    const internals = controller as unknown as {
      handleStreamFrame: (frame: unknown) => void
    }
    internals.handleStreamFrame({ type: 'start', attemptId: 'a', revision: 1 })
    internals.handleStreamFrame({
      type: 'chunk',
      attemptId: 'a',
      revision: 2,
      chunk: { type: 'text-delta', text: 'hel' },
    })
    internals.handleStreamFrame({
      type: 'chunk',
      attemptId: 'a',
      revision: 3,
      chunk: { type: 'reasoning-delta', text: 'think' },
    })
    expect(controller.model.preview?.text).toBe('hel')
    expect(controller.model.preview?.reasoning).toBe('think')
  })

  it('ignores frames from another attempt', () => {
    const controller = fakeController()
    const internals = controller as unknown as { handleStreamFrame: (frame: unknown) => void }
    internals.handleStreamFrame({ type: 'start', attemptId: 'a', revision: 1 })
    internals.handleStreamFrame({
      type: 'chunk',
      attemptId: 'b',
      revision: 2,
      chunk: { type: 'text-delta', text: 'x' },
    })
    expect(controller.model.preview?.text).toBe('')
  })
})

describe('span wrapping', () => {
  it('does not glue words when the line is exactly full', () => {
    const rows = wrapSpans([textSpan('ab cd ef')], 5)
    expect(rows.map((row) => row.spans.map((span) => span.text).join(''))).toEqual(['ab cd', 'ef'])
  })
})

describe('question custom input', () => {
  it('lets spaces and the letter c be typed as text', async () => {
    const app = new NanoApp({
      core: { ctx: {}, dispose: async () => {} } as never,
      official: {} as never,
      terminal: { width: 80, height: 24, copyToClipboard: () => {} } as never,
      renderer: { update: () => {}, resize: () => {} } as never,
      claim: { rootId: 'r', path: '/tmp/x', recovered: false },
      dataRoot: '/tmp',
      cwd: '/tmp',
      rootId: 'r',
      conversation: fakeController(),
      history: {} as never,
      writeDiagnostic: () => {},
    })
    const manager = app.decisionsManager
    const pending = manager.simulateQuestion([
      { id: 'q', question: 'pick', options: [{ label: 'A' }] },
    ])
    await Promise.resolve()
    const key = (name: string, extra: any = {}) => ({
      type: 'key' as const,
      key: {
        name,
        text: extra.text,
        ctrl: false,
        alt: false,
        shift: false,
        meta: false,
        sequence: '',
        ...extra,
      },
    })
    app.handleInput([key('char', { text: 'c' })])
    for (const char of ['a', 'c', ' ', 'b']) app.handleInput([key('char', { text: char })])
    const prompt = manager.prompt
    expect(prompt?.kind).toBe('question')
    if (prompt?.kind === 'question') {
      expect(prompt.drafts.get('q')?.custom).toBe('ac b')
      expect(prompt.drafts.get('q')?.customMode).toBe(true)
    }
    manager.submitQuestions()
    await pending
  })
})

describe('renderer regressions', () => {
  it('paints whitespace-only text with its real width', () => {
    const chunks: string[] = []
    const renderer = new Renderer({
      write: (bytes) => chunks.push(bytes),
      width: 10,
      height: 1,
      defaultFg: darkTheme.fg,
    })
    renderer.mount(box({ flexDirection: 'row', width: 10, height: 1 }, text('  '), text('ab')))
    renderer.flushFrame()
    expect(renderer.snapshotLines()[0]).toBe('  ab')
    renderer.unmount()
  })

  it('prefers the topmost pressable region (overlay wins)', () => {
    const renderer = new Renderer({
      write: () => {},
      width: 20,
      height: 4,
      defaultFg: darkTheme.fg,
    })
    renderer.mount(
      box(
        { flexDirection: 'column', width: 20, height: 4 },
        box({ onPress: 'under' }, text('row')),
        box({ onPress: 'over', position: 'absolute', left: 0, top: 0, width: 20, height: 4 }),
      ),
    )
    renderer.flushFrame()
    expect(renderer.pressIdAt(2, 0)).toBe('over')
    renderer.unmount()
  })

  it('frees every Yoga node on unmount', () => {
    const created = vi.spyOn(Yoga.Node, 'create')
    const freed = vi.spyOn(Yoga.Node.prototype, 'free')
    const before = created.mock.results.length
    const renderer = new Renderer({
      write: () => {},
      width: 20,
      height: 4,
      defaultFg: darkTheme.fg,
    })
    renderer.mount(box({ flexDirection: 'column' }, text('a'), text('b')))
    renderer.flushFrame()
    renderer.unmount()
    const made = created.mock.calls.length - before
    expect(made).toBeGreaterThan(0)
    expect(freed.mock.calls.length).toBeGreaterThanOrEqual(made)
    created.mockRestore()
    freed.mockRestore()
  })
})

describe('layout regressions', () => {
  it('right-aligns the status hint on an 80-column screen', () => {
    const model = new TranscriptModel()
    const renderer = new Renderer({
      write: () => {},
      width: 80,
      height: 24,
      defaultFg: darkTheme.fg,
    })
    renderer.mount(
      createElement(App, {
        snapshot: {
          transcript: model,
          decisions: new Decisions(),
          text: '',
          cursor: 0,
          theme: darkTheme,
          width: 80,
          height: 24,
          rootId: 'r',
          modelLabel: 'deepseek-official/deepseek-chat',
          status: 'idle',
          expanded: new Set<string>(),
          scrollOffset: 0,
          stickBottom: true,
          userName: '你',
        },
      }),
    )
    renderer.flushFrame()
    const status = renderer.snapshotLines()[18] ?? ''
    expect(status.trimEnd().endsWith('退出')).toBe(true)
    expect(status).toContain('nano 0.2.0')
    renderer.unmount()
  })
})

describe('grid regressions', () => {
  it('gives wide graphemes two cells and a continuation marker', () => {
    const grid = new CellGrid(6, 2)
    grid.feed('中ab')
    expect(grid.rows[0]?.[0]?.grapheme).toBe('中')
    expect(grid.rows[0]?.[1]?.continuation).toBe(true)
    expect(grid.text()[0]).toBe('中ab')
    expect(grid.cursor.col).toBe(4)
  })

  it('maps xterm 256 colours to the cube, not the first 16', () => {
    const grid = new CellGrid(4, 1)
    grid.feed('\x1b[38;5;196mX')
    expect(grid.rows[0]?.[0]?.style.fg).toEqual([255, 0, 0])
  })
})

describe('parser regressions', () => {
  it('parses Alt+Backspace and Alt+Enter as their keys', () => {
    const parser = new InputParser()
    const events = parser.feed('\x1b\x7f\x1b\r')
    expect(events[0]).toMatchObject({ type: 'key', key: { name: 'backspace', alt: true } })
    expect(events[1]).toMatchObject({ type: 'key', key: { name: 'enter', alt: true } })
  })

  it('drops an incomplete escape after the timeout instead of eating the next key', () => {
    const parser = new InputParser()
    expect(parser.feed('\x1b[1')).toEqual([])
    expect(parser.flushPending()).toEqual([])
    const next = parser.feed('a')
    expect(next[0]).toMatchObject({ type: 'key', key: { name: 'char', text: 'a' } })
  })
})

describe('diff and editor regressions', () => {
  it('treats an empty old file as no lines', () => {
    expect(diffLines('', 'a\nb').map((line) => line.op)).toEqual(['+', '+'])
  })

  it('keeps the cursor inside a merged grapheme', () => {
    const input = new InputModel()
    input.insert('e')
    input.insert('́')
    expect(input.text).toBe('e\u0301')
    expect(input.graphemes).toHaveLength(1)
    expect(input.cursor).toBe(1)
    input.backspace()
    expect(input.text).toBe('')
  })
})
