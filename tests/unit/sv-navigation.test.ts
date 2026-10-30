import { describe, expect, it } from 'vitest'
import { InputModel } from '../../src/app/input-model.ts'
import { DraftStore } from '../../src/input/drafts.ts'
import type { Key, KeyName } from '../../src/input/parser.ts'
import { SubagentDock } from '../../src/subagents/dock.ts'
import { SubagentNavigation } from '../../src/subagents/view.ts'

function key(name: KeyName, extra: Partial<Key> = {}): Key {
  return { name, ctrl: false, alt: false, shift: false, meta: false, sequence: '', ...extra }
}

type Entry = {
  kind: 'child' | 'diagnostic'
  id: string
  mode?: string
  label?: string
  activity?: 'running' | 'inactive'
  parentId?: string
  depth?: number
  reason?: string
}

function setup(
  options: {
    entries: Entry[]
    live?: Map<string, any>
    rootLive?: boolean
    history?: Record<string, any[]>
  } = { entries: [] },
) {
  const handlers = new Map<string, Set<(info: any) => void>>()
  const promptCalls: any[] = []
  const interruptCalls: any[] = []
  const live = options.live ?? new Map<string, any>()
  const emit = (event: string, info: any) => {
    for (const handler of handlers.get(event) ?? []) handler(info)
  }
  const ctx = {
    get(name: string) {
      if (name === 'subagents') {
        return {
          listChildren: async () =>
            options.entries
              .filter((entry) => entry.kind === 'child')
              .map((entry) => ({ id: entry.id, mode: entry.mode, label: entry.label })),
          listDescendants: async () => options.entries,
          prompt: async (request: any) => {
            promptCalls.push(request)
            return { messageId: 'm1' }
          },
          interruptByParent: (id: string, parent: string, mode: string) => {
            interruptCalls.push({ id, parent, mode })
            return {}
          },
        }
      }
      if (name === 'agents') {
        return {
          get: (id: string) =>
            id === 'root'
              ? options.rootLive === false
                ? undefined
                : { status: 'idle' }
              : live.get(id),
        }
      }
      if (name === 'sessionQuery') {
        return {
          readSession: async (id: string) => {
            if (options.unreadable?.has(id)) throw new Error('unreadable')
            return { events: options.history?.[id] ?? [] }
          },
        }
      }
      return undefined
    },
    on(event: string, handler: (info: any) => void) {
      const set = handlers.get(event) ?? new Set()
      set.add(handler)
      handlers.set(event, set)
      return () => set.delete(handler)
    },
    off(event: string, handler: (info: any) => void) {
      handlers.get(event)?.delete(handler)
    },
  }
  const input = new InputModel()
  const drafts = new DraftStore()
  const notices: string[] = []
  const dock = new SubagentDock({ ctx, rootId: 'root', onChange: () => {}, pollMs: 1_000_000_000 })
  dock.start()
  const nav = new SubagentNavigation({
    ctx,
    rootId: 'root',
    input,
    history: {
      entries: () =>
        (options.inputHistory ?? []).map((display) => ({
          display,
          timestamp: 0,
          project: '',
          sessionId: '',
        })),
    },
    drafts,
    dock,
    expanded: new Set(),
    bodyHeight: () => 10,
    onChange: () => {},
    setNotice: (text: string | undefined) => {
      if (text !== undefined) notices.push(text)
    },
    writeDiagnostic: () => {},
  })
  return { ctx, input, drafts, dock, nav, promptCalls, interruptCalls, notices, emit }
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('SubagentNavigation：dock 焦点与进入', () => {
  it('空草稿按 ↑ 聚焦 dock，Enter 进入详情', async () => {
    const { dock, nav, emit } = setup({
      entries: [
        { kind: 'child', id: 'a', mode: 'continuable', label: '任务 A', activity: 'running' },
      ],
      live: new Map([['a', { status: 'running' }]]),
    })
    emit('subagent/start', { id: 'a' })
    await dock.refresh()
    expect(nav.handleKey(key('up'))).toBe(true)
    expect(nav.view).toMatchObject({ mode: 'main', dockFocusId: 'a' })
    expect(nav.handleKey(key('enter'))).toBe(true)
    await flush()
    expect(nav.view).toMatchObject({ mode: 'child', id: 'a', origin: 'dock' })
  })

  it('点击 dock 行进入详情，Esc 返回', async () => {
    const { dock, nav, input, emit } = setup({
      entries: [
        { kind: 'child', id: 'a', mode: 'continuable', label: '任务 A', activity: 'running' },
      ],
    })
    emit('subagent/start', { id: 'a' })
    await dock.refresh()
    input.insert('主草稿')
    expect(nav.handlePress('subagent:row:a')).toBe(true)
    await flush()
    expect(nav.view).toMatchObject({ mode: 'child', id: 'a' })
    expect(input.text).toBe('')
    expect(nav.handleKey(key('escape'))).toBe(true)
    expect(nav.view).toMatchObject({ mode: 'main', dockFocusId: 'a' })
    expect(input.text).toBe('主草稿')
  })
})

describe('SubagentNavigation：草稿按地址隔离', () => {
  it('进出子代理不串草稿，子代理草稿留在它名下', async () => {
    const { dock, nav, input, drafts, emit } = setup({
      entries: [
        { kind: 'child', id: 'a', mode: 'continuable', label: '任务 A', activity: 'running' },
      ],
    })
    emit('subagent/start', { id: 'a' })
    await dock.refresh()
    input.insert('主草稿')
    nav.handlePress('subagent:row:a')
    await flush()
    input.insert('子草稿')
    nav.handleKey(key('escape'))
    expect(input.text).toBe('主草稿')
    expect(drafts.get({ root: 'root', subagent: 'a' })?.text).toBe('子草稿')
    nav.handlePress('subagent:row:a')
    await flush()
    expect(input.text).toBe('子草稿')
  })
})

describe('SubagentNavigation：全部列表', () => {
  it('Alt+L 打开列表，Enter 进入，Esc 返回列表原行', async () => {
    const { nav } = setup({
      entries: [
        { kind: 'child', id: 'a', mode: 'continuable', label: '任务 A', activity: 'running' },
        { kind: 'child', id: 'b', mode: 'continuable', label: '任务 B', activity: 'inactive' },
      ],
    })
    expect(nav.handleKey(key('char', { text: 'l', alt: true }))).toBe(true)
    await flush()
    expect(nav.view).toMatchObject({ mode: 'main', listOpen: true })
    expect(nav.handleKey(key('down'))).toBe(true)
    expect(nav.handleKey(key('enter'))).toBe(true)
    expect(nav.view).toMatchObject({ mode: 'child', id: 'b', origin: 'list' })
    expect(nav.handleKey(key('escape'))).toBe(true)
    expect(nav.view).toMatchObject({ mode: 'main', listOpen: true, listFocusId: 'b' })
  })

  it('列表打开时输入禁用且可打印键不落入输入框', async () => {
    const { nav, input } = setup({
      entries: [
        { kind: 'child', id: 'a', mode: 'continuable', label: '任务 A', activity: 'running' },
      ],
    })
    nav.handleKey(key('char', { text: 'l', alt: true }))
    await flush()
    expect(nav.inputDisabled).toBe(true)
    expect(nav.handleKey(key('char', { text: 'x' }))).toBe(true)
    expect(input.text).toBe('')
    expect(nav.handleKey(key('backspace'))).toBe(true)
    expect(input.text).toBe('')
  })
})

describe('SubagentNavigation：详情输入', () => {
  it('Enter 走 queue，Alt+Enter 走 steer，Alt+K 停止', async () => {
    const { dock, nav, input, promptCalls, interruptCalls, emit } = setup({
      entries: [
        { kind: 'child', id: 'a', mode: 'continuable', label: '任务 A', activity: 'running' },
      ],
      live: new Map([['a', { status: 'running' }]]),
    })
    emit('subagent/start', { id: 'a' })
    await dock.refresh()
    nav.handlePress('subagent:row:a')
    await flush()
    input.insert('继续查')
    expect(nav.handleKey(key('enter'))).toBe(true)
    await flush()
    expect(promptCalls[0]).toMatchObject({
      parentSessionId: 'root',
      childSessionId: 'a',
      mode: 'continuable',
      delivery: 'queue',
      content: [{ type: 'text', text: '继续查' }],
    })
    input.insert('插一句')
    expect(nav.handleKey(key('enter', { alt: true }))).toBe(true)
    await flush()
    expect(promptCalls[1]?.delivery).toBe('steer')
    expect(nav.handleKey(key('char', { text: 'k', alt: true }))).toBe(true)
    expect(interruptCalls).toEqual([{ id: 'a', parent: 'root', mode: 'continuable' }])
  })

  it('parent 不可用时可续聊详情仍显示输入框但禁用', async () => {
    const { dock, nav, emit } = setup({
      entries: [
        { kind: 'child', id: 'a', mode: 'continuable', label: '任务 A', activity: 'running' },
      ],
      rootLive: false,
    })
    emit('subagent/start', { id: 'a' })
    await dock.refresh()
    nav.handlePress('subagent:row:a')
    await flush()
    expect(nav.inputHidden).toBe(false)
    expect(nav.inputDisabled).toBe(true)
  })

  it('一次性会话历史读不到时不进入详情', async () => {
    const { nav } = setup({
      entries: [
        { kind: 'child', id: 'o', mode: 'one-shot', label: '一次性', activity: 'inactive' },
      ],
      unreadable: new Set(['o']),
    })
    nav.handleKey(key('char', { text: 'l', alt: true }))
    await flush()
    expect(nav.handleKey(key('enter'))).toBe(true)
    expect(nav.view).toMatchObject({ mode: 'main', listOpen: true })
  })

  it('详情里 Alt+L 回到主视图并打开列表', async () => {
    const { dock, nav, emit } = setup({
      entries: [
        { kind: 'child', id: 'a', mode: 'continuable', label: '任务 A', activity: 'running' },
      ],
    })
    emit('subagent:start', { id: 'a' })
    await dock.refresh()
    nav.handlePress('subagent:row:a')
    await flush()
    expect(nav.view).toMatchObject({ mode: 'child', id: 'a' })
    expect(nav.handleKey(key('char', { text: 'l', alt: true }))).toBe(true)
    expect(nav.view).toMatchObject({ mode: 'main', listOpen: true })
  })

  it('一次性子代理详情只读：不显示输入框，正文从官方历史读回', async () => {
    const history = [
      {
        seq: 1,
        type: 'user/message',
        data: { content: [{ type: 'text', text: '一次性任务' }], source: { kind: 'user' } },
      },
      {
        seq: 2,
        type: 'assistant/message',
        data: { message: { content: [{ type: 'text', text: '做完了' }] } },
      },
    ]
    const { nav } = setup({
      entries: [
        { kind: 'child', id: 'o', mode: 'one-shot', label: '一次性', activity: 'inactive' },
      ],
      history: { o: history },
    })
    nav.handleKey(key('char', { text: 'l', alt: true }))
    await flush()
    nav.handleKey(key('enter'))
    await flush()
    expect(nav.view).toMatchObject({ mode: 'child', id: 'o', origin: 'list' })
    expect(nav.inputHidden).toBe(true)
    expect(nav.childModel?.all.map((entry) => entry.kind)).toEqual(['user', 'assistant'])
  })
})

describe('SubagentNavigation：结果卡', () => {
  it('activation 结果卡 press 进入详情，返回落点是结果卡', async () => {
    const { nav } = setup({
      entries: [
        { kind: 'child', id: 'r', mode: 'continuable', label: '结果任务', activity: 'running' },
      ],
    })
    expect(nav.handlePress('subagent:result:r')).toBe(true)
    await flush()
    expect(nav.view).toMatchObject({ mode: 'child', id: 'r', origin: 'result' })
    expect(nav.handleKey(key('escape'))).toBe(true)
    expect(nav.view).toMatchObject({ mode: 'main', listOpen: false })
  })
})

describe('SubagentNavigation：滚动', () => {
  it('子代理正文滚轮独立，退出再进恢复', async () => {
    const longEvents = Array.from({ length: 20 }, (_, index) => ({
      seq: index + 1,
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: `第 ${index} 行\n第二行\n第三行` }] } },
    }))
    const { nav } = setup({
      entries: [
        { kind: 'child', id: 's', mode: 'one-shot', label: '长任务', activity: 'inactive' },
      ],
      history: { s: longEvents },
    })
    nav.handleKey(key('char', { text: 'l', alt: true }))
    await flush()
    nav.handleKey(key('enter'))
    await flush()
    expect(nav.handleWheel(3)).toBe(true)
    const offset = nav.childScrollOffset
    expect(offset).toBeGreaterThan(0)
    nav.handleKey(key('escape'))
    nav.handleKey(key('enter'))
    await flush()
    expect(nav.childScrollOffset).toBe(offset)
  })
})

