/**
 * ANSI/SGR encoding and screen diffing. The renderer computes a full cell
 * grid, compares it with the previous frame and emits only changed runs.
 */
import type { Rgb } from '../theme/theme.ts'

export interface Style {
  readonly fg?: Rgb
  readonly bg?: Rgb
  readonly bold?: boolean
  readonly dim?: boolean
  readonly italic?: boolean
  readonly underline?: boolean
  readonly reverse?: boolean
  readonly strikethrough?: boolean
}

export const EMPTY_STYLE: Style = Object.freeze({})

export function styleEquals(a: Style, b: Style): boolean {
  if (a === b) return true
  return (
    a.bold === b.bold &&
    a.dim === b.dim &&
    a.italic === b.italic &&
    a.underline === b.underline &&
    a.reverse === b.reverse &&
    a.strikethrough === b.strikethrough &&
    rgbEquals(a.fg, b.fg) &&
    rgbEquals(a.bg, b.bg)
  )
}

function rgbEquals(a: Rgb | undefined, b: Rgb | undefined): boolean {
  if (a === b) return true
  if (a === undefined || b === undefined) return false
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2]
}

export function styleKey(style: Style): string {
  return [
    style.fg ? style.fg.join(',') : '',
    style.bg ? style.bg.join(',') : '',
    style.bold ? 'b' : '',
    style.dim ? 'd' : '',
    style.italic ? 'i' : '',
    style.underline ? 'u' : '',
    style.reverse ? 'r' : '',
    style.strikethrough ? 's' : '',
  ].join(';')
}

/** SGR sequence for one style; empty style resets. */
export function sgr(style: Style): string {
  const params: string[] = []
  if (style.bold) params.push('1')
  if (style.dim) params.push('2')
  if (style.italic) params.push('3')
  if (style.underline) params.push('4')
  if (style.reverse) params.push('7')
  if (style.strikethrough) params.push('9')
  if (style.fg) params.push(`38;2;${style.fg[0]};${style.fg[1]};${style.fg[2]}`)
  if (style.bg) params.push(`48;2;${style.bg[0]};${style.bg[1]};${style.bg[2]}`)
  return params.length === 0 ? '\x1b[0m' : `\x1b[0;${params.join(';')}m`
}

export interface Cell {
  /** Grapheme at the cell's start; empty for continuation cells. */
  readonly grapheme: string
  readonly style: Style
  /** True for the second half of a wide grapheme. */
  readonly continuation?: boolean
}

export const BLANK: Cell = Object.freeze({ grapheme: ' ', style: EMPTY_STYLE })

export interface Screen {
  readonly width: number
  readonly height: number
  readonly rows: Cell[][]
}

export function createScreen(width: number, height: number): Screen {
  const rows: Cell[][] = []
  for (let r = 0; r < height; r++) {
    const row: Cell[] = new Array(width)
    for (let c = 0; c < width; c++) row[c] = BLANK
    rows.push(row)
  }
  return { width, height, rows }
}

export function cloneScreen(screen: Screen): Screen {
  return { width: screen.width, height: screen.height, rows: screen.rows.map((row) => row.slice()) }
}

interface Run {
  col: number
  text: string
  style: Style
}

/**
 * Encode the difference between two frames as terminal bytes. Rows are
 * compared cell by cell; wide graphemes are treated atomically so a stale
 * continuation cell can never survive a repaint.
 */
export function encodeDiff(previous: Screen | undefined, next: Screen): string {
  if (previous === undefined || previous.width !== next.width || previous.height !== next.height) {
    return encodeFull(next)
  }
  let out = ''
  for (let row = 0; row < next.height; row++) {
    const prevRow = previous.rows[row] as Cell[]
    const nextRow = next.rows[row] as Cell[]
    const dirty = computeDirty(prevRow, nextRow)
    if (dirty === undefined) continue
    const runs = buildRuns(nextRow, dirty)
    for (const run of runs) {
      out += `\x1b[${row + 1};${run.col + 1}H`
      out += sgr(run.style)
      out += run.text
    }
  }
  if (out !== '') out += '\x1b[0m'
  return out
}

