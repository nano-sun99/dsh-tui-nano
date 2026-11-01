import { describe, expect, it, vi } from 'vitest'
import { InputModel } from '../../src/app/input-model.ts'
import { Completions, detectTrigger } from '../../src/controls/completions.ts'

describe('completion edits', () => {
  it.each([
    { text: '请用/rev检查代码', cursor: 6, query: 'rev', remove: 4 },
    { text: 'hello /mo world', cursor: 9, query: 'mo', remove: 3 },
    { text: '第一行\n/mo 后文', cursor: 7, query: 'mo', remove: 3 },
    { text: '👩‍💻/ 后文', cursor: 2, query: '', remove: 1 },
  ])('detects a slash at the cursor in $text', ({ text, cursor, query, remove }) => {
    expect(detectTrigger(text, cursor)).toEqual({ kind: 'command', query, remove })
  })

  it.each([
    '请检查 https://example.com',
    '请检查 https://example.com/docs',
    '修复 src/app',
    '修复 ./src',
    '修复 ../src',
    '修复 ~/src',
    '修复 /usr/bin',
    '目录 foo-bar/baz',
    '目录 foo_bar/baz',
  ])('does not treat a URL or path as a slash command: %s', (text) => {
    expect(detectTrigger(text, [...text].length)).toBeUndefined()
  })

  it.each([
    { text: '@src/app', cursor: 8, query: 'src/app', remove: 8 },
    { text: '看看 @src/app 后文', cursor: 11, query: 'src/app', remove: 8 },
  ])('keeps file completion for $text', ({ text, cursor, query, remove }) => {
    expect(detectTrigger(text, cursor)).toEqual({ kind: 'file', query, remove })
  })

  it.each(['normal text', '/review ', '请用/review 然后检查', ''])(
    'closes completion after whitespace in %s',
    (text) => {
      expect(detectTrigger(text, [...text].length)).toBeUndefined()
    },
  )

  it('inserts an inline skill without deleting surrounding text', async () => {
    const input = new InputModel()
    input.insert('请用/rev检查代码')
    input.cursor = 6
    const completions = new Completions({
      ctx: {},
      input,
      getAgent: () => undefined,
      onChange: () => {},
      writeDiagnostic: () => {},
    })
    completions.registry.register({
      id: 'test.skills',
      kind: 'skill',
      complete: () => [{ label: '/review', insert: '/review ', kind: 'skill' }],
    })

    completions.sync()
    await vi.waitFor(() => expect(completions.open).toBe(true))
    completions.accept()

    expect(input.text).toBe('请用/review 检查代码')
    expect(input.cursor).toBe(10)
    expect(completions.open).toBe(false)
    completions.dispose()
  })

  it('does not reopen a cleared draft when an older query resolves', async () => {
    const input = new InputModel()
    input.insert('请用/kn')
    let resolveQuery!: (items: Array<{ label: string; kind: 'command' }>) => void
    const pending = new Promise<Array<{ label: string; kind: 'command' }>>((resolve) => {
      resolveQuery = resolve
    })
    const completions = new Completions({
      ctx: {},
      input,
      getAgent: () => undefined,
      onChange: () => {},
      writeDiagnostic: () => {},
    })
    completions.registry.register({
      id: 'test.pending',
      kind: 'command',
      complete: () => pending,
    })
    completions.sync()
    input.clear()
    completions.sync()
    resolveQuery([{ label: '/known', kind: 'command' }])
    await new Promise((resolve) => setImmediate(resolve))

    expect(input.text).toBe('')
    expect(completions.open).toBe(false)
    completions.dispose()
  })

  it('notifies the composer after accepting a completion', () => {
    let edits = 0
    const input = new InputModel()
    input.insert('/mo')
    const completions = new Completions({
      ctx: {},
      input,
      getAgent: () => undefined,
      onChange: () => {},
      onEdit: () => {
        edits += 1
      },
      writeDiagnostic: () => {},
    })
    const internal = completions as unknown as {
      lastTrigger: unknown
      session: { open: (...args: unknown[]) => void }
    }
    internal.lastTrigger = { kind: 'command', query: '/mo', remove: 3 }
    internal.session.open('command', '/mo', [
      { label: '/model', insert: '/model', kind: 'command' },
    ])

    completions.accept()

    expect(input.text).toBe('/model')
    expect(edits).toBe(1)
  })
})
