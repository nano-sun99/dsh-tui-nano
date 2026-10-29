/** End-to-end seams: the answerers registered on a Cordis-like context settle. */
import { describe, expect, it } from 'vitest'
import { DecisionManager } from '../../src/decisions/manager.ts'

class FakeContext {
  handlers = new Map<string, (payload: any, next?: any) => any>()
  on(name: string, handler: (payload: any, next?: any) => any) {
    this.handlers.set(name, handler)
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('decision seams on a context', () => {
  it('registers one answerer per seam and settles approvals', async () => {
    const ctx = new FakeContext()
    const manager = new DecisionManager()
    manager.register(ctx)
    expect(ctx.handlers.has('approval/request')).toBe(true)
    expect(ctx.handlers.has('user-questions/request')).toBe(true)

    const pending = ctx.handlers.get('approval/request')!({ toolName: 'bash', reason: 'run ls' })
    await tick()
    manager.resolveApproval('allowed-once')
    await expect(pending).resolves.toBe('allowed-once')
  })

  it('settles questions with skipped items and plan-review intent', async () => {
    const ctx = new FakeContext()
    const manager = new DecisionManager()
    manager.register(ctx)
    const pending = ctx.handlers.get('user-questions/request')!({
      questions: [
        {
          id: 'plan',
          question: 'approve?',
          intent: { kind: 'plan-review', approve: 'Approve' },
          options: [{ label: 'Approve' }, { label: 'Decline' }],
        },
      ],
    })
    await tick()
    expect(manager.prompt).toMatchObject({ kind: 'question', planReview: true })
    manager.escape()
    await expect(pending).resolves.toEqual({ answers: [{ id: 'plan', selected: [] }] })
  })

  it('aborts a pending approval when the request signal fires', async () => {
    const ctx = new FakeContext()
    const manager = new DecisionManager()
    manager.register(ctx)
    const controller = new AbortController()
    const pending = ctx.handlers.get('approval/request')!({
      toolName: 'bash',
      signal: controller.signal,
    })
    await tick()
    controller.abort()
    await expect(pending).resolves.toBe('cancelled')
  })
})
