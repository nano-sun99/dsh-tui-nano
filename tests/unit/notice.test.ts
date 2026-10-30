import { afterEach, describe, expect, it, vi } from 'vitest'
import { NOTICE_TTL_MS, NoticeState } from '../../src/app/notice.ts'

describe('notice lifecycle', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('clears an info notice after the 8 second TTL', () => {
    vi.useFakeTimers()
    let changes = 0
    const state = new NoticeState(() => {
      changes += 1
    })
    state.set('已选择 deepseek-v4-pro · 默认。')
    expect(state.current?.tone).toBe('info')

    vi.advanceTimersByTime(NOTICE_TTL_MS - 1)
    expect(state.current?.text).toContain('已选择')

    vi.advanceTimersByTime(1)
    expect(state.current).toBeUndefined()
    expect(changes).toBe(2)
  })

  it('keeps a danger notice until it is cleared', () => {
    vi.useFakeTimers()
    const state = new NoticeState(() => {})
    state.set('发送失败', 'danger')

    vi.advanceTimersByTime(NOTICE_TTL_MS * 3)
    expect(state.current?.text).toBe('发送失败')
  })

  it('replaces the current notice and resets the TTL', () => {
    vi.useFakeTimers()
    const state = new NoticeState(() => {})
    state.set('第一条', 'info')
    vi.advanceTimersByTime(NOTICE_TTL_MS - 1000)
    state.set('第二条', 'danger')
    vi.advanceTimersByTime(NOTICE_TTL_MS)
    expect(state.current?.text).toBe('第二条')
  })

  it('clears on undefined and cancels the pending timer', () => {
    vi.useFakeTimers()
    let changes = 0
    const state = new NoticeState(() => {
      changes += 1
    })
    state.set('提示')
    state.set(undefined)
    expect(state.current).toBeUndefined()
    vi.advanceTimersByTime(NOTICE_TTL_MS)
    expect(changes).toBe(2)
  })
})
