import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  compactFailureText,
  compactSuccessText,
  Features,
} from '../../src/controls/feature-host.ts'

afterEach(() => {
  vi.restoreAllMocks()
})

function fakeContext(status: 'idle' | 'running', execute: ReturnType<typeof vi.fn>) {
  const notices: Array<{ text: string; tone: string }> = []
  return {
    notices,
    context: {
      conversation: {
        status,
        agent: { id: 'agent' },
        model: {
          appendNotice: (text: string, tone: string) => notices.push({ text, tone }),
        },
      },
      core: { ctx: { get: () => ({ execute }) } },
      input: { take: vi.fn() },
      requestRender: vi.fn(),
    } as never,
  }
}

const flush = () => new Promise((resolve) => setImmediate(resolve))

describe('compact result mapping', () => {
  it('maps stable failures to Chinese causes', () => {
    expect(compactFailureText('Compaction cancelled.')).toBe('压缩已取消。')
    expect(
      compactFailureText(
        'Compaction is unavailable because this process has an active compaction, or the agent is not idle.',
      ),
    ).toMatch(/压缩暂不可用/)
    expect(compactFailureText('Usage: /compact (no arguments)')).toBe(
      '用法：/compact（不接受参数）。',
    )
    expect(compactFailureText('unexpected')).toBe('压缩失败：unexpected')
  })

  it('treats No compactable history as a success but still localizes it', () => {
    expect(compactSuccessText('No compactable history yet.')).toBe('还没有可压缩的历史。')
    expect(compactSuccessText('Compacted 3 history items (~42 tokens).')).toBe(
      'Compacted 3 history items (~42 tokens).',
    )
  })
})

describe('compact queue', () => {
  it('queues one pending while running and executes when idle', async () => {
    const execute = vi.fn(async () => ({
      result: { kind: 'success', text: 'Compacted 3 history items (~42 tokens).' },
    }))
    const { context, notices } = fakeContext('running', execute)
    const features = new Features() as unknown as {
      context: unknown
      runCompactCommand(context: unknown, raw: string): Promise<void>
      onConversationChange(): void
    }
    features.context = context

    await features.runCompactCommand(context, '/compact')
    expect(notices.at(-1)?.text).toBe('回合结束后压缩（已排队）')
    await features.runCompactCommand(context, '/compact')
    expect(notices.at(-1)?.text).toBe('已排队，回合结束后自动压缩')
    expect(execute).not.toHaveBeenCalled()

    ;(context as any).conversation.status = 'idle'
    features.onConversationChange()
    await flush()

    expect(execute).toHaveBeenCalledTimes(1)
    expect(execute).toHaveBeenCalledWith(expect.anything(), '/compact', [], expect.anything())
    expect(notices.map((notice) => notice.text)).toContain('正在压缩…')
    expect(notices.map((notice) => notice.text)).toContain(
      'Compacted 3 history items (~42 tokens).',
    )
  })

  it('does not enqueue while compaction is already running', async () => {
    const execute = vi.fn()
    const { context, notices } = fakeContext('idle', execute)
    const features = new Features() as unknown as {
      context: unknown
      compactInFlight: boolean
      runCompactCommand(context: unknown, raw: string): Promise<void>
    }
    features.context = context
    features.compactInFlight = true

    await features.runCompactCommand(context, '/compact')
    expect(notices.map((notice) => notice.text)).toEqual(['压缩进行中，完成后会显示结果'])
    expect(execute).not.toHaveBeenCalled()
  })

  it('drops a queued compact on dispose', async () => {
    const execute = vi.fn()
    const { context } = fakeContext('running', execute)
    const features = new Features() as unknown as {
      context: unknown
      runCompactCommand(context: unknown, raw: string): Promise<void>
      onConversationChange(): void
      dispose(): Promise<void>
    }
    features.context = context
    await features.runCompactCommand(context, '/compact')
    await features.dispose()

    ;(context as any).conversation.status = 'idle'
    features.onConversationChange()
    await flush()
    expect(execute).not.toHaveBeenCalled()
  })
})
