/**
 * 流式 markdown 的分块扫描与块缓存（spec 2026-11-10-stream-render-perf §3.1/§5.1）。
 *
 * 目标：每来一个 delta，只重排「尾块」，已稳定块命中缓存不再解析。
 * 不变式（ADR-20261110-markdown-render-parity）：已稳定部分必须与全文渲染的
 * 对应行逐行相等（行文本、缩进、tone 一致）。
 *
 * 因此切块只有一种安全边界：**代码围栏之外的空行**，且下一行必须能重新开始
 * 一个顶层块——以下情况一律不切，宁可让块更大：
 * - 下一行有前导空白（缩进代码块、列表项续行、嵌套列表）；
 * - 下一行是列表标记（松列表跨空行是一条列表，切开会让有序列表从头编号）；
 * - 下一行是引用（`>`）或表格行（`|`），它们跨空行 / 跨行有共享状态。
 *
 * 尾块上界（§5.1）：未闭合的代码围栏天然是一整块、无空行可切，长起来就是
 * 「成本随已稳定文本增长」。超过 `TAIL_MAX_LINES` 时把前缀冻结成稳定块，
 * 冻结处补一个收尾围栏、尾块重新写回同一个开场围栏——两边都按完整代码块渲染，
 * 行文本与缩进不变，只有 Prism 跨行 token 状态可能在边界处差一次（spec 允许，
 * settle 后由全文渲染覆盖）。
 *
 * 其它超长块（长表格、长列表）**不冻结**：表格列宽由全部行决定、有序列表编号
 * 由列表起点决定，按行冻结会让行文本与全文不一致，违反 ADR 的不变式。
 */
import { writeDiagnostic } from '../runtime/diagnostic.ts'

/** 尾块行数上界（spec §5.1 的默认值）。 */
export const TAIL_MAX_LINES = 200
/**
 * 冻结时一次腾出的行数：冻结到 `TAIL_MAX_LINES - FREEZE_BATCH`，
 * 避免「每来一个 delta 就多切一块」把缓存刷成一行一块。
 */
const FREEZE_BATCH = 64
/** 块缓存容量（spec §5.1）。 */
export const BLOCK_CACHE_MAX = 512

/** 切出来的一块：`blankBefore` 表示原文里它与上一块之间隔着一个空行。 */
export interface Chunk {
  readonly text: string
  readonly blankBefore: boolean
  /**
   * 冻结接缝：`start` / `end` 表示这一边要和相邻块**紧贴**（原文里没有空行）。
   * 冻结前缀与重开的尾块各自会得到一个代码块的边距空行，拼接时要削掉。
   */
  readonly seam?: 'start' | 'end'
}

