import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DecisionManager } from '../../src/decisions/manager.ts'
import { HistoryStore } from '../../src/input/history.ts'
import { Lifecycle } from '../../src/runtime/lifecycle.ts'

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('approval seam', () => {
  it('defaults focus to reject and resolves the chosen outcome', async () => {
    const manager = new DecisionManager()
    const pending = manager.simulateApproval('bash')
    await tick()
    expect(manager.prompt).toMatchObject({ kind: 'approval', selected: 1 })
    manager.chooseApproval()
    await expect(pending).resolves.toBe('rejected')
  })

  it('escape withdraws the request as cancelled', async () => {
    const manager = new DecisionManager()
    const pending = manager.simulateApproval('bash')
    await tick()
    manager.escape()
    await expect(pending).resolves.toBe('cancelled')
  })
})

describe('question seam', () => {
  it('supports single-select and deliberately skipped answers', async () => {
    const manager = new DecisionManager()
    const pending = manager.simulateQuestion([
      { id: 'q1', question: 'pick', options: [{ label: 'A' }, { label: 'B' }] },
      { id: 'q2', question: 'skipped', options: [{ label: 'C' }] },
    ])
    await tick()
    manager.toggleOption()
    manager.advanceQuestion()
    manager.skipQuestion()
    manager.submitQuestions()
    await expect(pending).resolves.toEqual({
      answers: [
        { id: 'q1', selected: ['A'] },
        { id: 'q2', selected: [] },
      ],
    })
  })

  it('blocks an incomplete batch and jumps to the first unanswered question', async () => {
    const manager = new DecisionManager()
    const pending = manager.simulateQuestion([
      { id: 'q1', question: 'pick', options: [{ label: 'A' }] },
      { id: 'q2', question: 'also pick', options: [{ label: 'B' }] },
    ])
    await tick()
    manager.submitQuestions()
    const prompt = manager.prompt
    expect(prompt).toMatchObject({ kind: 'question', current: 0, error: '请先回答这一题。' })
    manager.toggleOption()
    manager.advanceQuestion()
    manager.submitQuestions()
    expect(manager.prompt).toMatchObject({ current: 1, error: '请先回答这一题。' })
    manager.toggleOption()
    manager.advanceQuestion()
    manager.submitQuestions()
    await expect(pending).resolves.toEqual({
      answers: [
        { id: 'q1', selected: ['A'] },
        { id: 'q2', selected: ['B'] },
      ],
    })
  })

  it('cancels with ASK_ABORTED instead of sending half-finished answers', async () => {
    const manager = new DecisionManager()
    const pending = manager.simulateQuestion([
      { id: 'q1', question: 'pick', options: [{ label: 'A' }] },
    ])
    await tick()
    manager.toggleOption()
    manager.escape()
    await expect(pending).rejects.toMatchObject({
      name: 'UserQuestionError',
      code: 'ASK_ABORTED',
    })
    expect(manager.prompt).toBeUndefined()
  })

  it('reaches the custom row with arrows and types into it', async () => {
    const manager = new DecisionManager()
    const pending = manager.simulateQuestion([
      { id: 'q1', question: 'pick', options: [{ label: 'A' }] },
    ])
    await tick()
    manager.move(1)
    expect(manager.prompt).toMatchObject({ focusedOption: 1 })
    expect(manager.prompt?.kind === 'question' && manager.prompt.drafts.get('q1')?.customMode).toBe(
      true,
    )
    manager.typeCustom('自己写')
    manager.confirmFocused()
    await expect(pending).resolves.toEqual({
      answers: [{ id: 'q1', selected: [], custom: '自己写' }],
    })
  })

  it('supports multi-select custom text', async () => {
    const manager = new DecisionManager()
    const pending = manager.simulateQuestion([
      {
        id: 'q1',
        question: 'pick many',
        multiSelect: true,
        options: [{ label: 'A' }, { label: 'B' }],
      },
    ])
    await tick()
    manager.toggleOption()
    manager.toggleCustom()
    manager.typeCustom('other')
    manager.submitQuestions()
    await expect(pending).resolves.toEqual({
      answers: [{ id: 'q1', selected: ['A'], custom: 'other' }],
    })
  })
})

