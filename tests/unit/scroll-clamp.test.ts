/** 回归：向上滚过顶后，向下滚必须立刻生效，不能先吐掉看不见的偏移。 */
import { describe, expect, it } from 'vitest'
import { NanoApp } from '../../src/app/nano-app.ts'
import { ConversationController } from '../../src/conversation/controller.ts'
import { Renderer } from '../../src/render/renderer.ts'
import { darkTheme } from '../../src/theme/theme.ts'

function makeController(): ConversationController {
  const controller = new ConversationController({
    ctx: {},
    official: {},
    rootId: 'r',
    cwd: '/tmp',
    history: { record: () => {}, entries: () => [] } as never,
  })
  const paragraph = Array.from({ length: 40 }, (_, index) => `第 ${index} 行滚动内容`).join('\n')
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

describe('transcript scroll clamping', () => {
  it('moves down on the first wheel-down after overscrolling to the top', async () => {
    const renderer = new Renderer({
      write: () => {},
      width: 80,
      height: 24,
      defaultFg: darkTheme.fg,
    })
    const app = new NanoApp({
      core: { ctx: {}, dispose: async () => {} } as never,
      official: {} as never,
      terminal: { width: 80, height: 24, copyToClipboard: () => {} } as never,
      renderer,
      claim: { rootId: 'r', path: '/tmp/x', recovered: false },
      dataRoot: '/tmp',
      cwd: '/tmp',
      rootId: 'r',
      conversation: makeController(),
      history: { entries: () => [] } as never,
      writeDiagnostic: () => {},
    })

    // 首帧（真实启动时同款）先算出滚动上限，再模拟用户操作。
    app.render()
    renderer.flushFrame()

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
    // 让 handleInput 排的渲染跑完，避免卸载后再渲染。
    await new Promise((resolve) => setImmediate(resolve))
    renderer.unmount()
  })
})
