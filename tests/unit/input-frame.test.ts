/** 输入区回归：占位符消失、高度跟 Claude Code（一行留白 + 输入行 + 下边框）。 */

import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { App, type AppSnapshot } from '../../src/app/App.tsx'
import { DecisionManager as Decisions } from '../../src/decisions/manager.ts'
import { Renderer } from '../../src/render/renderer.ts'
import { darkTheme } from '../../src/theme/theme.ts'
import { TranscriptModel } from '../../src/transcript/model.ts'

function snapshot(text: string, cursor = text.length): AppSnapshot {
  return {
    transcript: new TranscriptModel(),
    decisions: new Decisions(),
    text,
    cursor,
    theme: darkTheme,
    width: 80,
    height: 24,
    rootId: 'r',
    modelLabel: 'deepseek-official/deepseek-chat',
    status: 'idle',
    expanded: new Set<string>(),
    scrollOffset: 0,
    stickBottom: true,
    userName: '你',
  }
}

function rendererFor(): Renderer {
  const renderer = new Renderer({
    write: () => {},
    width: 80,
    height: 24,
    defaultFg: darkTheme.fg,
  })
  renderer.mount(createElement(App, { snapshot: snapshot('') }))
  renderer.flushFrame()
  return renderer
}

describe('input frame', () => {
  it('输入文字后占位符消失', () => {
    const renderer = rendererFor()
    expect(renderer.snapshotLines().join('\n')).toContain('输入消息')
    renderer.update(createElement(App, { snapshot: snapshot('hello') }))
    renderer.flushFrame()
    const lines = renderer.snapshotLines()
    expect(lines.join('\n')).toContain('hello')
    expect(lines.join('\n')).not.toContain('输入消息')
    renderer.unmount()
  })

  it('输入区高度：上方一行留白、输入行、下方一条边框', () => {
    const renderer = rendererFor()
    renderer.update(createElement(App, { snapshot: snapshot('hello') }))
    renderer.flushFrame()
    const lines = renderer.snapshotLines()
    const row = lines.findIndex((line) => line.includes('hello'))
    expect(row).toBeGreaterThan(0)
    expect(lines[row - 1]?.trim()).toBe('')
    expect(lines[row + 1]?.trimStart().startsWith('▔')).toBe(true)
    renderer.unmount()
  })
})
