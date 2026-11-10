/**
 * Transcript model and process-display rules: consecutive reads merge into a
 * counting row, failures keep three result lines, streaming thinking keeps a
 * two-row tail that survives completion, foreground Bash keeps its last five
 * output lines, and only in-place clicks expand a row.
 *
 * Visual language: ADR-20261103-nano-four-visual-categories (`❯` / `∴` /
 * `⏺` / `⎿`); streaming / question records: ADR-20261103-streaming-process-preview
 * and ADR-20261103-question-answer-visible-in-transcript.
 */

import { type ApprovalOutcome, approvalDecisionText } from '../decisions/manager.ts'
import { displayWidth, graphemes, graphemeWidth, truncateText } from '../render/text.ts'
import { EDGE, INDENT, NESTED } from '../theme/spacing.ts'
import { diffsFromMeta, renderDiffs } from './diff.ts'
import { renderMarkdown } from './markdown.ts'
import { previewHasContent, previewToolResult } from './preview.ts'
import {
  projectQuestionResult,
  type QuestionAnswerLine,
  type QuestionOutcome,
} from './question-answers.ts'
import { type Row, type Span, textSpan, wrapSpans } from './spans.ts'

export interface Block {
  readonly type: 'text' | 'reasoning'
  readonly text: string
}

export type Entry = UserEntry | AssistantEntry | ToolEntry | ThinkingEntry | NoticeEntry

export interface UserEntry {
  readonly kind: 'user'
  readonly id: string
  /** D01: subagent address; the root session uses `root`. */
  readonly address?: string
  readonly text: string
  readonly requestId?: string
  readonly pending?: boolean
  readonly seq?: number
}

export interface AssistantEntry {
  readonly kind: 'assistant'
  readonly id: string
  readonly address?: string
  readonly seq: number
  readonly blocks: readonly Block[]
}

/** 已完成的思考：只保留最后 1–2 个非空行，避免长会话内存增长。 */
export interface ThinkingEntry {
  readonly kind: 'thinking'
  readonly id: string
  readonly address?: string
  readonly seq: number
  readonly lines: readonly string[]
}

function activationTarget(meta: unknown): string | undefined {
  if (meta === null || typeof meta !== 'object') return undefined
  const value = meta as { kind?: unknown; subagentId?: unknown }
  if (value.kind !== 'activation' || typeof value.subagentId !== 'string') return undefined
  return value.subagentId === '' ? undefined : `subagent:result:${value.subagentId}`
}

/**
 * 官方 `subagent` 工具只声明 `output.render`，没有 `presentationMeta`，
 * 所以正式会话里 `resultMeta` 永远缺失。结构化输出的可见回执是稳定的
 * `started subagent <id>`；在 meta 缺席时用它把结果卡接上详情。
 */
function activationFromResult(name: string, resultText: string | undefined): string | undefined {
  if (name !== 'subagent' || resultText === undefined) return undefined
  const match = /^\s*started subagent (\S+)\s*$/m.exec(resultText)
  const id = match?.[1]
  return id === undefined || id === '' ? undefined : `subagent:result:${id}`
}

export type ApprovalDecision = Exclude<ApprovalOutcome, 'allowed-once'>

export interface ToolEntry {
  readonly kind: 'tool'
  readonly id: string
  readonly address?: string
  readonly callId: string
  readonly name: string
  readonly args: string
  readonly status: 'running' | 'ok' | 'error' | 'waiting'
  /** Display preview projected at `completeTool`; never the raw payload. */
  readonly resultText?: string
  readonly resultMeta?: unknown
  /** User-facing approval decision (spec §3.9); allowed-once leaves no row. */
  readonly decision?: ApprovalDecision
  /** 问卷答案投影（ADR-20261103-question-answer-visible-in-transcript）。 */
  readonly questionAnswers?: readonly QuestionAnswerLine[]
  readonly questionOutcome?: QuestionOutcome
  /** 前台 Bash 运行中 / 完成后的最后 5 行输出。 */
  readonly liveOutput?: readonly string[]
  /** 仅用于清理 / 对账，不渲染。 */
  readonly liveJobId?: string
  /** Content revision used as the render-cache key (spec §3.5). */
  readonly rev: number
}

