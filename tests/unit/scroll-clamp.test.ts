/** 回归：向上滚过顶后，向下滚必须立刻生效，不能先吐掉看不见的偏移。 */
import { describe, expect, it } from 'vitest'
import { NanoApp } from '../../src/app/nano-app.ts'
import { ConversationController } from '../../src/conversation/controller.ts'
import { Renderer } from '../../src/render/renderer.ts'
import { darkTheme } from '../../src/theme/theme.ts'

function makeController(paragraph: string): ConversationController {
  const controller = new ConversationController({
    ctx: {},
    official: {},
    rootId: 'r',
    cwd: '/tmp',
    history: { record: () => {}, entries: () => [] } as never,
  })
  controller.model.appendUser('问题', 'req-1')
  controller.model.appendAssistant(1, [{ type: 'text', text: paragraph }])
  return controller
}

function wheel(direction: 1 | -1) {
  return {
    type: 'mouse' as const,
    event: {
      kind: 'wheel' as const,
      button: 'none' as const,
      x: 10,
      y: 10,
      shift: false,
      alt: false,
      ctrl: false,
      wheel: direction,
    },
  }
}

function makeApp(paragraph: string, height = 24) {
  const terminal = { width: 80, height, copyToClipboard: () => {} }
  const renderer = new Renderer({
    write: () => {},
    width: 80,
    height,
    defaultFg: darkTheme.fg,
  })
  const app = new NanoApp({
    core: { ctx: {}, dispose: async () => {} } as never,
    official: {} as never,
    terminal: terminal as never,
    renderer,
    claim: { rootId: 'r', path: '/tmp/x', recovered: false },
    dataRoot: '/tmp',
    cwd: '/tmp',
    rootId: 'r',
    conversation: makeController(paragraph),
    history: { entries: () => [] } as never,
    writeDiagnostic: () => {},
  })
  // 首帧（真实启动时同款）先算出滚动上限，再模拟用户操作。
  app.render()
  renderer.flushFrame()
  return { app, renderer, terminal }
}

async function settle() {
  // 让 handleInput / handleResize 排的渲染跑完，避免卸载后再渲染。
  await new Promise((resolve) => setImmediate(resolve))
}

const shortLines = Array.from({ length: 40 }, (_, index) => `第 ${index} 行滚动内容`).join('\n')
// 78 列恰好塞进 80 列终端；窄 2 列就会折成两行。
const longLines = Array.from({ length: 30 }, () => 'x'.repeat(78)).join('\n')

describe('transcript scroll clamping', () => {
  it('moves down on the first wheel-down after overscrolling to the top', async () => {
    const { app, renderer } = makeApp(shortLines)

    // 15 次上滚 = 45 行，远超内容高度与可见高度之差，必然越过顶部。
    for (let index = 0; index < 15; index++) app.handleInput([wheel(1)])
    app.render()
    renderer.flushFrame()
    const atTop = renderer.snapshotLines()

    app.handleInput([wheel(-1)])
    app.render()
    renderer.flushFrame()
    const afterDown = renderer.snapshotLines()

    expect(afterDown).not.toEqual(atTop)
    await settle()
    renderer.unmount()
  })

  it('moves down immediately with wrapped long lines', async () => {
    const { app, renderer } = makeApp(longLines)

    for (let index = 0; index < 15; index++) app.handleInput([wheel(1)])
    app.render()
    renderer.flushFrame()
    const atTop = renderer.snapshotLines()

    app.handleInput([wheel(-1)])
    app.render()
    renderer.flushFrame()
    const afterDown = renderer.snapshotLines()

    expect(afterDown).not.toEqual(atTop)
    await settle()
    renderer.unmount()
  })

  it('clamps a stale offset when the window grows taller', async () => {
    const { app, renderer, terminal } = makeApp(shortLines)
    for (let index = 0; index < 10; index++) app.handleInput([wheel(1)])
    app.render()
    renderer.flushFrame()

    // 窗口变高后可见行数变多，旧偏移会越过新的顶部。
    terminal.height = 40
    app.handleResize(80, 40)
    app.render()
    renderer.flushFrame()
    const afterResize = renderer.snapshotLines()

    app.handleInput([wheel(-1)])
    app.render()
    renderer.flushFrame()
    const afterDown = renderer.snapshotLines()

    expect(afterDown).not.toEqual(afterResize)
    await settle()
    renderer.unmount()
  })
})
