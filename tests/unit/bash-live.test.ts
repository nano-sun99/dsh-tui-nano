import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConversationController } from '../../src/conversation/controller.ts'

/** 官方 SessionId 牌的测试替身；放在模块级避免被 biome 当成 React 组件。 */
const sessionIdBrand = (id: string) => id

/**
 * Bash live 预览必须走真实接线：session `job/registered` → `tool/call` →
 * jobs `output` + `readAt`。只测 model API 会漏掉批次累积 / 停更 / 早到输出。
 */
function makeHarness() {
  const handlers = new Map<string, (subject: any, event: any) => void>()
  const jobs = {
    text: '',
    listener: undefined as ((event: any) => void) | undefined,
    events: {
      subscribe: (_filter: any, listener: (event: any) => void) => {
        jobs.listener = listener
        return () => {}
      },
    },
    readAt: (_jobId: string, from: number) => ({
      chunks: [{ text: jobs.text.slice(from) }],
      next: jobs.text.length,
    }),
  }
  const agent = {
    session: { id: 'root', deriveMessages: () => [] },
    status: 'idle',
    followup: vi.fn(),
    steer: vi.fn(),
    cancel: vi.fn(),
  }
  const agentCtx = {
    systemPrompt: { section: () => () => {} },
    on: () => () => {},
  }
  const ctx = {
    get: (name: string) => {
      if (name === 'jobs') return jobs
      if (name === 'agentDefaultModel')
        return { currentSelection: () => ({ provider: 'p', model: 'm' }) }
      return undefined
    },
    on: (name: string, handler: (subject: any, event: any) => void) => {
      handlers.set(name, handler)
    },
    off: () => {},
    agents: {
      resume: async () => {
        const error = new Error('not found') as Error & { name: string }
        error.name = 'SessionPersistenceNotFoundError'
        throw error
      },
      create: async (options: any) => {
        options.setup(agentCtx)
        return { agent }
      },
    },
  }
  const official = {
    session: { SessionId: sessionIdBrand },
    agent: { installModelSelection: () => () => {} },
    llm: { createUserMessage: (message: any) => message },
  }
  const controller = new ConversationController({
    ctx: ctx as any,
    official: official as any,
    rootId: 'root',
    cwd: '/tmp',
    history: { record: () => {}, entries: () => [] } as any,
  })
  const emit = (type: string, data: any) => {
    handlers.get('session/event')?.(agent.session, { type, data })
  }
  return { controller, jobs, emit }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('foreground Bash live wiring', () => {
  it('accumulates slow batches and keeps the last five lines', async () => {
    const { controller, jobs, emit } = makeHarness()
    await controller.start()
    vi.useFakeTimers()
    emit('job/registered', { jobId: 'j1', toolCall: { callId: 'c1' } })
    emit('tool/call', {
      callId: 'c1',
      name: 'bash',
      arguments: JSON.stringify({ command: 'make' }),
    })

    for (const batch of [
      'line one\n',
      'line two\n',
      'line three\nline four\n',
      'line five\n',
      'line six\n',
    ]) {
      jobs.text += batch
      jobs.listener?.({ type: 'output', id: 'j1', total: jobs.text.length })
      vi.advanceTimersByTime(130)
    }

    const entry = controller.model.toolEntryByCallId('c1')
    expect(entry?.liveOutput).toEqual([
      'line two',
      'line three',
      'line four',
      'line five',
      'line six',
    ])
  })

  it('stops updating at tool/result, including a promoted background job', async () => {
    const { controller, jobs, emit } = makeHarness()
    await controller.start()
    vi.useFakeTimers()
    emit('job/registered', { jobId: 'j1', toolCall: { callId: 'c1' } })
    emit('tool/call', {
      callId: 'c1',
      name: 'bash',
      arguments: JSON.stringify({ command: 'make' }),
    })
    jobs.text += 'first\n'
    jobs.listener?.({ type: 'output', id: 'j1', total: jobs.text.length })
    vi.advanceTimersByTime(130)

    emit('tool/result', {
      message: {
        toolCallId: 'c1',
        content: [{ type: 'text', text: 'still running; moved to background' }],
        isError: false,
      },
    })
    jobs.text += 'background continues\n'
    jobs.listener?.({ type: 'output', id: 'j1', total: jobs.text.length })
    vi.advanceTimersByTime(130)

    const entry = controller.model.toolEntryByCallId('c1')
    expect(entry?.status).toBe('ok')
    expect(entry?.liveJobId).toBeUndefined()
    expect(entry?.liveOutput).toEqual(['first'])
  })

  it('keeps output that arrives between job/registered and tool/call', async () => {
    const { controller, jobs, emit } = makeHarness()
    await controller.start()
    vi.useFakeTimers()
    emit('job/registered', { jobId: 'j1', toolCall: { callId: 'c1' } })
    jobs.text += 'early output line\n'
    jobs.listener?.({ type: 'output', id: 'j1', total: jobs.text.length })
    vi.advanceTimersByTime(130)
    expect(controller.model.toolEntryByCallId('c1')).toBeUndefined()

    emit('tool/call', {
      callId: 'c1',
      name: 'bash',
      arguments: JSON.stringify({ command: 'make' }),
    })
    const entry = controller.model.toolEntryByCallId('c1')
    expect(entry?.liveOutput).toEqual(['early output line'])
  })
})
