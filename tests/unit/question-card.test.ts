import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type FeatureHost, NanoApp } from '../../src/app/nano-app.ts'
import { ConversationController } from '../../src/conversation/controller.ts'
import { Text } from '../../src/render/components.ts'
import { Renderer } from '../../src/render/renderer.ts'
import { darkTheme } from '../../src/theme/theme.ts'

class FakeContext {
  handlers = new Map<string, (...args: never[]) => unknown>()
  on(name: string, handler: (...args: never[]) => unknown) {
    this.handlers.set(name, handler)
  }
}

let addedListeners: Array<{ event: string | symbol; handler: (...args: never[]) => void }> = []
let onSpy: ReturnType<typeof vi.spyOn> | undefined

beforeEach(() => {
  addedListeners = []
  const originalOn = process.on.bind(process)
  onSpy = vi.spyOn(process, 'on').mockImplementation(((
    event: string | symbol,
    handler: (...args: never[]) => void,
  ) => {
    addedListeners.push({ event, handler })
    return originalOn(event as never, handler as never)
  }) as never)
})

afterEach(() => {
  for (const { event, handler } of addedListeners) process.off(event as never, handler as never)
  addedListeners = []
  onSpy?.mockRestore()
  onSpy = undefined
})

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

function makeHarness(width = 80, height = 24, features: FeatureHost = {}) {
  const renderer = new Renderer({
    write: () => {},
    width,
    height,
    defaultFg: darkTheme.fg,
  })
  const ctx = new FakeContext()
  const conversation = new ConversationController({
    ctx,
    official: {},
    rootId: 'r',
    cwd: '/tmp',
    history: { record: () => {}, entries: () => [] } as never,
  })
  const app = new NanoApp({
    core: { ctx, dispose: async () => {} } as never,
    official: {} as never,
    terminal: {
      width,
      height,
      refreshSize: () => {},
      copyToClipboard: () => {},
    } as never,
    renderer,
    claim: { rootId: 'r', path: '/tmp/x', recovered: false },
    dataRoot: '/tmp',
    cwd: '/tmp/project',
    rootId: 'r',
    conversation,
    history: { entries: () => [] } as never,
    writeDiagnostic: () => {},
    features: { start: () => {}, inputActive: () => true, ...features },
  })
  return { app, renderer, ctx }
}

function key(name: string, extra: Record<string, unknown> = {}) {
  return {
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
  } as never
}

function keys(text: string) {
  return [...text].map((char) => key('char', { text: char }))
}

async function openQuestion(
  harness: ReturnType<typeof makeHarness>,
  questions: unknown[],
): Promise<() => void> {
  harness.app.start().catch(() => {})
  await tick()
  const handler = harness.ctx.handlers.get('user-questions/request') as
    | ((payload: unknown) => Promise<unknown>)
    | undefined
  const pending = handler?.({ questions })
  void pending?.catch(() => {})
  await tick()
  harness.app.render()
  harness.renderer.flushFrame()
  return () => {
    harness.app.decisionsManager.cancelQuestions()
    void (pending as Promise<unknown>).catch(() => {})
  }
}

function lines(harness: ReturnType<typeof makeHarness>): string[] {
  harness.app.render()
  harness.renderer.flushFrame()
  return harness.renderer.snapshotLines()
}

