import { createElement, type ReactNode } from 'react'
import { describe, expect, it } from 'vitest'
import { Box } from '../../src/render/components.ts'
import { Renderer } from '../../src/render/renderer.ts'
import { SubagentDock } from '../../src/subagents/dock.ts'
import { buildListRows, renderSubagentList } from '../../src/subagents/list.ts'
import { darkTheme } from '../../src/theme/theme.ts'

function render(element: ReactNode, width = 80, height = 10): string[] {
  const renderer = new Renderer({
    write: () => {},
    width,
    height,
    defaultFg: darkTheme.fg,
  })
  renderer.update(createElement(Box, { flexDirection: 'column', width, height }, element))
  renderer.flushFrame()
  return renderer.snapshotLines()
}

function fakeCtx(entries: Array<{ id: string; mode: string; label?: string }>) {
  const handlers = new Map<string, (info: any) => void>()
  return {
    ctx: {
      get(name: string) {
        if (name === 'subagents') return { listChildren: async () => entries }
        if (name === 'agents') return { get: () => undefined }
        return undefined
      },
      on(event: string, handler: (info: any) => void) {
        handlers.set(event, handler)
        return () => handlers.delete(event)
      },
    },
    emit(event: string, info: any) {
      handlers.get(event)?.(info)
    },
  }
}

describe('dock 渲染', () => {
  it('行内是「指针 + 灯 + 名字 + 右侧状态词」，超过 4 行出溢出入口', async () => {
    const entries = Array.from({ length: 6 }, (_, index) => ({
      id: `s${index}`,
      mode: 'continuable',
      label: `任务 ${index}`,
    }))
    const fake = fakeCtx(entries)
    const dock = new SubagentDock({
      ctx: fake.ctx,
      rootId: 'root',
      onChange: () => {},
      pollMs: 1e9,
    })
    dock.start()
    for (const entry of entries) fake.emit('subagent/start', { id: entry.id })
    await dock.refresh()
    const lines = render(dock.render(60, 's1'))
    const flat = lines.join('\n')
    expect(flat).toContain('任务 0')
    expect(flat).toContain('执行中')
    expect(flat).toContain('›')
    expect(flat).toContain('还有 2 个子代理')
    expect(dock.render(60, 's1')).not.toBeNull()
  })

  it('终态行显示完成灯与状态词', async () => {
    const fake = fakeCtx([{ id: 'a', mode: 'continuable', label: '任务 A' }])
    const dock = new SubagentDock({
      ctx: fake.ctx,
      rootId: 'root',
      onChange: () => {},
      pollMs: 1e9,
    })
    dock.start()
    fake.emit('subagent/start', { id: 'a' })
    fake.emit('subagent/end', { id: 'a', stopReason: 'completed' })
    await dock.refresh()
    const flat = render(dock.render(60)).join('\n')
    expect(flat).toContain('✓')
    expect(flat).toContain('完成')
  })
})

describe('全部子代理列表渲染', () => {
  it('标题带 N，行内标注一次性 / 外部，诊断行显示原因', () => {
    const entries = [
      {
        kind: 'child' as const,
        id: 'a',
        mode: 'continuable',
        label: '任务 A',
        activity: 'running' as const,
        depth: 1,
      },
      {
        kind: 'child' as const,
        id: 'b',
        mode: 'one-shot',
        label: '任务 B',
        activity: 'inactive' as const,
        depth: 1,
      },
      {
        kind: 'child' as const,
        id: 'x',
        mode: 'external',
        label: '外部任务',
        activity: 'inactive' as const,
        depth: 1,
      },
      { kind: 'diagnostic' as const, id: 'bad', reason: 'corrupt', depth: 1 },
      {
        kind: 'child' as const,
        id: 'deep',
        mode: 'continuable',
        label: '后代任务',
        activity: 'running' as const,
        parentId: 'a',
        depth: 2,
      },
    ]
    const rows = buildListRows(entries, () => 'idle')
    const lines = render(
      renderSubagentList({
        width: 70,
        height: 8,
        focusId: 'a',
        scrollTop: 0,
        rows,
        count: 2,
      }),
    )
    const flat = lines.join('\n')
    expect(flat).toContain('全部子代理 · 2')
    expect(flat).toContain('任务 A')
    expect(flat).toContain('一次性')
    expect(flat).toContain('外部')
    expect(flat).toContain('诊断')
    expect(flat).toContain('└ 后代任务')
    expect(flat).toContain('×')
  })

  it('读取中显示「读取中…」', () => {
    const flat = render(
      renderSubagentList({
        width: 70,
        height: 6,
        scrollTop: 0,
        rows: [],
        count: 0,
        loading: true,
      }),
    ).join('\n')
    expect(flat).toContain('读取中…')
  })
})

describe('dock 状态映射渲染', () => {
  for (const [reason, word, light] of [
    ['completed', '完成', '✓'],
    ['aborted', '终止', '■'],
    ['refusal', '终止', '■'],
    ['max-tokens', '终止', '■'],
    ['error', '错误', '✕'],
    ['future-variant', '未运行', '○'],
  ] as const) {
    it(`${reason} → ${word} ${light}`, async () => {
      const fake = fakeCtx([{ id: 'a', mode: 'continuable', label: '任务 A' }])
      const dock = new SubagentDock({
        ctx: fake.ctx,
        rootId: 'root',
        onChange: () => {},
        pollMs: 1e9,
      })
      dock.start()
      fake.emit('subagent/start', { id: 'a' })
      fake.emit('subagent/end', { id: 'a', stopReason: reason })
      await dock.refresh()
      const flat = render(dock.render(60)).join('\n')
      expect(flat).toContain(`${light}`)
      expect(flat).toContain(word)
    })
  }
})
