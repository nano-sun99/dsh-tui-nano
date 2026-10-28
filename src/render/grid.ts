/**
 * Cell grid + VT parser for embedded terminals (D01). S02 feeds PTY output
 * here and renders the grid with the `<Grid>` component; the main renderer
 * stays the only writer to the tty.
 */

import type { Rgb } from '../theme/theme.ts'
import { BLANK, type Cell, type Style } from './ansi.ts'
import { sanitizeText } from './text.ts'

const ANSI_PALETTE: Rgb[] = [
  [0, 0, 0],
  [205, 49, 49],
  [13, 188, 121],
  [229, 229, 16],
  [36, 114, 200],
  [188, 63, 188],
  [17, 168, 205],
  [229, 229, 229],
  [102, 102, 102],
  [241, 76, 76],
  [35, 209, 139],
  [245, 245, 67],
  [59, 142, 234],
  [214, 112, 214],
  [41, 184, 219],
  [255, 255, 255],
]

export interface GridOptions {
  readonly scrollback?: number
}

export class CellGrid {
  width: number
  height: number
  rows: Cell[][]
  cursorRow = 0
  cursorCol = 0
  private savedCursor = { row: 0, col: 0 }
  private style: Style = {}
  private scrollTop = 0
  private scrollBottom: number
  private pendingWrap = false
  private parserState: 'text' | 'esc' | 'csi' | 'osc' = 'text'
  private csi = ''
  private osc = ''
  readonly scrollback: number
  private history: Cell[][] = []

  constructor(width: number, height: number, options: GridOptions = {}) {
    this.width = Math.max(1, width)
    this.height = Math.max(1, height)
    this.scrollBottom = this.height - 1
    this.scrollback = options.scrollback ?? 1000
    this.rows = blankRows(this.width, this.height)
  }

  resize(width: number, height: number): void {
    const next = blankRows(Math.max(1, width), Math.max(1, height))
    for (let row = 0; row < Math.min(height, this.rows.length); row++) {
      for (let col = 0; col < Math.min(width, this.rows[row]?.length ?? 0); col++) {
        const cell = this.rows[row]?.[col]
        if (cell && next[row]) next[row]![col] = cell
      }
    }
    this.width = Math.max(1, width)
    this.height = Math.max(1, height)
    this.rows = next
    this.scrollBottom = this.height - 1
    this.cursorRow = Math.min(this.cursorRow, this.height - 1)
    this.cursorCol = Math.min(this.cursorCol, this.width - 1)
  }

  /** Feed raw PTY bytes. Escape sequences are interpreted, not shown. */
  feed(data: string): void {
    for (const char of data) {
      const code = char.charCodeAt(0)
      switch (this.parserState) {
        case 'text':
          if (code === 0x1b) this.parserState = 'esc'
          else this.writeChar(char)
          break
        case 'esc':
          if (char === '[') {
            this.parserState = 'csi'
            this.csi = ''
          } else if (char === ']') {
            this.parserState = 'osc'
            this.osc = ''
          } else {
            this.parserState = 'text'
          }
          break
        case 'csi': {
          if (code >= 0x40 && code <= 0x7e) {
            this.applyCsi(this.csi, char)
            this.parserState = 'text'
          } else {
            this.csi += char
          }
          break
        }
        case 'osc':
          if (code === 0x07) this.parserState = 'text'
          else if (code === 0x1b) this.parserState = 'text'
          else this.osc += char
          break
      }
    }
  }

  private writeChar(char: string): void {
    if (char === '\r') {
      this.cursorCol = 0
      this.pendingWrap = false
      return
    }
    if (char === '\n') {
      this.lineFeed()
      return
    }
    if (char === '\b') {
      if (this.cursorCol > 0) this.cursorCol--
      this.pendingWrap = false
      return
    }
    if (char === '\t') {
      const next = Math.min(this.width - 1, (Math.floor(this.cursorCol / 8) + 1) * 8)
      this.cursorCol = next
      return
    }
    if (char.charCodeAt(0) < 0x20) return
    if (this.pendingWrap) {
      this.cursorCol = 0
      this.lineFeed()
      this.pendingWrap = false
    }
    const safe = sanitizeText(char)
    if (safe === '') return
    const row = this.rows[this.cursorRow]
    if (!row) return
    row[this.cursorCol] = { grapheme: safe, style: this.style }
    if (safe.length > 1 || this.cursorCol + 1 >= this.width) {
      // Wide grapheme or last column: occupy one cell for VT simplicity.
      if (this.cursorCol + 1 >= this.width) this.pendingWrap = true
      else this.cursorCol++
    } else {
      this.cursorCol++
    }
  }

