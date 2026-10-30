import { describe, expect, it } from 'vitest'
import { NanoApp } from '../../src/app/nano-app.ts'
import { ConversationController } from '../../src/conversation/controller.ts'
import { Renderer } from '../../src/render/renderer.ts'
import { darkTheme } from '../../src/theme/theme.ts'

class FakeContext {
  handlers = new Map<string, (...args: never[]) => unknown>()
  on(name: string, handler: (...args: never[]) => unknown) {
    this.handlers.set(name, handler)
  }
}

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function makeHarness() {
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
  let featureContext:
    | { setNotice: (text: string | undefined, tone?: 'info' | 'danger') => void }
    | undefined
  const features = {
    start: (context: typeof featureContext) => {
      featureContext = context
    },
    inputActive: () => true,
  }
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
    features,
  })
  return {
    app,
    renderer,
    output: () => chunks.join(''),
    context: () => featureContext,
  }
}

describe('composer notice wiring', () => {
  it('shows a feature notice on the status line and clears it on edit', async () => {
    const harness = makeHarness()
    harness.app.start().catch(() => {})
    await tick()

    const context = harness.context()
    expect(context).toBeDefined()
    context?.setNotice('已选择 deepseek-v4-pro · 默认。')
    harness.app.render()
    harness.renderer.flushFrame()
    expect(harness.renderer.snapshotLines().at(-1) ?? '').toContain('已选择 deepseek-v4-pro')

    harness.app.handleInput([{ type: 'paste', text: 'x' }])
    harness.app.render()
    harness.renderer.flushFrame()
    const status = harness.renderer.snapshotLines().at(-1) ?? ''
    expect(status).not.toContain('已选择')
    expect(status).toContain('/tmp/project')
    await new Promise((resolve) => setImmediate(resolve))
    harness.renderer.unmount()
  })
})