export interface NoticeEntry {
  readonly kind: 'notice'
  readonly id: string
  readonly address?: string
  readonly text: string
  readonly tone: 'info' | 'warning' | 'danger'
}

export interface StreamPreview {
  readonly attemptId: string
  readonly revision: number
  readonly reasoning: string
  readonly text: string
}

export interface Unit {
  readonly id: string
  readonly kind:
    | 'user'
    | 'assistant'
    | 'tool'
    | 'group'
    | 'notice'
    | 'error'
    | 'thinking'
    | 'stream'
  readonly rows: readonly Row[]
  readonly gapBefore: 'None' | 'Section' | 'Block'
  readonly pressId?: string
}

export interface RenderOptions {
  readonly width: number
  readonly expanded: ReadonlySet<string>
  /** Which subagent address to render; defaults to the root. */
  readonly address?: string
}

const READ_LIKE = new Set([
  'read',
  'read_file',
  'readfile',
  'read_many_files',
  'grep',
  'grep_search',
  'search',
  'glob',
  'list',
  'list_dir',
  'listdir',
  'ls',
  'find',
])

export const USER_MARK = '❯'
export const ASSISTANT_MARK = '⏺'
export const THINKING_MARK = '∴'
export const BRANCH_MARK = '  ⎿  '
const THINKING_TAIL_LINES = 2
const BASH_TAIL_LINES = 5
const COLLAPSED_TEXT_WIDTH = 60

const RENDER_CACHE_MAX = 400

export class TranscriptModel {
  private readonly entries: Entry[] = []
  preview: StreamPreview | undefined
  private readonly listeners = new Set<() => void>()
  /** Bounded LRU of rendered units keyed by content identity, width and expansion. */
  private readonly renderCache = new Map<string, readonly Row[]>()
  private revision = 0
  private layoutCache: { key: string; lines: ReadonlyArray<{ row: Row; key: string }> } | undefined

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notify(): void {
    this.revision++
    for (const listener of [...this.listeners]) listener()
  }

  get all(): readonly Entry[] {
    return this.entries
  }

  appendUser(text: string, requestId: string): void {
    this.entries.push({
      kind: 'user',
      id: `user-local-${requestId}`,
      text,
      requestId,
      pending: true,
    })
    this.notify()
  }

  /** Retire the local echo once the official user message lands. */
  confirmUser(seq: number, text: string): boolean {
    const echo = this.entries.find(
      (entry): entry is UserEntry =>
        entry.kind === 'user' && entry.pending === true && entry.text === text,
    )
    if (echo) {
      const index = this.entries.indexOf(echo)
      this.entries[index] = { ...echo, pending: false, seq }
      this.notify()
      return true
    }
    this.entries.push({ kind: 'user', id: `user-${seq}`, text, seq })
    this.notify()
    return false
  }

  appendUserFromSession(seq: number, text: string): void {
    if (this.confirmUser(seq, text)) return
  }

  /** 只接收 text blocks；reasoning 走 `appendThinking`，不再进入正文条目。 */
  appendAssistant(seq: number, blocks: readonly Block[]): void {
    const text = blocks.filter((block) => block.type === 'text')
    this.preview = undefined
    if (text.length === 0) {
      this.notify()
      return
    }
    this.entries.push({ kind: 'assistant', id: `assistant-${seq}`, seq, blocks: text })
    this.notify()
  }

  /** 记录已完成思考的最后 1–2 个非空行；同一 seq 重复到达时替换。 */
  appendThinking(seq: number, text: string): void {
    const lines = reasoningTail(text)
    if (lines.length === 0) return
    const entry: ThinkingEntry = {
      kind: 'thinking',
      id: `thinking-${seq}`,
      seq,
      lines,
    }
    const index = this.entries.findIndex(
      (item): item is ThinkingEntry => item.kind === 'thinking' && item.id === entry.id,
    )
    if (index >= 0) this.entries[index] = entry
    else this.entries.push(entry)
    this.notify()
  }

