/**
 * 运行中提交的投递时点（spec 2026-10-30-nano-main-agent-responsive A1/A3/A4）。
 *
 * 这里用最小 fake 启动 ConversationController：resume 报 NotFound，create 调 setup
 * 并返回一个可记录 followup/steer 的 agent。状态通过官方 `agent/status` 事件翻转。
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { RUNNING_HINT } from '../../src/app/App.tsx'
import { assemblePrompt } from '../../src/attachments/prompt.ts'
import { ConversationController, deliveryNotice } from '../../src/conversation/controller.ts'

const ROOT = 'root-1'
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

function makeHarness(
  status: 'idle' | 'running' = 'idle',
  options: { resumeOnly?: boolean; notFoundMessage?: string; resumedId?: string } = {},
) {
  const handlers = new Map<string, (payload: any) => void>()
  const sections: any[] = []
  const agentCtx = {
    systemPrompt: {
      section: (section: any) => {
        sections.push(section)
        return () => {}
      },
    },
    on: () => () => {},
  }
  const agent = {
    session: { id: ROOT, deriveMessages: () => [] },
    status,
    followup: vi.fn(),
    steer: vi.fn(),
    cancel: vi.fn(),
  }
  const create = vi.fn(async (createOptions: any) => {
    createOptions.setup(agentCtx)
    return { agent }
  })
  const ctx = {
    get: (name: string) =>
      name === 'agentDefaultModel'
        ? { currentSelection: () => ({ provider: 'p', model: 'm' }) }
        : undefined,
    on: (name: string, handler: (payload: any) => void) => {
      handlers.set(name, handler)
    },
    off: () => {},
    agents: {
      resume: async () => {
        if (options.resumedId !== undefined) {
          return {
            agent: {
              ...agent,
              session: { id: options.resumedId, deriveMessages: () => [] },
            },
          }
        }
        const error = new Error('not found') as Error & { name: string }
        error.name = 'SessionPersistenceNotFoundError'
        throw error
      },
      create,
    },
  }
  const official = {
    session: { SessionId: vi.fn((id: string) => id) },
    agent: { installModelSelection: () => () => {} },
    llm: { createUserMessage: vi.fn((message: any) => message) },
  }
  const history = { record: vi.fn(), entries: () => [] }
  const controller = new ConversationController({
    ctx: ctx as any,
    official: official as any,
    rootId: ROOT,
    cwd: '/tmp',
    history: history as any,
    ...options,
  })
  return { controller, agent, sections, handlers, history, official, create }
}

function setStatus(harness: ReturnType<typeof makeHarness>, status: 'idle' | 'running') {
  harness.handlers.get('agent/status')?.({ agent: harness.agent, status })
}

describe('ConversationController delivery', () => {
  it('resume-only 在 NotFound 时报错，不创建替代会话', async () => {
    const harness = makeHarness('idle', {
      resumeOnly: true,
      notFoundMessage: '当前目录没有可续接的会话。直接运行 nano 开新会话。',
    })
    await expect(harness.controller.start()).rejects.toThrow('当前目录没有可续接的会话')
    expect(harness.create).not.toHaveBeenCalled()
  })

  it('resume 返回不同 id 时硬失败，不创建替代会话', async () => {
    const harness = makeHarness('idle', { resumedId: 'other' })
    await expect(harness.controller.start()).rejects.toThrow(/根身份不一致/)
    expect(harness.create).not.toHaveBeenCalled()
  })

  it('空闲提交走 followup', async () => {
    const harness = makeHarness('idle')
    await harness.controller.start()

    const result = harness.controller.submit('hello')

    expect(result.delivery).toBe('followup')
    expect(harness.agent.followup).toHaveBeenCalledTimes(1)
    expect(harness.agent.steer).not.toHaveBeenCalled()
  })

  it('运行中提交走 steer', async () => {
    const harness = makeHarness('idle')
    await harness.controller.start()
    setStatus(harness, 'running')

    const result = harness.controller.submit('hello')

    expect(result.delivery).toBe('steer')
    expect(harness.agent.steer).toHaveBeenCalledTimes(1)
    expect(harness.agent.followup).not.toHaveBeenCalled()
  })

  it('运行中带附件提交也走 steer，且回显与历史各一次', async () => {
    const harness = makeHarness('running')
    await harness.controller.start()

    const result = harness.controller.submitContent({
      content: [{ type: 'image', mediaType: 'image/png', data: 'AAAA' }],
      displayText: '看图',
    })

    expect(result.delivery).toBe('steer')
    expect(harness.agent.steer).toHaveBeenCalledTimes(1)
    expect(harness.agent.followup).not.toHaveBeenCalled()
    expect(harness.history.record).toHaveBeenCalledTimes(1)
    expect(harness.controller.model.all.filter((entry) => entry.kind === 'user')).toHaveLength(1)
  })

  it('运行中连续两次提交都走 steer，顺序保留', async () => {
    const harness = makeHarness('idle')
    await harness.controller.start()
    setStatus(harness, 'running')

    harness.controller.submit('one')
    harness.controller.submit('two')

    expect(harness.agent.steer).toHaveBeenCalledTimes(2)
    expect(harness.agent.steer.mock.calls.map((call) => call[0].content[0].text)).toEqual([
      'one',
      'two',
    ])
  })

  it('附件经 assemblePrompt 后仍以 steer 投递', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nano-delivery-att-'))
    const file = join(dir, 'shot.png')
    writeFileSync(file, PNG)
    const attachmentCtx = {
      get: (name: string) =>
        name === 'attachments' ? { admitPromptContent: async (parts: any[]) => parts } : undefined,
    }
    const assembled = await assemblePrompt({ ctx: attachmentCtx, cwd: dir, text: `see @${file}` })
    const harness = makeHarness('running')
    await harness.controller.start()

    const result = harness.controller.submitContent(assembled)

    expect(result.delivery).toBe('steer')
    const sent = harness.agent.steer.mock.calls[0]?.[0]
    expect(sent.content).toContainEqual(
      expect.objectContaining({ type: 'image', mediaType: 'image/png' }),
    )
  })

  it('通用文件一次性回执经 assemblePrompt 后也以 steer 投递', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nano-delivery-file-'))
    const file = join(dir, 'notes.md')
    writeFileSync(file, '# hi')
    const attachmentCtx = {
      get: (name: string) =>
        name === 'attachments'
          ? {
              saveFileStream: async ({ data, name: fileName }: any) => {
                let bytes = 0
                for await (const chunk of data) bytes += chunk.byteLength
                return { attachmentId: 'file-1', name: fileName, bytes }
              },
              admitPromptContent: async (parts: any[]) => parts,
            }
          : undefined,
    }
    const assembled = await assemblePrompt({ ctx: attachmentCtx, cwd: dir, text: `read @${file}` })
    const harness = makeHarness('running')
    await harness.controller.start()

    const result = harness.controller.submitContent(assembled)

    expect(result.delivery).toBe('steer')
    const sent = harness.agent.steer.mock.calls[0]?.[0]
    expect(sent.content).toContainEqual({
      type: 'file',
      attachment: { attachmentId: 'file-1', name: 'notes.md', bytes: 4 },
    })
  })

  it('三条提交路径共用同一 notice：运行中插话、空闲清空', () => {
    expect(deliveryNotice('steer')).toBe('已插入（下一 step 或新回合生效）')
    expect(deliveryNotice('followup')).toBeUndefined()
  })

  it('运行中状态行提示 Esc 停止', () => {
    expect(RUNNING_HINT).toBe('Enter 插话 · Esc 停止')
  })

  it('投递失败时透传原错误并写 danger notice', async () => {
    const harness = makeHarness('idle')
    await harness.controller.start()
    harness.agent.followup.mockImplementation(() => {
      throw new Error('boom')
    })

    expect(() => harness.controller.submit('hello')).toThrow('boom')

    const notice = harness.controller.model.all.filter((entry) => entry.kind === 'notice').at(-1)
    expect(notice).toMatchObject({ tone: 'danger' })
    expect(notice?.kind === 'notice' ? notice.text : '').toContain('提交失败：boom')
  })

  it('组装 user message 失败时也写 danger notice', async () => {
    const harness = makeHarness('idle')
    await harness.controller.start()
    harness.official.llm.createUserMessage.mockImplementation(() => {
      throw new Error('bad content')
    })

    expect(() => harness.controller.submit('hello')).toThrow('bad content')

    const notice = harness.controller.model.all.filter((entry) => entry.kind === 'notice').at(-1)
    expect(notice).toMatchObject({ tone: 'danger' })
    expect(notice?.kind === 'notice' ? notice.text : '').toContain('提交失败：bad content')
  })

  it('在根 agent 作用域按顺序注册调研、提问与委派纪律段', async () => {
    const harness = makeHarness('idle')
    await harness.controller.start()

    expect(harness.sections).toHaveLength(3)
    expect(harness.sections[0]).toEqual({
      name: 'nano:research-discipline',
      order: 10140,
      interpolate: false,
      text: `# Research before proposing
When the user asks for a change, a feature, or a plan, map the impact surface in the repository before proposing anything. Conclusions come after reading, not before.
- Locate the change site and state its current behavior from the code, not from memory.
- Upstream: find what calls it — routes, commands, jobs, event handlers, other services.
- Downstream: find what it calls — services, tools, external APIs, queued work.
- Data: when storage is involved, read the schema, migrations, and models; name the tables, columns, indexes, and the read/write path.
- Verification: name the tests, typecheck, or commands that would prove the change works.
- Every item cites paths, and symbols or lines where they matter, that you actually read. Name anything you did not read as unread, with the reason it cannot change the conclusion.
- Never present an assumption as a finding; "I did not find it" is not "it does not exist".
- "Non-trivial" means a new feature, a behavior change, a multi-file change, an architectural choice, or unclear scope. For non-trivial work, give the map before proposing and name the trade-off you accepted when genuine alternatives exist. Do not start editing until the map is complete.
- Skip the full map only for a one-line or other small local fix, a pure fact lookup, or when the user says to start immediately; even then, read the files first.`,
    })
    expect(harness.sections[0].text).not.toContain('/plan')
    expect(harness.sections[1]).toMatchObject({
      name: 'nano:question-discipline',
      order: 10145,
      interpolate: false,
    })
    expect(harness.sections[1].text).toContain('# Bias toward action')
    expect(harness.sections[1].text).toContain(
      'Use ask_user_question only when the answer changes what gets built and cannot be derived from the code, config, or defaults.',
    )
    expect(harness.sections[2]).toMatchObject({
      name: 'nano:delegation-responsiveness',
      order: 10150,
      interpolate: false,
    })
    expect(harness.sections[2].text).toBe(
      "Delegated subagents run in the background. The runtime notifies you when one finishes; do not sleep, poll `list_agents`, or read a subagent's output file to check its progress. If you have no useful work left while they run, end your turn — the user can keep talking to you, and the completion notice will wake you in a later turn.",
    )
  })
})
