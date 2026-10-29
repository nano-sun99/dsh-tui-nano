import { describe, expect, it } from 'vitest'
import { Monitor, trimLines } from '../../src/monitor/monitor.ts'

function fakeJobs(state: { total: number; chunks: string[]; status: string }) {
  return {
    get: () => ({ status: state.status, output: { total: state.total, earliest: 0 } }),
    readAt: (_id: string, from: number) => {
      const chunks = state.chunks.map((text, index) => ({ text, at: index }))
      return { chunks: from === 0 ? chunks : [], next: state.total, lossy: false }
    },
  }
}

function setup(state: { total: number; chunks: string[]; status: string }) {
  const delivered: Array<{ text: string; mode: string }> = []
  const ctx = { get: (name: string) => (name === 'jobs' ? fakeJobs(state) : undefined) }
  const monitor = new Monitor({
    ctx,
    sessionId: 'root',
    onChange: () => {},
    writeDiagnostic: () => {},
    deliver: (text, mode) => delivered.push({ text, mode }),
    intervalMs: 1_000_000,
  })
  return { monitor, delivered }
}

describe('trimLines', () => {
  it('保留最新行并标注裁剪', () => {
    const result = trimLines('a\nb\nc\nd', 2)
    expect(result.trimmed).toBe(true)
    expect(result.text).toContain('已裁剪 2 行')
    expect(result.text.endsWith('c\nd')).toBe(true)
    expect(trimLines('a\nb', 5)).toEqual({ text: 'a\nb', trimmed: false })
  })
})

describe('Monitor', () => {
  it('默认从当前输出总量开始，不投递旧内容', () => {
    const state = { total: 100, chunks: ['old'], status: 'running' }
    const { monitor, delivered } = setup(state)
    monitor.watch('job-1', 'quiet')
    monitor.poll()
    expect(delivered).toHaveLength(0)
  })

  it('攒够预算就投递一次，并用 quiet 模式', () => {
    const state = { total: 0, chunks: [], status: 'running' }
    const { monitor, delivered } = setup(state)
    monitor.watch('job-1', 'quiet', { bytes: 5, lines: 10 })
    state.chunks = ['hello']
    state.total = 5
    monitor.poll()
    expect(delivered).toHaveLength(1)
    expect(delivered[0]?.mode).toBe('quiet')
    expect(delivered[0]?.text).toContain('hello')
  })

  it('任务结束时补齐剩余内容并停止监听', () => {
    const state = { total: 0, chunks: [], status: 'running' }
    const { monitor, delivered } = setup(state)
    monitor.watch('job-1')
    state.chunks = ['bye']
    state.total = 3
    state.status = 'completed'
    monitor.poll()
    expect(delivered).toHaveLength(1)
    expect(delivered[0]?.text).toContain('bye')
    expect(monitor.watching).toHaveLength(0)
  })
})