  /** 审批卡打开 / 结算时把对应工具行标成 waiting（spec §3.9）。 */
  markWaiting(callId: string, waiting: boolean): boolean {
    const index = this.entries.findIndex(
      (entry): entry is ToolEntry => entry.kind === 'tool' && entry.callId === callId,
    )
    if (index < 0) return false
    const entry = this.entries[index] as ToolEntry
    const next = waiting
      ? entry.status === 'running'
        ? 'waiting'
        : entry.status
      : entry.status === 'waiting'
        ? 'running'
        : entry.status
    if (next === entry.status) return true
    this.entries[index] = { ...entry, status: next, rev: entry.rev + 1 }
    this.notify()
    return true
  }

  /** 绑定前台 Bash job；不改变渲染，只用于后续 output 对账。 */
  attachLiveJob(callId: string, jobId: string): boolean {
    const index = this.entries.findIndex(
      (entry): entry is ToolEntry => entry.kind === 'tool' && entry.callId === callId,
    )
    if (index < 0) return false
    const entry = this.entries[index] as ToolEntry
    if (entry.liveJobId === jobId) return true
    this.entries[index] = { ...entry, liveJobId: jobId }
    return true
  }

  /** 追加本次增量行，只保留最后 5 行；后台调用不接预览。 */
  setLiveOutput(callId: string, lines: readonly string[]): boolean {
    const index = this.entries.findIndex(
      (entry): entry is ToolEntry => entry.kind === 'tool' && entry.callId === callId,
    )
    if (index < 0) return false
    const entry = this.entries[index] as ToolEntry
    if (parseArgs(entry.args).run_in_background === true) return false
    // 慢速输出时每次 output 只有一两行；必须追加而不是覆盖，否则「最后 5 行」
    // 会退化成最后一批（F1）。
    const tail = [...(entry.liveOutput ?? []), ...lines].slice(-BASH_TAIL_LINES)
    const same =
      entry.liveOutput !== undefined &&
      entry.liveOutput.length === tail.length &&
      entry.liveOutput.every((line, i) => line === tail[i])
    if (same) return true
    this.entries[index] = { ...entry, liveOutput: tail, rev: entry.rev + 1 }
    this.notify()
    return true
  }

  /** job 结算后清映射，保留已显示的 liveOutput（不撤回）。 */
  clearLiveJob(callId: string): void {
    const index = this.entries.findIndex(
      (entry): entry is ToolEntry => entry.kind === 'tool' && entry.callId === callId,
    )
    if (index < 0) return
    const entry = this.entries[index] as ToolEntry
    if (entry.liveJobId === undefined) return
    const { liveJobId: _jobId, ...rest } = entry
    this.entries[index] = rest
  }

  appendTool(callId: string, name: string, args: string): void {
    this.entries.push({
      kind: 'tool',
      id: `tool-${callId}`,
      callId,
      name,
      args,
      status: 'running',
      rev: 0,
    })
    this.notify()
  }

  /** Look up one tool call for the approval card's command block (spec §3.3). */
  toolEntryByCallId(callId: string): ToolEntry | undefined {
    return this.entries.find(
      (entry): entry is ToolEntry => entry.kind === 'tool' && entry.callId === callId,
    )
  }

  /**
   * Record the user's approval decision so the tool row keeps a visible record
   * after the card closes (spec §3.9). Returns false when the call is unknown
   * so the caller can fall back to a transcript notice.
   */
  markApprovalDecision(callId: string, outcome: ApprovalOutcome): boolean {
    if (outcome === 'allowed-once') return false
    const index = this.entries.findIndex(
      (entry): entry is ToolEntry => entry.kind === 'tool' && entry.callId === callId,
    )
    if (index < 0) return false
    const entry = this.entries[index] as ToolEntry
    if (entry.decision !== outcome) {
      this.entries[index] = { ...entry, decision: outcome, rev: entry.rev + 1 }
      this.notify()
    }
    return true
  }