export interface Plan {
  readonly chunks: readonly Chunk[]
  /** 文本含引用式链接定义：调用方应让该文本的全部入口退化为全量渲染。 */
  readonly referenceDefinition: boolean
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/u
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/u
const LIST_MARKER = /^(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/u
const REFERENCE_DEFINITION = /^ {0,3}\[[^\]\n]+\]:/u

interface Fence {
  readonly marker: string
  readonly length: number
}

/**
 * 上一次扫描的结果：稳定块已经切开，只需从 `tailStart` 起重扫新增内容。
 * 预览文本只会向后追加，命中一次就能把「每个 delta 都重扫全文」变成只扫尾块；
 * 命中判据是**文本前缀**，所以过期只会慢，不会错。
 */
interface ScanState {
  readonly text: string
  readonly stable: readonly Chunk[]
  readonly tailStart: number
  readonly tailBlank: boolean
  readonly referenceDefinition: boolean
}

/** 预览正文与展开的思考是两个交替渲染的文本流，留两条命中位即可。 */
const SCAN_MEMO_MAX = 2
const scanMemo: ScanState[] = []

/** 逐行扫描，按安全空行切块，并顺带识别引用式链接定义。 */
export function planChunks(text: string): Plan {
  const memo = takeScanMemo(text)
  const state = scanFrom(text, memo)
  scanMemo.unshift(state)
  scanMemo.length = Math.min(scanMemo.length, SCAN_MEMO_MAX)
  return {
    chunks: freezeTail([...state.stable, tailChunk(state, text)]),
    referenceDefinition: state.referenceDefinition,
  }
}

function takeScanMemo(text: string): ScanState | undefined {
  const index = scanMemo.findIndex(
    (state) => text.length > state.text.length && text.startsWith(state.text),
  )
  if (index < 0) return undefined
  return scanMemo.splice(index, 1)[0]
}

/** 从 `from` 扫到结尾；`seed` 提供已经确定的稳定块。 */
function scanFrom(text: string, seed: ScanState | undefined): ScanState {
  const from = seed?.tailStart ?? 0
  const lines = text.slice(from).split('\n')
  const stable: Chunk[] = seed ? [...seed.stable] : []
  let blankBefore = seed?.tailBlank ?? false
  let referenceDefinition = seed?.referenceDefinition ?? false
  let start = 0
  let chunkStart = from
  let offset = from
  let fence: Fence | undefined
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] as string
    const nextOffset = offset + line.length + 1
    if (fence) {
      if (fenceClosed(line, fence)) fence = undefined
    } else {
      const opened = fenceOpen(line)
      if (opened) {
        fence = opened
      } else if (!isBlank(line)) {
        if (referenceDefinitionLine(line)) referenceDefinition = true
      } else {
        const next = lines[index + 1]
        if (next !== undefined && canStartChunk(next)) {
          stable.push({ text: lines.slice(start, index).join('\n'), blankBefore })
          start = index + 1
          chunkStart = nextOffset
          blankBefore = true
        }
      }
    }
    offset = nextOffset
  }
  // 尾块的正文先不入库：它是唯一会继续变长的一块，由调用方按需重建。
  return {
    text,
    stable,
    tailStart: chunkStart,
    tailBlank: blankBefore,
    referenceDefinition,
  }
}

function tailChunk(state: ScanState, text: string): Chunk {
  return { text: text.slice(state.tailStart), blankBefore: state.tailBlank }
}

/**
 * 尾块超过上界且停在未闭合围栏里时，把前缀冻结成一块完整代码块。
 * 冻结点只在**整批**（`FREEZE_BATCH` 行）边界上移动：冻结块的内容因此能在
 * 两次冻结之间保持不变、继续命中块缓存 —— 否则每来一行就重排整个冻结前缀，
 * 增量渲染就白做了。其它超长块保持原样（见文件头：冻结会破坏逐行相等）。
 */
function freezeTail(chunks: Chunk[]): Chunk[] {
  const index = chunks.length - 1
  const tail = chunks[index]
  if (tail === undefined) return chunks
  const lines = tail.text.split('\n')
  if (lines.length <= TAIL_MAX_LINES) return chunks
  const open = openFence(lines)
  if (open === undefined) {
    countOversize()
    return chunks
  }
  // 冻到 TAIL_MAX_LINES - FREEZE_BATCH 以内、按整批上取整：尾巴始终 ≤ TAIL_MAX_LINES。
  const keep = TAIL_MAX_LINES - FREEZE_BATCH
  let frozenCount = Math.ceil((lines.length - keep) / FREEZE_BATCH) * FREEZE_BATCH
  // 冻结必须吃掉围栏开场行，否则重开的尾巴会把正文当成代码。
  const minimum = open.index + 1
  if (frozenCount < minimum) frozenCount = Math.ceil(minimum / FREEZE_BATCH) * FREEZE_BATCH
  // 整行冻结：至少留一行给尾巴；留不下就不冻（长段落 / 长表格）。
  if (frozenCount < minimum || frozenCount >= lines.length - 1) {
    countOversize()
    return chunks
  }
  const closer = open.marker.repeat(open.length)
  const frozen = `${lines.slice(0, frozenCount).join('\n')}\n${closer}`
  const rest = `${lines[open.index] as string}\n${lines.slice(frozenCount).join('\n')}`
  countFrozen()
  return [
    ...chunks.slice(0, index),
    { text: frozen, blankBefore: tail.blankBefore, seam: 'end' },
    { text: rest, blankBefore: false, seam: 'start' },
  ]
}

