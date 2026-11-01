import { afterEach, describe, expect, it, vi } from 'vitest'
import type { InputModel } from '../../src/app/input-model.ts'
import { type FeatureContext, NanoApp } from '../../src/app/nano-app.ts'
import { Completions } from '../../src/controls/completions.ts'
import { Features } from '../../src/controls/feature-host.ts'
import { ConversationController } from '../../src/conversation/controller.ts'
import { InputParser, type Key } from '../../src/input/parser.ts'
import { Renderer } from '../../src/render/renderer.ts'
import { darkTheme } from '../../src/theme/theme.ts'

const enter: Key = {
  name: 'enter',
  ctrl: false,
  alt: false,
  shift: false,
  meta: false,
  sequence: '\r',
}
const sessionId = (id: string) => id
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose()
})

async function makeHarness({
  fail = false,
  commands,
}: {
  fail?: boolean
  commands?: {
    find: (agent: unknown, name: string) => unknown
    execute: (...args: unknown[]) => unknown
  }
} = {}) {
  const sent: unknown[] = []
  const history: string[] = []
  const agent = {
    session: { id: 'root', deriveMessages: () => [] },
    status: 'idle',
    followup: (message: unknown) => {
      if (fail) throw new Error('delivery rejected')
      sent.push(message)
    },
  }
  const ctx = {
    get: (name: string) =>
      name === 'commands'
        ? commands
        : name === 'agentDefaultModel'
          ? { currentSelection: () => ({ provider: 'test', model: 'test' }) }
          : undefined,
    on: () => {},
    off: () => {},
    agents: { resume: async () => ({ agent }) },
  }
  const official = {
    session: { SessionId: sessionId },
    agent: { installModelSelection: () => () => {} },
    llm: { createUserMessage: (message: unknown) => message },
  }
  const store = { entries: () => [], record: (text: string) => history.push(text) }
  const conversation = new ConversationController({
    ctx: ctx as never,
    official,
    rootId: 'root',
    cwd: '/tmp',
    history: store as never,
  })
  await conversation.start()
  const renderer = new Renderer({ write: () => {}, width: 80, height: 24, defaultFg: darkTheme.fg })
  const features = new Features()
  const app = new NanoApp({
    core: { ctx, dispose: async () => {} } as never,
    official: official as never,
    terminal: { width: 80, height: 24 } as never,
    renderer,
    claim: { rootId: 'root', path: '/tmp/claim', recovered: false },
    dataRoot: '/tmp',
    cwd: '/tmp',
    rootId: 'root',
    conversation,
    history: store as never,
    writeDiagnostic: (line) => {
      throw new Error(line)
    },
    features,
  })
  const input = (app as unknown as { input: InputModel }).input
  const setNotice = vi.fn()
  const context = {
    core: { ctx },
    terminal: { width: 80, height: 24 },
    renderer,
    conversation,
    input,
    setNotice,
    requestRender: () => {},
  }
  ;(features as unknown as { context: FeatureContext }).context =
    context as unknown as FeatureContext
  cleanup.push(async () => {
    await new Promise((resolve) => setImmediate(resolve))
    await features.dispose()
    renderer.unmount()
    await conversation.dispose()
  })
  return { app, input, renderer, features, ctx, conversation, sent, history, setNotice }
}