  completeTool(callId: string, resultText: string, isError: boolean, resultMeta?: unknown): void {
    const index = this.entries.findIndex(
      (entry): entry is ToolEntry => entry.kind === 'tool' && entry.callId === callId,
    )
    if (index < 0) return
    const entry = this.entries[index] as ToolEntry
    // 必须在 previewToolResult 截断之前解析问卷 JSON：长自定义答案可能超过
    // 单行 500 码元上限。解析成功才清空原始 JSON（ADR-20261102）。
    const projection =
      entry.name === 'ask_user_question'
        ? projectQuestionResult(entry.args, resultText, isError)
        : undefined
    this.entries[index] =
      projection === undefined
        ? {
            ...entry,
            status: isError ? 'error' : 'ok',
            resultText: previewToolResult(resultText),
            ...(resultMeta !== undefined ? { resultMeta } : {}),
            rev: entry.rev + 1,
          }
        : {
            ...entry,
            status: projection.outcome === 'cancelled' || isError ? 'error' : 'ok',
            resultText: '',
            questionAnswers: projection.answers,
            questionOutcome: projection.outcome,
            ...(resultMeta !== undefined ? { resultMeta } : {}),
            rev: entry.rev + 1,
          }
    this.notify()
  }

  appendNotice(text: string, tone: NoticeEntry['tone'] = 'info', address?: string): void {
    this.entries.push({
      kind: 'notice',
      id: `notice-${this.entries.length}`,
      text,
      tone,
      ...(address !== undefined ? { address } : {}),
    })
    this.notify()
  }

  setPreview(preview: StreamPreview | undefined): void {
    this.preview = preview
    this.notify()
  }

  clearPreview(): void {
    if (this.preview === undefined) return
    this.preview = undefined
    this.notify()
  }

  /** Mark an unconfirmed submission after a disconnect or unknown state. */
  markUnconfirmed(requestId: string): void {
    const index = this.entries.findIndex(
      (entry): entry is UserEntry => entry.kind === 'user' && entry.requestId === requestId,
    )
    if (index < 0) return
    const entry = this.entries[index] as UserEntry
    this.entries[index] = { ...entry, pending: false }
    this.notify()
  }

  private cachedRows(key: string, build: () => Row[]): Row[] {
    const hit = this.renderCache.get(key)
    if (hit) {
      this.renderCache.delete(key)
      this.renderCache.set(key, hit)
      return hit as Row[]
    }
    const rows = build()
    this.renderCache.set(key, rows)
    if (this.renderCache.size > RENDER_CACHE_MAX) {
      const oldest = this.renderCache.keys().next().value
      if (oldest !== undefined) this.renderCache.delete(oldest)
    }
    return rows
  }

  units(options: RenderOptions): Unit[] {
    const units: Unit[] = []
    const address = options.address ?? 'root'
    let index = 0
    while (index < this.entries.length) {
      const entry = this.entries[index] as Entry
      if ((entry.address ?? 'root') !== address) {
        index++
        continue
      }
      if (entry.kind === 'tool' && isReadLike(entry.name)) {
        const group: ToolEntry[] = [entry]
        let cursor = index + 1
        while (cursor < this.entries.length) {
          const next = this.entries[cursor] as Entry
          if ((next.address ?? 'root') !== address) break
          if (next.kind !== 'tool' || !isReadLike(next.name)) break
          group.push(next)
          cursor++
        }
        units.push(this.toolUnit(group, options))
        index = cursor
        continue
      }
      units.push(this.entryUnit(entry, options))
      index++
    }
    if (this.preview) units.push(this.previewUnit(options))
    return units
  }

  private entryUnit(entry: Entry, options: RenderOptions): Unit {
    switch (entry.kind) {
      case 'user': {
        const key = `${entry.id}|${options.width}|user|${entry.pending === true ? 1 : 0}`
        return {
          id: entry.id,
          kind: 'user',
          gapBefore: 'Block',
          rows: this.cachedRows(key, () =>
            wrapSpans(
              [textSpan(`${USER_MARK} `, 'muted'), textSpan(entry.text, 'normal')],
              options.width - EDGE,
            ).map((row) => ({ ...row, indent: EDGE, background: 'userBg' as const })),
          ),
        }
      }
      case 'assistant': {
        const text = entry.blocks
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('\n')
        const key = `${entry.id}|${options.width}|assistant`
        return {
          id: entry.id,
          kind: 'assistant',
          gapBefore: 'Block',
          rows: this.cachedRows(key, () =>
            renderMarkdown(text, options.width, {
              indent: NESTED,
              lead: textSpan(`${ASSISTANT_MARK} `, 'normal'),
              // 消息定稿时对全文校验一次（ADR-20261110）：分块结果必须与全文相等。
              verifyParity: true,
            }),
          ),
        }
      }
      case 'thinking':
        return this.thinkingUnit(entry, options)
      case 'tool':
        return this.toolUnit([entry], options)
      case 'notice':
        return {
          id: entry.id,
          kind: entry.tone === 'danger' ? 'error' : 'notice',
          gapBefore: 'Block',
          rows: wrapSpans([textSpan(entry.text, entry.tone)], options.width - EDGE).map((row) => ({
            ...row,
            indent: EDGE,
          })),
        }
    }
  }