  private lineFeed(): void {
    if (this.cursorRow === this.scrollBottom) {
      this.scrollUp(1)
    } else if (this.cursorRow < this.height - 1) {
      this.cursorRow++
    }
    this.pendingWrap = false
  }

  private scrollUp(lines: number): void {
    for (let i = 0; i < lines; i++) {
      const removed = this.rows.splice(this.scrollTop, 1)[0]
      if (removed) {
        this.history.push(removed)
        if (this.history.length > this.scrollback) this.history.shift()
      }
      this.rows.splice(this.scrollBottom, 0, blankRow(this.width))
    }
  }

  private scrollDown(lines: number): void {
    for (let i = 0; i < lines; i++) {
      this.rows.splice(this.scrollBottom, 1)
      this.rows.splice(this.scrollTop, 0, blankRow(this.width))
    }
  }

  private applyCsi(params: string, final: string): void {
    const numbers = params
      .replace(/^[?<>=]/u, '')
      .split(';')
      .map((part) => (part === '' ? Number.NaN : Number.parseInt(part, 10)))
    const first = Number.isNaN(numbers[0] ?? Number.NaN) ? 1 : (numbers[0] as number)
    switch (final) {
      case 'A':
        this.cursorRow = Math.max(this.scrollTop, this.cursorRow - first)
        break
      case 'B':
        this.cursorRow = Math.min(this.scrollBottom, this.cursorRow + first)
        break
      case 'C':
        this.cursorCol = Math.min(this.width - 1, this.cursorCol + first)
        break
      case 'D':
        this.cursorCol = Math.max(0, this.cursorCol - first)
        break
      case 'E':
        this.cursorRow = Math.min(this.scrollBottom, this.cursorRow + first)
        this.cursorCol = 0
        break
      case 'F':
        this.cursorRow = Math.max(this.scrollTop, this.cursorRow - first)
        this.cursorCol = 0
        break
      case 'G':
        this.cursorCol = clamp(first - 1, 0, this.width - 1)
        break
      case 'H':
      case 'f': {
        const row = Number.isNaN(numbers[0] ?? Number.NaN) ? 1 : first
        const col = Number.isNaN(numbers[1] ?? Number.NaN) ? 1 : (numbers[1] as number)
        this.cursorRow = clamp(row - 1, 0, this.height - 1)
        this.cursorCol = clamp(col - 1, 0, this.width - 1)
        break
      }
      case 'J':
        this.eraseDisplay(first)
        break
      case 'K':
        this.eraseLine(first)
        break
      case 'm':
        this.applySgr(numbers)
        break
      case 'r': {
        const top = Number.isNaN(numbers[0] ?? Number.NaN) ? 1 : first
        const bottom = Number.isNaN(numbers[1] ?? Number.NaN) ? this.height : (numbers[1] as number)
        this.scrollTop = clamp(top - 1, 0, this.height - 1)
        this.scrollBottom = clamp(bottom - 1, this.scrollTop, this.height - 1)
        this.cursorRow = this.scrollTop
        this.cursorCol = 0
        break
      }
      case 's':
        this.savedCursor = { row: this.cursorRow, col: this.cursorCol }
        break
      case 'u':
        this.cursorRow = this.savedCursor.row
        this.cursorCol = this.savedCursor.col
        break
      case 'S':
        this.scrollUp(first)
        break
      case 'T':
        this.scrollDown(first)
        break
      case 'L':
        this.rows.splice(this.cursorRow, 0, blankRow(this.width))
        this.rows.splice(this.scrollBottom + 1, 1)
        break
      case 'M':
        this.rows.splice(this.cursorRow, 1)
        this.rows.splice(this.scrollBottom, 0, blankRow(this.width))
        break
      default:
        break
    }
  }

