/** 输入区回归：占位符消失、高度跟 Claude Code（一行留白 + 输入行 + 下边框）。 */

import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { App, type AppSnapshot } from '../../src/app/App.tsx'
import { DecisionManager as Decisions } from '../../src/decisions/manager.ts'
import { Renderer } from '../../src/render/renderer.ts'
import { darkTheme } from '../../src/theme/theme.ts'
import { TranscriptModel } from '../../src/transcript/model.ts'

const ESC = String.fromCharCode(27)
const CUP_END = new RegExp(`${ESC}\\[\\d+;\\d+H$`)

function snapshot(
  text: string,
  cursor = text.length,
  overrides: Partial<AppSnapshot> = {},
): AppSnapshot {
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
    cwd: '/tmp/project',
    expanded: new Set<string>(),
    scrollOffset: 0,
    stickBottom: true,
    userName: '你',
    ...overrides,
  }
}

function rendererFor() {
  const chunks: string[] = []
  const renderer = new Renderer({
    write: (bytes) => chunks.push(bytes),
    width: 80,
    height: 24,
    defaultFg: darkTheme.fg,
  })
  renderer.mount(createElement(App, { snapshot: snapshot('') }))
  renderer.flushFrame()
  return { renderer, output: () => chunks.join('') }
}

function draw(target: ReturnType<typeof rendererFor>, next: AppSnapshot): string[] {
  target.renderer.update(createElement(App, { snapshot: next }))
  target.renderer.flushFrame()
  return target.renderer.snapshotLines()
}

describe('input frame', () => {
  it('输入文字后占位符消失', () => {
    const target = rendererFor()
    expect(target.renderer.snapshotLines().join('\n')).toContain('输入消息')
    const lines = draw(target, snapshot('hello'))
    expect(lines.join('\n')).toContain('hello')
    expect(lines.join('\n')).not.toContain('输入消息')
    target.renderer.unmount()
  })

  it('输入区：上下各一条边框，夹住输入行', () => {
    const target = rendererFor()
    const lines = draw(target, snapshot('hello'))
    const row = lines.findIndex((line) => line.includes('hello'))
    expect(row).toBeGreaterThan(0)
    expect(lines[row - 1]?.trimStart().startsWith('─')).toBe(true)
    expect(lines[row + 1]?.trimStart().startsWith('─')).toBe(true)
    target.renderer.unmount()
  })

  it('行尾插入点停靠到 caret 格', () => {
    const target = rendererFor()
    const lines = draw(target, snapshot('hello'))
    const row = lines.findIndex((line) => line.includes('hello'))
    const col = (lines[row] ?? '').indexOf('hello') + 'hello'.length
    expect(target.output().endsWith(`\x1b[${row + 1};${col + 1}H`)).toBe(true)
    expect(target.output()).not.toContain('\x1b[?25h')
    target.renderer.unmount()
  })

  it('满行时光标换到下一行并继续停靠', () => {
    const target = rendererFor()
    const text = 'a'.repeat(74)
    const lines = draw(target, snapshot(text))
    const row = lines.findIndex((line) => line.includes('a'.repeat(74)))
    expect(row).toBeGreaterThan(0)
    expect(target.output().endsWith(`\x1b[${row + 2};4H`)).toBe(true)
    target.renderer.unmount()
  })

  it('caretActive=false 时不停靠', () => {
    const target = rendererFor()
    draw(target, snapshot('hello', 5, { caretActive: false }))
    expect(CUP_END.test(target.output())).toBe(false)
    target.renderer.unmount()
  })

  it('长草稿只显示 4 行，窗口跟随插入点', () => {
    const target = rendererFor()
    const text = Array.from({ length: 10 }, (_, index) => `l${index}`).join('\n')
    const atEnd = draw(target, snapshot(text, text.length))
    expect(atEnd.join('\n')).toContain('l9')
    expect(atEnd.join('\n')).not.toContain('l0')

    const atStart = draw(target, snapshot(text, 0))
    expect(atStart.join('\n')).toContain('l0')
    expect(atStart.join('\n')).not.toContain('l9')
    target.renderer.unmount()
  })

  it('caretActive=false 时窗口仍按光标位置取', () => {
    const target = rendererFor()
    const text = Array.from({ length: 8 }, (_, index) => `l${index}`).join('\n')
    const lines = draw(target, snapshot(text, 0, { caretActive: false }))
    expect(lines.join('\n')).toContain('l0')
    expect(lines.join('\n')).not.toContain('l7')
    target.renderer.unmount()
  })

  it('notice 显示在状态行左侧并顶替 cwd', () => {
    const target = rendererFor()
    const withNotice = draw(
      target,
      snapshot('', 0, { notice: { text: '已选择 deepseek-v4-pro · 默认。', tone: 'info' } }),
    )
    const status = withNotice.at(-1) ?? ''
    expect(status).toContain('已选择 deepseek-v4-pro')
    expect(status).not.toContain('/tmp/project')

    const without = draw(target, snapshot('', 0))
    expect(without.at(-1) ?? '').toContain('/tmp/project')
    target.renderer.unmount()
  })

  it('决策卡激活时不渲染 caret，解决后恢复', async () => {
    const handlers = new Map<string, (payload: unknown) => Promise<unknown>>()
    const decisions = new Decisions()
    decisions.register({
      on: (name: string, handler: (payload: unknown) => Promise<unknown>) =>
        handlers.set(name, handler),
    } as never)
    const pending = handlers.get('approval/request')?.({ toolName: 'bash' })
    await new Promise((resolve) => setTimeout(resolve, 0))

    const target = rendererFor()
    draw(target, snapshot('hi', 2, { decisions }))
    expect(CUP_END.test(target.output())).toBe(false)

    decisions.resolveApproval('allowed-once')
    await pending
    draw(target, snapshot('hi', 2, { decisions }))
    expect(CUP_END.test(target.output())).toBe(true)
    target.renderer.unmount()
  })

  it('danger notice uses the danger colour', () => {
    const target = rendererFor()
    const lines = draw(target, snapshot('', 0, { notice: { text: '发送失败', tone: 'danger' } }))
    const row = lines.length - 1
    const col = (lines[row] ?? '').indexOf('发送失败')
    const screen = (
      target.renderer as unknown as {
        previous: { rows: Array<Array<{ style: { fg?: [number, number, number] } }>> }
      }
    ).previous
    expect(screen.rows[row]?.[col]?.style.fg).toEqual(darkTheme.danger)
    target.renderer.unmount()
  })

  it('notice 不再出现在输入行', () => {
    const target = rendererFor()
    const lines = draw(
      target,
      snapshot('hello', 0, { notice: { text: '已选择 deepseek-v4-pro · 默认。', tone: 'info' } }),
    )
    const input = lines.find((line) => line.includes('hello')) ?? ''
    expect(input).not.toContain('已选择')
    target.renderer.unmount()
  })
})