  private toolUnit(group: ToolEntry[], options: RenderOptions): Unit {
    const first = group[0] as ToolEntry
    const id = group.length === 1 ? first.id : `group-${first.id}`
    const expanded = options.expanded.has(id)
    const width = Math.max(1, options.width - EDGE)
    const version = group.map((entry) => `${entry.id}:${entry.rev}`).join(',')
    const cacheKey = `${id}|${options.width}|${expanded ? 1 : 0}|${version}`

    // 代码变更：带 diffs 的工具渲染为独立块（设计稿的 Update 块）。
    const diffs = group.length === 1 ? diffsFromMeta(first.resultMeta) : undefined
    if (diffs !== undefined) {
      const rows = this.cachedRows(cacheKey, () => {
        const built = renderDiffs(diffs, options.width, {
          expanded,
          status: first.status,
        })
        if (first.status === 'error') built.push(...failureRows(first, width))
        built.push(...decisionRows(first, width))
        return built
      })
      return { id, kind: 'tool', gapBefore: 'Block', rows, pressId: id }
    }

    if (isReadLike(first.name)) {
      const rows = this.cachedRows(cacheKey, () => {
        const built: Row[] = []
        const failures = group.filter((entry) => entry.status === 'error').length
        const target = group.length === 1 ? readTarget(first) : `${group.length} 项`
        built.push(
          ...wrapSpans(
            [
              textSpan(`${ASSISTANT_MARK} `, statusTone(groupStatus(group))),
              textSpan('读取', 'normal', { bold: true }),
              textSpan(` ${target}`, 'normal'),
              ...(failures > 0 ? [textSpan(` · ${failures} 失败`, 'danger')] : []),
              textSpan(decisionSummary(group), 'muted'),
            ],
            width,
          ).map((row) => ({ ...row, indent: EDGE })),
        )
        if (!expanded) {
          const last = group[group.length - 1] as ToolEntry
          built.push(...branchRows(readTarget(last), options.width))
        } else {
          for (const entry of group) {
            built.push({
              spans: [
                textSpan(`· `, statusTone(entry.status)),
                textSpan(entry.name, 'normal', { bold: true }),
                textSpan(` ${readTarget(entry)}`, 'normal'),
              ],
              indent: NESTED,
            })
            built.push(...decisionRows(entry, width))
            if (entry.status === 'error') built.push(...failureRows(entry, width))
          }
        }
        return built
      })
      return { id, kind: 'group', gapBefore: 'Block', rows, pressId: id }
    }

    const entry = first
    const rows = this.cachedRows(cacheKey, () => {
      const built: Row[] = []
      if (entry.name === 'ask_user_question') {
        built.push(...questionRows(entry, options.width))
      } else {
        const { name, args } = toolHeading(entry)
        built.push(
          ...wrapSpans(
            [
              textSpan(`${ASSISTANT_MARK} `, statusTone(entry.status)),
              textSpan(name, 'normal', { bold: true }),
              textSpan(args, 'normal'),
            ],
            width,
          ).map((row) => ({ ...row, indent: EDGE })),
        )
      }
      built.push(...decisionRows(entry, width))
      if (entry.status === 'error' && entry.questionOutcome !== 'cancelled' && !expanded) {
        built.push(...failureRows(entry, width))
      }
      if (isBash(entry) && !expanded && entry.status !== 'error') {
        built.push(...liveOutputRows(entry, options.width))
      }
      if (expanded) built.push(...expandedToolRows(entry))
      return built
    })
    return {
      id,
      kind: 'tool',
      gapBefore: 'Block',
      rows,
      pressId:
        activationTarget(entry.resultMeta) ??
        activationFromResult(entry.name, entry.resultText) ??
        id,
    }
  }

