/**
 * 启动前的会话列表（spec 2026-11-02-nano-session-lifecycle §3.3 / §3.4）。
 *
 * `-c` / `-r <id>` 必须在选根之前知道会话列表，但正式核心还没 boot。
 * 这里用一个最小 Cordis 上下文挂官方 JSONL 持久化，再用官方
 * `SessionQueryEngine.listSessions` 读 header；不读日志文件、不猜身份。
 */
import { join } from 'node:path'
import type { SessionRecordView } from '../sessions/filters.ts'
import type { OfficialModules } from './official.ts'

export interface SessionIndex {
  list(): Promise<SessionRecordView[]>
  close(): Promise<void>
}

export async function openSessionIndex(
  official: OfficialModules,
  dataRoot: string,
): Promise<SessionIndex> {
  const { Context } = await official.load('@deepseek-ai/cordis')
  const persistence = await official.load('@deepseek-ai/dsh-session-persistence-jsonl')
  const { default: SessionQueryEngine } = await official.load('@deepseek-ai/dsh-session-query')

  const ctx = new Context()
  const disposeSessions = ctx.provide('sessions', {
    list: () => [],
    get: () => undefined,
  })
  const persistenceFiber = ctx.plugin(persistence, { root: join(dataRoot, 'sessions') })
  await persistenceFiber

  // 只消费继承来的精确读取；全文搜索在启动前没有用途。
  type ListEngine = {
    listSessions(signal?: AbortSignal): Promise<SessionRecordView[]>
  }
  const Engine = SessionQueryEngine as unknown as new (
    ctx: any,
    config?: Record<string, unknown>,
  ) => ListEngine

  class ListOnlyQuery extends Engine {
    async searchSessions(): Promise<never> {
      throw new Error('nano: 启动前会话索引不支持搜索')
    }

    async searchEvents(): Promise<never> {
      throw new Error('nano: 启动前会话索引不支持搜索')
    }
  }

  let engine: ListEngine | undefined
  const engineFiber = ctx.plugin({
    inject: ['sessions'],
    apply(pluginCtx: any) {
      engine = new ListOnlyQuery(pluginCtx, {})
    },
  })
  await engineFiber
  const ready = engine
  if (ready === undefined) throw new Error('nano: 启动前会话索引初始化失败')

  return {
    list: () => ready.listSessions(),
    async close() {
      await engineFiber.dispose()
      await persistenceFiber.dispose()
      disposeSessions?.()
    },
  }
}
