import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { App, type AppSnapshot } from '../../src/app/App.tsx'
import { DecisionManager } from '../../src/decisions/manager.ts'
import { Renderer } from '../../src/render/renderer.ts'
import { displayWidth } from '../../src/render/text.ts'
import { darkTheme, lightTheme } from '../../src/theme/theme.ts'
import { TranscriptModel } from '../../src/transcript/model.ts'

function snapshot(
  model: TranscriptModel,
  width: number,
  theme = darkTheme,
  overrides: Partial<AppSnapshot> = {},
): AppSnapshot {
  return {
    transcript: model,
    decisions: new DecisionManager(),
    text: '',
    cursor: 0,
    theme,
    width,
    height: 40,
    rootId: 'r',
    modelLabel: '测试',
    status: 'running',
    cwd: '/tmp/project',
    version: '0.2.1',
    expanded: new Set(),
    scrollOffset: 0,
    stickBottom: true,
    userName: '你',
    activity: { text: '' },
    ...overrides,
  }
}

function model(): TranscriptModel {
  const transcript = new TranscriptModel()
  transcript.appendUser('请检查构建', 'req')
  transcript.appendThinking(1, '先看构建脚本，再看输出目录。')
  transcript.appendAssistant(1, [{ type: 'text', text: '好的，我先跑构建。' }])
  transcript.appendTool('b1', 'bash', JSON.stringify({ command: 'make build' }))
  transcript.setLiveOutput('b1', ['compiling src/a.ts', 'compiling src/b.ts', 'done 3 files'])
  transcript.completeTool('b1', 'done 3 files', false)
  transcript.appendTool(
    'q1',
    'ask_user_question',
    JSON.stringify({
      questions: [
        { id: 'q1', question: '用哪种构建？' },
        { id: 'q2', question: '覆盖哪些平台？' },
      ],
    }),
  )
  transcript.completeTool(
    'q1',
    JSON.stringify({
      answers: [
        { id: 'q1', selected: ['增量构建'] },
        { id: 'q2', selected: ['macOS'] },
      ],
    }),
    false,
  )
  return transcript
}

function render(
  transcript: TranscriptModel,
  width: number,
  overrides: Partial<AppSnapshot> = {},
): { lines: string[]; output: string } {
  let output = ''
  const renderer = new Renderer({
    width,
    height: 40,
    defaultFg: darkTheme.fg,
    write: (data) => {
      output += data
    },
  })
  try {
    renderer.mount(
      createElement(App, { snapshot: snapshot(transcript, width, darkTheme, overrides) }),
    )
    renderer.flushFrame()
    return { lines: renderer.snapshotLines(), output }
  } finally {
    renderer.unmount()
  }
}

describe('harness-feel rendered surface', () => {
  for (const width of [60, 100]) {
    it(`${width} columns: Update block stays inside the terminal`, () => {
      const transcript = new TranscriptModel()
      const longPath = `src/${'very-long-directory/'.repeat(12)}file.ts`
      const newText = Array.from({ length: 1500 }, (_, index) => `line ${index}`).join('\n')
      transcript.appendTool('e', 'edit', JSON.stringify({ path: longPath }))
      transcript.completeTool('e', 'ok', false, {
        diffs: [{ path: longPath, oldText: null, newText }],
      })
      const { lines } = render(transcript, width)
      const screen = lines.join('\n')
      expect(screen).toContain('⏺ Update(')
      expect(screen).toContain('+1500 -0')
      expect(screen).toContain('┄')
      for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(width)
    })

    it(`${width} columns: failed question and notice stay inside the terminal`, () => {
      const transcript = new TranscriptModel()
      transcript.appendTool(
        'q',
        'ask_user_question',
        JSON.stringify({ questions: [{ id: 'q1', question: 'Q' }] }),
      )
      transcript.completeTool('q', 'boom: tool failed', true)
      const { lines } = render(transcript, width, {
        status: 'running',
        cwd: '/tmp/project',
        version: '0.2.1',
        notice: { text: '已发送停止请求（队列保留）', tone: 'info' },
      })
      const screen = lines.join('\n')
      expect(screen).toContain('⏺ 问卷')
      expect(screen).toContain('boom: tool failed')
      expect(screen).toContain('v0.2.1 · ')
      expect(screen).toContain('Esc 停止')
      for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(width)
    })
  }

  for (const width of [60, 100]) {
    for (const theme of [darkTheme, lightTheme]) {
      it(`${width} columns / ${theme === darkTheme ? 'dark' : 'light'}: four categories and records`, () => {
        let output = ''
        const renderer = new Renderer({
          width,
          height: 40,
          defaultFg: theme.fg,
          write: (data) => {
            output += data
          },
        })
        try {
          renderer.mount(createElement(App, { snapshot: snapshot(model(), width, theme) }))
          renderer.flushFrame()
          const lines = renderer.snapshotLines()
          const screen = lines.join('\n')
          expect(screen).toContain('❯ 请检查构建')
          expect(screen).toContain('∴ 思考')
          expect(screen).toContain('⏺ 好的，我先跑构建。')
          expect(screen).toContain('⏺ Bash(make build)')
          expect(screen).toContain('⎿')
          expect(screen).toContain('done 3 files')
          expect(screen).toContain('⏺ 问卷 · 已回答 2 题')
          expect(screen).toContain('用哪种构建？ → 增量构建')
          expect(screen).toContain('v0.2.1 · /tmp/project')
          expect(screen).toContain('Enter 插话 · Esc 停止')
          expect(output).toContain(`48;2;${theme.userBg.join(';')}m`)
          for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(width)
        } finally {
          renderer.unmount()
        }
      })
    }
  }
})
