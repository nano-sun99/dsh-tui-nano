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
    expect(features.dockRows()).toBe(0)
  })

  it('model 面板打开时 dock 隐藏，关闭后恢复行数', () => {
    const features = new Features() as unknown as {
      dockBody(): unknown
      dockRows(): number
      modelPanel?: { open: boolean }
      navigation?: { dock: () => string; dockRows: () => number }
    }
    features.navigation = { dock: () => 'dock-body', dockRows: () => 2 }
    expect(features.dockRows()).toBe(2)
    expect(features.dockBody()).toBe('dock-body')
    features.modelPanel = { open: true }
    expect(features.dockRows()).toBe(0)
    expect(features.dockBody()).toBeNull()
    features.modelPanel.open = false
    expect(features.dockRows()).toBe(2)
    expect(features.dockBody()).toBe('dock-body')
  })
})