describe('composer submission', () => {
  it('clears ordinary text from the draft and rendered composer after Enter', async () => {
    const h = await makeHarness()
    h.app.handleInput([{ type: 'paste', text: 'ordinary message' }])
    h.app.render()
    await new Promise((resolve) => setImmediate(resolve))
    h.renderer.flushFrame()
    expect(h.renderer.snapshotLines().join('\n')).toContain('ordinary message')

    h.app.handleInput([{ type: 'key', key: enter }])
    h.app.render()
    await new Promise((resolve) => setImmediate(resolve))
    h.renderer.flushFrame()

    expect(h.sent).toHaveLength(1)
    expect(h.history).toEqual(['ordinary message'])
    expect(h.input.text).toBe('')
    expect(h.input.cursor).toBe(0)
    expect(h.renderer.snapshotLines().join('\n')).toContain('输入消息')
  })

  it('clears a slash skill message after the fallback delivery succeeds', async () => {
    const h = await makeHarness()
    h.app.handleInput([{ type: 'paste', text: '/review inspect this code' }])
    h.app.handleInput([{ type: 'key', key: enter }])

    expect(h.sent).toHaveLength(1)
    expect(h.history).toEqual(['/review inspect this code'])
    expect(h.input.text).toBe('')
    expect(h.input.cursor).toBe(0)
    h.app.render()
    await new Promise((resolve) => setImmediate(resolve))
    h.renderer.flushFrame()
    expect(h.renderer.snapshotLines().join('\n')).toContain('输入消息')
  })

  it.each(['ordinary draft', '/review preserve this draft'])(
    'keeps %s when delivery fails',
    async (text) => {
      const h = await makeHarness({ fail: true })
      h.app.handleInput([{ type: 'paste', text }])
      h.app.handleInput([{ type: 'key', key: enter }])

      expect(h.sent).toHaveLength(0)
      expect(h.input.text).toBe(text)
      expect(h.input.cursor).toBe(text.length)
    },
  )

  it.each([
    { text: '/kn explain it', cursor: 3, want: '/known  explain it' },
    { text: '请用/kn 后文', cursor: 5, want: '请用/known  后文' },
    { text: '请用/kn', cursor: 5, want: '请用/known ' },
  ])('inserts $text on Enter without running it or submitting', async ({ text, cursor, want }) => {
    const execute = vi.fn()
    const h = await makeHarness({
      commands: { find: (_agent, name) => (name === 'known' ? {} : undefined), execute },
    })
    h.input.insert(text)
    h.input.cursor = cursor
    const completions = new Completions({
      ctx: h.ctx,
      input: h.input,
      getAgent: () => h.conversation.agent,
      onChange: () => {},
      writeDiagnostic: () => {},
    })
    completions.registry.register({
      id: 'test.commands',
      kind: 'command',
      complete: () => [{ label: '/known', insert: '/known ', kind: 'command' }],
    })
    ;(h.features as unknown as { completions: Completions }).completions = completions
    completions.sync()
    await vi.waitFor(() => expect(completions.session.selected?.label).toBe('/known'))

    h.app.handleInput([{ type: 'key', key: enter }])

    expect(h.input.text).toBe(want)
    expect(execute).not.toHaveBeenCalled()
    expect(h.sent).toHaveLength(0)
  })

  it.each([
    { raw: '\x1b[D\t', want: '请用/known n', cursor: 9 },
    { raw: '\x1b[D\r', want: '请用/known n', cursor: 9 },
    { raw: '\x1b[H\t', want: '请用/kn', cursor: 0 },
    { raw: '\x1b[H\r', want: '请用/kn', cursor: 0 },
  ])('does not delete prose for batched cursor/accept keys $raw', async ({ raw, want, cursor }) => {
    const execute = vi.fn()
    const h = await makeHarness({
      commands: { find: (_agent, name) => (name === 'known' ? {} : undefined), execute },
    })
    h.input.insert('请用/kn')
    const completions = new Completions({
      ctx: h.ctx,
      input: h.input,
      getAgent: () => h.conversation.agent,
      onChange: () => {},
      writeDiagnostic: () => {},
    })
    completions.registry.register({
      id: 'test.commands',
      kind: 'command',
      complete: () => [{ label: '/known', insert: '/known ', kind: 'command' }],
    })
    ;(h.features as unknown as { completions: Completions }).completions = completions
    completions.sync()
    await vi.waitFor(() => expect(completions.session.selected?.label).toBe('/known'))

    h.app.handleInput(new InputParser().feed(raw))

    expect(h.input.text).toBe(want)
    expect(h.input.cursor).toBe(cursor)
    expect(h.sent).toHaveLength(0)
    expect(execute).not.toHaveBeenCalled()
  })

  it('still runs a standalone command on Enter and clears its draft', async () => {
    const execute = vi.fn(async () => ({ result: { kind: 'success', text: 'done' } }))
    const h = await makeHarness({
      commands: { find: (_agent, name) => (name === 'known' ? {} : undefined), execute },
    })
    h.input.insert('/kn')
    const completions = new Completions({
      ctx: h.ctx,
      input: h.input,
      getAgent: () => h.conversation.agent,
      onChange: () => {},
      writeDiagnostic: () => {},
    })
    completions.registry.register({
      id: 'test.commands',
      kind: 'command',
      complete: () => [{ label: '/known', insert: '/known ', kind: 'command' }],
    })
    ;(h.features as unknown as { completions: Completions }).completions = completions
    completions.sync()
    await vi.waitFor(() => expect(completions.session.selected?.label).toBe('/known'))

    h.app.handleInput([{ type: 'key', key: enter }])
    await new Promise((resolve) => setImmediate(resolve))

    expect(execute).toHaveBeenCalledTimes(1)
    expect(execute.mock.calls[0]?.[1]).toBe('/known ')
    expect(h.sent).toHaveLength(0)
    expect(h.input.text).toBe('')
  })
})