describe('history', () => {
  it('filters by project and prefers the current session', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nano-history-'))
    const path = join(dir, 'history.jsonl')
    const store = new HistoryStore(path, '/proj', () => 's2')
    store.record('one')
    store.record('two')
    const other = new HistoryStore(path, '/other', () => 's9')
    other.record('elsewhere')
    const entries = store.entries()
    expect(entries.map((entry) => entry.display)).toEqual(['two', 'one'])
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(readFileSync(path, 'utf8')).toContain('elsewhere')
  })
})

describe('lifecycle', () => {
  it('runs phases in order and reports failures', async () => {
    const lifecycle = new Lifecycle()
    const order: string[] = []
    lifecycle.register('freeze', 'f', () => {
      order.push('freeze')
    })
    lifecycle.register('drain', 'ok', () => {
      order.push('drain-ok')
    })
    lifecycle.register('drain', 'boom', () => {
      throw new Error('boom')
    })
    lifecycle.register('flush', 'flush', () => {
      order.push('flush')
    })
    lifecycle.register('release', 'release', () => {
      order.push('release')
    })
    lifecycle.register('restore', 'restore', () => {
      order.push('restore')
    })
    const report = await lifecycle.requestShutdown('test')
    expect(order).toEqual(['freeze', 'drain-ok', 'flush', 'release', 'restore'])
    expect(report.results.find((result) => result.name === 'boom')?.status).toBe('failed')
  })

  it('marks a hook unknown when its deadline passes', async () => {
    const lifecycle = new Lifecycle()
    lifecycle.register('drain', 'hang', () => new Promise(() => {}), 20)
    const report = await lifecycle.requestShutdown('test')
    expect(report.results[0]?.status).toBe('unknown')
  })
})

describe('approval settlement', () => {
  it('reports the enter path exactly once', async () => {
    const manager = new DecisionManager()
    const seen: string[] = []
    manager.onApprovalSettled((_prompt, outcome) => seen.push(outcome))
    const pending = manager.askApproval({ toolName: 'bash', callId: 'c1' })
    await tick()
    manager.move(-1)
    manager.chooseApproval()
    await expect(pending).resolves.toBe('allowed-once')
    expect(seen).toEqual(['allowed-once'])
  })

  it('reports escape and direct outcomes', async () => {
    const manager = new DecisionManager()
    const seen: string[] = []
    manager.onApprovalSettled((_prompt, outcome) => seen.push(outcome))
    const first = manager.askApproval({ toolName: 'bash', callId: 'c1' })
    await tick()
    manager.escape()
    await expect(first).resolves.toBe('cancelled')
    const second = manager.askApproval({ toolName: 'bash', callId: 'c2' })
    await tick()
    manager.resolveApproval('unavailable')
    await expect(second).resolves.toBe('unavailable')
    expect(seen).toEqual(['cancelled', 'unavailable'])
  })

  it('reports an official abort as cancelled', async () => {
    const manager = new DecisionManager()
    const seen: string[] = []
    manager.onApprovalSettled((_prompt, outcome) => seen.push(outcome))
    const controller = new AbortController()
    const pending = manager.askApproval({
      toolName: 'bash',
      callId: 'c1',
      signal: controller.signal,
    })
    await tick()
    controller.abort()
    await expect(pending).resolves.toBe('cancelled')
    expect(seen).toEqual(['cancelled'])
  })

  it('does not settle twice when an abort follows a user choice', async () => {
    const manager = new DecisionManager()
    const seen: string[] = []
    manager.onApprovalSettled((_prompt, outcome) => seen.push(outcome))
    const controller = new AbortController()
    const pending = manager.askApproval({
      toolName: 'bash',
      callId: 'c1',
      signal: controller.signal,
    })
    await tick()
    manager.resolveApproval('rejected')
    controller.abort()
    await expect(pending).resolves.toBe('rejected')
    expect(seen).toEqual(['rejected'])
  })
})
