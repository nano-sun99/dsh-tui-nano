import { describe, expect, it } from 'vitest'
import { parseBashInput, renderBashInjection } from '../../src/controls/bash-mode.ts'

describe('parseBashInput', () => {
  it('区分 ! 与 !!：前者注入、后者只本地显示', () => {
    expect(parseBashInput('!ls -la')).toEqual({ command: 'ls -la', inject: true })
    expect(parseBashInput('  !!echo hi')).toEqual({ command: 'echo hi', inject: false })
  })

  it('不是人工命令或命令为空时不接管', () => {
    expect(parseBashInput('hello')).toBeUndefined()
    expect(parseBashInput('!')).toBeUndefined()
    expect(parseBashInput('!!   ')).toBeUndefined()
  })
})

describe('renderBashInjection', () => {
  it('注入文本带命令、退出码与合并输出，并标明是人工命令', () => {
    const text = renderBashInjection({
      command: 'false',
      exitCode: 1,
      stdout: 'out',
      stderr: 'err',
      timedOut: false,
      aborted: false,
    })
    expect(text).toContain('[人工命令] $ false')
    expect(text).toContain('退出码 1')
    expect(text).toContain('out\nerr')
  })
})
