import { describe, expect, it, vi } from 'vitest'
import { ConversationController } from '../../src/conversation/controller.ts'

function makeController(
  options: {
    listModels?: (provider: string) => Promise<any[]>
    resolveModelInfo?: () => Promise<any>
    current?: () => any
  } = {},
) {
  const select = vi.fn()
  const llm = {
    listModels: options.listModels ?? (async () => [{ id: 'm1' }, { id: 'm2' }]),
    resolveModelInfo:
      options.resolveModelInfo ?? (async () => ({ reasoning: { efforts: [{ id: 'high' }] } })),
    resolveCallConfig: vi.fn(async (selection: any) => selection),
  }
  const ctx = {
    get(name: string) {
      if (name === 'llm') return llm
      if (name === 'agentDefaultModel') return { saveSelection: vi.fn(async () => {}) }
      return undefined
    },
  }
  const controller = new ConversationController({
    ctx,
    official: {} as any,
    rootId: 'root',
    cwd: '/tmp',
    history: {} as any,
  })
  ;(controller as any).handle = {
    agent: {
      model: {
        select,
        current: options.current ?? (() => undefined),
      },
    },
  }
  return { controller, select, llm }
}

describe('模型选择（DSH 0.2.2 的 Agent 持有选择）', () => {
  it('切换成功后把选择交给 agent.model.select，而不是只改本地 UI 状态', async () => {
    const { controller, select, llm } = makeController()
    const result = await controller.selectModel('p', 'm1', 'high')

    expect(select).toHaveBeenCalledTimes(1)
    expect(select).toHaveBeenCalledWith({ provider: 'p', model: 'm1', reasoningEffort: 'high' })
    expect(llm.resolveCallConfig).toHaveBeenCalledWith({
      provider: 'p',
      model: 'm1',
      reasoningEffort: 'high',
    })
    expect(result).toMatchObject({ provider: 'p', model: 'm1', reasoningEffort: 'high' })
    expect(controller.modelSelection).toEqual({
      provider: 'p',
      model: 'm1',
      reasoningEffort: 'high',
    })
  })

  it('目录外模型不写选择', async () => {
    const { controller, select } = makeController()
    await expect(controller.selectModel('p', 'nope')).rejects.toThrow(/模型不在目录/u)
    expect(select).not.toHaveBeenCalled()
  })

  it('模型面板读取会话里已有的选择，而不是启动默认值', () => {
    const { controller } = makeController({
      current: () => ({ provider: 'p', model: 'm2', reasoningEffort: 'low' }),
    })
    expect(controller.modelSelection).toEqual({
      provider: 'p',
      model: 'm2',
      reasoningEffort: 'low',
    })
    expect(controller.selectionInfo).toBe('p/m2')
  })

  it('Agent 还没有选择时回退到启动默认值', () => {
    const { controller } = makeController({ current: () => undefined })
    ;(controller as any).selection = { provider: 'p', model: 'm0' }
    expect(controller.modelSelection).toEqual({ provider: 'p', model: 'm0' })
  })
})
