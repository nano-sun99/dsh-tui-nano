/**
 * Performance evidence for spec §3.1. Run from the repo root:
 *   node --expose-gc docs/evidence/2026-10-28-nano-ts/alpha/tools/perf.mjs
 * Prints p95 scroll/stream/resize numbers and heap growth for 1000/5000 lines.
 */
import { createElement } from 'react'
import { App } from '../../../../../dist/app/App.js'
import { DecisionManager } from '../../../../../dist/decisions/manager.js'
import { Renderer } from '../../../../../dist/render/renderer.js'
import { darkTheme } from '../../../../../dist/theme/theme.js'
import { TranscriptModel } from '../../../../../dist/transcript/model.js'

function makeTranscript(targetLines) {
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
    produced += 22
    seq++
  }
  return model
}

function snapshot(model, overrides = {}) {
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
    expanded: new Set(),
    scrollOffset: 0,
    stickBottom: true,
    userName: '你',
    ...overrides,
  }
}

const p95 = (samples) => {
  const sorted = [...samples].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]
}

function rendererFor(model) {
  const renderer = new Renderer({ write: () => {}, width: 100, height: 30, defaultFg: darkTheme.fg })
  renderer.mount(createElement(App, { snapshot: snapshot(model) }))
  renderer.flushFrame()
  return renderer
}

const model = makeTranscript(1000)
const renderer = rendererFor(model)

const scroll = []
for (let step = 0; step < 60; step++) {
  const start = performance.now()
  renderer.update(
    createElement(App, { snapshot: snapshot(model, { scrollOffset: 3 * step, stickBottom: false }) }),
  )
  renderer.flushFrame()
  scroll.push(performance.now() - start)
}
renderer.update(createElement(App, { snapshot: snapshot(model) }))
renderer.flushFrame()

model.setPreview({ attemptId: 'perf', revision: 1, reasoning: '', text: '' })
const stream = []
let text = ''
for (let step = 0; step < 40; step++) {
  text += `delta ${step}\n`
  model.setPreview({ attemptId: 'perf', revision: 1, reasoning: '', text })
  const start = performance.now()
  renderer.update(createElement(App, { snapshot: snapshot(model) }))
  renderer.flushFrame()
  stream.push(performance.now() - start)
}

const resize = []
for (let step = 0; step < 12; step++) {
  const width = 60 + (step % 2) * 40
  const height = 20 + (step % 2) * 10
  const start = performance.now()
  renderer.resize(width, height)
  renderer.update(createElement(App, { snapshot: snapshot(model, { width, height }) }))
  renderer.flushFrame()
  resize.push(performance.now() - start)
}
renderer.unmount()

function heapFor(lines) {
  const big = makeTranscript(lines)
  const local = rendererFor(big)
  for (let i = 0; i < 20; i++) {
    local.update(createElement(App, { snapshot: snapshot(big, { scrollOffset: i * 6, stickBottom: false }) }))
    local.flushFrame()
    local.update(createElement(App, { snapshot: snapshot(big) }))
    local.flushFrame()
  }
  if (global.gc) global.gc()
  const before = process.memoryUsage().heapUsed
  for (let i = 0; i < 60; i++) {
    local.update(
      createElement(App, { snapshot: snapshot(big, { scrollOffset: (i % 20) * 6, stickBottom: false }) }),
    )
    local.flushFrame()
  }
  const after = process.memoryUsage().heapUsed
  local.unmount()
  return after - before
}

const growth1000 = heapFor(1000)
const growth5000 = heapFor(5000)

console.log(
  JSON.stringify(
    {
      lines: 1000,
      scrollP95ms: Number(p95(scroll).toFixed(2)),
      streamingP95ms: Number(p95(stream).toFixed(2)),
      resizeP95Ms: Number(p95(resize).toFixed(2)),
      heapGrowth1000Bytes: growth1000,
      heapGrowth5000Bytes: growth5000,
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
    },
    null,
    2,
  ),
)
