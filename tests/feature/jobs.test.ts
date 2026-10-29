import { describe, expect, it } from 'vitest'
import { classifyStop, statusWord } from '../../src/jobs/panel.ts'

describe('statusWord', () => {
  it('把官方状态码翻成状态词，未知状态原样显示', () => {
    expect(statusWord('running')).toBe('运行中')
    expect(statusWord('killed')).toBe('已停止')
    expect(statusWord('weird')).toBe('weird')
  })
})

describe('classifyStop', () => {
  it('区分已请求停止、已结束与任务不存在', () => {
    const live = { kill: () => 'requested' }
    const finished = { kill: () => 'already-finished' }
    const missing = {
      kill: () => {
        throw new Error('job not found')
      },
    }
    expect(classifyStop('job-1', 'root', live)).toBe('requested')
    expect(classifyStop('job-1', 'root', finished)).toBe('already-finished')
    expect(classifyStop('job-1', 'root', missing)).toBe('job/not-found')
  })
})
