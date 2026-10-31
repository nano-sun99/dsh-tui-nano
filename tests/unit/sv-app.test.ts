import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type AppSnapshot, transcriptBodyHeight } from '../../src/app/App.tsx'
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

async function settle() {
  // 让 handleInput 排的 setImmediate 渲染跑完，避免卸载后再 mount。
  await new Promise((resolve) => setImmediate(resolve))
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

  it('只读详情 / 列表打开时，paste 与 Shift+Enter 不得改写输入', async () => {
    const harness = makeHarness({
      start: () => {},
      body: () => createElement(Text, null, '只读详情'),
      replacesTranscript: () => true,
      inputHidden: () => true,
      inputActive: () => false,
      inputEditable: () => false,
    })
    harness.app.start().catch(() => {})
    await tick()
    harness.app.handleInput([{ type: 'paste', text: '偷偷写进去' } as never])
    harness.app.handleInput([
      {
        type: 'key',
        key: {
          name: 'enter',
          ctrl: false,
          alt: false,
          shift: true,
          meta: false,
          sequence: '\r',
        },
      } as never,
    ])
    expect((harness.app as never as { input: { text: string } }).input.text).toBe('')
    await settle()
    harness.renderer.unmount()
  })

  it('可编辑输入仍接收 paste 与 Shift+Enter', async () => {
    const harness = makeHarness({
      start: () => {},
      body: () => createElement(Text, null, '可续聊详情'),
      replacesTranscript: () => true,
      inputHidden: () => false,
      inputDisabled: () => false,
      inputActive: () => true,
      inputEditable: () => true,
    })
    harness.app.start().catch(() => {})
    await tick()
    harness.app.handleInput([{ type: 'paste', text: 'abc' } as never])
    harness.app.handleInput([
      {
        type: 'key',
        key: {
          name: 'enter',
          ctrl: false,
          alt: false,
          shift: true,
          meta: false,
          sequence: '\r',
        },
      } as never,
    ])
    expect((harness.app as never as { input: { text: string } }).input.text).toBe('abc\n')
    await settle()
    harness.renderer.unmount()
  })

  it('activation 卡导航被拒（external / 非主视图）时回落到展开', async () => {
    const harness = makeHarness({ start: () => {}, inputActive: () => true })
    harness.app.start().catch(() => {})
    await tick()
    const model = (
      harness.app as never as {
        options: {
          conversation: {
            model: {
              appendTool: (...args: never[]) => void
              completeTool: (...args: never[]) => void
              units: (options: never) => Array<{ id: string; pressId?: string }>
            }
          }
        }
      }
    ).options.conversation.model
    model.appendTool('call-x' as never, 'subagent' as never, '{}' as never)
    model.completeTool(
      'call-x' as never,
      'started subagent ext-1' as never,
      false as never,
      undefined as never,
    )
    const unit = model
      .units({ width: 80, expanded: new Set() } as never)
      .find((item) => item.pressId === 'subagent:result:ext-1')
    expect(unit).toBeDefined()
    ;(harness.app as never as { handlePress: (id: string) => void }).handlePress(
      'subagent:result:ext-1',
    )
    expect((harness.app as never as { expanded: Set<string> }).expanded.has(unit?.id ?? '')).toBe(
      true,
    )
    await settle()
    harness.renderer.unmount()
  })

  it('dock 渲染在状态栏之后，输入与状态栏仍在它上方', async () => {
    const harness = makeHarness({
      start: () => {},
      dockBody: () => createElement(Text, null, 'DOCK-ROW'),
      dockRows: () => 2,
      inputPlaceholder: () => 'INPUT-PLACEHOLDER',
      inputActive: () => true,
    })
    harness.app.start().catch(() => {})
    await tick()
    harness.app.render()
    harness.renderer.flushFrame()
    const lines = harness.renderer.snapshotLines()
    const dock = lines.findIndex((line) => line.includes('DOCK-ROW'))
    const input = lines.findIndex((line) => line.includes('INPUT-PLACEHOLDER'))
    const status = lines.findIndex((line) => line.includes('Enter 发送 · Ctrl+C 退出'))
    expect(input).toBeGreaterThanOrEqual(0)
    expect(status).toBeGreaterThan(input)
    expect(dock).toBeGreaterThan(status)
    harness.renderer.unmount()
  })

  it('transcriptBodyHeight 扣掉 dockRows', () => {
    const base = {
      width: 80,
      height: 24,
      text: '',
      cursor: 0,
      completionRows: 0,
      modelPanelRows: 0,
      inputHidden: false,
      inputDisabled: false,
      decisions: { hasDecision: false },
      dockRows: 0,
    } as unknown as AppSnapshot
    expect(transcriptBodyHeight({ ...base, dockRows: 2 })).toBe(transcriptBodyHeight(base) - 2)
  })

  it('model 面板打开时不渲染 dock', async () => {
    const harness = makeHarness({
      start: () => {},
      modelPanelRows: () => 2,
      modelPanelBody: () => createElement(Text, null, 'MODEL-PANEL'),
      dockBody: () => createElement(Text, null, 'DOCK-ROW'),
      dockRows: () => 2,
      inputActive: () => true,
    })
    harness.app.start().catch(() => {})
    await tick()
    harness.app.render()
    harness.renderer.flushFrame()
    const lines = harness.renderer.snapshotLines()
    expect(lines).toContain('MODEL-PANEL')
    expect(lines).not.toContain('DOCK-ROW')
    harness.renderer.unmount()
  })

  it('主视图的 feature body（面板）追加在 transcript 之后', async () => {
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
