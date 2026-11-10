#!/usr/bin/env node
/**
 * 流式渲染基准（spec 2026-11-10-stream-render-perf §6.1）。
 *
 * 只跑在已构建的 `dist/` 上：`npm run build && node scripts/bench-stream.mjs`。
 * 之所以不用 vitest / 直接跑 src：本脚本要在**改动前**的提交上跑出基线，
 * 所以只允许依赖改动前就存在的公开 API（`App`、`Renderer`、`TranscriptModel`）
 * 和编译产物 —— TSX 不能直接被 node 的类型剥离加载。
 *
 * 协议（§6.1）：每轮预热 20 次、取 200 个样本的 p95；同一进程跑 3 轮，取中位数。
 *
 *   node scripts/bench-stream.mjs               # 跑全部用例
 *   node scripts/bench-stream.mjs --case=preview
 *   node scripts/bench-stream.mjs --json        # 末尾追加一行机器可读结果
 */
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createElement } from 'react'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIST = path.join(ROOT, 'dist')

const ROUNDS = 3
const WARMUP = 20
const SAMPLES = 200
const PREVIEW_WIDTH = 100
const PREVIEW_HEIGHT = 40

function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

if (!existsSync(path.join(DIST, 'app/App.js'))) {
  fail(`找不到 ${path.relative(ROOT, DIST)}/app/App.js；先跑 npm run build`)
}

const load = async (relative) => import(pathToFileURL(path.join(DIST, relative)).href)

const { App } = await load('app/App.js')
const { Renderer } = await load('render/renderer.js')
const { TranscriptModel } = await load('transcript/model.js')
const { DecisionManager } = await load('decisions/manager.js')
const { darkTheme } = await load('theme/theme.js')
const { graphemes, displayWidth } = await load('render/text.js')

/** 一条接近真实长回答的 markdown：标题、段落、列表、代码块、表格、引用。 */
function answerSection(index) {
  return [
    `## 第 ${index} 节：为什么这样改`,
    '',
    '流式输出时，每个 delta 都会把「到目前为止的整段回答」重新解析、重新换行、重新布局，' +
      '于是成本 = 已稳定文本长度 × delta 次数。把稳定前缀缓存住，单次成本就只和尾块有关。',
    '',
    '- 第一条：先切出稳定块，命中缓存就不再重排。',
    '- 第二条：尾块有上界，超出部分冻结成稳定块。',
    '- 第三条：帧调度按时间合并，纯动画帧不重排整棵树。',
    '',
    '```ts',
    'export function split(text: string): Block[] {',
    '  const blocks: Block[] = []',
    '  for (const line of text.split("\\n")) blocks.push({ text: line })',
    '  return blocks',
    '}',
    '```',
    '',
    '| 项 | 改动前 | 改动后 |',
    '|---|---|---|',
    '| 单 delta | 13.2ms | ≤2ms |',
    '| 帧预算 | 无 | 33ms |',
    '',
    `> 结论 ${index}：已稳定文本不再参与重排。`,
    '',
    '这就是把「随历史增长」换成「只与尾块有关」。剩下的底噪交给帧预算和文本快路径。',
    '',
    '再补一段普通正文，让段落长度接近真实回答：终端渲染的成本主要在逐字切分与换行，' +
      '长段落在 100 列下会折成好几行，每行都要重新走一遍 grapheme 切分与宽度查表。',
    '',
  ].join('\n')
}

/** 拼出至少 `bytes` 字节的 markdown 正文（按整节拼接，保证块结构完整）。 */
function makeAnswer(bytes) {
  let text = ''
  for (let index = 0; text.length < bytes; index++) text += answerSection(index)
  const cut = text.lastIndexOf('\n\n')
  return text.slice(0, cut > 0 ? cut + 2 : text.length)
}

/** 一条不断增长的未闭合代码围栏：`lines` 行代码，没有收尾的 ```。 */
function makeOpenFence(lines) {
  const body = Array.from(
    { length: lines },
    (_, index) => `const value${index} = compute(${index}, "第 ${index} 行") // 注释`,
  ).join('\n')
  return `下面是一段还没写完的代码：\n\n\`\`\`ts\n${body}\n`
}

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
    produced += paragraph.split('\n').length + 2
    seq++
  }
  return model
}

function snapshot(model, extra = {}) {
  return {
    transcript: model,
    decisions: new DecisionManager(),
    text: '',
    cursor: 0,
    theme: darkTheme,
    width: PREVIEW_WIDTH,
    height: PREVIEW_HEIGHT,
    rootId: 'bench-root',
    modelLabel: 'deepseek-official/deepseek-chat',
    status: 'idle',
    expanded: new Set(),
    scrollOffset: 0,
    stickBottom: true,
    userName: '你',
    ...extra,
  }
}

function percentile(samples, ratio) {
  const sorted = [...samples].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))
  return sorted[index] ?? 0
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

/**
 * 每次调用返回下一份「预览文本」：真实流式只往后追加（前缀不变），
 * 所以这里也是单调增长，而不是每次换一个同长的尾巴 —— 后者会让分块扫描
 * 永远命中不了前缀记忆，量出来的是最坏情况。
 */
function previewSource(base, unit) {
  let text = base
  let index = 0
  return () => {
    index++
    text = `${text}\n${unit(index)}`
    return text
  }
}