  /** 已完成的思考块：标题 + 最后一行尾巴；展开只看保留的 1–2 行。 */
  private thinkingUnit(entry: ThinkingEntry, options: RenderOptions): Unit {
    const id = entry.id
    const expanded = options.expanded.has(id)
    const key = `${id}|${options.width}|${expanded ? 1 : 0}|${entry.lines.join('\u0000')}`
    const rows = this.cachedRows(key, () => {
      const built: Row[] = [
        {
          spans: [textSpan(`${THINKING_MARK} 思考`, 'muted', { italic: true })],
          indent: EDGE,
          pressId: id,
        },
      ]
      const lines = expanded ? entry.lines : entry.lines.slice(-1)
      for (const line of lines) {
        if (expanded) {
          built.push(
            ...wrapSpans([textSpan(line, 'faint')], Math.max(1, options.width - NESTED)).map(
              (row) => ({ ...row, indent: NESTED, pressId: id }),
            ),
          )
        } else {
          built.push({
            spans: [textSpan(truncateLeft(line, options.width - NESTED), 'faint')],
            indent: NESTED,
            pressId: id,
          })
        }
      }
      return built
    })
    return { id, kind: 'thinking', gapBefore: 'Block', rows, pressId: id }
  }

  /**
   * Flattened, gap-aware transcript lines memoized by width, expansion set and
   * content revision. Scrolling reuses the same array instead of reallocating
   * thousands of row wrappers per frame.
   */
  layout(options: RenderOptions): ReadonlyArray<{ row: Row; key: string }> {
    const key = `${options.width}|${options.address ?? 'root'}|${[...options.expanded].sort().join(',')}|${this.revision}`
    if (this.layoutCache?.key === key) return this.layoutCache.lines
    const lines: Array<{ row: Row; key: string }> = []
    const units = this.units(options)
    for (const unit of units) {
      if (unit.rows.length === 0) continue
      if (unit.gapBefore !== 'None' && lines.length > 0) {
        lines.push({ row: { spans: [textSpan('', 'normal')] }, key: `${unit.id}-gap` })
      }
      unit.rows.forEach((row, index) => {
        lines.push({
          row: unit.pressId && !row.pressId ? { ...row, pressId: unit.pressId } : row,
          key: `${unit.id}-${index}`,
        })
      })
    }
    this.layoutCache = { key, lines }
    return lines
  }

  private previewUnit(options: RenderOptions): Unit {
    const preview = this.preview as StreamPreview
    const id = `thinking-${preview.attemptId}`
    const expanded = options.expanded.has(id)
    const rows: Row[] = []
    if (preview.reasoning.trim() !== '') {
      rows.push({
        spans: [textSpan(`${THINKING_MARK} 思考中`, 'muted', { italic: true })],
        indent: EDGE,
        pressId: id,
      })
      if (expanded) {
        const reasoning = renderMarkdown(preview.reasoning, options.width, { indent: NESTED })
        rows.push(...reasoning.map((row) => ({ ...row, pressId: id })))
      } else {
        const tail = reasoningTail(preview.reasoning).at(-1)
        if (tail !== undefined) {
          rows.push({
            spans: [textSpan(truncateLeft(tail, options.width - NESTED), 'faint')],
            indent: NESTED,
            pressId: id,
          })
        }
      }
    }
    if (preview.text !== '') {
      rows.push(
        ...renderMarkdown(preview.text, options.width, {
          indent: NESTED,
          lead: textSpan(`${ASSISTANT_MARK} `, 'normal'),
        }),
      )
    }
    return { id, kind: 'thinking', gapBefore: 'Block', rows, pressId: id }
  }
}

function isReadLike(name: string): boolean {
  return READ_LIKE.has(name.toLowerCase())
}

interface ParsedArgs {
  [key: string]: unknown
}

export function parseArgs(raw: string): ParsedArgs {
  try {
    const value = JSON.parse(raw)
    return typeof value === 'object' && value !== null ? (value as ParsedArgs) : {}
  } catch {
    return {}
  }
}

function readTarget(entry: ToolEntry): string {
  const args = parseArgs(entry.args)
  for (const key of ['file_path', 'path', 'pattern', 'query', 'glob']) {
    const value = args[key]
    if (typeof value === 'string' && value !== '') return value
  }
  return entry.name
}

