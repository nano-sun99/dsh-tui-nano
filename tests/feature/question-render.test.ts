import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import {
  App,
  type AppSnapshot,
  questionCardRows,
  transcriptBodyHeight,
} from '../../src/app/App.tsx'
import {
  buildQuestionCard,
  questionCardCap,
  questionCardWindow,
  questionTabWidth,
} from '../../src/app/question-card.ts'
import { DecisionManager } from '../../src/decisions/manager.ts'
import { Text } from '../../src/render/components.ts'
import { Renderer } from '../../src/render/renderer.ts'
import { displayWidth } from '../../src/render/text.ts'
import { darkTheme, lightTheme } from '../../src/theme/theme.ts'
import { TranscriptModel } from '../../src/transcript/model.ts'
import { rowText } from '../../src/transcript/spans.ts'

const questions = [
  {
    id: 'q1',
    header: '验收方式',
    question: '这次改动采用哪种验收方式？',
    options: [
      { label: '聚焦回归（推荐）', description: '覆盖本次修改相关的检查，反馈较快。' },
      { label: '完整回归', description: '检查范围更广，需要等待更多脚本完成。' },
    ],
  },
  {
    id: 'q2',
    header: '测试范围',
    question: '需要覆盖哪些终端场景？',
    multiSelect: true,
    options: [
      { label: '普通宽度', description: '检查常规终端里的阅读与输入。' },
      { label: '窄终端', description: '检查换行、折叠和选项可见性。' },
    ],
  },
]

function snapshot(
  decisions: DecisionManager,
  width: number,
  theme = darkTheme,
  height = 36,
): AppSnapshot {
  const transcript = new TranscriptModel()
  transcript.setPreview({ text: '对话正文保持可见', reasoning: '' })
  return {
    decisions,
    transcript,
    text: '隐藏但保留的草稿',
    cursor: 0,
    theme,
    width,
    height,
    rootId: 'r',
    modelLabel: '测试',
    status: 'running',
    expanded: new Set(),
    scrollOffset: 0,
    stickBottom: true,
    userName: '用户',
    notice: { text: '等待你的选择', tone: 'info' },
  }
}

