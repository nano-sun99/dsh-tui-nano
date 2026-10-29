/**
 * Incremental terminal input parser: keys, modified keys, kitty CSI-u
 * sequences, SGR mouse reports, bracketed paste and focus reporting. State is
 * kept across chunks so a sequence split between reads is reassembled.
 */
import { sanitizeText } from '../render/text.ts'

export type KeyName =
  | 'char'
  | 'enter'
  | 'tab'
  | 'backspace'
  | 'escape'
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'home'
  | 'end'
  | 'pageup'
  | 'pagedown'
  | 'insert'
  | 'delete'

export interface Key {
  readonly name: KeyName
  readonly text?: string
  readonly ctrl: boolean
  readonly alt: boolean
  readonly shift: boolean
  readonly meta: boolean
  /** Raw bytes, useful for diagnostics. */
  readonly sequence: string
}

export interface MouseEvent {
  readonly kind: 'press' | 'release' | 'move' | 'wheel'
  readonly button: 'left' | 'middle' | 'right' | 'none'
  /** 1-based column. */
  readonly x: number
  /** 1-based row. */
  readonly y: number
  readonly shift: boolean
  readonly alt: boolean
  readonly ctrl: boolean
  /** Positive is up the screen. */
  readonly wheel?: 1 | -1
}

export type InputEvent =
  | { readonly type: 'key'; readonly key: Key }
  | { readonly type: 'paste'; readonly text: string }
  | { readonly type: 'mouse'; readonly event: MouseEvent }
  | { readonly type: 'focus'; readonly focused: boolean }

const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'

export class InputParser {
  private pending = ''

  /** Feed one decoded chunk and return every complete event. */
  feed(chunk: string): InputEvent[] {
    this.pending += chunk
    const events: InputEvent[] = []
    while (this.pending.length > 0) {
      const consumed = this.consumeOne(events)
      if (consumed === 0) break
      this.pending = this.pending.slice(consumed)
    }
    return events
  }

  /** True when only an ambiguous prefix (e.g. a lone ESC) remains. */
  hasPending(): boolean {
    return this.pending.length > 0
  }

  /** Resolve an ambiguous lone ESC after the escape timeout. */
  flushPending(): InputEvent[] {
    if (this.pending === '\x1b') {
      this.pending = ''
      return [{ type: 'key', key: key('escape', '\x1b') }]
    }
    if (this.pending.startsWith('\x1b') && this.pending.length === 2) {
      const sequence = this.pending
      const ch = [...sequence][1] as string
      this.pending = ''
      return [{ type: 'key', key: { ...key('char', sequence), text: ch, alt: true } }]
    }
    if (this.pending.startsWith('\x1b')) {
      // An incomplete escape sequence past the timeout is dropped whole, so it
      // cannot swallow the next keystroke as its final byte.
      this.pending = ''
    }
    return []
  }

  /** Bytes still buffered; exposed for diagnostics. */
  peekPending(): string {
    return this.pending
  }

  private consumeOne(events: InputEvent[]): number {
    const text = this.pending
    if (text.startsWith(PASTE_START)) {
      const end = text.indexOf(PASTE_END, PASTE_START.length)
      if (end < 0) return 0
      const pasted = text.slice(PASTE_START.length, end)
      events.push({ type: 'paste', text: sanitizeText(pasted) })
      return end + PASTE_END.length
    }
    if (text.startsWith('\x1b[200~')) {
      // Incomplete paste start: wait for more bytes.
      return 0
    }
    if (text[0] === '\x1b') return this.consumeEscape(events)
    const code = text.charCodeAt(0)
    if (code === 0x0d) {
      events.push({ type: 'key', key: key('enter', '\r') })
      return 1
    }
    if (code === 0x0a) {
      // Ctrl+J is a newline in most terminals; Shift+Enter via kitty sends \r with shift.
      events.push({ type: 'key', key: { ...key('enter', '\n'), ctrl: true } })
      return 1
    }
    if (code === 0x09) {
      events.push({ type: 'key', key: key('tab', '\t') })
      return 1
    }
    if (code === 0x7f) {
      events.push({ type: 'key', key: key('backspace', '\x7f') })
      return 1
    }
    if (code === 0x00) {
      events.push({ type: 'key', key: { ...key('char', '\x00'), text: ' ', ctrl: true } })
      return 1
    }
    if (code > 0 && code < 0x20) {
      const letter = String.fromCharCode(code + 0x60)
      events.push({ type: 'key', key: { ...key('char', text[0] ?? ''), text: letter, ctrl: true } })
      return 1
    }
    const codePoint = text.codePointAt(0) ?? 0
    const char = String.fromCodePoint(codePoint)
    events.push({ type: 'key', key: { ...key('char', char), text: char } })
    return char.length
  }

  private consumeEscape(events: InputEvent[]): number {
    const text = this.pending
    if (text.length === 1) return 0
    const second = text[1] as string
    if (second === '[') return this.consumeCsi(events)
    if (second === 'O') return this.consumeSs3(events)
    if (second === ']') {
      // OSC response from the terminal (e.g. clipboard or title); ignore.
      const bel = text.indexOf('\x07')
      const st = text.indexOf('\x1b\\')
      const end = bel >= 0 && (st < 0 || bel < st) ? bel + 1 : st >= 0 ? st + 2 : -1
      if (end < 0) return 0
      return end
    }
    const secondCode = text.charCodeAt(1)
    if (secondCode === 0x7f) {
      events.push({ type: 'key', key: { ...key('backspace', text.slice(0, 2)), alt: true } })
      return 2
    }
    if (secondCode === 0x0d || secondCode === 0x0a) {
      events.push({ type: 'key', key: { ...key('enter', text.slice(0, 2)), alt: true } })
      return 2
    }
    // Alt + key.
    const codePoint = text.codePointAt(1) ?? 0
    const char = String.fromCodePoint(codePoint)
    events.push({
      type: 'key',
      key: { ...key('char', text.slice(0, 1) + char), text: char, alt: true },
    })
    return 1 + char.length
  }