function openFence(lines: readonly string[]): (Fence & { readonly index: number }) | undefined {
  let current: Fence | undefined
  let index = 0
  for (let line = 0; line < lines.length; line++) {
    const text = lines[line] as string
    if (current) {
      if (fenceClosed(text, current)) current = undefined
      continue
    }
    const opened = fenceOpen(text)
    if (opened) {
      current = opened
      index = line
    }
  }
  return current ? { ...current, index } : undefined
}

function fenceOpen(line: string): Fence | undefined {
  const match = FENCE_OPEN.exec(line)
  if (!match) return undefined
  const marker = match[1] as string
  // 反引号围栏的 info string 不允许再含反引号（与 CommonMark / marked 一致）。
  if (marker[0] === '`' && (match[2] ?? '').includes('`')) return undefined
  return { marker: marker[0] as string, length: marker.length }
}

function fenceClosed(line: string, open: Fence): boolean {
  const match = FENCE_CLOSE.exec(line)
  if (!match) return false
  const marker = match[1] as string
  return marker[0] === open.marker && marker.length >= open.length
}

/** 空行之后的这一行能否安全地重新开始一个顶层块。 */
function canStartChunk(line: string): boolean {
  if (line === '' || line[0] === ' ' || line[0] === '\t') return false
  if (LIST_MARKER.test(line)) return false
  return line[0] !== '>' && line[0] !== '|'
}

function isBlank(line: string): boolean {
  return line.trim() === ''
}

function referenceDefinitionLine(line: string): boolean {
  return (line[0] === '[' || /^ {1,3}\[/u.test(line)) && REFERENCE_DEFINITION.test(line)
}

export interface RenderStats {
  /** 因引用式链接定义整体退化为全量渲染的次数。 */
  readonly degrades: number
  /** 尾块触发冻结的次数。 */
  readonly frozen: number
  /** 尾块超上界但无法安全冻结（长表格 / 长列表）的次数。 */
  readonly oversize: number
  /** settle 校验发现「分块结果 ≠ 全文渲染」的次数。 */
  readonly mismatches: number
}

let stats = { degrades: 0, frozen: 0, oversize: 0, mismatches: 0 }

export function renderStats(): RenderStats {
  return stats
}

/** 仅测试用。 */
export function resetRenderStats(): void {
  stats = { degrades: 0, frozen: 0, oversize: 0, mismatches: 0 }
}

/** 计数并在 `NANO_DEBUG_RENDER=1` 时写一行诊断。 */
export function countDegrade(): void {
  stats.degrades++
  if (debugRender()) {
    writeDiagnostic(
      `nano: markdown 分块退化（引用式链接定义），本段走全量渲染（累计 ${stats.degrades} 次）`,
    )
  }
}

/** settle 校验不一致：退回全文渲染，并记一行诊断。 */
export function countParityMismatch(): void {
  stats.mismatches++
  if (debugRender()) {
    writeDiagnostic(
      `nano: markdown 分块结果与全文不一致，已退回全量（累计 ${stats.mismatches} 次）`,
    )
  }
}

function countFrozen(): void {
  stats.frozen++
}

function countOversize(): void {
  stats.oversize++
  if (debugRender()) {
    writeDiagnostic(
      `nano: 尾块超过 ${TAIL_MAX_LINES} 行且不是未闭合围栏，无法安全冻结（累计 ${stats.oversize} 次）`,
    )
  }
}

function debugRender(): boolean {
  const raw = process.env.NANO_DEBUG_RENDER
  return raw === '1' || raw === 'true'
}

/** 定长 LRU：`Map` 的插入顺序就是淘汰顺序，命中时重插一次。 */
export class BlockCache<T> {
  private readonly entries = new Map<string, T>()

  constructor(private readonly max: number = BLOCK_CACHE_MAX) {}

  get(key: string): T | undefined {
    const hit = this.entries.get(key)
    if (hit === undefined) return undefined
    this.entries.delete(key)
    this.entries.set(key, hit)
    return hit
  }

  set(key: string, value: T): void {
    this.entries.delete(key)
    this.entries.set(key, value)
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
  }

  get size(): number {
    return this.entries.size
  }

  clear(): void {
    this.entries.clear()
  }
}