describe('question card rendered surface', () => {
  it('shows the question instead of an already-open model panel and restores the panel afterwards', async () => {
    const manager = new DecisionManager()
    const pending = manager.simulateQuestion(questions)
    const cancelled = pending.catch(() => {})
    const view = {
      ...snapshot(manager, 80),
      modelPanelRows: 18,
      modelPanelBody: createElement(Text, {}, 'MODEL PANEL'),
    }
    const renderer = new Renderer({ width: 80, height: 36, write: () => {} })
    try {
      renderer.mount(createElement(App, { snapshot: view }))
      renderer.flushFrame()
      const screen = renderer.snapshotLines().join('\n')
      expect(screen).toContain('这次改动采用哪种验收方式？')
      expect(screen).toContain('等待你的选择')
      expect(screen).not.toContain('MODEL PANEL')
      expect(transcriptBodyHeight(view)).toBe(transcriptBodyHeight({ ...view, modelPanelRows: 0 }))
      manager.cancelQuestions()
      renderer.update(createElement(App, { snapshot: view }))
      renderer.flushFrame()
      expect(renderer.snapshotLines().join('\n')).toContain('MODEL PANEL')
    } finally {
      manager.cancelQuestions()
      await cancelled
      renderer.unmount()
    }
  })
  for (const width of [60, 100])
    for (const theme of [darkTheme, lightTheme]) {
      it(`${width} columns / ${theme === darkTheme ? 'dark' : 'light'}: inline layout, text and RGB roles`, async () => {
        const manager = new DecisionManager()
        const pending = manager.simulateQuestion(questions)
        manager.selectIndex(0)
        manager.focusQuestion(0)
        manager.move(1)
        let output = ''
        const renderer = new Renderer({
          width,
          height: 36,
          defaultFg: theme.fg,
          write: (data) => {
            output += data
          },
        })
        const view = snapshot(manager, width, theme)
        try {
          renderer.mount(createElement(App, { snapshot: view }))
          renderer.flushFrame()
          const lines = renderer.snapshotLines()
          const screen = lines.join('\n')
          expect(screen).toContain('对话正文保持可见')
          expect(screen).not.toContain('隐藏但保留的草稿')
          expect(screen).toContain('1. 聚焦回归（推荐） ✓')
          expect(screen).toContain('> 2. 完整回归')
          expect(screen.split('覆盖本次修改相关的检查，反馈较快。')).toHaveLength(2)
          expect(screen).toContain('       覆盖本次修改相关的检查')
          expect(screen).toContain('3. 其他：直接输入')
          expect(screen).toContain('等待你的选择')
          const rule = lines.findIndex((text) => text.includes('─'))
          expect(lines[rule]?.trim()).toHaveLength(width - 4)
          expect(lines[rule + 1]?.trim()).toBe('')
          for (const text of lines) expect(displayWidth(text)).toBeLessThanOrEqual(width)
          expect(questionCardRows(view)).toBeLessThanOrEqual(questionCardCap(view.height))
          expect(transcriptBodyHeight(view)).toBeGreaterThanOrEqual(8)
          expect(output).toContain(
            `\x1b[0;1;38;2;${theme.success.join(';')}m  1. 聚焦回归（推荐） ✓`,
          )
          expect(output).toContain(`\x1b[0;1;38;2;${theme.accent.join(';')}m> 2. 完整回归`)
          expect(renderer.pressIdAt(2, rule + 2)).toBe('decision:tab:0')
          expect(renderer.pressIdAt(22, rule + 2)).toBe('decision:tab:1')
        } finally {
          manager.skipQuestion()
          manager.skipQuestion()
          manager.submitQuestions()
          await pending
          renderer.unmount()
        }
      })
    }

  it.each([6, 8, 10, 12, 16, 18, 24])(
    'keeps the entire question card and status visible at height %s',
    async (height) => {
      const manager = new DecisionManager()
      const pending = manager.simulateQuestion(questions)
      const rejected = pending.catch(() => {})
      manager.focusQuestion(1)
      manager.confirmFocused()
      const view = snapshot(manager, 60, darkTheme, height)
      const renderer = new Renderer({ width: 60, height, write: () => {} })
      try {
        renderer.mount(createElement(App, { snapshot: view }))
        renderer.flushFrame()
        const screen = renderer.snapshotLines().join('\n')
        expect(questionCardRows(view)).toBeLessThanOrEqual(questionCardCap(height))
        expect(screen).toContain('等待你的选择')
        if (questionCardCap(height) >= 4) {
          expect(screen).toContain('请至少选择一项。')
          expect(screen).toContain('> 1.')
          expect(screen).toContain('Esc 取消')
        } else expect(screen).toContain('终端过矮')
      } finally {
        manager.cancelQuestions()
        await rejected
        renderer.unmount()
      }
    },
  )

  it('keeps the empty custom placeholder when focused', async () => {
    const manager = new DecisionManager()
    const pending = manager.simulateQuestion(questions)
    const rejected = pending.catch(() => {})
    manager.focusCustom()
    const prompt = manager.prompt
    if (prompt?.kind !== 'question') throw new Error('missing question')
    expect(buildQuestionCard(prompt, 56).body.map(rowText).join('\n')).toContain('其他：直接输入▏')
    manager.cancelQuestions()
    await rejected
  })

  it('keeps four long tabs on one row at 60 columns and preserves the current tab', async () => {
    const manager = new DecisionManager()
    const pending = manager.simulateQuestion(
      Array.from({ length: 4 }, (_, index) => ({
        ...questions[0]!,
        id: `q${index}`,
        header: '非常长的十二个中文标题字段',
      })),
    )
    manager.focusQuestion(2)
    const prompt = manager.prompt
    if (prompt?.kind !== 'question') throw new Error('missing prompt')
    const parts = buildQuestionCard(prompt, 56)
    expect(
      parts.tabs.reduce((sum, row) => sum + questionTabWidth(row) + 2, -2),
    ).toBeLessThanOrEqual(56)
    expect(parts.tabs.find((row) => row.pressId === 'decision:tab:2')?.spans[0]).toMatchObject({
      tone: 'accent',
      bold: true,
    })
    const rejected = pending.catch(() => {})
    manager.cancelQuestions()
    await rejected
  })

  it('reduces crowded tabs to the current heading first three characters', async () => {
    const manager = new DecisionManager()
    const pending = manager.simulateQuestion(
      Array.from({ length: 8 }, (_, index) => ({
        ...questions[0]!,
        id: `q${index}`,
        header: '当前标题要截短',
      })),
    )
    const rejected = pending.catch(() => {})
    manager.focusQuestion(3)
    const prompt = manager.prompt
    if (prompt?.kind !== 'question') throw new Error('missing question')
    expect(buildQuestionCard(prompt, 56).tabs.map(rowText)).toEqual(['[ ] 当前标', '提交'])
    manager.cancelQuestions()
    await rejected
  })

  it('budgets the submit page and errors within the cap across short heights', async () => {
    const manager = new DecisionManager()
    const pending = manager.simulateQuestion(questions)
    const rejected = pending.catch(() => {})
    manager.focusQuestion(2)
    const prompt = manager.prompt
    if (prompt?.kind !== 'question') throw new Error('missing question')
    for (let height = 6; height <= 40; height++) {
      const cap = questionCardCap(height)
      const parts = buildQuestionCard(prompt, 56, cap)
      expect(questionCardWindow(parts, cap, 100, false).total).toBeLessThanOrEqual(cap)
    }
    manager.cancelQuestions()
    await rejected
  })

  it('pins errors and footer outside the scroll body and keeps focus visible', async () => {
    const manager = new DecisionManager()
    const pending = manager.simulateQuestion([
      {
        ...questions[1]!,
        options: Array.from({ length: 12 }, (_, index) => ({
          label: `选项${index}`,
          description: '长描述。'.repeat(12),
        })),
      },
    ])
    manager.move(11)
    const prompt = manager.prompt
    if (prompt?.kind !== 'question') throw new Error('missing prompt')
    const parts = buildQuestionCard(prompt, 56)
    const window = questionCardWindow(parts, 12, 0)
    expect(window.start).toBeGreaterThan(0)
    expect(window.body.map(rowText).join('\n')).toContain('> 12.')
    expect(window.total).toBeLessThanOrEqual(12)
    manager.confirmFocused()
    const invalid = manager.prompt
    if (invalid?.kind !== 'question') throw new Error('missing prompt')
    const failed = buildQuestionCard(invalid, 56)
    expect(failed.footer.map(rowText).join('\n')).toContain('请至少选择一项。')
    expect(failed.body.map(rowText).join('\n')).not.toContain('请至少选择一项。')
    const rejected = pending.catch(() => {})
    manager.cancelQuestions()
    await rejected
  })

  it('keeps plan header, detail text and the approve marker in the shared card', async () => {
    const manager = new DecisionManager()
    const pending = manager.simulateQuestion([
      {
        id: 'plan',
        question: '请审阅计划',
        header: '实施计划',
        detail: '# 目标\n\n保留计划正文',
        intent: { kind: 'plan-review', approve: '实施' },
        options: [{ label: '实施' }, { label: '修改' }],
      },
    ])
    const prompt = manager.prompt
    if (prompt?.kind !== 'question') throw new Error('missing prompt')
    const parts = buildQuestionCard(prompt, 96)
    const text = [...parts.header, ...parts.body].map(rowText).join('\n')
    expect(text).toContain('实施计划')
    expect(text).toContain('保留计划正文')
    expect(text).toContain('实施 (批准)')
    expect(text).not.toContain('修改 (批准)')
    manager.selectIndex(0)
    await expect(pending).resolves.toEqual({ answers: [{ id: 'plan', selected: ['实施'] }] })
  })
})