function toolHeading(entry: ToolEntry): { name: string; args: string } {
  const args = parseArgs(entry.args)
  const command = args.command
  if (typeof command === 'string' && command !== '') {
    return { name: 'Bash', args: `(${truncate(command, COLLAPSED_TEXT_WIDTH)})` }
  }
  const target = readTarget(entry)
  return {
    name: entry.name,
    args: target === entry.name ? '' : `(${truncate(target, COLLAPSED_TEXT_WIDTH)})`,
  }
}

function isBash(entry: ToolEntry): boolean {
  return entry.name.toLowerCase() === 'bash'
}

function expandedToolRows(entry: ToolEntry): Row[] {
  const rows: Row[] = []
  // 问卷成功投影后，题面 / 答案已经变成决策行，展开不再重复原始 JSON；
  // 解析失败 / 运行中 / 报错时保留旧工具行的 args + 预览（F3 / F4）。
  if (entry.name === 'ask_user_question' && entry.questionOutcome !== undefined) return rows
  const args = parseArgs(entry.args)
  if (typeof args.command === 'string' && args.command !== '') {
    rows.push({ spans: [textSpan(`$ ${args.command}`, 'code')], indent: NESTED })
  } else if (Object.keys(args).length > 0) {
    const pretty = JSON.stringify(args, null, 2).split('\n').slice(0, 24)
    rows.push(...pretty.map((line) => ({ spans: [textSpan(line, 'faint')], indent: NESTED })))
  }
  if (entry.resultText !== undefined && previewHasContent(entry.resultText)) {
    const lines = entry.resultText.split('\n')
    const tone = entry.status === 'error' ? 'danger' : 'muted'
    rows.push(...lines.map((line) => ({ spans: [textSpan(line, tone)], indent: NESTED })))
  }
  return rows
}

function statusTone(status: ToolEntry['status']): Span['tone'] {
  switch (status) {
    case 'ok':
      return 'success'
    case 'error':
      return 'danger'
    case 'waiting':
      return 'warning'
    default:
      return 'muted'
  }
}

function groupStatus(group: readonly ToolEntry[]): ToolEntry['status'] {
  if (group.some((entry) => entry.status === 'error')) return 'error'
  if (group.some((entry) => entry.status === 'waiting')) return 'waiting'
  if (group.some((entry) => entry.status === 'running')) return 'running'
  return 'ok'
}

function questionRows(entry: ToolEntry, totalWidth: number): Row[] {
  const outcome = entry.questionOutcome
  const answers = entry.questionAnswers ?? []
  const mark = outcome === 'cancelled' ? '·' : ASSISTANT_MARK
  const tone =
    outcome === 'cancelled'
      ? 'muted'
      : outcome === 'pending'
        ? 'warning'
        : entry.status === 'ok'
          ? 'success'
          : statusTone(entry.status)
  const suffix = questionSuffix(outcome, answers.length)
  const width = Math.max(1, totalWidth - EDGE)
  const rows: Row[] = wrapSpans(
    [
      textSpan(`${mark} `, tone),
      textSpan('问卷', 'normal', { bold: true }),
      ...(suffix !== '' ? [textSpan(` · ${suffix}`, 'muted')] : []),
    ],
    width,
  ).map((row) => ({ ...row, indent: EDGE }))
  if (outcome === 'cancelled') {
    rows.push(answerRow('已取消，未提交答案', totalWidth))
  } else if (outcome === 'answered' || outcome === 'skipped') {
    for (const line of answers) {
      rows.push(answerRow(`${line.question} → ${line.answer}`, totalWidth))
    }
  }
  return rows
}

function questionSuffix(outcome: QuestionOutcome | undefined, count: number): string {
  if (outcome === 'skipped') return '已跳过'
  if (outcome === 'pending') return '等待你的选择'
  if (outcome === 'answered' && count > 1) return `已回答 ${count} 题`
  return ''
}

function answerRow(text: string, totalWidth: number): Row {
  const available = Math.max(1, totalWidth - INDENT - 2)
  return {
    spans: [
      textSpan('· ', 'muted'),
      textSpan(truncateText(collapseWhitespace(text), available), 'muted'),
    ],
    indent: INDENT,
  }
}

