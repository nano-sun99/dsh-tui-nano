/**
 * 分块渲染的一致性 property test（spec 2026-11-10-stream-render-perf §6.2）。
 *
 * 不变式（ADR-20261110-markdown-render-parity）：任一时刻，分块渲染的结果必须与
 * `renderMarkdownFull(全文)` 逐行相等（行文本、缩进、tone）。未闭合围栏被冻结时，
 * 只允许边界处的高亮差异 —— 行文本与缩进仍然必须相等。
 */
import { describe, expect, it } from 'vitest'
import {
  BLOCK_CACHE_MAX,
  BlockCache,
  planChunks,
  renderStats,
  resetRenderStats,
  TAIL_MAX_LINES,
} from '../../src/transcript/blocks.ts'
import { renderMarkdown, renderMarkdownFull } from '../../src/transcript/markdown.ts'
import { type Row, rowText } from '../../src/transcript/spans.ts'

const CORPUS = `# 标题一

第一段正文，含 **加粗**、*斜体*、\`代码\` 与 [链接](https://example.com/a)。

## 标题二

- 项目一
- 项目二
  - 嵌套一
  - 嵌套二

1. 有序一
2. 有序二

### setext 标题
---

> 引用第一行
> 引用第二行

| 列 A | 列 B |
|---|---|
| 1 | 2 |
| 3 | 4 |

\`\`\`ts
const a = 1
const b = 2

function f() {
  return a + b
}
\`\`\`

段落里带一个很长的行，用来测试换行：alpha beta gamma delta epsilon zeta eta theta iota kappa。

~~~

未标注语言的围栏
里面有空行

还没结束

~~~

<div>原始 HTML</div>

- 松列表第一项

- 松列表第二项

    缩进续行

结尾段落：中文、emoji 🧑‍🚀 与制表符\t之后的内容。
`

const LONG_TABLE = [
  '| 行号 | 说明 |',
  '|---|---|',
  ...Array.from({ length: 260 }, (_, index) => `| ${index} | 第 ${index} 行的说明文字 |`),
].join('\n')

const LONG_FENCE = [
  '下面是一段还没写完的代码：',
  '',
  '```ts',
  ...Array.from(
    { length: 500 },
    (_, index) => `const value${index} = compute(${index}, "第 ${index} 行") // 注释`,
  ),
].join('\n')

