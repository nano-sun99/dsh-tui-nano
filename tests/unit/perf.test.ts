/**
 * Performance budgets from spec §3.1: 1000 transcript lines, scroll p95 ≤33ms,
 * streaming p95 ≤50ms, resize p95 ≤80ms; 5000-line memory growth is bounded.
 */
import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { App, type AppSnapshot } from '../../src/app/App.tsx'
import { DecisionManager } from '../../src/decisions/manager.ts'
import { Renderer } from '../../src/render/renderer.ts'
import { darkTheme } from '../../src/theme/theme.ts'
import { TranscriptModel } from '../../src/transcript/model.ts'

function p95(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0
}

function makeTranscript(targetLines: number): TranscriptModel {
  const model = new TranscriptModel()
  const paragraph = Array.from(
    { length: 20 },
    (_, index) => `第 ${index} 行：the quick brown fox jumps over the lazy dog.`,
  ).join('\n')
  let produced = 0
  let seq = 0
  while (produced < targetLines) {
    model.appendUser(`question ${seq}`, `req-${seq}`)
    model.appendAssistant(seq, [{ type: 'text', text: paragraph }])
    produced += paragraph.split('\n').length + 2
    seq++
  }
  return model
}

function snapshot(model: TranscriptModel, overrides: Partial<AppSnapshot> = {}): AppSnapshot {
  return {
    transcript: model,
    decisions: new DecisionManager(),
    text: '',
    cursor: 0,
    theme: darkTheme,
    width: 100,
    height: 30,
    rootId: 'perf-root',
    modelLabel: 'deepseek-official/deepseek-chat',
    status: 'idle',
    expanded: new Set<string>(),
    scrollOffset: 0,
    stickBottom: true,
    userName: '你',
    ...overrides,
  }
}

function createRenderer(): { renderer: Renderer } {
  const renderer = new Renderer({
    write: () => {},
    width: 100,
    height: 30,
    defaultFg: darkTheme.fg,
  })
  return { renderer }
}

describe('transcript performance', () => {
  it('scrolls a 1000-line transcript within p95 33ms', () => {
    const model = makeTranscript(1000)
    const { renderer } = createRenderer()
    renderer.mount(createElement(App, { snapshot: snapshot(model) }))
    renderer.flushFrame()
    const samples: number[] = []
    for (let step = 0; step < 60; step++) {
      const started = performance.now()
      renderer.update(
        createElement(App, {
          snapshot: snapshot(model, { scrollOffset: 3 * step, stickBottom: false }),
        }),
      )
      renderer.flushFrame()
      samples.push(performance.now() - started)
    }
    expect(p95(samples)).toBeLessThanOrEqual(33)
    renderer.unmount()
  })

  it('appends streaming text within p95 50ms', () => {
    const model = makeTranscript(1000)
    model.setPreview({ attemptId: 'perf', revision: 1, reasoning: '', text: '' })
    const { renderer } = createRenderer()
    renderer.mount(createElement(App, { snapshot: snapshot(model) }))
    renderer.flushFrame()
    const samples: number[] = []
    let text = ''
    for (let step = 0; step < 40; step++) {
      text += `delta ${step}\n`
      model.setPreview({ attemptId: 'perf', revision: 1, reasoning: '', text })
      const started = performance.now()
      renderer.update(createElement(App, { snapshot: snapshot(model) }))
      renderer.flushFrame()
      samples.push(performance.now() - started)
    }
    expect(p95(samples)).toBeLessThanOrEqual(50)
    renderer.unmount()
  })

  it('resizes within p95 80ms', () => {
    const model = makeTranscript(1000)
    const { renderer } = createRenderer()
    renderer.mount(createElement(App, { snapshot: snapshot(model) }))
    renderer.flushFrame()
    const samples: number[] = []
    for (let step = 0; step < 12; step++) {
      const width = 60 + (step % 2) * 40
      const height = 20 + (step % 2) * 10
      const started = performance.now()
      renderer.resize(width, height)
      renderer.update(createElement(App, { snapshot: snapshot(model, { width, height }) }))
      renderer.flushFrame()
      samples.push(performance.now() - started)
    }
    expect(p95(samples)).toBeLessThanOrEqual(80)
    renderer.unmount()
  })

  function scrollGrowth(lines: number): number {
    const model = makeTranscript(lines)
    const { renderer } = createRenderer()
    renderer.mount(createElement(App, { snapshot: snapshot(model) }))
    renderer.flushFrame()
    for (let i = 0; i < 10; i++) {
      renderer.update(
        createElement(App, {
          snapshot: snapshot(model, { scrollOffset: i * 6, stickBottom: false }),
        }),
      )
      renderer.flushFrame()
      renderer.update(createElement(App, { snapshot: snapshot(model) }))
      renderer.flushFrame()
    }
    const before = process.memoryUsage().heapUsed
    for (let i = 0; i < 40; i++) {
      renderer.update(
        createElement(App, {
          snapshot: snapshot(model, { scrollOffset: (i % 20) * 6, stickBottom: false }),
        }),
      )
      renderer.flushFrame()
    }
    const growth = process.memoryUsage().heapUsed - before
    renderer.unmount()
    return growth
  }

  it('keeps per-frame memory growth independent of transcript length', () => {
    const small = scrollGrowth(500)
    const large = scrollGrowth(5000)
    // Memoized layout means a 10x transcript must not mean 10x per-frame garbage.
    expect(large - small).toBeLessThan(24 * 1024 * 1024)
  })
})
