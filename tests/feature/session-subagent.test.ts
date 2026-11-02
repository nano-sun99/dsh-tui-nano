/**
 * `-c` 不选子代理会话（spec 2026-11-02-nano-session-lifecycle §5）。
 *
 * 用官方 JSONL 持久化构造一个 `origin: 'subagent'` 会话，再走启动前
 * `sessionQuery` 索引与 `continueCandidates`，验证候选集里只剩顶层会话。
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadOfficial } from '../../src/boot/official.ts'
import { openSessionIndex } from '../../src/boot/session-index.ts'
import { continueCandidates } from '../../src/sessions/filters.ts'

const base = mkdtempSync(join(tmpdir(), 'nano-subagent-fixture-'))
const dataRoot = join(base, 'data')
const work = join(base, 'work')

beforeAll(() => {
  mkdirSync(dataRoot, { recursive: true })
  mkdirSync(work, { recursive: true })
})

afterAll(() => {
  rmSync(base, { recursive: true, force: true })
})

describe('启动前会话索引', () => {
  it('排除 origin=subagent / 有父会话 / 深度 > 0 的会话', async () => {
    const official = await loadOfficial()
    const { Context } = await official.load('@deepseek-ai/cordis')
    const persistence = await official.load('@deepseek-ai/dsh-session-persistence-jsonl')
    const version = official.session.SESSION_FORMAT_VERSION as number
    const SessionId = official.session.SessionId as (id: string) => string

    const ctx = new Context()
    const fiber = ctx.plugin(persistence, { root: join(dataRoot, 'sessions') })
    await fiber
    const store = ctx.sessionPersistence
    const write = async (id: string, meta: Record<string, unknown> = {}) => {
      const handle = await store.create({
        version,
        id: SessionId(id),
        createdAt: Date.now(),
        cwd: work,
        isSeeded: false,
        ...meta,
      })
      await handle.flush()
      await handle.close()
    }
    try {
      await write('top-level')
      await write('subagent', {
        origin: 'subagent',
        parentSession: SessionId('top-level'),
        delegationDepth: 1,
      })
      await write('child-depth', { delegationDepth: 2 })
    } finally {
      await fiber.dispose()
    }

    const index = await openSessionIndex(official, dataRoot)
    try {
      const records = await index.list()
      const ids = continueCandidates(records, work).map((record) => record.header.id)
      expect(ids).toEqual(['top-level'])
    } finally {
      await index.close()
    }
  })
})
