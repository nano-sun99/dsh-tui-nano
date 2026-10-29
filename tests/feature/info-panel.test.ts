import { describe, expect, it } from 'vitest'
import { occupancyText, readModelIdentity } from '../../src/controls/info-panel.ts'

function ctxWith(selection: any, efforts?: string[]) {
  return {
    get: (name: string) =>
      name === 'agentDefaultModel'
        ? { currentSelection: () => selection, ...(efforts ? { efforts } : {}) }
        : undefined,
  }
}

describe('readModelIdentity', () => {
  it('只认 provider + model 同时存在的身份', () => {
    expect(
      readModelIdentity(ctxWith({ provider: 'deepseek-official', model: 'deepseek-flash' })),
    ).toEqual({
      provider: 'deepseek-official',
      model: 'deepseek-flash',
    })
    expect(readModelIdentity(ctxWith({ provider: 'deepseek-official' }))).toBeUndefined()
    expect(readModelIdentity(ctxWith(undefined))).toBeUndefined()
  })

  it('efforts 只取官方目录给出的值', () => {
    const identity = readModelIdentity(ctxWith({ provider: 'p', model: 'm' }, ['low', 'high']))
    expect(identity?.efforts).toEqual(['low', 'high'])
  })
})

describe('occupancyText', () => {
  function ctxWithPressure(state: any) {
    return {
      get: (name: string) =>
        name === 'sessionProjections'
          ? { snapshot: () => ({ values: { contextPressure: state } }) }
          : undefined,
    }
  }
  it('缺 token 或窗口时显示未知，不混用计费累计', () => {
    expect(occupancyText(undefined, undefined)).toBe('未知')
    const agent = { session: {} }
    expect(
      occupancyText(ctxWithPressure({ pressureTokens: 1000, contextWindow: 4000 }), agent),
    ).toBe('25%（1000/4000）')
    expect(occupancyText(ctxWithPressure({ surfaceTokens: 1000 }), agent)).toBe('未知')
  })
})
