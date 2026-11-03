import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { App, type AppSnapshot } from '../../src/app/App.tsx'
import { buildQuestionCard } from '../../src/app/question-card.ts'
import { DecisionManager } from '../../src/decisions/manager.ts'
import { resolveKey } from '../../src/input/keymap.ts'
import type { Key } from '../../src/input/parser.ts'
import { Renderer } from '../../src/render/renderer.ts'
import { displayWidth, graphemeWidth } from '../../src/render/text.ts'
import { darkTheme } from '../../src/theme/theme.ts'
import { renderDiffs } from '../../src/transcript/diff.ts'
import { type ToolEntry, TranscriptModel } from '../../src/transcript/model.ts'
import { rowText } from '../../src/transcript/spans.ts'

function snapshot(model: TranscriptModel, overrides: Partial<AppSnapshot> = {}): AppSnapshot {
  return {
    transcript: model,
    decisions: new DecisionManager(),
    text: '',
    cursor: 0,
    theme: darkTheme,
    width: 80,
    height: 30,
    rootId: 'root',
    modelLabel: 'test/model',
    status: 'idle',
    expanded: new Set<string>(),
    scrollOffset: 0,
    stickBottom: true,
    userName: '你',
    ...overrides,
  }
}

function screen(model: TranscriptModel, overrides: Partial<AppSnapshot> = {}): string[] {
  const width = overrides.width ?? 80
  const height = overrides.height ?? 30
  const renderer = new Renderer({ width, height, defaultFg: darkTheme.fg, write: () => {} })
  try {
    renderer.mount(createElement(App, { snapshot: snapshot(model, overrides) }))
    renderer.flushFrame()
    return renderer.snapshotLines()
  } finally {
    renderer.unmount()
  }
}

function key(name: Key['name'], extra: Partial<Key> = {}): Key {
  return { name, ctrl: false, alt: false, shift: false, meta: false, sequence: '', ...extra }
}

function tool(model: TranscriptModel, callId = 'c1'): ToolEntry {
  const entry = model.all.find((item) => item.kind === 'tool' && item.callId === callId)
  if (entry?.kind !== 'tool') throw new Error('missing tool entry')
  return entry
}

describe('version in the status line (spec §3.1)', () => {
  for (const width of [60, 100]) {
    it(`${width} columns keeps v<version> · cwd and the running hint`, () => {
      const model = new TranscriptModel()
      const lines = screen(model, {
        width,
        height: 20,
        status: 'running',
        cwd: '/tmp/project',
        version: '0.2.1',
      })
      const status = lines.at(-1) ?? ''
      expect(status).toContain('v0.2.1 · /tmp/project')
      expect(status).toContain('Enter 插话 · Esc 停止')
    })
  }

  it('omits the v prefix when the package version is missing', () => {
    const model = new TranscriptModel()
    const lines = screen(model, { width: 60, height: 20, cwd: '/tmp/project' })
    const status = lines.at(-1) ?? ''
    expect(status).toContain('/tmp/project')
    expect(status).not.toContain('v0.0.0')
    expect(status.trimStart().startsWith('v')).toBe(false)
  })

  it('truncates a notice so the right-side hint survives at 60 columns', () => {
    const model = new TranscriptModel()
    const lines = screen(model, {
      width: 60,
      height: 20,
      status: 'running',
      cwd: '/tmp/project',
      version: '0.2.1',
      notice: { text: '已发送停止请求（队列保留）', tone: 'info' },
    })
    const status = lines.at(-1) ?? ''
    expect(status).toContain('v0.2.1 · ')
    expect(status).toContain('Esc 停止')
    expect(displayWidth(status)).toBeLessThanOrEqual(60)
  })
})

