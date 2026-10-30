import { describe, expect, it } from 'vitest'
import { Features } from '../../src/controls/feature-host.ts'

describe('feature input focus', () => {
  it('keeps the composer active unless a panel or terminal takes keys', () => {
    const features = new Features()
    expect(features.inputActive()).toBe(true)

    ;(features as unknown as { modelPanel: { open: boolean } }).modelPanel = { open: true }
    expect(features.inputActive()).toBe(false)

    ;(features as unknown as { modelPanel?: unknown }).modelPanel = undefined
    ;(features as unknown as { terminal: { focused: boolean } }).terminal = { focused: true }
    expect(features.inputActive()).toBe(false)

    ;(features as unknown as { terminal?: unknown }).terminal = undefined
    ;(features as unknown as { info: { visible: boolean } }).info = { visible: true }
    expect(features.inputActive()).toBe(false)

    ;(features as unknown as { info?: unknown }).info = undefined
    ;(features as unknown as { sessions: { visible: boolean } }).sessions = { visible: false }
    expect(features.inputActive()).toBe(true)
  })
})