/** 确定性 PRNG：切点可复现，失败时能照数字重跑。 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = Math.imul(state ^ (state >>> 15), 1 | state)
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

function shape(rows: readonly Row[]): string[] {
  return rows.map(
    (row) =>
      `${row.indent ?? 0}|${rowText(row)}|${row.spans.map((span) => `${span.text}:${span.tone}`).join(',')}`,
  )
}

function textShape(rows: readonly Row[]): string[] {
  return rows.map((row) => `${row.indent ?? 0}|${rowText(row)}`)
}

describe('block scan', () => {
  it('cuts at blank lines and keeps the text intact', () => {
    const { chunks } = planChunks('第一段\n\n第二段\n\n第三段\n')
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.map((chunk) => chunk.text).join('\n\n')).toContain('第二段')
    expect(chunks[0]?.text).toBe('第一段')
  })

  it('never cuts inside a fenced code block', () => {
    const { chunks } = planChunks('说明\n\n```ts\na\n\nb\n\nc\n```\n\n结尾')
    const fenced = chunks.filter((chunk) => chunk.text.includes('```ts'))
    expect(fenced).toHaveLength(1)
    expect(fenced[0]?.text).toContain('b')
    expect(fenced[0]?.text).toContain('c')
  })

  it('keeps lists, quotes and table rows glued to the next block', () => {
    const { chunks } = planChunks(
      '前言\n\n- 第一项\n\n- 第二项\n\n> 引用\n\n| a | b |\n|---|---|\n',
    )
    const joined = chunks.map((chunk) => chunk.text)
    expect(joined.some((text) => text.includes('第一项') && text.includes('第二项'))).toBe(true)
    expect(joined.some((text) => text.includes('前言') && text.includes('第一项'))).toBe(true)
  })

  it('freezes a long unclosed fence into a closed block plus a reopened tail', () => {
    resetRenderStats()
    const { chunks } = planChunks(LONG_FENCE)
    expect(chunks.length).toBeGreaterThan(1)
    const tail = chunks[chunks.length - 1]?.text ?? ''
    expect(tail.startsWith('```ts')).toBe(true)
    const tailLines = tail.split('\n').length
    expect(tailLines).toBeLessThanOrEqual(TAIL_MAX_LINES)
    const frozen = chunks[chunks.length - 2]?.text ?? ''
    expect(frozen.endsWith('```')).toBe(true)
    expect(renderStats().frozen).toBe(1)
  })

  it('keeps the frozen block stable while the tail keeps growing', () => {
    const base = LONG_FENCE.split('\n')
    const frozen: string[] = []
    for (let extra = 0; extra < 40; extra++) {
      const plan = planChunks([...base, `const extra${extra} = 1`].join('\n'))
      const tail = plan.chunks[plan.chunks.length - 1]?.text ?? ''
      expect(tail.split('\n').length).toBeLessThanOrEqual(TAIL_MAX_LINES)
      const block = plan.chunks[plan.chunks.length - 2]?.text
      if (block !== undefined) frozen.push(block)
    }
    // 40 个 delta 里冻结前缀至多换一次（每 32 行才整体前移一次），否则每帧都要重排。
    expect(new Set(frozen).size).toBeLessThanOrEqual(2)
  })

  it('does not freeze a long table (freezing would change row text)', () => {
    resetRenderStats()
    const { chunks } = planChunks(LONG_TABLE)
    expect(chunks[chunks.length - 1]?.text).toContain('| 259 |')
    expect(renderStats().oversize).toBe(1)
    expect(renderStats().frozen).toBe(0)
  })

  it('flags reference-style link definitions for degradation', () => {
    expect(planChunks('见[文档]。\n\n[文档]: https://example.com\n').referenceDefinition).toBe(true)
    expect(planChunks('普通正文\n\n没有定义\n').referenceDefinition).toBe(false)
  })
})

describe('block cache', () => {
  it('evicts the least recently used entry', () => {
    const cache = new BlockCache<number>(2)
    cache.set('a', 1)
    cache.set('b', 2)
    expect(cache.get('a')).toBe(1)
    cache.set('c', 3)
    expect(cache.get('b')).toBeUndefined()
    expect(cache.get('a')).toBe(1)
    expect(cache.get('c')).toBe(3)
    expect(cache.size).toBe(BLOCK_CACHE_MAX === 0 ? 0 : 2)
  })
})

describe('chunked rendering parity', () => {
  it('renders the whole corpus identically to the full path', () => {
    for (const width of [40, 72, 100, 137]) {
      for (const indent of [0, 2, 4]) {
        const chunked = renderMarkdown(CORPUS, width, { indent })
        const full = renderMarkdownFull(CORPUS, width, { indent })
        expect(shape(chunked)).toEqual(shape(full))
      }
    }
  })

  it('keeps the lead marker attached to the same first row', () => {
    const lead = { text: '⏺ ', tone: 'normal' as const }
    const chunked = renderMarkdown(CORPUS, 80, { indent: 4, lead })
    const full = renderMarkdownFull(CORPUS, 80, { indent: 4, lead })
    expect(shape(chunked)).toEqual(shape(full))
  })

  it('matches the full path at 200+ random cut points', () => {
    const bodies = [CORPUS, LONG_TABLE, LONG_FENCE]
    const random = mulberry32(20261110)
    let checked = 0
    for (const body of bodies) {
      for (let index = 0; index < 90; index++) {
        const cut = 1 + Math.floor(random() * (body.length - 1))
        const text = body.slice(0, cut)
        const width = [40, 72, 100][index % 3] as number
        const indent = index % 2 === 0 ? 0 : 4
        const chunked = renderMarkdown(text, width, { indent })
        const full = renderMarkdownFull(text, width, { indent })
        // 冻结边界的 Prism 跨行 token 状态允许差一次高亮：只比行文本与缩进。
        const frozen = text.includes('```ts') && text.split('\n').length > TAIL_MAX_LINES
        if (frozen) expect(textShape(chunked)).toEqual(textShape(full))
        else expect(shape(chunked)).toEqual(shape(full))
        checked++
      }
    }
    expect(checked).toBe(270)
  })

  it('reaches the same rows whether a block was cached or not', () => {
    const first = renderMarkdown(CORPUS, 90)
    const second = renderMarkdown(CORPUS, 90)
    expect(shape(second)).toEqual(shape(first))
  })
})

describe('degradation and settle verification', () => {
  it('degrades the whole text when a reference definition is present', () => {
    resetRenderStats()
    const text = '见[文档][doc]。\n\n[doc]: https://example.com\n'
    const chunked = renderMarkdown(text, 60)
    const full = renderMarkdownFull(text, 60)
    expect(shape(chunked)).toEqual(shape(full))
    expect(renderStats().degrades).toBe(1)
  })

  it('does not report a parity mismatch on ordinary text when verifying', () => {
    resetRenderStats()
    renderMarkdown(CORPUS, 100, { indent: 4, verifyParity: true })
    renderMarkdown(LONG_FENCE, 100, { indent: 4, verifyParity: true })
    expect(renderStats().mismatches).toBe(0)
  })
})
