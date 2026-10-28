/**
 * File-diff rendering from tool metadata (`meta.diffs`): a line diff with
 * three context lines, an eight-line budget when collapsed, and no invented
 * line numbers (the metadata carries none).
 */
import { EDGE } from '../theme/spacing.ts'
import { type Row, type Span, textSpan, wrapSpans } from './spans.ts'

export interface FileDiff {
  readonly path: string
  readonly oldText: string | null
  readonly newText: string
}

type DiffOp = ' ' | '-' | '+'

export interface DiffLine {
  readonly op: DiffOp
  readonly text: string
}

export const DIFF_LINE_BUDGET = 8
const CONTEXT = 3

/** Narrow opaque tool metadata to validated file diffs. */
export function diffsFromMeta(meta: unknown): FileDiff[] | undefined {
  if (typeof meta !== 'object' || meta === null) return undefined
  const diffs = (meta as { diffs?: unknown }).diffs
  if (!Array.isArray(diffs) || diffs.length === 0) return undefined
  const valid: FileDiff[] = []
  for (const entry of diffs) {
    if (typeof entry !== 'object' || entry === null) return undefined
    const { path, oldText, newText } = entry as Record<string, unknown>
    if (typeof path !== 'string' || typeof newText !== 'string') return undefined
    if (oldText !== null && typeof oldText !== 'string') return undefined
    valid.push({ path, oldText: oldText as string | null, newText })
  }
  return valid
}

/** Myers line diff (sufficiently small inputs; huge files fall back to replace). */
export function diffLines(oldText: string | null, newText: string): DiffLine[] {
  const before = oldText === null ? [] : oldText.split('\n')
  const after = newText.split('\n')
  if (before.length * after.length > 4_000_000) {
    return [
      ...before.map((text) => ({ op: '-' as const, text })),
      ...after.map((text) => ({ op: '+' as const, text })),
    ]
  }
  // Trim common prefix/suffix first; diff only the middle.
  let prefix = 0
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix])
    prefix++
  let suffix = 0
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix++
  }
  const oldMiddle = before.slice(prefix, before.length - suffix)
  const newMiddle = after.slice(prefix, after.length - suffix)
  const middle = myers(oldMiddle, newMiddle)
  return [
    ...before.slice(0, prefix).map((text) => ({ op: ' ' as const, text })),
    ...middle,
    ...before.slice(before.length - suffix).map((text) => ({ op: ' ' as const, text })),
  ]
}

function myers(a: readonly string[], b: readonly string[]): DiffLine[] {
  const n = a.length
  const m = b.length
  if (n === 0) return b.map((text) => ({ op: '+' as const, text }))
  if (m === 0) return a.map((text) => ({ op: '-' as const, text }))
  const max = n + m
  const offset = max
  const v = new Int32Array(2 * max + 1)
  const trace: Int32Array[] = []
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice())
    for (let k = -d; k <= d; k += 2) {
      let x: number
      if (k === -d || (k !== d && (v[offset + k - 1] ?? 0) < (v[offset + k + 1] ?? 0))) {
        x = v[offset + k + 1] ?? 0
      } else {
        x = (v[offset + k - 1] ?? 0) + 1
      }
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }
      v[offset + k] = x
      if (x >= n && y >= m) return backtrack(trace, a, b, offset)
    }
  }
  return []
}

function backtrack(
  trace: Int32Array[],
  a: readonly string[],
  b: readonly string[],
  offset: number,
): DiffLine[] {
  const ops: DiffLine[] = []
  let x = a.length
  let y = b.length
  for (let d = trace.length - 1; d >= 0; d--) {
    if (d === 0) {
      while (x > 0 && y > 0) {
        ops.push({ op: ' ', text: a[x - 1] as string })
        x--
        y--
      }
      continue
    }
    const v = trace[d] as Int32Array
    const k = x - y
    const prevK =
      k === -d || (k !== d && (v[offset + k - 1] ?? 0) < (v[offset + k + 1] ?? 0)) ? k + 1 : k - 1
    const prevX = v[offset + prevK] ?? 0
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      ops.push({ op: ' ', text: a[x - 1] as string })
      x--
      y--
    }
    if (x === prevX) {
      if (y - 1 >= 0) ops.push({ op: '+', text: b[y - 1] as string })
      y--
    } else {
      if (x - 1 >= 0) ops.push({ op: '-', text: a[x - 1] as string })
      x--
    }
  }
  return ops.reverse()
}

/** Rows for one file's diff; collapsed output is capped at the 8-line budget. */
export function renderDiffs(
  diffs: readonly FileDiff[],
  width: number,
  options: { expanded?: boolean; budget?: number } = {},
): Row[] {
  const rows: Row[] = []
  for (const diff of diffs) {
    rows.push({ spans: [textSpan(diff.path, 'accent', { bold: true })] })
    const lines = diffLines(diff.oldText, diff.newText)
    const { visible, hidden } =
      options.expanded === true
        ? { visible: lines, hidden: 0 }
        : collapseContext(lines, options.budget ?? DIFF_LINE_BUDGET)
    for (const line of visible) rows.push(...diffRows(line, width))
    if (hidden > 0) {
      rows.push({ spans: [textSpan(`… 还有 ${hidden} 行（点击展开）`, 'faint')] })
    }
  }
  return rows
}

/** Keep changed lines plus context, hiding lines beyond the budget. */
function collapseContext(
  lines: readonly DiffLine[],
  budget: number,
): { visible: DiffLine[]; hidden: number } {
  const changed = lines
    .map((line, index) => (line.op === ' ' ? -1 : index))
    .filter((index) => index >= 0)
  if (changed.length === 0) {
    const visible = lines.slice(0, budget)
    return { visible, hidden: Math.max(0, lines.length - visible.length) }
  }
  const keep = new Set<number>()
  for (const index of changed) {
    for (let i = index - CONTEXT; i <= index + CONTEXT; i++) {
      if (i >= 0 && i < lines.length) keep.add(i)
    }
  }
  const visible: DiffLine[] = []
  let hidden = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as DiffLine
    if (keep.has(i) && visible.length < budget) visible.push(line)
    else hidden++
  }
  return { visible, hidden }
}

function diffRows(line: DiffLine, width: number): Row[] {
  const tone: Span['tone'] = line.op === '+' ? 'diffAdd' : line.op === '-' ? 'diffDel' : 'muted'
  const prefix = line.op === ' ' ? '  ' : `${line.op} `
  const spans: Span[] = [textSpan(prefix, tone), textSpan(line.text, tone)]
  return wrapSpans(spans, Math.max(1, width - EDGE)).map((row) => ({ ...row, indent: EDGE }))
}
