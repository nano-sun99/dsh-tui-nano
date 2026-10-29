import { describe, expect, it } from 'vitest'
import {
  displayWidth,
  graphemes,
  sanitizeText,
  truncateText,
  wrapText,
} from '../../src/render/text.ts'

describe('sanitizeText', () => {
  it('removes CSI, OSC (clipboard/title) and control bytes', () => {
    const input = 'a\x1b[31mb\x1b]52;c;ZGFuZ2Vy\x07c\x1b]0;title\x07d\x00e\x07f'
    expect(sanitizeText(input)).toBe('abcdef')
  })

  it('keeps newlines and tabs, normalizes CR', () => {
    expect(sanitizeText('a\r\nb\tc\rd')).toBe('a\nb\tc\nd')
  })

  it('removes C1 controls and DEL', () => {
    expect(sanitizeText('a\u009bb\u007fc')).toBe('abc')
  })
})

describe('display width', () => {
  it('counts CJK as two cells', () => {
    expect(displayWidth('中文')).toBe(4)
  })

  it('keeps ZWJ emoji sequences intact', () => {
    const family = '👨‍👩‍👧‍👦'
    expect(graphemes(`a${family}b`)).toEqual(['a', family, 'b'])
    expect(displayWidth(family)).toBe(2)
  })
})

describe('wrapText', () => {
  it('breaks Chinese text between characters', () => {
    expect(wrapText('中文测试', 4)).toEqual(['中文', '测试'])
  })

  it('prefers spaces for latin words', () => {
    expect(wrapText('alpha beta gamma', 10)).toEqual(['alpha beta', 'gamma'])
  })

  it('hard-breaks overlong words', () => {
    expect(wrapText('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij'])
  })

  it('never splits a wide grapheme at the edge', () => {
    const lines = wrapText('a中', 2)
    expect(lines).toEqual(['a', '中'])
  })
})

describe('truncateText', () => {
  it('adds an ellipsis and respects cell width', () => {
    expect(truncateText('abcdef', 4)).toBe('abc…')
    expect(displayWidth(truncateText('中文测试', 4))).toBeLessThanOrEqual(4)
  })
})