describe('question record projection (spec §3.3)', () => {
  it('renders question → answer rows and drops the raw JSON', () => {
    const model = new TranscriptModel()
    model.appendTool(
      'q',
      'ask_user_question',
      JSON.stringify({
        questions: [
          { id: 'q1', question: '采用哪种方案？' },
          { id: 'q2', question: '覆盖哪些平台？', multi_select: true },
          { id: 'q3', question: '备注？' },
        ],
      }),
    )
    model.completeTool(
      'q',
      JSON.stringify({
        answers: [
          { id: 'q1', selected: ['方案 A'] },
          { id: 'q2', selected: ['macOS', 'Linux'], custom: 'Windows' },
          { id: 'q3', selected: [] },
        ],
      }),
      false,
    )
    const entry = tool(model, 'q')
    expect(entry.questionOutcome).toBe('answered')
    expect(entry.resultText).toBe('')
    expect(entry.questionAnswers?.map((line) => line.answer)).toEqual([
      '方案 A',
      'macOS、Linux、Windows',
      '（已跳过）',
    ])
    const text = model
      .units({ width: 100, expanded: new Set() })
      .flatMap((unit) => unit.rows.map(rowText))
      .join('\n')
    expect(text).toContain('⏺ 问卷 · 已回答 3 题')
    expect(text).toContain('采用哪种方案？ → 方案 A')
    expect(text).toContain('覆盖哪些平台？ → macOS、Linux、Windows')
    expect(text).not.toContain('"answers"')
  })

  it('marks an all-empty answer batch as skipped', () => {
    const model = new TranscriptModel()
    model.appendTool(
      'q',
      'ask_user_question',
      JSON.stringify({ questions: [{ id: 'q1', question: 'Q' }] }),
    )
    model.completeTool('q', JSON.stringify({ answers: [{ id: 'q1', selected: [] }] }), false)
    expect(tool(model, 'q').questionOutcome).toBe('skipped')
    const text = model
      .units({ width: 80, expanded: new Set() })
      .flatMap((unit) => unit.rows.map(rowText))
      .join('\n')
    expect(text).toContain('⏺ 问卷 · 已跳过')
    expect(text).toContain('Q → （已跳过）')
  })

  it('records a cancelled batch without a red failure summary', () => {
    const model = new TranscriptModel()
    model.appendTool(
      'q',
      'ask_user_question',
      JSON.stringify({ questions: [{ id: 'q1', question: 'Q' }] }),
    )
    model.completeTool('q', 'ask_user_question was aborted before the user answered', true)
    expect(tool(model, 'q').questionOutcome).toBe('cancelled')
    expect(tool(model, 'q').resultText).toBe('')
    const rows = model.units({ width: 80, expanded: new Set() })[0]!.rows
    const text = rows.map(rowText).join('\n')
    expect(text).toContain('· 已取消，未提交答案')
    expect(text).not.toContain('（无错误输出）')
  })

  it('falls back to the existing tool row when the result is not JSON', () => {
    const model = new TranscriptModel()
    model.appendTool(
      'q',
      'ask_user_question',
      JSON.stringify({ questions: [{ id: 'q1', question: 'Q' }] }),
    )
    model.completeTool('q', 'not-json', false)
    const entry = tool(model, 'q')
    expect(entry.questionOutcome).toBeUndefined()
    expect(entry.resultText).toBe('not-json')
    const text = model
      .units({ width: 80, expanded: new Set() })
      .flatMap((unit) => unit.rows.map(rowText))
      .join('\n')
    expect(text).toContain('⏺ 问卷')
    expect(text).not.toContain('问答')
    // 解析失败要退回「标题 + 预览」，展开态能看到原始结果（F3）。
    const expanded = model
      .units({ width: 80, expanded: new Set(['tool-q']) })
      .flatMap((unit) => unit.rows.map(rowText))
      .join('\n')
    expect(expanded).toContain('not-json')
  })

  it('keeps a non-aborted error summary visible after expansion', () => {
    const model = new TranscriptModel()
    model.appendTool(
      'q',
      'ask_user_question',
      JSON.stringify({ questions: [{ id: 'q1', question: 'Q' }] }),
    )
    model.completeTool('q', 'boom: tool failed', true)
    const collapsed = model
      .units({ width: 80, expanded: new Set() })
      .flatMap((unit) => unit.rows.map(rowText))
      .join('\n')
    expect(collapsed).toContain('boom: tool failed')
    const expanded = model
      .units({ width: 80, expanded: new Set(['tool-q']) })
      .flatMap((unit) => unit.rows.map(rowText))
      .join('\n')
    expect(expanded).toContain('boom: tool failed')
  })

  it('distinguishes a missing answer item from an explicit skip', () => {
    const model = new TranscriptModel()
    model.appendTool(
      'q',
      'ask_user_question',
      JSON.stringify({
        questions: [
          { id: 'q1', question: '有答案' },
          { id: 'q2', question: '明确跳过' },
          { id: 'q3', question: '没有答案项' },
        ],
      }),
    )
    model.completeTool(
      'q',
      JSON.stringify({
        answers: [
          { id: 'q1', selected: ['A'] },
          { id: 'q2', selected: [] },
        ],
      }),
      false,
    )
    expect(tool(model, 'q').questionAnswers?.map((line) => line.answer)).toEqual([
      'A',
      '（已跳过）',
      '（未回答）',
    ])
  })

  it('parses a long custom answer before preview truncation', () => {
    const custom = '很长的自定义答案'.repeat(80)
    const model = new TranscriptModel()
    model.appendTool(
      'q',
      'ask_user_question',
      JSON.stringify({ questions: [{ id: 'q1', question: 'Q' }] }),
    )
    model.completeTool(
      'q',
      JSON.stringify({ answers: [{ id: 'q1', selected: [], custom }] }),
      false,
    )
    expect(tool(model, 'q').questionAnswers?.[0]?.answer).toBe(custom)
  })
})

