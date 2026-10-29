import { describe, expect, it } from 'vitest'
import { deriveStatus, pruneRows, statusWord } from '../../src/subagents/dock.ts'

describe('statusWord', () => {
  it('只产出 ADR 的五个状态词', () => {
    expect(statusWord('running')).toBe('执行中')
    expect(statusWord('done')).toBe('完成')
    expect(statusWord('killed')).toBe('终止')
    expect(statusWord('error')).toBe('错误')
    expect(statusWord('idle')).toBe('未运行')
  })
})

describe('deriveStatus', () => {
  it('把官方状态并入五个词之一，unknown 终态归未运行', () => {
    expect(deriveStatus({ status: 'running' })).toBe('running')
    expect(deriveStatus({ status: 'completed' })).toBe('done')
    expect(deriveStatus({ status: 'failed' })).toBe('error')
    expect(deriveStatus({ status: 'killed' })).toBe('killed')
    expect(deriveStatus({ status: 'something-else' })).toBe('idle')
  })
})

describe('pruneRows', () => {
  it('终态行保留 30 秒后移除，活动行不动', () => {
    const now = 1_000_000
    const rows = [
      { id: 'a', name: 'a', status: 'running' as const },
      { id: 'b', name: 'b', status: 'done' as const, finishedAt: now - 10_000 },
      { id: 'c', name: 'c', status: 'done' as const, finishedAt: now - 31_000 },
    ]
    expect(pruneRows(rows, now).map((row) => row.id)).toEqual(['a', 'b'])
  })
})