describe('question card layout (spec §3/§4)', () => {
  it('routes keys and clicks to a visible question while the model panel is suspended', async () => {
    const panelKey = vi.fn(() => true)
    const panelPress = vi.fn(() => true)
    const harness = makeHarness(80, 30, {
      modelPanelRows: () => 15,
      modelPanelBody: () => createElement(Text, {}, 'MODEL PANEL'),
      handleKey: panelKey,
      handlePress: panelPress,
    })
    const close = await openQuestion(harness, [
      { id: 'a', question: '请明确作答', options: [{ label: 'A' }, { label: 'B' }] },
      { id: 'b', question: '第二个问题', options: [{ label: 'C' }, { label: 'D' }] },
    ])
    try {
      const screen = lines(harness)
      expect(screen.join('\n')).toContain('请明确作答')
      expect(screen.join('\n')).not.toContain('MODEL PANEL')
      const row = screen.findIndex((text) => text.includes('> 1.'))
      harness.app.handleInput([
        { type: 'mouse', event: { kind: 'press', button: 'left', x: 4, y: row + 1 } },
        { type: 'mouse', event: { kind: 'release', button: 'left', x: 4, y: row + 1 } },
      ] as never)
      expect(harness.app.decisionsManager.prompt).toMatchObject({ current: 1 })
      expect(panelPress).not.toHaveBeenCalled()
      expect(lines(harness).join('\n')).toContain('第二个问题')
      harness.app.handleInput([key('escape')])
      expect(panelKey).not.toHaveBeenCalled()
      expect(lines(harness).join('\n')).toContain('MODEL PANEL')
    } finally {
      close()
      await tick()
      harness.renderer.unmount()
    }
  })
  it('renders numbered options, the focus pointer and a single description line', async () => {
    const harness = makeHarness()
    const close = await openQuestion(harness, [
      {
        id: 'q1',
        header: '验收方式',
        question: '这次改动采用哪种验收方式？',
        options: [
          { label: '聚焦回归（推荐）', description: '覆盖本次修改相关的检查。' },
          { label: '完整回归', description: '检查范围更广。' },
        ],
      },
    ])
    const screen = lines(harness).join('\n')
    expect(screen).toContain('> 1. 聚焦回归（推荐）')
    expect(screen).toContain('     覆盖本次修改相关的检查。')
    expect(screen).toContain('  2. 完整回归')
    expect(screen).not.toContain('[ ]')
    expect(screen).toContain('3. 其他')
    expect(screen).not.toContain('3. 其他：直接输入')
    expect(screen).toContain('等待你的选择')
    close()
    await tick()
    harness.renderer.unmount()
  })

  it('checks multi-select rows and refuses to advance with nothing selected', async () => {
    const harness = makeHarness()
    const close = await openQuestion(harness, [
      {
        id: 'q1',
        header: '测试范围',
        question: '需要覆盖哪些终端场景？',
        multiSelect: true,
        options: [{ label: '普通宽度' }, { label: '窄终端' }],
      },
    ])
    expect(lines(harness).join('\n')).toContain('> 1. [ ] 普通宽度')
    harness.app.handleInput([key('char', { text: ' ' })])
    expect(lines(harness).join('\n')).toContain('> 1. [x] 普通宽度')
    harness.app.handleInput([key('char', { text: ' ' })])
    harness.app.handleInput([key('enter')])
    expect(lines(harness).join('\n')).toContain('请至少选择一项。')
    close()
    await tick()
    harness.renderer.unmount()
  })

  it('renders tabs, review rows and the submit page for a batch', async () => {
    // 活动栏固定占 1 行；本用例验证提交页内容，给它补回这一行预算。
    const harness = makeHarness(80, 25)
    const close = await openQuestion(harness, [
      {
        id: 'q1',
        header: '验收方式',
        question: '怎么验？',
        options: [{ label: '聚焦回归' }, { label: '完整回归' }],
      },
      {
        id: 'q2',
        header: '测试范围',
        question: '覆盖哪些场景？',
        options: [{ label: '普通宽度' }, { label: '窄终端' }],
      },
    ])
    const first = lines(harness).join('\n')
    expect(first).toContain('[ ] 验收方式')
    expect(first).toContain('[ ] 测试范围')
    expect(first).toContain('提交')
    harness.app.handleInput([key('enter')])
    const second = lines(harness).join('\n')
    expect(second).toContain('[x] 验收方式')
    expect(second).toContain('> 1. 普通宽度')
    harness.app.handleInput([key('tab')])
    const submit = lines(harness).join('\n')
    expect(submit).toContain('提交这组答案')
    expect(submit).toContain('提交答案')
    expect(submit).toContain('还差 1 题')
    expect(submit).toContain('尚未回答')
    harness.app.handleInput([key('enter')])
    expect(lines(harness).join('\n')).toContain('请先回答这一题。')
    close()
    await tick()
    harness.renderer.unmount()
  })

  it('cancels with Esc and never submits the draft', async () => {
    const harness = makeHarness()
    harness.app.start().catch(() => {})
    await tick()
    const handler = harness.ctx.handlers.get('user-questions/request') as
      | ((payload: unknown) => Promise<unknown>)
      | undefined
    const pending = handler?.({
      questions: [{ id: 'q', question: '选吗', options: [{ label: 'A' }] }],
    })
    await tick()
    harness.app.render()
    harness.renderer.flushFrame()
    harness.app.handleInput([key('escape')])
    await expect(pending).rejects.toMatchObject({ code: 'ASK_ABORTED' })
    const screen = lines(harness).join('\n')
    expect(screen).toContain('已取消，未提交答案')
    expect(screen).not.toContain('聚焦回归')
    harness.renderer.unmount()
  })

  it('does not draw the waiting activity line on a takeover surface', async () => {
    const harness = makeHarness(80, 24, { replacesTranscript: () => true })
    harness.app.start().catch(() => {})
    await tick()
    const handler = harness.ctx.handlers.get('user-questions/request') as
      | ((payload: unknown) => Promise<unknown>)
      | undefined
    const pending = handler?.({
      questions: [{ id: 'q', question: '选吗', options: [{ label: 'A' }] }],
    })
    await tick()
    harness.app.render()
    harness.renderer.flushFrame()
    expect(lines(harness).join('\n')).not.toContain('等待你的选择')
    harness.app.handleInput([key('escape')])
    await expect(pending).rejects.toMatchObject({ code: 'ASK_ABORTED' })
    harness.renderer.unmount()
  })

  it.each(['number', 'space', 'click'])(
    'single choice advances via %s and shows the answer notice',
    async (method) => {
      const harness = makeHarness()
      const close = await openQuestion(harness, [
        { id: 'q', question: '选择？', options: [{ label: 'A' }, { label: 'B' }] },
      ])
      if (method === 'number') harness.app.handleInput([key('char', { text: '2' })])
      else if (method === 'space') harness.app.handleInput([key('char', { text: ' ' })])
      else {
        const row = lines(harness).findIndex((text) => text.includes('> 1.'))
        harness.app.handleInput([
          { type: 'mouse', event: { kind: 'press', button: 'left', x: 4, y: row + 1 } },
          { type: 'mouse', event: { kind: 'release', button: 'left', x: 4, y: row + 1 } },
        ] as never)
      }
      expect(harness.app.decisionsManager.hasDecision).toBe(false)
      expect(lines(harness).join('\n')).toContain('已回答 1 题')
      close()
      await tick()
      harness.renderer.unmount()
    },
  )

  it('lets Tab leave the custom editor and restores its focus on Shift+Tab', async () => {
    const harness = makeHarness()
    const close = await openQuestion(harness, [
      { id: 'q1', question: '第一题', options: [{ label: 'A' }] },
      { id: 'q2', question: '第二题', options: [{ label: 'B' }] },
    ])
    harness.app.handleInput([key('up'), ...keys('a c123'), key('tab')])
    expect(harness.app.decisionsManager.prompt).toMatchObject({ current: 1 })
    harness.app.handleInput([key('tab', { shift: true })])
    expect(harness.app.decisionsManager.prompt).toMatchObject({ current: 0, focusedOption: 1 })
    expect(lines(harness).join('\n')).toContain('2. 其他：a c123▏')
    harness.app.handleInput([key('escape')])
    expect(harness.app.decisionsManager.hasDecision).toBe(false)
    expect(lines(harness).join('\n')).toContain('已取消，未提交答案')
    close()
    await tick()
    harness.renderer.unmount()
  })

  it('routes Alt+N to explicit skip even inside custom input', async () => {
    const harness = makeHarness()
    const close = await openQuestion(harness, [
      { id: 'q1', question: '第一题', options: [{ label: 'A' }] },
      { id: 'q2', question: '第二题', options: [{ label: 'B' }] },
    ])
    harness.app.handleInput([key('up'), ...keys('草稿'), key('char', { text: 'n', alt: true })])
    const prompt = harness.app.decisionsManager.prompt
    expect(prompt).toMatchObject({ current: 1 })
    if (prompt?.kind === 'question')
      expect(prompt.drafts.get('q1')).toMatchObject({ skipped: true, custom: '' })
    close()
    await tick()
    harness.renderer.unmount()
  })

  it('pages a long list and keeps the focused row and footer visible', async () => {
    const harness = makeHarness(60, 30)
    const close = await openQuestion(harness, [
      {
        id: 'q',
        question: '很长的列表',
        multiSelect: true,
        options: Array.from({ length: 14 }, (_, index) => ({
          label: `选项 ${index + 1}`,
          description: '选项说明。',
        })),
      },
    ])
    const before = lines(harness).join('\n')
    harness.app.handleInput([key('pagedown')])
    const after = lines(harness).join('\n')
    expect(after).not.toEqual(before)
    expect(after).toContain('> ')
    expect(after).toContain('确认已选项')
    expect(after).toContain('Esc 取消')
    harness.app.handleInput([key('pageup')])
    expect(lines(harness).join('\n')).toContain('> ')
    close()
    await tick()
    harness.renderer.unmount()
  })

  it('pages through a long description without moving focus or changing the selected answer', async () => {
    const harness = makeHarness(60, 24)
    const close = await openQuestion(harness, [
      {
        id: 'q',
        question: '长说明',
        options: [
          {
            label: '保持这个选项',
            description: Array.from({ length: 24 }, (_, index) => `描述第${index + 1}行`).join(
              '\n',
            ),
          },
          { label: '不能自动移到这里' },
        ],
      },
    ])
    try {
      const before = lines(harness).join('\n')
      harness.app.handleInput([key('pagedown')])
      const after = lines(harness).join('\n')
      expect(after).not.toBe(before)
      expect(after).toContain('> 1. 保持这个选项')
      expect(harness.app.decisionsManager.prompt).toMatchObject({ focusedOption: 0 })
      for (let i = 0; i < 8; i++) harness.app.handleInput([key('pagedown')])
      expect(lines(harness).join('\n')).toContain('描述第24行')
      expect(harness.app.decisionsManager.prompt).toMatchObject({ focusedOption: 0 })
      harness.app.handleInput([key('pageup')])
      expect(lines(harness).join('\n')).not.toContain('描述第24行')
      harness.app.handleInput([key('down')])
      expect(lines(harness).join('\n')).toContain('> 2. 不能自动移到这里')
    } finally {
      close()
      await tick()
      harness.renderer.unmount()
    }
  })

  it('refuses answer keys when the terminal only has room for a resize notice', async () => {
    const harness = makeHarness(60, 8)
    const close = await openQuestion(harness, [
      { id: 'q', question: '不可隐藏作答', options: [{ label: 'A' }, { label: 'B' }] },
    ])
    try {
      expect(lines(harness).join('\n')).toContain('终端过矮')
      harness.app.handleInput([
        key('enter'),
        key('char', { text: '1' }),
        key('char', { text: ' ' }),
        key('char', { text: 'n', alt: true }),
      ])
      expect(harness.app.decisionsManager.prompt).toMatchObject({ kind: 'question', current: 0 })
      harness.app.handleInput([key('escape')])
      expect(harness.app.decisionsManager.hasDecision).toBe(false)
    } finally {
      close()
      await tick()
      harness.renderer.unmount()
    }
  })

  it('keeps the card within the terminal and does not overflow 60 columns', async () => {
    const harness = makeHarness(60, 24)
    const close = await openQuestion(harness, [
      {
        id: 'q1',
        header: '很长的题目标题会怎么样',
        question: '窄终端里这张卡片会不会横向溢出？这是一段足够长的题干用来触发折行。',
        options: [
          {
            label: '第一个选项的标签也足够长，用来触发折行',
            description: '描述同样很长，窄屏应该折行而不是溢出。',
          },
          { label: '第二个选项' },
        ],
      },
    ])
    for (const line of lines(harness)) {
      expect(line.length).toBeLessThanOrEqual(60)
    }
    close()
    await tick()
    harness.renderer.unmount()
  })
})
