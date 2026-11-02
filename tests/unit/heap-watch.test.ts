import { afterEach, describe, expect, it, vi } from 'vitest'
import { HEAP_WARN_MB, startHeapWatch } from '../../src/runtime/heap-watch.ts'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

describe('堆看门狗', () => {
  it('没超预警线不写诊断', () => {
    vi.useFakeTimers()
    const lines: string[] = []
    startHeapWatch({
      intervalMs: 1000,
      heapUsedMb: () => HEAP_WARN_MB - 1,
      report: (line) => lines.push(line),
    })
    vi.advanceTimersByTime(5000)
    expect(lines).toHaveLength(0)
  })

  it('超线写一行，并带上实际占用', () => {
    vi.useFakeTimers()
    const lines: string[] = []
    let used = 100
    startHeapWatch({ intervalMs: 1000, heapUsedMb: () => used, report: (line) => lines.push(line) })
    vi.advanceTimersByTime(2000)
    expect(lines).toHaveLength(0)
    used = 3000
    vi.advanceTimersByTime(1000)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('3000MB')
  })

  it('冷却期内不重复刷屏，冷却过后再报', () => {
    vi.useFakeTimers()
    const lines: string[] = []
    startHeapWatch({
      intervalMs: 1000,
      cooldownMs: 60_000,
      heapUsedMb: () => 4096,
      report: (line) => lines.push(line),
    })
    vi.advanceTimersByTime(30_000)
    expect(lines).toHaveLength(1)
    vi.advanceTimersByTime(29_000)
    expect(lines).toHaveLength(1)
    vi.advanceTimersByTime(2_000)
    expect(lines).toHaveLength(2)
  })

  it('停止后不再检查', () => {
    vi.useFakeTimers()
    const lines: string[] = []
    const stop = startHeapWatch({
      intervalMs: 1000,
      heapUsedMb: () => 4096,
      report: (line) => lines.push(line),
    })
    vi.advanceTimersByTime(1000)
    expect(lines).toHaveLength(1)
    stop()
    vi.advanceTimersByTime(600_000)
    expect(lines).toHaveLength(1)
  })

  it('间隔有 1s 下限，不会被夹成毫秒轮询', () => {
    vi.useFakeTimers()
    const lines: string[] = []
    startHeapWatch({ intervalMs: 0, heapUsedMb: () => 4096, report: (line) => lines.push(line) })
    vi.advanceTimersByTime(999)
    expect(lines).toHaveLength(0)
    vi.advanceTimersByTime(1)
    expect(lines).toHaveLength(1)
  })

  it('堆值读不出来（NaN）时不写假警报', () => {
    vi.useFakeTimers()
    const lines: string[] = []
    startHeapWatch({
      intervalMs: 1000,
      heapUsedMb: () => Number.NaN,
      report: (line) => lines.push(line),
    })
    vi.advanceTimersByTime(10_000)
    expect(lines).toHaveLength(0)
  })

  it('预警线可用环境变量覆盖', () => {
    vi.useFakeTimers()
    vi.stubEnv('NANO_HEAP_WARN_MB', '100')
    const lines: string[] = []
    startHeapWatch({ intervalMs: 1000, heapUsedMb: () => 200, report: (line) => lines.push(line) })
    vi.advanceTimersByTime(1000)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('100MB')
  })
})
