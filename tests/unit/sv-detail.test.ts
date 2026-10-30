import { describe, expect, it } from 'vitest'
import {
  composerState,
  detailTitle,
  foldSessionEvent,
  modeAllowsDetail,
  replaySessionMessages,
} from '../../src/subagents/detail.ts'
import { TranscriptModel } from '../../src/transcript/model.ts'

describe('detailTitle', () => {
  it('顶部标识是「子代理 · 名字 · 状态词」', () => {
    expect(detailTitle('核对样式回归', 'done')).toBe('子代理 · 核对样式回归 · 完成')
  })
})

describe('composerState', () => {
  it('可续聊 + parent live：输入可用，child 运行时 Stop 可用', () => {
    expect(composerState({ mode: 'continuable', parentLive: true, childRunning: true })).toEqual({
      showInput: true,
      editable: true,
      showStop: true,
    })
    expect(composerState({ mode: 'continuable', parentLive: true, childRunning: false })).toEqual({
      showInput: true,
      editable: true,
      showStop: false,
    })
  })

  it('parent 不可用：输入禁用，但 child 运行中仍保留独立 Stop', () => {
    expect(composerState({ mode: 'continuable', parentLive: false, childRunning: true })).toEqual({
      showInput: true,
      editable: false,
      showStop: true,
    })
    expect(composerState({ mode: 'continuable', parentLive: false, childRunning: false })).toEqual({
      showInput: true,
      editable: false,
      showStop: false,
    })
  })

  it('一次性与未知模式只读，不画输入框和 Stop', () => {
    expect(composerState({ mode: 'one-shot', parentLive: true, childRunning: false })).toEqual({
      showInput: false,
      editable: false,
      showStop: false,
    })
    expect(composerState({ mode: 'unknown', parentLive: true, childRunning: false })).toEqual({
      showInput: false,
      editable: false,
      showStop: false,
    })
  })
})

describe('modeAllowsDetail', () => {
  it('external 不进入详情，其余模式可以', () => {
    expect(modeAllowsDetail('external')).toBe(false)
    expect(modeAllowsDetail('continuable')).toBe(true)
    expect(modeAllowsDetail('one-shot')).toBe(true)
    expect(modeAllowsDetail('unknown')).toBe(true)
  })
})

describe('replaySessionMessages', () => {
  it('把官方消息投影折回 transcript 条目', () => {
    const model = new TranscriptModel()
    replaySessionMessages(model, [
      { role: 'user', content: [{ type: 'text', text: '查一下' }], source: { kind: 'user' } },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: '开始查' },
          { type: 'tool-call', id: 'call-1', name: 'Read', arguments: '{"file":"a"}' },
        ],
      },
      { role: 'tool', toolCallId: 'call-1', content: [{ type: 'text', text: '结果' }] },
    ])
    const kinds = model.all.map((entry) => entry.kind)
    expect(kinds).toEqual(['user', 'assistant', 'tool'])
    const tool = model.all.find((entry) => entry.kind === 'tool')
    expect(tool?.status).toBe('ok')
  })
})

describe('foldSessionEvent', () => {
  it('只把用户来源的消息与 notice 折进正文', () => {
    const model = new TranscriptModel()
    foldSessionEvent(model, {
      seq: 1,
      type: 'user/message',
      data: { content: [{ type: 'text', text: '注入' }], source: { kind: 'instruction' } },
    })
    foldSessionEvent(model, {
      seq: 2,
      type: 'user/message',
      data: {
        content: [{ type: 'text', text: '完成回执' }],
        source: { form: 'notice', summary: '完成回执' },
      },
    })
    foldSessionEvent(model, {
      seq: 3,
      type: 'user/message',
      data: { content: [{ type: 'text', text: '用户说的' }], source: { kind: 'user' } },
    })
    expect(model.all.map((entry) => entry.kind)).toEqual(['notice', 'user'])
  })

  it('工具结果保留 resultMeta，错误结果标 error', () => {
    const model = new TranscriptModel()
    foldSessionEvent(model, {
      seq: 1,
      type: 'tool/call',
      data: { callId: 'c1', name: 'Task', arguments: '{}' },
    })
    foldSessionEvent(model, {
      seq: 2,
      type: 'tool/result',
      data: {
        message: { toolCallId: 'c1', content: [{ type: 'text', text: '失败' }], isError: true },
        meta: { kind: 'activation', subagentId: 'child-1' },
      },
    })
    const tool = model.all.find((entry) => entry.kind === 'tool')
    expect(tool?.status).toBe('error')
    expect(tool?.resultMeta).toEqual({ kind: 'activation', subagentId: 'child-1' })
  })
})
