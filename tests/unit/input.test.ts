import { describe, expect, it } from 'vitest'
import { resolveKey } from '../../src/input/keymap.ts'
import { InputParser } from '../../src/input/parser.ts'

function feedAll(chunks: string[]) {
  const parser = new InputParser()
  const events = chunks.flatMap((chunk) => parser.feed(chunk))
  return { parser, events }
}

describe('InputParser', () => {
  it('parses printable characters and enter', () => {
    const { events } = feedAll(['hi', '\r'])
    expect(events.map((event) => event.type)).toEqual(['key', 'key', 'key'])
    expect(events[0]).toMatchObject({ type: 'key', key: { name: 'char', text: 'h' } })
    expect(events[2]).toMatchObject({ type: 'key', key: { name: 'enter' } })
  })

  it('reassembles a CSI sequence split between reads', () => {
    const { events } = feedAll(['\x1b[', '1;5A'])
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'key', key: { name: 'up', ctrl: true } })
  })

  it('parses SGR mouse press and wheel', () => {
    const { events } = feedAll(['\x1b[<0;12;5M', '\x1b[<64;3;4M'])
    expect(events[0]).toMatchObject({
      type: 'mouse',
      event: { kind: 'press', button: 'left', x: 12, y: 5 },
    })
    expect(events[1]).toMatchObject({ type: 'mouse', event: { kind: 'wheel', wheel: 1 } })
  })

  it('parses bracketed paste as one sanitized event', () => {
    const { events } = feedAll(['\x1b[200~a\x1b[31mb\x1b[201~'])
    expect(events).toEqual([{ type: 'paste', text: 'ab' }])
  })

  it('waits for paste terminator across chunks', () => {
    const parser = new InputParser()
    expect(parser.feed('\x1b[200~abc')).toEqual([])
    expect(parser.feed('\x1b[201~')).toEqual([{ type: 'paste', text: 'abc' }])
  })

  it('resolves a lone escape only after the timeout flush', () => {
    const parser = new InputParser()
    expect(parser.feed('\x1b')).toEqual([])
    expect(parser.flushPending()).toEqual([
      expect.objectContaining({ type: 'key', key: expect.objectContaining({ name: 'escape' }) }),
    ])
  })

  it('parses kitty CSI-u with modifiers', () => {
    const { events } = feedAll(['\x1b[13;2u'])
    expect(events[0]).toMatchObject({ type: 'key', key: { name: 'enter', shift: true } })
  })
})

