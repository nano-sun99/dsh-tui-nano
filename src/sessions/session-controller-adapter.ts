/**
 * 最小 `sessionController` 适配器（S02 spec §1、§3.5、§6）。
 *
 * base 不含官方 `@deepseek-ai/dsh-api-session-controller`（它要 12 个注入服务 +
 * 必填 `nativeOpen`），而官方 `dsh-schedule` 的投递路径需要
 * `ctx.sessionController.resolveAgent(sessionId)`。这里只供这一个方法：
 * `{ agent }` / `{ error }` 两种形状与官方一致，其余会话操作继续走官方
 * `sessions` / `agents`，不造第二套会话服务。
 */

/** 与官方 `ApiSessionAgentError` 同码、同形状；不新增依赖，用结构化的 Error。 */
export interface SessionAgentFailure {
  readonly code: 'session/not-found' | 'session/writer-held' | 'gateway/internal'
  readonly details: Readonly<Record<string, unknown>>
  readonly isDSHRemoteError: true
}

export type SessionAgentResult = { readonly agent: any } | { readonly error: SessionAgentFailure }

export interface SessionControllerContext {
  readonly agents: any
}

function failure(
  code: SessionAgentFailure['code'],
  message: string,
  details: Readonly<Record<string, unknown>>,
): SessionAgentFailure {
  return Object.assign(new Error(message), { code, details, isDSHRemoteError: true }) as any
}

function isNotFound(error: unknown): boolean {
  const name = (error as { name?: string } | undefined)?.name ?? ''
  const message = String((error as { message?: string } | undefined)?.message ?? error)
  return name === 'SessionPersistenceNotFoundError' || /not found/i.test(message)
}

function isWriterHeld(error: unknown): boolean {
  return (error as { name?: string } | undefined)?.name === 'SessionAlreadyOwnedError'
}

/** 只暴露 `resolveAgent` 的会话控制器；同名服务由本适配器 provide。 */
export class SessionControllerAdapter {
  private readonly ctx: SessionControllerContext
  private readonly resumes = new Map<string, Promise<SessionAgentResult>>()

  constructor(ctx: SessionControllerContext) {
    this.ctx = ctx
  }

  /**
   * 把一个会话身份解析成活 Agent：先查活表，再 resume。
   * 并发调用合并成一次 resume，避免同一身份被重复加载。
   */
  async resolveAgent(sessionId: string): Promise<SessionAgentResult> {
    const live = this.ctx.agents?.get?.(sessionId)
    if (live) return { agent: live }
    const existing = this.resumes.get(sessionId)
    if (existing) return existing
    const pending = this.resume(sessionId).finally(() => this.resumes.delete(sessionId))
    this.resumes.set(sessionId, pending)
    return pending
  }

  private async resume(sessionId: string): Promise<SessionAgentResult> {
    try {
      const handle = await this.ctx.agents.resume({ resumeSessionId: sessionId })
      const live = this.ctx.agents?.get?.(sessionId)
      return { agent: live ?? handle?.agent }
    } catch (error) {
      const raced = this.ctx.agents?.get?.(sessionId)
      if (raced) return { agent: raced }
      if (isNotFound(error)) {
        return { error: failure('session/not-found', String((error as Error)?.message ?? error), { sessionId }) }
      }
      if (isWriterHeld(error)) {
        return { error: failure('session/writer-held', String((error as Error)?.message ?? error), { sessionId }) }
      }
      return {
        error: failure(
          'gateway/internal',
          `resume failed for session "${sessionId}": ${String(error)}`,
          {},
        ),
      }
    }
  }
}
