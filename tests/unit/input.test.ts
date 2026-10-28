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
