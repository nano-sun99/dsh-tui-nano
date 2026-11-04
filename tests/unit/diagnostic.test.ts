// 诊断写 / 退出兜底的单元证据（spec 2026-11-03-nano-exit-hardening §3.2、§3.5）。
// 关键判据：写通道死掉之后不再尝试第二次（切断自激），EAGAIN 不算死。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fsMock = vi.hoisted(() => ({ writeSync: vi.fn() }))
vi.mock('node:fs', () => ({ writeSync: fsMock.writeSync }))

/** 每个用例一份新模块：`dead` 是模块级状态，不重置会串味。 */
async function load() {
  vi.resetModules()
  return await import('../../src/runtime/diagnostic.ts')
}

function errno(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException
  error.code = code
  return error
}

beforeEach(() => {
  fsMock.writeSync.mockReset()
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('writeDiagnostic', () => {
  it('EIO 之后熔断：连续 100 次只尝试 1 次，且从不抛', async () => {
    fsMock.writeSync.mockImplementation(() => {
      throw errno('EIO')
    })
    const { writeDiagnostic } = await load()
    for (let index = 0; index < 100; index++) {
      expect(() => writeDiagnostic('nano: 未捕获异常：EIO')).not.toThrow()
    }
    expect(fsMock.writeSync).toHaveBeenCalledTimes(1)
  })

  it('EAGAIN 不熔断：每次调用都重试', async () => {
    fsMock.writeSync.mockImplementation(() => {
      throw errno('EAGAIN')
    })
    const { writeDiagnostic } = await load()
    for (let index = 0; index < 100; index++) {
      expect(() => writeDiagnostic('nano: 终端读停')).not.toThrow()
    }
    expect(fsMock.writeSync).toHaveBeenCalledTimes(100)
  })

  it('熔断后 normal 写也不再尝试；重置后可恢复', async () => {
    fsMock.writeSync.mockImplementationOnce(() => {
      throw errno('EPIPE')
    })
    const { writeDiagnostic, resetDiagnosticForTest } = await load()
    writeDiagnostic('第一条')
    writeDiagnostic('第二条')
    expect(fsMock.writeSync).toHaveBeenCalledTimes(1)
    resetDiagnosticForTest()
    writeDiagnostic('第三条')
    expect(fsMock.writeSync).toHaveBeenCalledTimes(2)
  })

  it('补行尾换行，已有换行不重复', async () => {
    const { writeDiagnostic } = await load()
    writeDiagnostic('without newline')
    writeDiagnostic('with newline\n')
    expect(fsMock.writeSync.mock.calls.map((call) => call[1])).toEqual([
      'without newline\n',
      'with newline\n',
    ])
    expect(fsMock.writeSync.mock.calls.every((call) => call[0] === 2)).toBe(true)
  })
})

describe('forceExit', () => {
  it('process.exit 正常时按给定码退出', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    const { forceExit } = await load()
    forceExit(0)
    expect(exit).toHaveBeenCalledWith(0)
  })

  it('process.exit 抛错时用 SIGKILL 兜底', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.spyOn(process, 'exit').mockImplementation((() => {
      throw errno('EIO')
    }) as never)
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    const { forceExit } = await load()
    expect(() => forceExit(7)).not.toThrow()
    expect(kill).toHaveBeenCalledWith(process.pid, 'SIGKILL')
  })

  it('测试环境里 rethrow，不真的杀自己', async () => {
    vi.stubEnv('NODE_ENV', 'test')
    vi.spyOn(process, 'exit').mockImplementation((() => {
      throw errno('EIO')
    }) as never)
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    const { forceExit } = await load()
    expect(() => forceExit(1)).toThrow('EIO')
    expect(kill).not.toHaveBeenCalled()
  })
})
