import { describe, expect, it } from 'vitest'
import { SceneRegistry } from '../../src/app/scenes.ts'
import { CompletionRegistry, CompletionSession } from '../../src/input/completion.ts'
import { DraftStore } from '../../src/input/drafts.ts'
import { InputSegments } from '../../src/input/segments.ts'
import { CellGrid } from '../../src/render/grid.ts'

describe('CellGrid / VT', () => {
  it('writes text, wraps and scrolls', () => {
    const grid = new CellGrid(5, 2)
    grid.feed('helloworld')
    expect(grid.text()[0]).toBe('hello')
    expect(grid.text()[1]).toBe('world')
  })

  it('applies SGR colours and cursor moves', () => {
    const grid = new CellGrid(10, 3)
    grid.feed('\x1b[31mred\x1b[0m')
    expect(grid.rows[0]?.[0]?.style.fg).toEqual([205, 49, 49])
    grid.feed('\x1b[2;3Hok')
    expect(grid.text()[1]).toBe('  ok')
  })

  it('erases lines and scrolls history', () => {
    const grid = new CellGrid(4, 2)
    grid.feed('aa\r\nbb\r\ncc')
    expect(grid.historyRows().length).toBe(1)
    grid.feed('\x1b[2J')
    expect(grid.text().join('').trim()).toBe('')
  })

  it('resizes without losing the visible corner', () => {
    const grid = new CellGrid(4, 2)
    grid.feed('abcd\r\nefgh')
    grid.resize(2, 1)
    expect(grid.text()[0]).toBe('ab')
  })
})

describe('input segments', () => {
  it('keeps order across text and attachments and enforces the limit', () => {
    const segments = new InputSegments()
    segments.pushText('a')
    segments.pushAttachment('image.png')
    segments.pushText('b')
    expect(segments.orderedText()).toBe('ab')
    expect(segments.attachments()).toHaveLength(1)
    segments.move(segments.segments[2]!.id, 0)
    expect(segments.segments.map((segment) => segment.kind)).toEqual(['text', 'text', 'attachment'])
    expect(segments.exceedsLimit(1)).toBe(true)
  })
})

describe('completion', () => {
  it('queries providers and accepts without submitting', async () => {
    const registry = new CompletionRegistry()
    registry.register({
      id: 'files',
      kind: 'file',
      complete: () => [{ label: 'a.ts', kind: 'file' }],
    })
    const { items, failures } = await registry.query('file', 'a')
    expect(items).toHaveLength(1)
    expect(failures).toHaveLength(0)
    const session = new CompletionSession()
    session.open('file', 'a', items)
    expect(session.isOpen).toBe(true)
    expect(session.accept()).toBe('a.ts')
    expect(session.isOpen).toBe(false)
  })

  it('reports provider failures instead of swallowing them', async () => {
    const registry = new CompletionRegistry()
    registry.register({ id: 'bad', kind: 'skill', complete: () => Promise.reject(new Error('x')) })
    const { failures } = await registry.query('skill', '')
    expect(failures).toHaveLength(1)
  })
})

describe('drafts and scenes', () => {
  it('keys drafts by root and subagent address', () => {
    const store = new DraftStore()
    store.save({ root: 'r', subagent: 's1' }, { text: 'a', cursor: 1, scrollAnchor: 0 })
    store.save({ root: 'r' }, { text: 'b', cursor: 1, scrollAnchor: 2 })
    expect(store.get({ root: 'r', subagent: 's1' })?.text).toBe('a')
    expect(store.get({ root: 'r' })?.text).toBe('b')
    expect(store.size).toBe(2)
  })

  it('focuses scenes and escapes only closable ones', () => {
    const scenes = new SceneRegistry()
    scenes.register({ id: 'pane', kind: 'pane', closable: true })
    expect(scenes.active.id).toBe('pane')
    expect(scenes.escape()).toBe('pane')
    expect(scenes.active.id).toBe('main')
    expect(scenes.escape()).toBeUndefined()
  })
})
