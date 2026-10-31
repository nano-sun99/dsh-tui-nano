import { describe, expect, it } from 'vitest'
import {
  buildListRows,
  countDirectChildren,
  isEnterable,
  listIds,
} from '../../src/subagents/list.ts'

const entries = [
  {
    kind: 'child' as const,
    id: 'a',
    mode: 'continuable',
    label: '任务 A',
    activity: 'running' as const,
    parentId: 'root',
    depth: 1,
  },
  {
    kind: 'child' as const,
    id: 'b',
    mode: 'one-shot',
    label: '任务 B',
    activity: 'inactive' as const,
    parentId: 'root',
    depth: 1,
  },
  {
    kind: 'child' as const,
    id: 'x',
    mode: 'external',
    label: '外部',
    activity: 'inactive' as const,
    parentId: 'root',
    depth: 1,
  },
  {
    kind: 'child' as const,
    id: 'deep',
    mode: 'continuable',
    label: '后代',
    activity: 'running' as const,
    parentId: 'a',
    depth: 2,
  },
  {
    kind: 'diagnostic' as const,
    id: 'bad',
    reason: 'corrupt' as const,
    parentId: 'root',
    depth: 1,
  },
]

describe('buildListRows', () => {
  it('递归后代全列出，external 不可进入，diagnostic 显示原因', () => {
    const rows = buildListRows(entries, () => 'idle')
    expect(rows.map((row) => row.id)).toEqual(['a', 'b', 'x', 'deep', 'bad'])
    expect(rows.find((row) => row.id === 'a')?.enterable).toBe(true)
    expect(rows.find((row) => row.id === 'x')?.enterable).toBe(false)
    expect(rows.find((row) => row.id === 'bad')?.diagnostic).toBe('corrupt')
    expect(rows.find((row) => row.id === 'bad')?.enterable).toBe(false)
  })

  it('一次性会话读不到历史时退成不可导航只读行', () => {
    const rows = buildListRows(
      entries,
      () => 'idle',
      (id) => id !== 'b',
    )
    const row = rows.find((item) => item.id === 'b')
    expect(row?.enterable).toBe(false)
    expect(row?.modeLabel).toContain('不可读')
  })

  it('mode 只在列表里标注：continuable 不缀，其余带中文后缀', () => {
    const rows = buildListRows(entries, () => 'idle')
    expect(rows.find((row) => row.id === 'a')?.modeLabel).toBe('')
    expect(rows.find((row) => row.id === 'b')?.modeLabel).toBe('一次性')
    expect(rows.find((row) => row.id === 'x')?.modeLabel).toBe('外部')
  })

  it('状态优先用 dock 已知终态，其次用 activity', () => {
    const rows = buildListRows(entries, (id) => (id === 'b' ? 'done' : 'idle'))
    expect(rows.find((row) => row.id === 'b')?.status).toBe('done')
    expect(rows.find((row) => row.id === 'deep')?.status).toBe('running')
    expect(rows.find((row) => row.id === 'a')?.status).toBe('running')
  })

  it('多级后代带父级关系与缩进', () => {
    const rows = buildListRows(entries, () => 'idle')
    const deep = rows.find((row) => row.id === 'deep')
    expect(deep?.parentId).toBe('a')
    expect(deep?.indent).toBe(1)
  })
})

describe('countDirectChildren', () => {
  it('N 只数本地直接子代理：不含 external、不含更深的行', () => {
    expect(countDirectChildren(entries, new Set())).toBe(2)
  })

  it('已出列的直接子代理不计入 N，但仍在列表里', () => {
    expect(countDirectChildren(entries, new Set(['a']))).toBe(1)
    expect(buildListRows(entries, () => 'idle').some((row) => row.id === 'a')).toBe(true)
  })
})

describe('listIds / isEnterable', () => {
  it('焦点候选包含所有行（含诊断），Enter 只对可进入行生效', () => {
    const rows = buildListRows(entries, () => 'idle')
    expect(listIds(rows)).toEqual(['a', 'b', 'x', 'deep', 'bad'])
    expect(isEnterable(rows.find((row) => row.id === 'a')!)).toBe(true)
    expect(isEnterable(rows.find((row) => row.id === 'bad')!)).toBe(false)
  })
})
