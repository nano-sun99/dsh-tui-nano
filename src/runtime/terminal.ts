/**
 * Terminal ownership: alternate screen, raw mode, mouse/bracketed-paste/focus
 * modes, resize and the single write path. The process keeps the tty on an
 * independent fd (`/dev/tty`) because fd 1/2 are redirected to a log by the
 * fd guard; all frames are written here and nowhere else.
 */

import { execFileSync } from 'node:child_process'
import { closeSync, openSync, writeSync } from 'node:fs'
import { StringDecoder } from 'node:string_decoder'
import { type InputEvent, InputParser } from '../input/parser.ts'
import {
  ACTIVITY_QUERY_ID,
  type ActivityGraphics,
  activityQuery,
  deleteActivityImage,
} from '../render/activity-image.ts'
import { CONTROL, osc52 } from '../render/ansi.ts'

export interface TerminalOptions {
  readonly onInput: (events: InputEvent[]) => void
  readonly onResize: (width: number, height: number) => void
  readonly onError: (error: unknown) => void
}

export class Terminal {
  private fd: number | undefined
  private parser = new InputParser()
  private decoder = new StringDecoder('utf8')
  private escapeTimer: NodeJS.Timeout | undefined
  private active = false
  private readonly options: TerminalOptions
  private inputHandler: ((chunk: Buffer) => void) | undefined
  private resizeHandler: (() => void) | undefined
  private graphicsTimer: NodeJS.Timeout | undefined
  private graphicsConfirmed = false
  private graphicsPending = false
  private pendingCell: ActivityGraphics | undefined
  activityGraphics: ActivityGraphics | undefined
  width = 80
  height = 24

  constructor(options: TerminalOptions) {
    this.options = options
  }

  get isTTY(): boolean {
    return process.stdin.isTTY === true
  }

  /** Take ownership: alternate screen, raw mode and input piping. */
  enter(): void {
    if (this.active) return
    this.fd = openSync('/dev/tty', 'r+')
    this.refreshSize()
    process.stdin.setRawMode?.(true)
    process.stdin.resume()
    this.inputHandler = (chunk: Buffer) => this.handleChunk(this.decoder.write(chunk))
    process.stdin.on('data', this.inputHandler)
    this.resizeHandler = () => {
      this.activityGraphics = undefined
      this.refreshSize()
      this.probeGraphics()
      this.options.onResize(this.width, this.height)
    }
    process.on('SIGWINCH', this.resizeHandler)
    this.write(
      CONTROL.enterAltScreen +
        CONTROL.hideCursor +
        CONTROL.enableMouse +
        CONTROL.enableBracketedPaste +
        CONTROL.enableFocusReporting +
        CONTROL.enableKittyKeyboard +
        CONTROL.clear,
    )
    this.active = true
    this.probeGraphics()
  }

  /** Idempotent recovery; safe to call from a signal handler or finally block. */
  restore(): void {
    if (!this.active) return
    this.active = false
    if (this.graphicsTimer) clearTimeout(this.graphicsTimer)
    this.graphicsTimer = undefined
    this.graphicsPending = false
    this.activityGraphics = undefined
    try {
      this.write(
        (this.graphicsConfirmed ? deleteActivityImage() : '') +
          CONTROL.disableKittyKeyboard +
          CONTROL.disableFocusReporting +
          CONTROL.disableBracketedPaste +
          CONTROL.disableMouse +
          CONTROL.showCursor +
          CONTROL.leaveAltScreen,
      )
    } catch {
      // The tty may already be gone; still release local state below.
    }
    try {
      process.stdin.setRawMode?.(false)
      process.stdin.pause()
    } catch {
      // ignore
    }
    if (this.inputHandler) process.stdin.off('data', this.inputHandler)
    if (this.resizeHandler) process.off('SIGWINCH', this.resizeHandler)
    this.inputHandler = undefined
    this.resizeHandler = undefined
    if (this.escapeTimer) clearTimeout(this.escapeTimer)
    this.escapeTimer = undefined
    if (this.fd !== undefined) {
      try {
        closeSync(this.fd)
      } catch {
        // ignore
      }
      this.fd = undefined
    }
  }

  /** Single writer. Large frames are chunked to keep writeSync bounded. */
  write(bytes: string): void {
    if (this.fd === undefined) return
    const buffer = Buffer.from(bytes, 'utf8')
    let offset = 0
    while (offset < buffer.length) {
      offset += writeSync(this.fd, buffer, offset, Math.min(65536, buffer.length - offset))
    }
  }

