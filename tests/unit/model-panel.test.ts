/** /model 面板：默认档、扫光、Max 脉冲、减少动效、应用/取消。 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { ModelPanel } from '../../src/controls/model-panel.ts'
import type { Key } from '../../src/input/parser.ts'

function key(name: Key['name'], extra: Partial<Key> = {}): Key {
  return {
    name,
    text: undefined,
    ctrl: false,
    alt: false,
    shift: false,
    meta: false,
    sequence: '',
    ...extra,
  } as Key
}

function fakeConversation(modelName = 'M1') {
  const calls: Array<{ provider: string; model: string; effort?: string }> = []
  return {
    calls,
    modelSelection: { provider: 'p', model: 'm1' },
    listModels: async () => [
      { id: 'm1', name: modelName },
      { id: 'm2', name: 'M2' },
    ],
    resolveModelMeta: async (_provider: string, model: string) =>
      model === 'm1'
        ? {
            efforts: [
              { id: 'off', name: 'Off' },
              { id: 'low', name: 'Low' },
              { id: 'high', name: 'High' },
              { id: 'max', name: 'Max' },
            ],
            defaultEffort: 'high',
          }
        : { efforts: [{ id: 'low', name: 'Low' }] },
    selectModel: async (provider: string, model: string, effort?: string) => {
      calls.push({ provider, model, ...(effort ? { effort } : {}) })
      return { provider, model, ...(effort ? { reasoningEffort: effort } : {}) }
    },
  }
}

function colors(json: string): Array<[number, number, number]> {
  const out: Array<[number, number, number]> = []
  for (const match of json.matchAll(/"color":\[(\d+),(\d+),(\d+)\]/g)) {
    out.push([Number(match[1]), Number(match[2]), Number(match[3])])
  }
  return out
}

interface Span {
  readonly color: [number, number, number]
  readonly text: string
}

/** Flatten every colored text run in the rendered element tree. */
function spans(node: any): Span[] {
  const out: Span[] = []
  const visit = (value: any): void => {
    if (!value || typeof value !== 'object') return
    const children = value.props?.children
    const text = Array.isArray(children)
      ? children.filter((child: unknown) => typeof child === 'string').join('')
      : typeof children === 'string'
        ? children
        : ''
    if (text !== '' && Array.isArray(value.props?.color)) {
      out.push({ color: value.props.color, text })
    }
    if (Array.isArray(children)) children.forEach(visit)
    else if (children && typeof children === 'object') visit(children)
  }
  visit(node)
  return out
}

/** Per-cell colors of the effort bar (fill first, then the rule track). */
function barColors(panel: ModelPanel, width = 100): Array<[number, number, number]> {
  return spans(panel.render(width))
    .filter((span) => /^█+$/u.test(span.text))
    .flatMap((span) => Array.from({ length: span.text.length }, () => span.color))
}

function brightestFraction(cells: Array<[number, number, number]>, limit: number): number {
  let best = -1
  let index = 0
  cells.slice(0, limit).forEach(([r, g, b], at) => {
    const value = 0.2126 * r + 0.7152 * g + 0.0722 * b
    if (value > best) {
      best = value
      index = at
    }
  })
  return index / Math.max(1, limit - 1)
}

async function open(notices: string[] = [], modelName = 'M1') {
  const conversation = fakeConversation(modelName)
  const panel = new ModelPanel({
    conversation: conversation as never,
    onChange: () => {},
    setNotice: (text) => {
      if (text) notices.push(text)
    },
  })
  await panel.openPanel()
  return { panel, conversation, notices }
}

afterEach(() => {
  delete process.env.NANO_REDUCED_MOTION
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('/model panel', () => {
  it('显示模型、当前摘要与官方档位', async () => {
    const { panel } = await open()
    const json = JSON.stringify(panel.render(100))
    expect(json).toContain('模型')
    expect(json).toContain('当前：M1')
    expect(json).toContain('▶ M1')
    expect(json).toContain('Off')
    expect(json).toContain('Max')
    expect(json).toContain('█')
    panel.handleKey(key('escape'))
  })

  it('倒数第二档（High）扫光：底色 + 高光梯度', async () => {
    const { panel } = await open()
    panel.handleKey(key('right'))
    panel.handleKey(key('right'))
    panel.handleKey(key('right')) // Off → Low → High
    const values = colors(JSON.stringify(panel.render(100)))
    expect(values.some(([r, g, b]) => r === 93 && g === 127 && b === 173)).toBe(true)
    expect(values.some(([r, g, b]) => r > 130 && g > 160 && b > 200)).toBe(true)
    panel.handleKey(key('escape'))
  })

  it('扫光按设计稿 1.4s 周期：0.72s 后离开填充区、1.4s 从左缘重播', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const { panel } = await open()
    panel.handleKey(key('right'))
    panel.handleKey(key('right'))
    panel.handleKey(key('right')) // Off → Low → High
    const fill = 64 // 100 列内容宽 96，High 占 2/3

    expect(brightestFraction(barColors(panel), fill)).toBeLessThanOrEqual(0.1)
    vi.setSystemTime(600)
    expect(brightestFraction(barColors(panel), fill)).toBeGreaterThanOrEqual(0.9)
    vi.setSystemTime(800)
    expect(
      barColors(panel)
        .slice(0, fill)
        .every(([r, g, b]) => r === 93 && g === 127 && b === 173),
    ).toBe(true)
    vi.setSystemTime(1400)
    expect(brightestFraction(barColors(panel), fill)).toBeLessThanOrEqual(0.1)

    panel.handleKey(key('escape'))
  })

  it('60 列头部摘要不被提前截断', async () => {
    const { panel } = await open([], 'DeepSeek-V4.1-Flash')
    const summary = spans(panel.render(60)).find((span) => span.text.startsWith('当前：'))
    expect(summary?.text).toContain('默认（模型默认：High）')
    expect(summary?.text).not.toContain('…')
    panel.handleKey(key('escape'))
  })

  it('Max 脉冲：颜色在深蓝与亮蓝之间', async () => {
    const { panel } = await open()
    for (let i = 0; i < 4; i++) panel.handleKey(key('right'))
    const values = colors(JSON.stringify(panel.render(100)))
    expect(values.some(([r, g, b]) => r >= 54 && b >= 157)).toBe(true)
    panel.handleKey(key('escape'))
  })

  it('减少动效：扫光档只保留静态底色', async () => {
    process.env.NANO_REDUCED_MOTION = '1'
    const { panel } = await open()
    panel.handleKey(key('right'))
    panel.handleKey(key('right'))
    panel.handleKey(key('right'))
    const values = colors(JSON.stringify(panel.render(100)))
    expect(values.some(([r, g, b]) => r === 93 && g === 127 && b === 173)).toBe(true)
    expect(values.some(([r, g, b]) => r > 130 && b > 200)).toBe(false)
    panel.handleKey(key('escape'))
  })

  it('Enter 应用焦点模型与强度；Esc 取消并给回执', async () => {
    const notices: string[] = []
    const { panel, conversation } = await open(notices)
    panel.handleKey(key('down'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    panel.handleKey(key('right'))
    panel.handleKey(key('enter'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(conversation.calls.at(-1)).toEqual({ provider: 'p', model: 'm2', effort: 'low' })
    expect(notices.at(-1)).toContain('已选择')

    const second = await open(notices)
    second.panel.handleKey(key('escape'))
    expect(notices.at(-1)).toContain('已取消')
  })
})