describe('streaming thinking tail (spec §3.4)', () => {
  it('keeps two rows, left-truncates the tail and retains it after completion', () => {
    const model = new TranscriptModel()
    const reasoning = `first line\n${'tail '.repeat(40)}`
    model.setPreview({ attemptId: 'a', revision: 1, reasoning, text: '' })
    const rows = model.units({ width: 40, expanded: new Set() })[0]!.rows
    expect(rows).toHaveLength(2)
    expect(rowText(rows[0]!)).toContain('∴ 思考中')
    expect(rowText(rows[1]!)).toContain('…')
    expect(rowText(rows[1]!)).toContain('tail')

    model.appendThinking(1, reasoning)
    model.appendAssistant(1, [{ type: 'text', text: 'done' }])
    const committed = model.units({ width: 40, expanded: new Set() })
    const thinking = committed.find((unit) => unit.kind === 'thinking')
    expect(thinking?.rows).toHaveLength(2)
    expect(rowText(thinking!.rows[1]!)).toContain('tail')
    expect(thinking!.kind).toBe('thinking')
  })

  it('expands to both retained lines and never stores the full reasoning', () => {
    const model = new TranscriptModel()
    model.appendThinking(1, 'keep one\nkeep two\ndrop three')
    const entry = model.all.find((item) => item.kind === 'thinking')
    expect(entry?.kind === 'thinking' ? entry.lines : []).toEqual(['keep two', 'drop three'])
    const text = model
      .units({ width: 80, expanded: new Set(['thinking-1']) })
      .flatMap((unit) => unit.rows.map(rowText))
      .join('\n')
    expect(text).toContain('keep two')
    expect(text).toContain('drop three')
    expect(text).not.toContain('keep one')
  })
})

describe('foreground Bash live output (spec §3.5)', () => {
  it('keeps the last five lines and keeps them after completion', () => {
    const model = new TranscriptModel()
    model.appendTool('b', 'bash', JSON.stringify({ command: 'make' }))
    model.setLiveOutput('b', ['1', '2', '3', '4', '5', '6'])
    expect(tool(model, 'b').liveOutput).toEqual(['2', '3', '4', '5', '6'])
    model.completeTool('b', 'done', false)
    expect(tool(model, 'b').liveOutput).toEqual(['2', '3', '4', '5', '6'])
    const text = model
      .units({ width: 60, expanded: new Set() })
      .flatMap((unit) => unit.rows.map(rowText))
      .join('\n')
    expect(text).toContain('⎿')
    expect(text).toContain('6')
    expect(text).not.toContain('完成')
  })

  it('ignores background calls and clears the job binding without dropping output', () => {
    const model = new TranscriptModel()
    model.appendTool('b', 'bash', JSON.stringify({ command: 'make', run_in_background: true }))
    expect(model.setLiveOutput('b', ['x'])).toBe(false)
    expect(tool(model, 'b').liveOutput).toBeUndefined()

    model.appendTool('f', 'bash', JSON.stringify({ command: 'make' }))
    model.attachLiveJob('f', 'job-1')
    model.setLiveOutput('f', ['x'])
    model.clearLiveJob('f')
    expect(tool(model, 'f').liveJobId).toBeUndefined()
    expect(tool(model, 'f').liveOutput).toEqual(['x'])
  })
})