/** Mark every cell that must be repainted, including wide-glyph neighbours. */
function computeDirty(prevRow: Cell[], nextRow: Cell[]): Set<number> | undefined {
  let dirty: Set<number> | undefined
  const width = nextRow.length
  for (let col = 0; col < width; col++) {
    const prev = prevRow[col] as Cell
    const next = nextRow[col] as Cell
    const changed =
      prev.grapheme !== next.grapheme ||
      prev.continuation !== next.continuation ||
      !styleEquals(prev.style, next.style)
    if (!changed) continue
    dirty ??= new Set<number>()
    dirty.add(col)
    if (prev.continuation) {
      // The wide glyph started to our left; repaint its first column too.
      if (col > 0) dirty.add(col - 1)
    }
    if (next.continuation && col > 0) dirty.add(col - 1)
    if (prev.grapheme !== '' && !prev.continuation && prevRow[col + 1]?.continuation) {
      dirty.add(col + 1)
    }
    if (next.grapheme !== '' && !next.continuation && nextRow[col + 1]?.continuation) {
      dirty.add(col + 1)
    }
  }
  return dirty
}

function buildRuns(row: Cell[], dirty: Set<number>): Run[] {
  const runs: Run[] = []
  let col = 0
  while (col < row.length) {
    if (!dirty.has(col)) {
      col++
      continue
    }
    const cell = row[col] as Cell
    if (cell.continuation) {
      // Covered by the run that paints the wide glyph's first column.
      col++
      continue
    }
    const style = cell.style
    let text = cell.grapheme === '' ? ' ' : cell.grapheme
    let nextCol = col + 1
    while (nextCol < row.length && dirty.has(nextCol)) {
      const candidate = row[nextCol] as Cell
      if (candidate.continuation) {
        nextCol++
        continue
      }
      if (!styleEquals(candidate.style, style)) break
      text += candidate.grapheme === '' ? ' ' : candidate.grapheme
      nextCol++
    }
    runs.push({ col, text, style })
    col = nextCol
  }
  return runs
}

function encodeFull(screen: Screen): string {
  let out = '\x1b[0m\x1b[2J\x1b[H'
  for (let row = 0; row < screen.height; row++) {
    const cells = screen.rows[row] as Cell[]
    let text = ''
    let style: Style | null = null
    for (const cell of cells) {
      if (cell.continuation) continue
      if (style === null) {
        style = cell.style
      } else if (!styleEquals(style, cell.style)) {
        if (text !== '') out += sgr(style) + text
        text = ''
        style = cell.style
      }
      text += cell.grapheme === '' ? ' ' : cell.grapheme
    }
    if (text !== '') out += sgr(style ?? EMPTY_STYLE) + text
    if (row < screen.height - 1) out += '\x1b[K\r\n'
  }
  return `${out}\x1b[0m`
}

/** Terminal control sequences owned by the renderer. */
export const CONTROL = {
  enterAltScreen: '\x1b[?1049h',
  leaveAltScreen: '\x1b[?1049l',
  hideCursor: '\x1b[?25l',
  showCursor: '\x1b[?25h',
  clear: '\x1b[2J\x1b[H',
  reset: '\x1b[0m',
  enableMouse: '\x1b[?1000h\x1b[?1002h\x1b[?1006h',
  disableMouse: '\x1b[?1006l\x1b[?1002l\x1b[?1000l',
  enableBracketedPaste: '\x1b[?2004h',
  disableBracketedPaste: '\x1b[?2004l',
  enableFocusReporting: '\x1b[?1004h',
  disableFocusReporting: '\x1b[?1004l',
  // Kitty keyboard protocol: modifiers (notably Shift+Enter) become visible.
  enableKittyKeyboard: '\x1b[>1u',
  disableKittyKeyboard: '\x1b[<u',
  saveTitle: '\x1b[22;0t',
  restoreTitle: '\x1b[23;0t',
} as const

/** OSC 52 clipboard write (subject to terminal support and user opt-in). */
export function osc52(text: string): string {
  return `\x1b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\x07`
}

/** Bracketed-paste guard bytes the input parser strips. */
export const PASTE_START = '\x1b[200~'
export const PASTE_END = '\x1b[201~'
