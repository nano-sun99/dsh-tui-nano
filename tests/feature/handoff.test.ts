import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { takeHandoff, writeHandoff } from '../../src/runtime/handoff.ts'

describe('handoff（受控重启的落点）', () => {
  it('写-读-删一轮完成，读后文件不再存在', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nano-handoff-'))
    const path = writeHandoff(dir, {
      rootId: 'target',
      sessionId: 'source',
      reason: 'root-switch',
      payload: { draft: 'hello' },
    })
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    expect(raw.rootId).toBe('target')
    expect(raw.version).toBe(1)
    const taken = takeHandoff(dir)
    expect(taken?.payload?.draft).toBe('hello')
    expect(takeHandoff(dir)).toBeUndefined()
  })

  it('版本不对时删掉并报错，不猜', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nano-handoff-'))
    const path = writeHandoff(dir, { rootId: 'r', sessionId: 's', reason: 'cold-rename' })
    const body = JSON.parse(readFileSync(path, 'utf8'))
    require('node:fs').writeFileSync(path, JSON.stringify({ ...body, version: 99 }))
    expect(() => takeHandoff(dir)).toThrow(/版本|version/i)
    expect(takeHandoff(dir)).toBeUndefined()
  })
})
