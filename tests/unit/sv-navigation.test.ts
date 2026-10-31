import { createElement, type ReactNode } from 'react'
import { describe, expect, it } from 'vitest'
import { InputModel } from '../../src/app/input-model.ts'
import { DraftStore } from '../../src/input/drafts.ts'
import type { Key, KeyName } from '../../src/input/parser.ts'
import { Box } from '../../src/render/components.ts'
import { Renderer } from '../../src/render/renderer.ts'
import { SubagentDock } from '../../src/subagents/dock.ts'
import { SubagentNavigation } from '../../src/subagents/view.ts'
import { darkTheme } from '../../src/theme/theme.ts'

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
    unreadable?: Set<string>
    inputHistory?: string[]
    failFirst?: Set<string>
  } = { entries: [] },
) {
  const readAttempts = new Map<string, number>()
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
            const attempt = (readAttempts.get(id) ?? 0) + 1
            readAttempts.set(id, attempt)
            if (options.failFirst?.has(id) && attempt === 1) throw new Error('transient')
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

function renderNode(node: ReactNode, width = 80, height = 10): string {
  const renderer = new Renderer({
    write: () => {},
    width,
    height,
    defaultFg: darkTheme.fg,
  })
  renderer.update(createElement(Box, { flexDirection: 'column', width, height }, node))
  renderer.flushFrame()
  return renderer.snapshotLines().join('\n')
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
    // 主草稿非空时返回不恢复 dock 焦点，否则 x 会被 dock 吃掉（§4.1）。
    expect(nav.view).toMatchObject({ mode: 'main', dockFocusId: undefined })
    expect(input.text).toBe('主草稿')
  })

  it('终态行也能用 ↓ 聚焦并用 Enter 进入', async () => {
    const { dock, nav, emit } = setup({
      entries: [{ kind: 'child', id: 'a', mode: 'continuable', label: '任务 A' }],
    })
    emit('subagent/start', { id: 'a' })
    await dock.refresh()
    emit('subagent/end', { id: 'a', stopReason: 'completed' })
    await dock.refresh()
    expect(nav.handleKey(key('down'))).toBe(true)
    expect(nav.view).toMatchObject({ mode: 'main', dockFocusId: 'a' })
    expect(nav.handleKey(key('enter'))).toBe(true)
    await flush()
    expect(nav.view).toMatchObject({ mode: 'child', id: 'a', origin: 'dock' })
  })

  it('主草稿非空时返回，x 仍然进输入框而不是删 dock 行', async () => {
    const { dock, nav, input, emit } = setup({
      entries: [
        { kind: 'child', id: 'a', mode: 'continuable', label: '任务 A', activity: 'running' },
      ],
    })
    emit('subagent/start', { id: 'a' })
    await dock.refresh()
    input.insert('abc')
    nav.handlePress('subagent:row:a')
    await flush()
    nav.handleKey(key('escape'))
    expect(nav.handleKey(key('char', { text: 'x' }))).toBe(false)
    expect(dock.entryIds()).toEqual(['a'])
    expect(input.text).toBe('abc')
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

  it('从列表进入详情再返回，保留列表滚动位置且焦点行在视口内', async () => {
    const entries = Array.from({ length: 30 }, (_, index) => ({
      kind: 'child' as const,
      id: `s${index}`,
      mode: 'continuable',
      label: `任务 ${index}`,
      activity: 'running' as const,
      depth: 1,
    }))
    const { nav } = setup({
      entries,
      live: new Map(entries.map((entry) => [entry.id, { status: 'running' }])),
    })
    nav.handleKey(key('char', { text: 'l', alt: true }))
    await flush()
    for (let index = 0; index < 20; index++) nav.handleKey(key('down'))
    const before = nav.view
    if (before.mode !== 'main') throw new Error('expected main list view')
    expect(before.listScrollTop).toBeGreaterThan(0)
    expect(nav.handleKey(key('enter'))).toBe(true)
    await flush()
    expect(nav.view).toMatchObject({ mode: 'child', id: before.listFocusId, origin: 'list' })
    expect(nav.handleKey(key('escape'))).toBe(true)
    await flush()
    const after = nav.view
    if (after.mode !== 'main') throw new Error('expected main list view')
    expect(after.listOpen).toBe(true)
    expect(after.listScrollTop).toBe(before.listScrollTop)
    expect(after.listFocusId).toBe(before.listFocusId)
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

  it('空输入 ← 与顶部返回按钮都能退出详情', async () => {
    const { dock, nav, emit } = setup({
      entries: [
        { kind: 'child', id: 'a', mode: 'continuable', label: '任务 A', activity: 'running' },
      ],
    })
    emit('subagent/start', { id: 'a' })
    await dock.refresh()
    nav.handlePress('subagent:row:a')
    await flush()
    expect(nav.handleKey(key('left'))).toBe(true)
    expect(nav.view).toMatchObject({ mode: 'main' })
    nav.handlePress('subagent:row:a')
    await flush()
    expect(nav.handlePress('subagent:back')).toBe(true)
    expect(nav.view).toMatchObject({ mode: 'main' })
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
    await flush()
    expect(nav.view).toMatchObject({ mode: 'main', listOpen: true })
    // 第二次 Enter 不能因为缓存了 false 反而进入详情。
    expect(nav.handleKey(key('enter'))).toBe(true)
    await flush()
    expect(nav.view).toMatchObject({ mode: 'main', listOpen: true })
  })

  it('可编辑详情里 Ctrl+End 只滚子正文，不漏给主对话', async () => {
    const longEvents = Array.from({ length: 20 }, (_, index) => ({
      seq: index + 1,
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: `第 ${index} 行` }] } },
    }))
    const { nav } = setup({
      entries: [
        { kind: 'child', id: 'a', mode: 'continuable', label: '任务 A', activity: 'running' },
      ],
      live: new Map([['a', { status: 'running' }]]),
      history: { a: longEvents },
    })
    nav.handlePress('subagent:row:a')
    await flush()
    expect(nav.inputActive).toBe(true)
    // 已经粘底时 Ctrl+End 是 no-op，但必须被详情消费，不能漏给主对话。
    expect(nav.handleKey(key('end', { ctrl: true }))).toBe(true)
    expect(nav.childScrollOffset).toBe(0)
  })

  it('unknown 详情有原因行时，Home 仍能到达正文第一行', async () => {
    const longEvents = Array.from({ length: 20 }, (_, index) => ({
      seq: index + 1,
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: `第 ${index} 行` }] } },
    }))
    const { nav } = setup({
      entries: [{ kind: 'child', id: 'u', mode: 'unknown', label: '未知', activity: 'inactive' }],
      history: { u: longEvents },
    })
    nav.handleKey(key('char', { text: 'l', alt: true }))
    await flush()
    nav.handleKey(key('enter'))
    await flush()
    expect(nav.handleKey(key('home'))).toBe(true)
    expect(renderNode(nav.body(40), 40, 10)).toContain('第 0 行')
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

  it('一次性可读性探测瞬时失败后，下一次列表刷新会重试并允许进入', async () => {
    const { nav } = setup({
      entries: [
        { kind: 'child', id: 'o', mode: 'one-shot', label: '一次性', activity: 'inactive' },
      ],
      failFirst: new Set(['o']),
      history: {
        o: [
          {
            seq: 1,
            type: 'assistant/message',
            data: { message: { content: [{ type: 'text', text: '做完了' }] } },
          },
        ],
      },
    })
    nav.handleKey(key('char', { text: 'l', alt: true }))
    await flush()
    // 第一次探测失败：行不可读。
    nav.handleKey(key('char', { text: 'l', alt: true }))
    await flush()
    // 第二次打开列表会重试成功。
    nav.handleKey(key('char', { text: 'l', alt: true }))
    await flush()
    expect(nav.handleKey(key('enter'))).toBe(true)
    await flush()
    expect(nav.view).toMatchObject({ mode: 'child', id: 'o', origin: 'list' })
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
    expect(renderNode(nav.body(70))).toContain('未知模式：暂不支持发送，仅只读显示')
  })

  it('dock 行出列后残留焦点不会 Enter 打开已消失的详情', async () => {
    const { dock, nav, emit } = setup({
      entries: [{ kind: 'child', id: 'a', mode: 'continuable', label: '任务 A' }],
    })
    emit('subagent/start', { id: 'a' })
    await dock.refresh()
    expect(nav.handleKey(key('up'))).toBe(true)
    emit('subagent/end', { id: 'a', stopReason: 'completed' })
    await dock.refresh()
    expect(nav.handleKey(key('char', { text: 'x' }))).toBe(true)
    expect(dock.entryIds()).toEqual([])
    nav.handleKey(key('enter'))
    await flush()
    expect(nav.view).toMatchObject({ mode: 'main' })
  })

  it('未知模式只读时 inputEditable 为 false（paste / 换行不得改写输入）', async () => {
    const { nav } = setup({
      entries: [{ kind: 'child', id: 'u', mode: 'unknown', label: '未知', activity: 'inactive' }],
    })
    nav.handleKey(key('char', { text: 'l', alt: true }))
    await flush()
    nav.handleKey(key('enter'))
    await flush()
    expect(nav.view).toMatchObject({ mode: 'child', id: 'u' })
    expect(nav.inputHidden).toBe(true)
    expect(nav.inputEditable).toBe(false)
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
    // 走真实按键路径：详情里的 ↑ 必须翻子地址历史，不能被 S01 换成主历史。
    expect(nav.handleKey(key('up'))).toBe(true)
    expect(input.text).toBe('子历史')
    nav.handleKey(key('escape'))
    input.previousHistory()
    expect(input.text).toBe('主历史')
  })

  it('详情输入可用时 ↑ 只翻子地址历史，不会落到主会话历史', async () => {
    const { nav, input } = setup({
      entries: [
        { kind: 'child', id: 'a', mode: 'continuable', label: '任务 A', activity: 'running' },
      ],
      live: new Map([['a', { status: 'running' }]]),
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
    nav.handlePress('subagent:row:a')
    await flush()
    expect(nav.handleKey(key('up'))).toBe(true)
    expect(input.text).toBe('子历史')
    expect(input.text).not.toBe('主历史')
  })
})
