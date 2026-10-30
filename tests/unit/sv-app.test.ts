import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NanoApp } from '../../src/app/nano-app.ts'
import { ConversationController } from '../../src/conversation/controller.ts'
import { Text } from '../../src/render/components.ts'
import { Renderer } from '../../src/render/renderer.ts'
import { darkTheme } from '../../src/theme/theme.ts'

class FakeContext {
  handlers = new Map<string, (...args: never[]) => unknown>()
  on(name: string, handler: (...args: never[]) => unknown) {
    this.handlers.set(name, handler)
  }
  off(name: string) {
    this.handlers.delete(name)
  }
  get() {
    return undefined
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

async function tick() {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function makeHarness(features: Record<string, unknown>) {
  const chunks: string[] = []
  const renderer = new Renderer({
    write: (bytes) => chunks.push(bytes),
    width: 80,
    height: 24,
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
      width: 80,
      height: 24,
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
    features: features as never,
  })
  return { app, renderer, lines: () => renderer.snapshotLines().join('\n') }
}

describe('详情 / 列表的正文与输入区切换', () => {
  it('详情占满正文区时隐藏主 transcript 与输入框', async () => {
    const harness = makeHarness({
      start: () => {},
      body: () => createElement(Text, null, '子代理详情正文'),
      replacesTranscript: () => true,
      inputHidden: () => true,
      inputPlaceholder: () => '给 任务 A 发送消息…',
      inputActive: () => false,
    })
    harness.app.start().catch(() => {})
    await tick()
    harness.app.render()
    harness.renderer.flushFrame()
    const lines = harness.lines()
    expect(lines).toContain('子代理详情正文')
    expect(lines).not.toContain('给 任务 A 发送消息…')
    expect(lines).not.toContain('输入消息…')
    harness.renderer.unmount()
  })

  it('可续聊详情显示设计稿的输入占位', async () => {
    const harness = makeHarness({
      start: () => {},
      body: () => createElement(Text, null, '子代理详情正文'),
      replacesTranscript: () => true,
      inputHidden: () => false,
      inputDisabled: () => false,
      inputPlaceholder: () => '给 任务 A 发送消息…',
      inputActive: () => true,
    })
    harness.app.start().catch(() => {})
    await tick()
    harness.app.render()
    harness.renderer.flushFrame()
    expect(harness.lines()).toContain('给 任务 A 发送消息…')
    harness.renderer.unmount()
  })

  it('列表打开时输入框可见但禁用', async () => {
    const harness = makeHarness({
      start: () => {},
      body: () => createElement(Text, null, '全部子代理 · 2'),
      replacesTranscript: () => true,
      inputHidden: () => false,
      inputDisabled: () => true,
      inputPlaceholder: () => '给 任务 A 发送消息…',
      inputActive: () => false,
    })
    harness.app.start().catch(() => {})
    await tick()
    harness.app.render()
    harness.renderer.flushFrame()
    const lines = harness.lines()
    expect(lines).toContain('全部子代理 · 2')
    expect(lines).toContain('给 任务 A 发送消息…')
    harness.renderer.unmount()
  })

  it('主视图的 feature body（dock）追加在 transcript 之后', async () => {
    const harness = makeHarness({
      start: () => {},
      body: () => createElement(Text, null, '● 任务 A  执行中'),
      replacesTranscript: () => false,
      inputActive: () => true,
    })
    harness.app.start().catch(() => {})
    await tick()
    harness.app.render()
    harness.renderer.flushFrame()
    expect(harness.lines()).toContain('● 任务 A  执行中')
    harness.renderer.unmount()
  })
})