  private eraseDisplay(mode: number): void {
    if (mode === 2 || mode === 3) {
      this.rows = blankRows(this.width, this.height)
      return
    }
    if (mode === 1) {
      for (let row = 0; row <= this.cursorRow; row++) {
        for (let col = 0; col < this.width; col++) {
          if (row === this.cursorRow && col > this.cursorCol) break
          this.rows[row]![col] = BLANK
        }
      }
      return
    }
    this.eraseLine(0)
    for (let row = this.cursorRow + 1; row < this.height; row++) {
      this.rows[row] = blankRow(this.width)
    }
  }

  private eraseLine(mode: number): void {
    const row = this.rows[this.cursorRow]
    if (!row) return
    if (mode === 2) {
      this.rows[this.cursorRow] = blankRow(this.width)
      return
    }
    if (mode === 1) {
      for (let col = 0; col <= this.cursorCol; col++) row[col] = BLANK
      return
    }
    for (let col = this.cursorCol; col < this.width; col++) row[col] = BLANK
  }

  private applySgr(numbers: number[]): void {
    let style: Style = { ...this.style }
    for (let i = 0; i < numbers.length; i++) {
      const code = numbers[i] as number
      if (Number.isNaN(code)) continue
      switch (code) {
        case 0:
          style = {}
          break
        case 1:
          style = { ...style, bold: true }
          break
        case 2:
          style = { ...style, dim: true }
          break
        case 3:
          style = { ...style, italic: true }
          break
        case 4:
          style = { ...style, underline: true }
          break
        case 7:
          style = { ...style, reverse: true }
          break
        case 9:
          style = { ...style, strikethrough: true }
          break
        case 22:
          style = { ...style, bold: false, dim: false }
          break
        case 23:
          style = { ...style, italic: false }
          break
        case 24:
          style = { ...style, underline: false }
          break
        case 27:
          style = { ...style, reverse: false }
          break
        case 29:
          style = { ...style, strikethrough: false }
          break
        case 39:
          style = { ...style, fg: undefined }
          break
        case 49:
          style = { ...style, bg: undefined }
          break
        case 38: {
          const parsed = readColor(numbers, i + 1)
          if (parsed) {
            style = { ...style, fg: parsed.color }
            i = parsed.next - 1
          }
          break
        }
        case 48: {
          const parsed = readColor(numbers, i + 1)
          if (parsed) {
            style = { ...style, bg: parsed.color }
            i = parsed.next - 1
          }
          break
        }
        default:
          if (code >= 30 && code <= 37) style = { ...style, fg: ANSI_PALETTE[code - 30] }
          else if (code >= 90 && code <= 97) style = { ...style, fg: ANSI_PALETTE[code - 90 + 8] }
          else if (code >= 40 && code <= 47) style = { ...style, bg: ANSI_PALETTE[code - 40] }
          else if (code >= 100 && code <= 107)
            style = { ...style, bg: ANSI_PALETTE[code - 100 + 8] }
          break
      }
    }
    this.style = style
  }

  /** Plain text of every row (ESC already stripped). */
  text(): string[] {
    return this.rows.map((row) =>
      row
        .map((cell) => (cell.continuation ? '' : cell.grapheme === '' ? ' ' : cell.grapheme))
        .join('')
        .replace(/ +$/u, ''),
    )
  }

  snapshot(): Cell[][] {
    return this.rows.map((row) => row.slice())
  }

  historyRows(): Cell[][] {
    return this.history.slice()
  }

  get cursor(): { row: number; col: number } {
    return { row: this.cursorRow, col: this.cursorCol }
  }
}

function blankRow(width: number): Cell[] {
  return new Array(width).fill(BLANK)
}

function blankRows(width: number, height: number): Cell[][] {
  return Array.from({ length: height }, () => blankRow(width))
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function readColor(numbers: number[], start: number): { color: Rgb; next: number } | undefined {
  const mode = numbers[start]
  if (mode === 5) {
    const index = numbers[start + 1]
    if (index === undefined || Number.isNaN(index)) return undefined
    return { color: ANSI_PALETTE[index % 16] ?? [200, 200, 200], next: start + 2 }
  }
  if (mode === 2) {
    const r = numbers[start + 1]
    const g = numbers[start + 2]
    const b = numbers[start + 3]
    if (r === undefined || g === undefined || b === undefined) return undefined
    if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return undefined
    return { color: [r, g, b], next: start + 4 }
  }
  return undefined
}
