import { createElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { launchNodeEnv } from '../../src/boot/env.ts'
import { Box, Text } from '../../src/render/components.ts'
import { Renderer } from '../../src/render/renderer.ts'

/**
 * issue #138：`react-reconciler` 的开发构建给每次组件渲染打一条
 * `performance.measure`，Node 的全局测量缓冲只增不减，长会话一路涨到 OOM。
 * 这里锁住两条防线：启动时的 NODE_ENV 默认值，以及渲染循环里的定期清理。
 */

const settle = () => new Promise((resolve) => setImmediate(resolve))

function tree(tick: number) {
  return createElement(
    Box,
    { flexDirection: 'column' },
    ...Array.from({ length: 40 }, (_, index) =>
      createElement(Text, { key: index }, `row ${index} ${tick}`),
    ),
  )
}

afterEach(() => {
  performance.clearMeasures()
})

describe('启动环境', () => {
  it('没设 NODE_ENV 时默认生产构建', () => {
    expect(launchNodeEnv(undefined)).toBe('production')
    expect(launchNodeEnv('')).toBe('production')
  })

  it('显式设置时不覆盖（development 仍可调试）', () => {
    expect(launchNodeEnv('development')).toBe('development')
    expect(launchNodeEnv('test')).toBe('test')
  })
})

describe('渲染循环清理测量缓冲', () => {
  it('连续渲染后 measure 条数保持有界', async () => {
    performance.clearMeasures()
    const renderer = new Renderer({
      write: () => {},
      width: 60,
      height: 12,
      defaultFg: [232, 230, 224],
    })
    renderer.mount(tree(0))
    await settle()
    const updates = 150
    for (let tick = 1; tick <= updates; tick++) {
      renderer.update(tree(tick))
      await settle()
    }
    const measures = performance.getEntriesByType('measure').length
    renderer.unmount()
    // 不清理时这类树每帧约 40+ 条，150 帧会是 6000 条上下；清理后只留最后一个窗口。
    expect(measures).toBeLessThan(3000)
    expect(measures).toBeLessThan(updates * 20)
  })
})