describe('SubagentNavigation：边界', () => {
  it('dock 里的一次性会话历史不可读时停在主视图并提示', async () => {
    const { dock, nav, notices, emit } = setup({
      entries: [
        { kind: 'child', id: 'o', mode: 'one-shot', label: '一次性', activity: 'inactive' },
      ],
      unreadable: new Set(['o']),
    })
    emit('subagent:start', { id: 'o' })
    await dock.refresh()
    expect(nav.handlePress('subagent:row:o')).toBe(true)
    await flush()
    expect(nav.view).toMatchObject({ mode: 'main' })
    expect(notices.some((text) => text.includes('不可读'))).toBe(true)
  })

  it('详情里打 x 不吞字符，交给输入框', async () => {
    const { dock, nav, emit } = setup({
      entries: [
        { kind: 'child', id: 'a', mode: 'continuable', label: '任务 A', activity: 'running' },
      ],
    })
    emit('subagent:start', { id: 'a' })
    await dock.refresh()
    nav.handlePress('subagent:row:a')
    await flush()
    expect(nav.view.mode).toBe('child')
    expect(nav.inputHidden).toBe(false)
    expect(nav.inputDisabled).toBe(false)
    expect(nav.handleKey(key('char', { text: 'x' }))).toBe(false)
  })

  it('未知模式只读并显示原因，确认前不显示输入框', async () => {
    const { nav } = setup({
      entries: [{ kind: 'child', id: 'u', mode: 'unknown', label: '未知', activity: 'inactive' }],
    })
    nav.handleKey(key('char', { text: 'l', alt: true }))
    await flush()
    nav.handleKey(key('enter'))
    await flush()
    expect(nav.view).toMatchObject({ mode: 'child', id: 'u' })
    expect(nav.inputHidden).toBe(true)
  })

  it('列表 PageDown 滚动，不越界', async () => {
    const entries = Array.from({ length: 30 }, (_, index) => ({
      kind: 'child' as const,
      id: `s${index}`,
      mode: 'continuable',
      label: `任务 ${index}`,
      activity: 'running' as const,
      depth: 1,
    }))
    const { nav } = setup({ entries })
    nav.handleKey(key('char', { text: 'l', alt: true }))
    await flush()
    expect(nav.handleKey(key('pagedown'))).toBe(true)
    expect(nav.view.mode).toBe('main')
    if (nav.view.mode === 'main') expect(nav.view.listScrollTop).toBe(5)
  })
})

describe('SubagentNavigation：输入历史按地址', () => {
  it('子代理里↑翻子地址历史，退出后恢复主历史', async () => {
    const { nav, input } = setup({
      entries: [
        { kind: 'child', id: 'a', mode: 'continuable', label: '任务 A', activity: 'inactive' },
      ],
      history: {
        a: [
          {
            seq: 1,
            type: 'user/message',
            data: { content: [{ type: 'text', text: '子历史' }], source: { kind: 'user' } },
          },
        ],
      },
      inputHistory: ['主历史'],
    })
    nav.handleKey(key('char', { text: 'l', alt: true }))
    await flush()
    nav.handleKey(key('enter'))
    await flush()
    input.previousHistory()
    expect(input.text).toBe('子历史')
    nav.handleKey(key('escape'))
    input.previousHistory()
    expect(input.text).toBe('主历史')
  })
})
