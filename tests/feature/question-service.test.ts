import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { resolveInstallAnchor } from '../../src/boot/official.ts'
import { DecisionManager } from '../../src/decisions/manager.ts'

const requireOfficial = createRequire(resolveInstallAnchor())
const { Context } = await import(pathToFileURL(requireOfficial.resolve('@deepseek-ai/cordis')).href)
const { UserQuestionService, UserQuestionError } = await import(
  pathToFileURL(requireOfficial.resolve('@deepseek-ai/dsh-user-questions')).href
)

describe('official user-question service integration', () => {
  it('restores answerer cancellation as the official ASK_ABORTED error', async () => {
    const ctx = new Context()
    const fork = ctx.plugin(UserQuestionService)
    await fork
    const manager = new DecisionManager()
    manager.register(ctx)
    const signal = new AbortController()
    try {
      const pending = ctx.userQuestions.ask({
        questions: [
          { id: 'q', question: '继续？', options: [{ label: '继续' }, { label: '停止' }] },
        ],
        signal: signal.signal,
      })
      const result = pending.catch((error: unknown) => error)
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(manager.prompt).toMatchObject({ kind: 'question' })
      manager.escape()
      const error = await result
      expect(error).toBeInstanceOf(UserQuestionError)
      expect(error).toMatchObject({
        name: 'UserQuestionError',
        code: 'ASK_ABORTED',
        message: 'ask_user_question was aborted before the user answered',
      })
      expect(signal.signal.aborted).toBe(false)
      expect(manager.prompt).toBeUndefined()
    } finally {
      await fork.dispose()
    }
  })

  it('passes explicit skip as an empty selected array, not cancellation', async () => {
    const ctx = new Context()
    const fork = ctx.plugin(UserQuestionService)
    await fork
    const manager = new DecisionManager()
    manager.register(ctx)
    try {
      const pending = ctx.userQuestions.ask({
        questions: [
          { id: 'q', question: '继续？', options: [{ label: '继续' }, { label: '停止' }] },
        ],
      })
      await new Promise((resolve) => setTimeout(resolve, 0))
      manager.skipQuestion()
      await expect(pending).resolves.toEqual({ answers: [{ id: 'q', selected: [] }] })
    } finally {
      await fork.dispose()
    }
  })
})
