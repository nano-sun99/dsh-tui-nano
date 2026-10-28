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
  it('supports single-select and skipped answers', async () => {
    const manager = new DecisionManager()
    const pending = manager.simulateQuestion([
      { id: 'q1', question: 'pick', options: [{ label: 'A' }, { label: 'B' }] },
      { id: 'q2', question: 'skipped', options: [{ label: 'C' }] },
    ])
    await tick()
    manager.toggleOption()
    manager.advanceQuestion()
    manager.submitQuestions()
    await expect(pending).resolves.toEqual({
      answers: [
        { id: 'q1', selected: ['A'] },
        { id: 'q2', selected: [] },
      ],
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
