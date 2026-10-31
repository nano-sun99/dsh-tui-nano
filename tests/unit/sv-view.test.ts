import { describe, expect, it } from 'vitest'
import {
  closeList,
  enterChild,
  focusDock,
  focusList,
  initialView,
  leaveChild,
  openList,
} from '../../src/subagents/view.ts'

describe('initialView', () => {
  it('登录后是主视图、列表关闭、没有焦点', () => {
    expect(initialView()).toEqual({ mode: 'main', listOpen: false, listScrollTop: 0 })
  })
})

describe('focusDock', () => {
  it('第一次向下聚焦第一个 dock 行', () => {
    expect(focusDock(initialView(), ['a', 'b'], 1).dockFocusId).toBe('a')
  })

  it('向下、向上都能移动并在两端循环', () => {
    const first = focusDock(initialView(), ['a', 'b', 'c'], 1)
    const second = focusDock(first, ['a', 'b', 'c'], 1)
    expect(second.dockFocusId).toBe('b')
    expect(focusDock(second, ['a', 'b', 'c'], -1).dockFocusId).toBe('a')
    expect(focusDock(first, ['a', 'b', 'c'], -1).dockFocusId).toBe('c')
  })

  it('没有可聚焦的行时清掉焦点', () => {
    const focused = focusDock(initialView(), ['a'], 1)
    expect(focusDock(focused, [], 1).dockFocusId).toBeUndefined()
  })
})

describe('openList / closeList', () => {
  it('打开列表默认聚焦第一行', () => {
    const view = openList(initialView(), ['a', 'b'])
    expect(view.listOpen).toBe(true)
    expect(view.listFocusId).toBe('a')
  })

  it('从 dock 焦点打开时沿用该行', () => {
    const dock = focusDock(initialView(), ['a', 'b'], 1)
    const view = openList({ ...dock, dockFocusId: 'b' }, ['a', 'b'])
    expect(view.listFocusId).toBe('b')
  })

  it('关闭列表清掉列表焦点，主视图保留 dock 焦点', () => {
    const view = closeList({
      mode: 'main',
      dockFocusId: 'a',
      listOpen: true,
      listFocusId: 'b',
      listScrollTop: 3,
    })
    expect(view).toEqual({ mode: 'main', dockFocusId: 'a', listOpen: false, listScrollTop: 0 })
  })
})

describe('focusList', () => {
  it('列表焦点向下循环，空列表清空焦点', () => {
    const view = openList(initialView(), ['a', 'b'])
    expect(focusList(view, ['a', 'b'], 1).listFocusId).toBe('b')
    expect(focusList(view, ['a', 'b'], -1).listFocusId).toBe('b')
    expect(focusList(view, [], 1).listFocusId).toBeUndefined()
  })
})

describe('enterChild / leaveChild', () => {
  it('从 dock 进入详情，返回时回到 dock 同一行', () => {
    const child = enterChild(initialView(), 'a', 'dock')
    expect(child).toEqual({ mode: 'child', id: 'a', origin: 'dock' })
    expect(leaveChild(child)).toEqual({
      view: expect.objectContaining({ mode: 'main', listOpen: false }),
      returnTo: { origin: 'dock', id: 'a' },
    })
  })

  it('从列表进入详情，返回时重新打开列表并聚焦原行', () => {
    const child = enterChild(initialView(), 'b', 'list')
    const left = leaveChild(child)
    expect(left.view).toEqual({
      mode: 'main',
      listOpen: true,
      listFocusId: 'b',
      listScrollTop: 0,
    })
  })

  it('从结果卡进入详情，返回时回到结果卡来源', () => {
    const child = enterChild(initialView(), 'c', 'result')
    expect(leaveChild(child).returnTo).toEqual({ origin: 'result', id: 'c' })
  })
})
