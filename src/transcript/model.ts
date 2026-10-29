/**
 * Transcript model and process-display rules (ADR-20261028-nano-process-display):
 * consecutive reads merge into a counting row, successful tools keep zero
 * result rows, failures keep three, streaming thinking is one row that
 * disappears once committed, and only in-place clicks expand a row.
 */

import { graphemes } from '../render/text.ts'
import { EDGE, INDENT } from '../theme/spacing.ts'
import { diffsFromMeta, type FileDiff, renderDiffs } from './diff.ts'
import { renderMarkdown } from './markdown.ts'
import { type Row, textSpan, wrapSpans } from './spans.ts'

export interface Block {
  readonly type: 'text' | 'reasoning'
  readonly text: string
}

export type Entry = UserEntry | AssistantEntry | ToolEntry | NoticeEntry

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

export interface ToolEntry {
  readonly kind: 'tool'
  readonly id: string
  readonly address?: string
  readonly callId: string
  readonly name: string
  readonly args: string
  readonly status: 'running' | 'ok' | 'error'
  readonly resultText?: string
  readonly resultMeta?: unknown
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

const THINKING_MARK = { collapsed: '▸', expanded: '▾' }

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

  appendAssistant(seq: number, blocks: readonly Block[]): void {
    this.entries.push({ kind: 'assistant', id: `assistant-${seq}`, seq, blocks })
    this.preview = undefined
    this.notify()
  }

  appendTool(callId: string, name: string, args: string): void {
    this.entries.push({
      kind: 'tool',
      id: `tool-${callId}`,
      callId,
      name,
      args,
      status: 'running',
    })
    this.notify()
  }

  completeTool(callId: string, resultText: string, isError: boolean, resultMeta?: unknown): void {
    const index = this.entries.findIndex(
      (entry): entry is ToolEntry => entry.kind === 'tool' && entry.callId === callId,
    )
    if (index < 0) return
    const entry = this.entries[index] as ToolEntry
    this.entries[index] = {
      ...entry,
      status: isError ? 'error' : 'ok',
      resultText,
      ...(resultMeta !== undefined ? { resultMeta } : {}),
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
              [textSpan('› ', 'user', { bold: true }), textSpan(entry.text, 'user')],
              options.width - EDGE,
            ).map((row) => ({ ...row, indent: EDGE })),
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
          rows: this.cachedRows(key, () => renderMarkdown(text, options.width, { indent: EDGE })),
        }
      }
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
    const version = group
      .map((entry) => `${entry.id}:${entry.status}:${entry.resultText?.length ?? 0}`)
      .join(',')
    const cacheKey = `${id}|${options.width}|${expanded ? 1 : 0}|${version}`
    const groupKind: Unit['kind'] = group.length > 1 || isReadLike(first.name) ? 'group' : 'tool'
    const failures = group.filter((entry) => entry.status === 'error').length
    const running = group.some((entry) => entry.status === 'running')
    const rows: Row[] = []
    const suffix = expanded ? ' · 点击收起' : ' · 点击展开'
    if (isReadLike(first.name)) {
      const label = group.length === 1 ? `读取 ${readTarget(first)}` : `读取 ${group.length} 项`
      const statusMark = running ? '…' : failures > 0 ? ` · ${failures} 失败` : ''
      rows.push(
        ...wrapSpans(
          [
            textSpan(label, 'tool'),
            textSpan(statusMark, failures > 0 ? 'danger' : 'muted'),
            textSpan(suffix, 'faint'),
          ],
          width,
        ).map((row) => ({ ...row, indent: EDGE })),
      )
      if (expanded) {
        for (const entry of group) {
          const mark = entry.status === 'error' ? '✗' : entry.status === 'running' ? '…' : '✓'
          rows.push({
            spans: [
              textSpan('  ', 'muted'),
              textSpan(`${mark} `, entry.status === 'error' ? 'danger' : 'muted'),
              textSpan(`${entry.name} ${readTarget(entry)}`, 'muted'),
            ],
            indent: EDGE,
          })
          if (entry.status === 'error') rows.push(...failureRows(entry, width))
        }
      }
      const cached = this.cachedRows(cacheKey, () => rows)
      return { id, kind: groupKind, gapBefore: 'Block', rows: cached, pressId: id }
    }
    const entry = first
    const title = toolTitle(entry)
    const mark = entry.status === 'error' ? '✗' : entry.status === 'running' ? '…' : '✓'
    rows.push(
      ...wrapSpans(
        [
          textSpan(
            `${mark} `,
            entry.status === 'error' ? 'danger' : entry.status === 'running' ? 'muted' : 'success',
          ),
          textSpan(title, 'tool'),
          textSpan(suffix, 'faint'),
        ],
        width,
      ).map((row) => ({ ...row, indent: EDGE })),
    )
    if (entry.status === 'error' && !expanded) rows.push(...failureRows(entry, width))
    if (expanded) {
      rows.push(...expandedToolRows(entry, width))
    }
    const cached = this.cachedRows(cacheKey, () => rows)
    return { id, kind: groupKind, gapBefore: 'Block', rows: cached, pressId: id }
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
    const _width = Math.max(1, options.width - EDGE)
    if (preview.reasoning !== '') {
      const mark = expanded ? THINKING_MARK.expanded : THINKING_MARK.collapsed
      rows.push({
        spans: [textSpan(`${mark} 思考中`, 'muted')],
        indent: EDGE,
        pressId: id,
      })
      if (expanded) {
        const reasoning = renderMarkdown(preview.reasoning, options.width, { indent: EDGE })
        rows.push(...reasoning.map((row) => ({ ...row, pressId: id })))
      }
    }
    if (preview.text !== '') {
      rows.push(...renderMarkdown(preview.text, options.width, { indent: EDGE }))
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

function parseArgs(raw: string): ParsedArgs {
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

function toolTitle(entry: ToolEntry): string {
  const args = parseArgs(entry.args)
  const command = args.command
  if (typeof command === 'string' && command !== '') {
    return `Bash ${truncate(command, 60)}`
  }
  const target = readTarget(entry)
  return `${entry.name} ${truncate(target, 60)}`
}

function expandedToolRows(entry: ToolEntry, width: number): Row[] {
  const rows: Row[] = []
  const args = parseArgs(entry.args)
  if (typeof args.command === 'string' && args.command !== '') {
    rows.push({ spans: [textSpan(`$ ${args.command}`, 'code')], indent: EDGE })
  } else if (Object.keys(args).length > 0) {
    const pretty = JSON.stringify(args, null, 2).split('\n').slice(0, 24)
    rows.push(...pretty.map((line) => ({ spans: [textSpan(line, 'faint')], indent: EDGE })))
  }
  const diffs: FileDiff[] | undefined = diffsFromMeta(entry.resultMeta)
  if (diffs) rows.push(...renderDiffs(diffs, width, { expanded: true }))
  if (entry.resultText && entry.resultText.trim() !== '') {
    const lines = entry.resultText.split('\n').slice(0, 40)
    const tone = entry.status === 'error' ? 'danger' : 'muted'
    rows.push(...lines.map((line) => ({ spans: [textSpan(line, tone)], indent: EDGE })))
  }
  return rows
}

/** Failures keep exactly three result lines when collapsed. */
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

export { EDGE, INDENT }
