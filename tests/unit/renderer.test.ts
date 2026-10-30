import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { box, Renderer, text } from '../../src/render/renderer.ts'
import { darkTheme } from '../../src/theme/theme.ts'

function createRenderer(width = 20, height = 6) {
  const chunks: string[] = []
  const renderer = new Renderer({
    write: (bytes) => chunks.push(bytes),
    width,
    height,
    defaultFg: darkTheme.fg,
  })
  return { renderer, chunks, output: () => chunks.join('') }
}

describe('renderer', () => {
  it('paints a column of text', () => {
    const { renderer, output } = createRenderer()
    renderer.mount(box({ height: 6 }, text('hello')))
    renderer.flushFrame()
    expect(output()).toContain('hello')
    renderer.unmount()
  })

  it('wraps long text at the box width', () => {
    const { renderer, output } = createRenderer(10, 6)
    renderer.mount(box({ width: 10, height: 6, flexDirection: 'column' }, text('alpha beta gamma')))
    renderer.flushFrame()
    expect(output()).toContain('alpha beta')
    expect(output()).toContain('gamma')
    renderer.unmount()
  })

  it('places wide CJK graphemes in two cells and never splits them', () => {
    const { renderer, chunks } = createRenderer(6, 2)
    renderer.mount(box({ width: 6, height: 2, flexDirection: 'column' }, text('中文测试')))
    renderer.flushFrame()
    renderer.flushFrame()
    const first = chunks[0] as string
    expect(first).toContain('中文测')
    const lines = renderer.snapshotLines()
    expect(lines[0]).toBe('中文测')
    expect(lines[1]).toBe('试')
    renderer.unmount()
  })

  it('re-emits only changed cells on the next frame', () => {
    const { renderer, chunks } = createRenderer(12, 3)
    renderer.mount(box({ height: 3 }, text('one')))
    renderer.flushFrame()
    const firstLength = (chunks[0] as string).length
    renderer.update(box({ height: 3 }, text('two')))
    renderer.flushFrame()
    const second = chunks[1] ?? ''
    expect(second).toContain('two')
    expect(second.length).toBeLessThan(firstLength)
    renderer.unmount()
  })

  it('clears cells under an overlay so the layer is opaque to text', () => {
    const { renderer } = createRenderer(6, 2)
    renderer.mount(
      box(
        { width: 6, height: 2, flexDirection: 'column' },
        text('AAAAAA'),
        createElement('overlay', { clear: true }, text('X')),
      ),
    )
    renderer.flushFrame()
    expect(renderer.snapshotLines()[0]).toBe('X')
    renderer.unmount()
  })

  it('reports pressable regions with absolute rows', () => {
    const { renderer } = createRenderer(10, 4)
    renderer.mount(
      box(
        { flexDirection: 'column' },
        text('line one'),
        box({ onPress: 'row-2' }, text('line two')),
      ),
    )
    renderer.flushFrame()
    expect(renderer.pressIdAt(0, 1)).toBe('row-2')
    expect(renderer.pressIdAt(0, 0)).toBeUndefined()
    renderer.unmount()
  })
})

describe('selection and width', () => {
  it('extracts selected text and clamps to wide cells', () => {
    const { renderer } = createRenderer(12, 3)
    renderer.mount(box({ width: 12, height: 3, flexDirection: 'column' }, text('中文 abc')))
    renderer.flushFrame()
    const textOut = renderer.extractText({ startRow: 0, startCol: 0, endRow: 0, endCol: 8 })
    expect(textOut).toBe('中文 abc')
    renderer.unmount()
  })

  it('keeps every line inside 60 and 100 columns', () => {
    for (const width of [60, 100]) {
      const { renderer } = createRenderer(width, 20)
      renderer.mount(
        box(
          { width, height: 20, flexDirection: 'column' },
          text('一段很长的中文文本 '.repeat(20)),
          text('a'.repeat(300)),
        ),
      )
      renderer.flushFrame()
      for (const line of renderer.snapshotLines()) {
        expect(line.length).toBeLessThanOrEqual(width)
      }
      renderer.unmount()
    }
  })
})

describe('escape injection', () => {
  it('never emits smuggled terminal control sequences from content', () => {
    const { renderer, output } = createRenderer(40, 4)
    renderer.mount(
      box(
        { width: 40, height: 4, flexDirection: 'column' },
        text('safe\x1b]52;c;cGF3bmVk\x07\x1b[2Jtitle\x1b]0;evil\x07'),
      ),
    )
    renderer.flushFrame()
    const bytes = output()
    expect(bytes).toContain('safetitle')
    expect(bytes).not.toContain('cGF3bmVk')
    expect(bytes).not.toContain('evil')
    // The only clear is the renderer's own full-frame clear.
    expect(bytes.split('\x1b[2J').length - 1).toBe(1)
    renderer.unmount()
  })
})

const ESC = String.fromCharCode(27)
const CUP_END = new RegExp(`${ESC}\\[\\d+;\\d+H$`)

describe('hardware cursor parking', () => {
  it('parks the hidden cursor on a cursor-marked box', () => {
    const { renderer, output } = createRenderer(10, 3)
    renderer.mount(
      box({ flexDirection: 'row' }, text('abc'), box({ cursor: true, width: 0, height: 1 })),
    )
    renderer.flushFrame()
    expect(output().endsWith('\x1b[1;4H')).toBe(true)
    expect(output()).not.toContain('\x1b[?25h')
    renderer.unmount()
  })

  it('does not park when no box declares the cursor', () => {
    const { renderer, output } = createRenderer(10, 3)
    renderer.mount(box({ flexDirection: 'row' }, text('abc')))
    renderer.flushFrame()
    expect(CUP_END.test(output())).toBe(false)
    renderer.unmount()
  })
})
