import { describe, expect, it } from 'vitest'
import { TranscriptModel } from '../../src/transcript/model.ts'

describe('activation 结果卡', () => {
  it('pressId 指向子代理详情，而不是普通展开', () => {
    const model = new TranscriptModel()
    model.appendTool('call-1', 'Task', '{"prompt":"查一下"}')
    model.completeTool('call-1', '已启动', false, {
      kind: 'activation',
      subagentId: 'child-1',
    })
    const lines = model.layout({ width: 60, expanded: new Set() })
    const target = lines.find((line) => line.row.pressId?.startsWith('subagent:result:'))
    expect(target?.row.pressId).toBe('subagent:result:child-1')
  })

  it('官方 subagent 工具没有 resultMeta 时，从稳定回执文本识别激活卡', () => {
    const model = new TranscriptModel()
    model.appendTool('call-3', 'subagent', '{"prompt":"查一下"}')
    model.completeTool('call-3', 'started subagent child-3', false, undefined)
    const lines = model.layout({ width: 60, expanded: new Set() })
    const target = lines.find((line) => line.row.pressId?.startsWith('subagent:result:'))
    expect(target?.row.pressId).toBe('subagent:result:child-3')
  })

  it('别的工具即使回执文本相同也不导航', () => {
    const model = new TranscriptModel()
    model.appendTool('call-4', 'Read', '{"file":"a"}')
    model.completeTool('call-4', 'started subagent child-4', false, undefined)
    const lines = model.layout({ width: 60, expanded: new Set() })
    expect(lines.some((line) => line.row.pressId === 'subagent:result:child-4')).toBe(false)
  })

  it('普通工具卡仍然只展开', () => {
    const model = new TranscriptModel()
    model.appendTool('call-2', 'Read', '{"file":"a"}')
    model.completeTool('call-2', '内容', false, undefined)
    const lines = model.layout({ width: 60, expanded: new Set() })
    expect(lines.some((line) => line.row.pressId === 'subagent:result:child-1')).toBe(false)
    expect(
      lines.some((line) => line.row.pressId === 'tool-call-2' || line.row.pressId === 'call-2'),
    ).toBe(true)
  })
})