describe('waiting status and four visual marks (spec §3.8 / §3.9)', () => {
  it('maps the approval callId to waiting and back', () => {
    const model = new TranscriptModel()
    model.appendTool('c', 'bash', JSON.stringify({ command: 'rm -rf build' }))
    expect(model.markWaiting('c', true)).toBe(true)
    expect(tool(model, 'c').status).toBe('waiting')
    expect(
      model
        .units({ width: 60, expanded: new Set() })[0]!
        .rows.flatMap((row) => row.spans)
        .some((span) => span.tone === 'warning' && span.text === '⏺ '),
    ).toBe(true)
    model.markWaiting('c', false)
    expect(tool(model, 'c').status).toBe('running')
    model.completeTool('c', 'ok', false)
    expect(tool(model, 'c').status).toBe('ok')
  })

  it('paints the user row with ❯ and userBg, without bold or accent', () => {
    const model = new TranscriptModel()
    model.appendUser('hello', 'req')
    const rows = model.units({ width: 60, expanded: new Set() })[0]!.rows
    expect(rows.every((row) => row.background === 'userBg')).toBe(true)
    expect(rowText(rows[0]!)).toBe('❯ hello')
    expect(rows[0]!.spans[0]).toMatchObject({ tone: 'muted', text: '❯ ' })
    expect(rows[0]!.spans[1]).toMatchObject({ tone: 'normal', text: 'hello' })
    expect(rows[0]!.spans.some((span) => span.bold === true)).toBe(false)
  })

  it('leads assistant text with ⏺, uses normal bold headings and - lists', () => {
    const model = new TranscriptModel()
    model.appendAssistant(1, [{ type: 'text', text: '# Title\n\n- first' }])
    const rows = model.units({ width: 60, expanded: new Set() })[0]!.rows
    expect(rowText(rows[0]!)).toBe('⏺ Title')
    expect(rows[0]!.spans.some((span) => span.bold === true && span.tone === 'normal')).toBe(true)
    expect(rows.some((row) => rowText(row).trimStart().startsWith('- '))).toBe(true)
  })

  it('treats ⏺ as one cell so ⏺ + two spaces stay aligned', () => {
    expect(graphemeWidth('⏺')).toBe(1)
  })

  it('keeps the Update head inside 60/100 columns with a long path and large counters', () => {
    const longPath = `src/${'very-long-directory/'.repeat(12)}file.ts`
    const newText = Array.from({ length: 1500 }, (_, index) => `line ${index}`).join('\n')
    for (const width of [60, 100]) {
      const rows = renderDiffs([{ path: longPath, oldText: null, newText }], width)
      for (const row of rows) {
        expect((row.indent ?? 0) + displayWidth(rowText(row))).toBeLessThanOrEqual(width)
      }
      expect(rows.map(rowText).join('\n')).toContain('+1500')
    }
  })

  it('numbers diff lines and shows +N -M in the Update block', () => {
    const model = new TranscriptModel()
    model.appendTool('e', 'edit', JSON.stringify({ path: 'x.ts' }))
    model.completeTool('e', 'ok', false, {
      diffs: [{ path: 'x.ts', oldText: 'a\nb\nc', newText: 'a\nB\nc' }],
    })
    const text = model
      .units({ width: 80, expanded: new Set() })
      .flatMap((unit) => unit.rows.map(rowText))
      .join('\n')
    expect(text).toContain('⏺ Update(x.ts) +1 -1')
    expect(text).toContain('┄')
    expect(text).toContain('2 - b')
    expect(text).toContain('2 + B')
    expect(text).toContain('Updated x.ts with 1 addition and 1 removal')
  })
})

describe('Esc routing (spec §3.7)', () => {
  it('maps Escape to stop only while running', () => {
    expect(resolveKey(key('escape'), ['input', 'running'])).toBe('conversation.cancel')
    expect(resolveKey(key('escape'), ['input', 'idle'])).toBeUndefined()
    expect(resolveKey(key('escape'), ['overlay', 'running'])).toBe('overlay.escape')
  })
})

describe('Other row placeholder (spec §3.6)', () => {
  const questions = [
    {
      id: 'q1',
      question: '选一个',
      options: [{ label: 'A' }, { label: 'B' }],
    },
  ]

  function cardRows(manager: DecisionManager): string {
    const prompt = manager.prompt
    if (prompt?.kind !== 'question') throw new Error('missing prompt')
    return buildQuestionCard(prompt, 60).body.map(rowText).join('\n')
  }

  it('hides the placeholder when the Other row is unfocused and empty', async () => {
    const manager = new DecisionManager()
    const pending = manager.simulateQuestion(questions)
    const cancelled = pending.catch(() => {})
    try {
      expect(cardRows(manager)).toContain('3. 其他')
      expect(cardRows(manager)).not.toContain('3. 其他：直接输入')
      manager.focusCustom()
      expect(cardRows(manager)).toContain('3. 其他：直接输入')
    } finally {
      manager.cancelQuestions()
      await cancelled
    }
  })

  it('shows the custom value when unfocused and non-empty', async () => {
    const manager = new DecisionManager()
    const pending = manager.simulateQuestion(questions)
    const cancelled = pending.catch(() => {})
    try {
      manager.focusCustom()
      manager.typeCustom('自定义')
      manager.move(-1)
      const rows = cardRows(manager)
      expect(rows).toContain('3. 其他：自定义')
      expect(rows).not.toContain('▏')
    } finally {
      manager.cancelQuestions()
      await cancelled
    }
  })
})