describe('numpad', () => {
  const keyOf = (events: ReturnType<InputParser['feed']>[number]) => {
    if (events.type !== 'key') throw new Error(`expected key event, got ${events.type}`)
    return events.key
  }

  it('maps SS3 application keypad digits to 0-9', () => {
    for (let digit = 0; digit < 10; digit++) {
      const sequence = `\x1bO${String.fromCharCode('p'.charCodeAt(0) + digit)}`
      const parser = new InputParser()
      const events = parser.feed(sequence)
      expect(events).toHaveLength(1)
      expect(keyOf(events[0]!)).toMatchObject({ name: 'char', text: String(digit), sequence })
      expect(parser.hasPending()).toBe(false)
    }
  })

  it('maps SS3 application keypad operators and enter', () => {
    const operators: Array<[string, string]> = [
      ['j', '*'],
      ['k', '+'],
      ['l', ','],
      ['m', '-'],
      ['n', '.'],
      ['o', '/'],
      ['X', '='],
    ]
    for (const [final, text] of operators) {
      const sequence = `\x1bO${final}`
      const parser = new InputParser()
      const events = parser.feed(sequence)
      expect(events).toHaveLength(1)
      expect(keyOf(events[0]!)).toMatchObject({ name: 'char', text, sequence })
      expect(parser.hasPending()).toBe(false)
    }
    const parser = new InputParser()
    const events = parser.feed('\x1bOM')
    expect(events).toHaveLength(1)
    expect(keyOf(events[0]!)).toMatchObject({ name: 'enter', sequence: '\x1bOM' })
    expect(parser.hasPending()).toBe(false)
  })

  it('still maps SS3 arrows', () => {
    const { events } = feedAll(['\x1bOA', '\x1bOB', '\x1bOC', '\x1bOD'])
    expect(events.map((event) => (event.type === 'key' ? event.key.name : event.type))).toEqual([
      'up',
      'down',
      'right',
      'left',
    ])
  })

  it('drops unknown SS3 sequences without text', () => {
    const parser = new InputParser()
    expect(parser.feed('\x1bOT')).toEqual([])
    expect(parser.hasPending()).toBe(false)
  })

  it('maps kitty KP_0..KP_9 to digits', () => {
    for (let digit = 0; digit < 10; digit++) {
      const codePoint = 57399 + digit
      const sequence = `\x1b[${codePoint}u`
      const parser = new InputParser()
      const events = parser.feed(sequence)
      expect(events).toHaveLength(1)
      expect(keyOf(events[0]!)).toMatchObject({ name: 'char', text: String(digit), sequence })
      expect(parser.hasPending()).toBe(false)
    }
  })

  it('maps kitty KP_DECIMAL..KP_SEPARATOR to text', () => {
    const cases: Array<[number, string]> = [
      [57409, '.'],
      [57410, '/'],
      [57411, '*'],
      [57412, '-'],
      [57413, '+'],
      [57415, '='],
      [57416, ','],
    ]
    for (const [codePoint, text] of cases) {
      const sequence = `\x1b[${codePoint}u`
      const parser = new InputParser()
      const events = parser.feed(sequence)
      expect(events).toHaveLength(1)
      expect(keyOf(events[0]!)).toMatchObject({ name: 'char', text, sequence })
      expect(parser.hasPending()).toBe(false)
    }
  })

  it('maps kitty KP_ENTER to enter', () => {
    const parser = new InputParser()
    const events = parser.feed('\x1b[57414u')
    expect(events).toHaveLength(1)
    expect(keyOf(events[0]!)).toMatchObject({
      name: 'enter',
      text: '\r',
      sequence: '\x1b[57414u',
    })
    expect(parser.hasPending()).toBe(false)
  })

  it('maps kitty KP navigation keys', () => {
    const cases: Array<[number, string]> = [
      [57417, 'left'],
      [57418, 'right'],
      [57419, 'up'],
      [57420, 'down'],
      [57421, 'pageup'],
      [57422, 'pagedown'],
      [57423, 'home'],
      [57424, 'end'],
      [57425, 'insert'],
      [57426, 'delete'],
    ]
    for (const [codePoint, name] of cases) {
      const parser = new InputParser()
      const events = parser.feed(`\x1b[${codePoint}u`)
      expect(events).toHaveLength(1)
      expect(keyOf(events[0]!)).toMatchObject({ name })
      expect(parser.hasPending()).toBe(false)
    }
  })

  it('ignores KP_BEGIN without inserting 5', () => {
    const parser = new InputParser()
    expect(parser.feed('\x1b[57427u')).toEqual([])
    expect(parser.hasPending()).toBe(false)
  })

  it('keeps shift, alt, ctrl and meta on numpad keys', () => {
    const cases: Array<[number, string]> = [
      [2, 'shift'],
      [3, 'alt'],
      [5, 'ctrl'],
      [9, 'meta'],
    ]
    for (const [mods, flag] of cases) {
      const parser = new InputParser()
      const events = parser.feed(`\x1b[57400;${mods}u`)
      expect(events).toHaveLength(1)
      expect(keyOf(events[0]!)).toMatchObject({
        name: 'char',
        text: '1',
        shift: flag === 'shift',
        alt: flag === 'alt',
        ctrl: flag === 'ctrl',
        meta: flag === 'meta',
      })
      expect(parser.hasPending()).toBe(false)
    }
  })

  it('does not add hyper or super flags', () => {
    const parser = new InputParser()
    const events = parser.feed('\x1b[57400;17u')
    expect(events).toHaveLength(1)
    expect(keyOf(events[0]!)).toMatchObject({
      name: 'char',
      text: '1',
      shift: false,
      alt: false,
      ctrl: false,
      meta: false,
    })
  })

  it('drops unknown keypad and functional CSI-u instead of inserting private-use text', () => {
    for (const codePoint of [57428, 57364, 57452]) {
      const parser = new InputParser()
      expect(parser.feed(`\x1b[${codePoint}u`)).toEqual([])
      expect(parser.hasPending()).toBe(false)
    }
  })

  it('leaves non-kitty CSI-u keys unchanged', () => {
    const { events } = feedAll(['\x1b[13;2u', '\x1b[9u', '\x1b[27u'])
    expect(events).toHaveLength(3)
    expect(keyOf(events[0]!)).toMatchObject({ name: 'enter', text: '\r', shift: true })
    expect(keyOf(events[1]!)).toMatchObject({ name: 'tab', text: '\t' })
    expect(keyOf(events[2]!)).toMatchObject({ name: 'escape', text: '\x1b' })
  })

  it('reassembles split SS3 numpad sequences', () => {
    const parser = new InputParser()
    expect(parser.feed('\x1bO')).toEqual([])
    const events = parser.feed('p')
    expect(events).toHaveLength(1)
    expect(keyOf(events[0]!)).toMatchObject({ name: 'char', text: '0', sequence: '\x1bOp' })
    expect(parser.hasPending()).toBe(false)
  })

  it('reassembles split kitty numpad sequences', () => {
    const parser = new InputParser()
    expect(parser.feed('\x1b[574')).toEqual([])
    const events = parser.feed('00;2u')
    expect(events).toHaveLength(1)
    expect(keyOf(events[0]!)).toMatchObject({
      name: 'char',
      text: '1',
      shift: true,
      sequence: '\x1b[57400;2u',
    })
    expect(parser.hasPending()).toBe(false)
  })

  it('reassembles split KP_BEGIN and still ignores it', () => {
    const parser = new InputParser()
    expect(parser.feed('\x1b[57427')).toEqual([])
    expect(parser.feed('u')).toEqual([])
    expect(parser.hasPending()).toBe(false)
  })

  it('keeps legacy NumLock-off navigation bytes as navigation', () => {
    const { events } = feedAll(['\x1b[A', '\x1b[3~'])
    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({ type: 'key', key: { name: 'up' } })
    expect(events[1]).toMatchObject({ type: 'key', key: { name: 'delete' } })
  })
})

describe('keymap', () => {
  const key = (name: any, extra: any = {}) => ({
    name,
    text: extra.text,
    ctrl: extra.ctrl ?? false,
    alt: extra.alt ?? false,
    shift: extra.shift ?? false,
    meta: false,
    sequence: '',
  })

  it('maps enter to submit in the input scope', () => {
    expect(resolveKey(key('enter'), ['input', 'idle'])).toBe('conversation.submit')
  })

  it('maps ctrl+c to cancel while running and to exit while idle', () => {
    expect(resolveKey(key('char', { text: 'c', ctrl: true }), ['input', 'running'])).toBe(
      'conversation.cancel',
    )
    expect(resolveKey(key('char', { text: 'c', ctrl: true }), ['input', 'idle'])).toBe('app.exit')
  })

  it('maps shift+enter to newline', () => {
    expect(resolveKey(key('enter', { shift: true }), ['input', 'idle'])).toBe('input.newline')
  })
})