async function measure(run, next) {
  const rounds = []
  for (let round = 0; round < ROUNDS; round++) {
    for (let i = 0; i < WARMUP; i++) await run(next())
    await new Promise((resolve) => setImmediate(resolve))
    const samples = []
    for (let i = 0; i < SAMPLES; i++) {
      const input = next()
      await new Promise((resolve) => setImmediate(resolve))
      const started = performance.now()
      await run(input)
      samples.push(performance.now() - started)
    }
    rounds.push(percentile(samples, 0.95))
  }
  return { p95: median(rounds), rounds }
}

async function previewCase(base) {
  const model = makeTranscript(1200)
  const renderer = new Renderer({
    write: () => {},
    width: PREVIEW_WIDTH,
    height: PREVIEW_HEIGHT,
    defaultFg: darkTheme.fg,
  })
  renderer.mount(createElement(App, { snapshot: snapshot(model) }))
  renderer.flushFrame()
  const next = previewSource(base, (index) =>
    index % 4 === 0
      ? `补充第 ${index} 句：这一段是流式到达的尾部内容。`
      : `第 ${index} 个 delta：成本应当与已稳定文本无关。`,
  )
  const result = await measure(async (text) => {
    const preview = { attemptId: 'bench', revision: 1, reasoning: '', text }
    model.setPreview(preview)
    renderer.update(createElement(App, { snapshot: snapshot(model) }))
    renderer.flushFrame()
  }, next)
  renderer.unmount()
  return result
}

async function frameCase() {
  const model = makeTranscript(40)
  const renderer = new Renderer({
    write: () => {},
    width: PREVIEW_WIDTH,
    height: PREVIEW_HEIGHT,
    defaultFg: darkTheme.fg,
  })
  renderer.mount(createElement(App, { snapshot: snapshot(model) }))
  renderer.flushFrame()
  const element = createElement(App, { snapshot: snapshot(model) })
  let index = 0
  const result = await measure(async () => {
    renderer.update(element)
    renderer.flushFrame()
  }, () => index++)
  renderer.unmount()
  return result
}

/**
 * §6.3 的两个用例内容是**纯 ASCII** 与**纯 CJK**：混排的 markdown 走不到
 * ASCII 快路径，量出来的就不是这条路径的成本。
 */
function textCase() {
  const ascii = 'the quick brown fox jumps over the lazy dog.\n'
    .repeat(2048)
    .slice(0, 48 * 1024)
  const cjk = '中文宽字符测试，'.repeat(4096).slice(0, 48 * 1024)
  const run = (text) => () => {
    graphemes(text)
    displayWidth(text)
  }
  const time = (text) => {
    for (let i = 0; i < 5; i++) run(text)()
    const rounds = []
    for (let round = 0; round < ROUNDS; round++) {
      const samples = []
      for (let i = 0; i < 12; i++) {
        const started = performance.now()
        run(text)()
        samples.push(performance.now() - started)
      }
      rounds.push(median(samples))
    }
    return median(rounds)
  }
  return { ascii: { p95: time(ascii) }, cjk: { p95: time(cjk) } }
}

const args = new Map(
  process.argv
    .slice(2)
    .filter((value) => value.startsWith('--'))
    .map((value) => {
      const [key, raw] = value.slice(2).split('=')
      return [key, raw ?? 'true']
    }),
)

const only = args.get('case')
const results = {}

if (!only || only === 'preview') {
  const kb4 = makeAnswer(4 * 1024)
  const kb48 = makeAnswer(48 * 1024)
  results.preview = {
    '4KB': await previewCase(kb4),
    '48KB': await previewCase(kb48),
  }
  results.preview.ratio = results.preview['48KB'].p95 / results.preview['4KB'].p95
}

if (!only || only === 'fence') {
  results.fence = {}
  for (const lines of [100, 500]) {
    results.fence[`${lines}行`] = await previewCase(makeOpenFence(lines - 1))
  }
  results.fence.ratio = results.fence['500行'].p95 / results.fence['100行'].p95
}

if (!only || only === 'frame') {
  results.frame = await frameCase()
}

if (!only || only === 'text') {
  results.text = textCase()
}

const format = (value) => (value >= 10 ? value.toFixed(2) : value.toFixed(3))
for (const [name, value] of Object.entries(results)) {
  if (name === 'text') {
    process.stdout.write(
      `text    ASCII 48KB graphemes+displayWidth: ${format(value.ascii.p95)}ms  ` +
        `CJK 48KB: ${format(value.cjk.p95)}ms\n`,
    )
    continue
  }
  if (name === 'preview' || name === 'fence') {
    const parts = Object.entries(value)
      .filter(([key]) => key !== 'ratio')
      .map(([key, entry]) => `${key} p95 ${format(entry.p95)}ms`)
    process.stdout.write(`${name.padEnd(7)} ${parts.join('  ')}  ratio ${value.ratio.toFixed(2)}x\n`)
    continue
  }
  process.stdout.write(`frame   p95 ${format(value.p95)}ms\n`)
}

if (args.get('json') === 'true') {
  const plain = JSON.parse(JSON.stringify(results))
  process.stdout.write(`${JSON.stringify(plain)}\n`)
}