/** `  ⎿  ` 分支：`⎿` 在 2ch，正文从 5ch 开始，单行截断。 */
function branchRows(text: string, totalWidth: number, tone: Span['tone'] = 'faint'): Row[] {
  const available = Math.max(1, totalWidth - displayWidth(BRANCH_MARK))
  return [
    {
      spans: [
        textSpan(BRANCH_MARK, 'muted'),
        textSpan(truncateText(collapseWhitespace(text), available), tone),
      ],
      indent: 0,
    },
  ]
}

/** 前台 Bash 的 live 输出：最多 5 行，第一行带 `⎿`，后续 5ch。 */
function liveOutputRows(entry: ToolEntry, totalWidth: number): Row[] {
  const output = entry.liveOutput
  if (output === undefined || output.length === 0) return []
  const padding = ' '.repeat(displayWidth(BRANCH_MARK))
  const available = Math.max(1, totalWidth - displayWidth(BRANCH_MARK))
  return output.slice(-BASH_TAIL_LINES).map((line, index) => ({
    spans: [
      textSpan(index === 0 ? BRANCH_MARK : padding, 'muted'),
      textSpan(truncateText(line, available), 'faint'),
    ],
    indent: 0,
  }))
}

/** Failures keep exactly three result lines when collapsed. */
const DECISION_LABELS: Record<ApprovalDecision, string> = {
  rejected: '已拒绝',
  cancelled: '已取消',
  unavailable: '无法回答',
}

const DECISION_ORDER: ApprovalDecision[] = ['rejected', 'cancelled', 'unavailable']

/** 组行折叠摘要：同一结果写一次，混合结果按数量（spec §3.9）。 */
function decisionSummary(group: ToolEntry[]): string {
  const counts = new Map<ApprovalDecision, number>()
  for (const entry of group) {
    if (entry.decision) counts.set(entry.decision, (counts.get(entry.decision) ?? 0) + 1)
  }
  if (counts.size === 0) return ''
  if (counts.size === 1) return ` · ${DECISION_LABELS[[...counts.keys()][0]!]}`
  return DECISION_ORDER.filter((decision) => counts.has(decision))
    .map((decision) => ` · ${DECISION_LABELS[decision]} ${counts.get(decision)}`)
    .join('')
}

/** 工具行下方的决策行（`muted`、缩进 `INDENT`）；允许路径没有这一行。 */
function decisionRows(entry: ToolEntry, width: number): Row[] {
  const text = entry.decision ? approvalDecisionText(entry.decision) : undefined
  if (text === undefined) return []
  return wrapSpans([textSpan(text, 'muted')], width).map((row) => ({
    ...row,
    indent: INDENT,
  }))
}

function failureRows(entry: ToolEntry, width: number): Row[] {
  const text = entry.resultText ?? '（无错误输出）'
  const lines = text.split('\n').slice(0, 3)
  return lines.map((line) => ({
    spans: wrapSpans([textSpan(line, 'danger')], width)[0]?.spans ?? [textSpan('', 'danger')],
    indent: INDENT,
  }))
}

function truncate(text: string, length: number): string {
  const line = text.split('\n')[0] ?? ''
  const chars = graphemes(line)
  return chars.length > length ? `${chars.slice(0, length - 1).join('')}…` : line
}

/** 思考尾句：最后 1–2 个非空行，连续空白压成一个空格。 */
function reasoningTail(text: string): string[] {
  return text
    .split('\n')
    .map(collapseWhitespace)
    .filter((line) => line !== '')
    .slice(-THINKING_TAIL_LINES)
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/gu, ' ').trim()
}

/** 按显示宽度从左侧截断，保留尾部并加 `…` 前缀。 */
function truncateLeft(text: string, width: number): string {
  const max = Math.max(1, Math.floor(width))
  if (displayWidth(text) <= max) return text
  const budget = Math.max(0, max - 1)
  const chars = graphemes(text)
  let out = ''
  let used = 0
  for (let i = chars.length - 1; i >= 0; i--) {
    const g = chars[i] as string
    const gw = graphemeWidth(g)
    if (used + gw > budget) break
    out = g + out
    used += gw
  }
  return `…${out}`
}

export { EDGE, INDENT }