  private consumeCsi(events: InputEvent[]): number {
    const text = this.pending
    let index = 2
    while (index < text.length) {
      const code = text.charCodeAt(index)
      if (code >= 0x40 && code <= 0x7e) break
      index++
    }
    if (index >= text.length) return 0
    const final = text[index] as string
    const body = text.slice(2, index)
    const sequence = text.slice(0, index + 1)

    if (final === 'M' || final === 'm') {
      if (body.startsWith('<')) {
        const mouse = parseSgrMouse(body.slice(1), final === 'M')
        if (mouse) events.push({ type: 'mouse', event: mouse })
        return index + 1
      }
      return index + 1
    }
    if (body === '' && final === 'I') {
      events.push({ type: 'focus', focused: true })
      return index + 1
    }
    if (body === '' && final === 'O') {
      events.push({ type: 'focus', focused: false })
      return index + 1
    }

    // Kitty keyboard protocol: CSI codepoint ; modifiers [; text] u
    if (final === 'u') {
      const parts = body.split(';')
      const codePoint = Number.parseInt(parts[0] ?? '0', 10)
      const mods = Number.parseInt(parts[1] ?? '1', 10)
      if (Number.isFinite(codePoint) && codePoint > 0) {
        const char = String.fromCodePoint(codePoint)
        const flags = parseModifierFlags(mods)
        const name = namedFromCodepoint(codePoint) ?? 'char'
        events.push({ type: 'key', key: { ...key(name, sequence), text: char, ...flags } })
        return index + 1
      }
      return index + 1
    }

    const parts = body.split(';')
    const number = Number.parseInt(parts[0] ?? '', 10)
    const mods = parts.length > 1 ? Number.parseInt(parts[1] ?? '1', 10) : 1
    const flags = parseModifierFlags(mods)
    const name = csiName(number, final)
    if (name) {
      events.push({ type: 'key', key: { ...key(name, sequence), ...flags } })
      return index + 1
    }
    return index + 1
  }

  private consumeSs3(events: InputEvent[]): number {
    const text = this.pending
    if (text.length < 3) return 0
    const final = text[2] as string
    const name =
      final === 'A'
        ? 'up'
        : final === 'B'
          ? 'down'
          : final === 'C'
            ? 'right'
            : final === 'D'
              ? 'left'
              : undefined
    if (name) {
      events.push({ type: 'key', key: key(name, text.slice(0, 3)) })
      return 3
    }
    return 3
  }
}

function key(name: KeyName, sequence: string): Key {
  return { name, ctrl: false, alt: false, shift: false, meta: false, sequence }
}

function parseModifierFlags(mods: number): Pick<Key, 'shift' | 'alt' | 'ctrl' | 'meta'> {
  const bits = Number.isFinite(mods) ? mods - 1 : 0
  return {
    shift: (bits & 1) !== 0,
    alt: (bits & 2) !== 0,
    ctrl: (bits & 4) !== 0,
    meta: (bits & 8) !== 0,
  }
}

function csiName(number: number, final: string): KeyName | undefined {
  if (final === 'A') return 'up'
  if (final === 'B') return 'down'
  if (final === 'C') return 'right'
  if (final === 'D') return 'left'
  if (final === 'H') return 'home'
  if (final === 'F') return 'end'
  if (final === 'Z') return 'tab'
  if (final === '~') {
    switch (number) {
      case 1:
      case 7:
        return 'home'
      case 2:
        return 'insert'
      case 3:
        return 'delete'
      case 4:
      case 8:
        return 'end'
      case 5:
        return 'pageup'
      case 6:
        return 'pagedown'
      default:
        return undefined
    }
  }
  return undefined
}

function namedFromCodepoint(codePoint: number): KeyName | undefined {
  switch (codePoint) {
    case 13:
      return 'enter'
    case 9:
      return 'tab'
    case 27:
      return 'escape'
    case 127:
      return 'backspace'
    default:
      return undefined
  }
}

function parseSgrMouse(body: string, pressed: boolean): MouseEvent | undefined {
  const parts = body.split(';')
  if (parts.length < 3) return undefined
  const code = Number.parseInt(parts[0] ?? '', 10)
  const x = Number.parseInt(parts[1] ?? '', 10)
  const y = Number.parseInt(parts[2] ?? '', 10)
  if (!Number.isFinite(code) || !Number.isFinite(x) || !Number.isFinite(y)) return undefined
  const shift = (code & 4) !== 0
  const alt = (code & 8) !== 0
  const ctrl = (code & 16) !== 0
  const motion = (code & 32) !== 0
  const wheelBit = (code & 64) !== 0
  const buttonBits = code & 3
  if (wheelBit) {
    return {
      kind: 'wheel',
      button: 'none',
      x,
      y,
      shift,
      alt,
      ctrl,
      wheel: buttonBits === 0 ? 1 : -1,
    }
  }
  const button =
    buttonBits === 0 ? 'left' : buttonBits === 1 ? 'middle' : buttonBits === 2 ? 'right' : 'none'
  return {
    kind: pressed ? (motion ? 'move' : 'press') : 'release',
    button,
    x,
    y,
    shift,
    alt,
    ctrl,
  }
}