  /** Copy through OSC 52 and, on macOS, pbcopy for maximal compatibility. */
  copyToClipboard(text: string): void {
    if (text === '') return
    try {
      this.write(osc52(text))
    } catch {
      // OSC 52 is best effort; pbcopy below is the fallback.
    }
    try {
      execFileSync('pbcopy', [], {
        input: text,
        stdio: ['pipe', 'ignore', 'ignore'],
        timeout: 1000,
      })
    } catch {
      // Non-macOS or no pbcopy: OSC 52 already ran.
    }
  }

  refreshSize(): void {
    const size = readTerminalSize()
    if (size) {
      this.width = size.width
      this.height = size.height
    }
  }

  private probeGraphics(): void {
    if (
      !this.active ||
      !this.isTTY ||
      process.env.TERM_PROGRAM !== 'ghostty' ||
      process.env.TMUX ||
      process.env.STY ||
      process.env.SSH_TTY ||
      process.env.SSH_CONNECTION
    )
      return
    this.pendingCell = undefined
    this.graphicsPending = true
    this.graphicsConfirmed = false
    if (this.graphicsTimer) clearTimeout(this.graphicsTimer)
    this.graphicsTimer = setTimeout(() => {
      this.graphicsPending = false
      this.graphicsTimer = undefined
      if (this.parser.hasPending()) this.handleChunk('')
    }, 400)
    this.write(activityQuery())
  }

  private graphicsResponse(sequence: string): void {
    if (!this.graphicsPending) return
    if (sequence.startsWith(`${String.fromCharCode(27)}_Gi=${ACTIVITY_QUERY_ID};OK`))
      this.graphicsConfirmed = true
    const cell = /^6;(\d+);(\d+)t$/u.exec(sequence.startsWith('\x1b[') ? sequence.slice(2) : '')
    if (cell) {
      const cellHeight = Number(cell[1])
      const cellWidth = Number(cell[2])
      if (cellHeight > 0 && cellHeight <= 512 && cellWidth > 0 && cellWidth <= 256) {
        this.pendingCell = { cellWidth, cellHeight }
      }
    }
    if (this.graphicsConfirmed && this.pendingCell) {
      this.activityGraphics = this.pendingCell
      this.pendingCell = undefined
      this.graphicsPending = false
      if (this.graphicsTimer) clearTimeout(this.graphicsTimer)
      this.graphicsTimer = undefined
      this.options.onResize(this.width, this.height)
      if (this.parser.hasPending()) this.scheduleEscapeFlush()
    }
  }

  private scheduleEscapeFlush(): void {
    if (this.escapeTimer) clearTimeout(this.escapeTimer)
    this.escapeTimer = setTimeout(() => {
      this.escapeTimer = undefined
      const flushed = this.parser.flushPending(this.graphicsPending)
      if (flushed.length > 0) this.options.onInput(flushed)
    }, 30)
  }

  private handleChunk(text: string): void {
    let events: InputEvent[] = []
    try {
      events = this.parser.feed(text, this.graphicsPending || this.activityGraphics !== undefined)
    } catch (error) {
      this.options.onError(error)
      return
    }
    const input = events.filter((event) => {
      if (event.type !== 'terminal-response') return true
      this.graphicsResponse(event.sequence)
      return false
    })
    if (input.length > 0) this.options.onInput(input)
    if (this.parser.hasPending()) this.scheduleEscapeFlush()
  }
}

/** Query the terminal size without relying on stdio being a tty. */
export function readTerminalSize(): { width: number; height: number } | undefined {
  try {
    const output = execFileSync('stty', ['size'], {
      stdio: ['inherit', 'pipe', 'ignore'],
      encoding: 'utf8',
      timeout: 1000,
    }).trim()
    const [rowsText, colsText] = output.split(/\s+/)
    const rows = Number.parseInt(rowsText ?? '', 10)
    const cols = Number.parseInt(colsText ?? '', 10)
    if (Number.isFinite(cols) && Number.isFinite(rows) && cols > 0 && rows > 0) {
      return { width: cols, height: rows }
    }
  } catch {
    // fall through to environment defaults
  }
  const envCols = Number.parseInt(process.env.COLUMNS ?? '', 10)
  const envRows = Number.parseInt(process.env.LINES ?? '', 10)
  if (Number.isFinite(envCols) && Number.isFinite(envRows) && envCols > 0 && envRows > 0) {
    return { width: envCols, height: envRows }
  }
  return undefined
}
