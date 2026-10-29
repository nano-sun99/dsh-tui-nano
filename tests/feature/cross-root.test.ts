import { describe, expect, it } from 'vitest'
import { scheduleStorageRoot } from '../../src/schedule/storage.ts'
import { findReferences } from '../../src/attachments/prompt.ts'
import { detectTrigger } from '../../src/controls/completions.ts'

describe('跨根隔离（S02 九面中的可纯测部分）', () => {
  it('调度存储按根分目录，两根本会话表互不可见', () => {
    const a = scheduleStorageRoot('/data', 'root-a')
    const b = scheduleStorageRoot('/data', 'root-b')
    expect(a).not.toBe(b)
    expect(a).toContain('root-a')
    expect(b).toContain('root-b')
  })

  it('输入解析不跨根共享状态：引用与触发都只看当前文本', () => {
    expect(findReferences('@a.txt')).toHaveLength(1)
    expect(findReferences('')).toHaveLength(0)
    expect(detectTrigger('/per', 4)?.kind).toBe('command')
    expect(detectTrigger('', 0)).toBeUndefined()
  })
})
