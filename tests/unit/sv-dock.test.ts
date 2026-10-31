import { describe, expect, it } from 'vitest'
import {
  DOCK_GRACE_MS,
  type DockRow,
  deriveStatus,
  PROVISIONAL_MS,
  pruneRows,
  SubagentDock,
  statusWord,
  stopReasonStatus,
} from '../../src/subagents/dock.ts'

function row(id: string, status: DockRow['status'], terminalAt?: number): DockRow {
  return {
    id,
    name: id,
    mode: 'continuable',
    local: true,
    status,
    ...(terminalAt === undefined ? {} : { terminalAt }),
  }
}

function fakeCtx(options: {
  entries?: Array<{ id: string; mode: string; label?: string }>
  live?: Set<string>
  liveStatus?: Record<string, string>
  liveAgents?: Map<string, any>
}) {
  const handlers = new Map<string, (info: any) => void>()
  const state = {
    entries: options.entries ?? [],
    live: options.live ?? new Set<string>(),
    liveStatus: options.liveStatus ?? {},
    liveAgents: options.liveAgents ?? new Map<string, any>(),
  }
  const ctx = {
    get(name: string) {
      if (name === 'subagents') {
        return { listChildren: async () => state.entries }
      }
      if (name === 'agents') {
        return {
          get: (id: string) =>
            state.liveAgents.get(id) ??
            (state.live.has(id) ? { status: state.liveStatus[id] ?? 'running' } : undefined),
        }
      }
      return undefined
    },
    on(event: string, handler: (info: any) => void) {
      handlers.set(event, handler)
      return () => handlers.delete(event)
    },
    off(event: string) {
      handlers.delete(event)
    },
  }
  return {
    ctx,
    state,
    emit(event: string, info: any) {
      handlers.get(event)?.(info)
    },
  }
}

function childAgent(status = 'running') {
  const session = { id: 'child-session' }
  const handlers = new Map<string, (subject: any, event: any) => void>()
  const agent: any = {
    status,
    session,
    ctx: {
      on(event: string, handler: (subject: any, event: any) => void) {
        handlers.set(event, handler)
        return () => handlers.delete(event)
      },
      off(event: string) {
        handlers.delete(event)
      },
    },
  }
  return {
    agent,
    setStatus(next: string) {
      agent.status = next
    },
    emit(event: any) {
      handlers.get('session/event')?.(session, event)
    },
    emitForeign(event: any) {
      handlers.get('session/event')?.({ id: 'other' }, event)
    },
  }
}

function startDock(options: ConstructorParameters<typeof SubagentDock>[0]) {
  const dock = new SubagentDock({ pollMs: 1_000_000_000, ...options })
  dock.start()
  return dock
}

describe('stopReasonStatus', () => {
  it('把官方 stopReason 五种取值映射到状态词，未知并入未运行', () => {
    expect(stopReasonStatus('completed')).toBe('done')
    expect(stopReasonStatus('aborted')).toBe('killed')
    expect(stopReasonStatus('refusal')).toBe('killed')
    expect(stopReasonStatus('max-tokens')).toBe('killed')
    expect(stopReasonStatus('error')).toBe('error')
    expect(stopReasonStatus('unknown-variant')).toBe('idle')
    expect(stopReasonStatus(undefined)).toBe('idle')
  })
})

describe('pruneRows', () => {
  it('终态行按 terminalAt 保留 30 秒，活动行不动', () => {
    const now = 1_000_000
    const rows = [
      row('a', 'running'),
      row('b', 'done', now - 10_000),
      row('c', 'done', now - 31_000),
    ]
    expect(pruneRows(rows, now).map((item) => item.id)).toEqual(['a', 'b'])
  })

  it('terminalAt 不被 refresh 重写：纯函数只按给定时间判断', () => {
    const now = 1_000_000
    const rows = [row('a', 'done', now - DOCK_GRACE_MS + 1)]
    expect(pruneRows(rows, now).map((item) => item.id)).toEqual(['a'])
    expect(pruneRows(rows, now + 1).map((item) => item.id)).toEqual([])
  })
})

describe('deriveStatus', () => {
  it('保留活对象状态映射', () => {
    expect(deriveStatus({ status: 'running' })).toBe('running')
    expect(deriveStatus({ status: 'completed' })).toBe('done')
    expect(deriveStatus({ status: 'something-else' })).toBe('idle')
  })
})

describe('statusWord', () => {
  it('只产出 ADR 的五个状态词', () => {
    expect(statusWord('running')).toBe('执行中')
    expect(statusWord('done')).toBe('完成')
    expect(statusWord('killed')).toBe('终止')
    expect(statusWord('error')).toBe('错误')
    expect(statusWord('idle')).toBe('未运行')
  })
})

describe('SubagentDock 展示窗口', () => {
  it('冷启动目录里有历史子代理，但没有 live / start 事件时 dock 0 行', async () => {
    const fake = fakeCtx({ entries: [{ id: 'old', mode: 'continuable', label: '旧任务' }] })
    const dock = startDock({ ctx: fake.ctx, rootId: 'root', onChange: () => {} })
    await dock.refresh()
    expect(dock.visible).toBe(false)
    expect(dock.entryIds()).toEqual([])
  })

  it('只收到 end、没有 start / live 时不建行', async () => {
    const fake = fakeCtx({ entries: [{ id: 'old', mode: 'continuable', label: '旧任务' }] })
    const dock = startDock({ ctx: fake.ctx, rootId: 'root', onChange: () => {} })
    fake.emit('subagent/end', { id: 'old', stopReason: 'completed' })
    await dock.refresh()
    expect(dock.entryIds()).toEqual([])
  })

  it('subagent/start 建行，活对象在跑时显示执行中', async () => {
    const fake = fakeCtx({
      entries: [{ id: 'a', mode: 'continuable', label: '任务 A' }],
      live: new Set(['a']),
    })
    const dock = startDock({ ctx: fake.ctx, rootId: 'root', onChange: () => {} })
    fake.emit('subagent/start', { id: 'a' })
    await dock.refresh()
    expect(dock.entryIds()).toEqual(['a'])
    expect(dock.statusOf('a')).toBe('running')
  })

  it('subagent/end 按 stopReason 进入终态，30 秒后出列且刷新不复活', async () => {
    let now = 1_000_000
    const fake = fakeCtx({ entries: [{ id: 'a', mode: 'continuable', label: '任务 A' }] })
    const dock = startDock({
      ctx: fake.ctx,
      rootId: 'root',
      onChange: () => {},
      now: () => now,
    })
    fake.emit('subagent/start', { id: 'a' })
    await dock.refresh()
    fake.emit('subagent/end', { id: 'a', stopReason: 'completed' })
    await dock.refresh()
    expect(dock.statusOf('a')).toBe('done')
    const terminalAt = dock.terminalAtOf('a')
    expect(terminalAt).toBe(now)
    // 再次 refresh 不许重置计时。
    await dock.refresh()
    expect(dock.terminalAtOf('a')).toBe(terminalAt)
    now += DOCK_GRACE_MS
    await dock.refresh()
    expect(dock.entryIds()).toEqual([])
    // 目录里仍有该 id，但已出列，连续 3 次 refresh 都不复活。
    for (let index = 0; index < 3; index++) {
      now += 1
      await dock.refresh()
      expect(dock.entryIds()).toEqual([])
    }
  })

  it('未知 stopReason 显示未运行，但仍保留 30 秒', async () => {
    let now = 1_000_000
    const fake = fakeCtx({ entries: [{ id: 'a', mode: 'continuable', label: '任务 A' }] })
    const dock = startDock({
      ctx: fake.ctx,
      rootId: 'root',
      onChange: () => {},
      now: () => now,
    })
    fake.emit('subagent/start', { id: 'a' })
    await dock.refresh()
    fake.emit('subagent/end', { id: 'a', stopReason: 'future-variant' })
    await dock.refresh()
    expect(dock.statusOf('a')).toBe('idle')
    expect(dock.terminalAtOf('a')).toBe(now)
    now += DOCK_GRACE_MS - 1
    await dock.refresh()
    expect(dock.entryIds()).toEqual(['a'])
  })

  it('x 只移除终态行；运行中行不响应', async () => {
    const fake = fakeCtx({
      entries: [
        { id: 'a', mode: 'continuable' },
        { id: 'b', mode: 'continuable' },
      ],
      live: new Set(['a']),
    })
    const dock = startDock({ ctx: fake.ctx, rootId: 'root', onChange: () => {} })
    fake.emit('subagent/start', { id: 'a' })
    fake.emit('subagent/start', { id: 'b' })
    await dock.refresh()
    dock.dismiss('a')
    expect(dock.entryIds()).toEqual(['a', 'b'])
    fake.emit('subagent/end', { id: 'b', stopReason: 'aborted' })
    await dock.refresh()
    dock.dismiss('b')
    expect(dock.entryIds()).toEqual(['a'])
    await dock.refresh()
    expect(dock.entryIds()).toEqual(['a'])
  })

  it('同一 id 再次 start 清掉 dismissed 与 terminalAt，重新完整计时', async () => {
    let now = 1_000_000
    const fake = fakeCtx({ entries: [{ id: 'a', mode: 'continuable' }] })
    const dock = startDock({
      ctx: fake.ctx,
      rootId: 'root',
      onChange: () => {},
      now: () => now,
    })
    fake.emit('subagent/start', { id: 'a' })
    await dock.refresh()
    fake.emit('subagent/end', { id: 'a', stopReason: 'completed' })
    await dock.refresh()
    dock.dismiss('a')
    expect(dock.entryIds()).toEqual([])
    fake.emit('subagent/start', { id: 'a' })
    await dock.refresh()
    expect(dock.entryIds()).toEqual(['a'])
    expect(dock.terminalAtOf('a')).toBeUndefined()
    now += DOCK_GRACE_MS - 1
    await dock.refresh()
    expect(dock.entryIds()).toEqual(['a'])
  })

  it('同一 id 在行仍存在时再次 start，必须清掉旧 terminalAt，运行中不能被 30 秒规则出列', async () => {
    let now = 1_000_000
    const fake = fakeCtx({ entries: [{ id: 'a', mode: 'continuable' }] })
    const dock = startDock({
      ctx: fake.ctx,
      rootId: 'root',
      onChange: () => {},
      now: () => now,
    })
    fake.emit('subagent/start', { id: 'a' })
    await dock.refresh()
    fake.emit('subagent/end', { id: 'a', stopReason: 'completed' })
    await dock.refresh()
    expect(dock.terminalAtOf('a')).toBe(now)
    now += 10_000
    // 可续聊会话冷恢复：同一 id 再次 start，行还在。
    fake.emit('subagent/start', { id: 'a' })
    await dock.refresh()
    expect(dock.terminalAtOf('a')).toBeUndefined()
    expect(dock.statusOf('a')).toBe('running')
    now += DOCK_GRACE_MS
    await dock.refresh()
    expect(dock.entryIds()).toEqual(['a'])
    expect(dock.dismissedIds().has('a')).toBe(false)
  })

  it('子会话 turn/end completed 立即完成；turn/start 复位；activation end 不覆盖', async () => {
    let now = 1_000_000
    const child = childAgent()
    const fake = fakeCtx({
      entries: [{ id: 'a', mode: 'continuable', label: '任务 A' }],
      liveAgents: new Map([['a', child.agent]]),
    })
    const dock = startDock({
      ctx: fake.ctx,
      rootId: 'root',
      onChange: () => {},
      now: () => now,
    })
    await dock.refresh()
    expect(dock.statusOf('a')).toBe('running')
    child.emit({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    expect(dock.statusOf('a')).toBe('done')
    expect(dock.terminalAtOf('a')).toBe(now)
    // activation end 后到：turn 状态权威，不改时间与状态。
    now += 5_000
    fake.emit('subagent/end', { id: 'a', stopReason: 'error' })
    await dock.refresh()
    expect(dock.statusOf('a')).toBe('done')
    expect(dock.terminalAtOf('a')).toBe(1_000_000)
    // 30 秒后出列；新的一轮 turn/start 清 dismissed 与 terminal，重新出现。
    now += DOCK_GRACE_MS
    await dock.refresh()
    expect(dock.entryIds()).toEqual([])
    child.emit({ type: 'turn/start', data: { turn: 2 } })
    await dock.refresh()
    expect(dock.statusOf('a')).toBe('running')
    expect(dock.terminalAtOf('a')).toBeUndefined()
    expect(dock.entryIds()).toEqual(['a'])
    expect(dock.dismissedIds().has('a')).toBe(false)
  })

  it('activation end 先到、turn/end 后到：状态以 turn 为准，terminalAt 不变', async () => {
    let now = 1_000_000
    const child = childAgent()
    const fake = fakeCtx({
      entries: [{ id: 'a', mode: 'continuable' }],
      liveAgents: new Map([['a', child.agent]]),
    })
    const dock = startDock({
      ctx: fake.ctx,
      rootId: 'root',
      onChange: () => {},
      now: () => now,
    })
    await dock.refresh()
    fake.emit('subagent/end', { id: 'a', stopReason: 'error' })
    expect(dock.statusOf('a')).toBe('error')
    expect(dock.terminalAtOf('a')).toBe(now)
    now += 5_000
    child.emit({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
    expect(dock.statusOf('a')).toBe('done')
    expect(dock.terminalAtOf('a')).toBe(1_000_000)
  })

  it('one-shot live 子代理同样走 turn/end 完成态', async () => {
    const child = childAgent()
    const fake = fakeCtx({
      entries: [{ id: 'o', mode: 'one-shot' }],
      liveAgents: new Map([['o', child.agent]]),
    })
    const dock = startDock({ ctx: fake.ctx, rootId: 'root', onChange: () => {} })
    await dock.refresh()
    child.emit({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
    expect(dock.statusOf('o')).toBe('done')
  })

  it('turn/end 的 blocked/interrupted/forked/未知映射未运行；别的 session 事件不生效', async () => {
    const child = childAgent()
    const fake = fakeCtx({
      entries: [{ id: 'a', mode: 'continuable' }],
      liveAgents: new Map([['a', child.agent]]),
    })
    const dock = startDock({ ctx: fake.ctx, rootId: 'root', onChange: () => {} })
    await dock.refresh()
    child.emitForeign({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
    expect(dock.statusOf('a')).toBe('running')
    for (const kind of ['blocked', 'interrupted', 'forked', 'future-variant']) {
      child.emit({ type: 'turn/end', data: { reason: { kind } } })
      expect(dock.statusOf('a')).toBe('idle')
    }
  })

  it('external 的 start 不进 dock', async () => {
    const fake = fakeCtx({ entries: [{ id: 'ext', mode: 'external' }] })
    const dock = startDock({ ctx: fake.ctx, rootId: 'root', onChange: () => {} })
    fake.emit('subagent/start', { id: 'ext', local: false })
    await dock.refresh()
    expect(dock.entryIds()).toEqual([])
  })

  it('后代 start 只短暂占位，目录始终不列出时窗口过后不进 dock', async () => {
    let now = 1_000_000
    const fake = fakeCtx({ entries: [] })
    const dock = startDock({
      ctx: fake.ctx,
      rootId: 'root',
      onChange: () => {},
      now: () => now,
    })
    fake.emit('subagent/start', { id: 'deep', local: true })
    // 目录晚一拍时先占位，避免键盘焦点竞态。
    expect(dock.entryIds()).toEqual(['deep'])
    await dock.refresh()
    expect(dock.entryIds()).toEqual(['deep'])
    now += PROVISIONAL_MS
    await dock.refresh()
    expect(dock.entryIds()).toEqual([])
  })

  it('活对象存在但未运行，不建行（I1 只认观察到的 running）', async () => {
    const fake = fakeCtx({
      entries: [{ id: 'idle', mode: 'continuable' }],
      live: new Set(['idle']),
      liveStatus: { idle: 'idle' },
    })
    const dock = startDock({ ctx: fake.ctx, rootId: 'root', onChange: () => {} })
    await dock.refresh()
    expect(dock.entryIds()).toEqual([])
  })

  it('窗口最多 4 行 + 1 个溢出入口，焦点在整套行上循环', async () => {
    const entries = Array.from({ length: 6 }, (_, index) => ({
      id: `s${index}`,
      mode: 'continuable',
      label: `任务 ${index}`,
    }))
    const fake = fakeCtx({ entries, live: new Set(entries.map((entry) => entry.id)) })
    const dock = startDock({ ctx: fake.ctx, rootId: 'root', onChange: () => {} })
    for (const entry of entries) fake.emit('subagent/start', { id: entry.id })
    await dock.refresh()
    expect(dock.entryIds()).toEqual(['s0', 's1', 's2', 's3', 'overflow'])
    expect(dock.overflowCount()).toBe(2)
  })

  it('连续 20 个运行中子代理，dock 仍只有 4 行 + 1 个溢出入口', async () => {
    const entries = Array.from({ length: 20 }, (_, index) => ({
      id: `s${index}`,
      mode: 'continuable',
      label: `任务 ${index}`,
    }))
    const fake = fakeCtx({ entries, live: new Set(entries.map((entry) => entry.id)) })
    const dock = startDock({ ctx: fake.ctx, rootId: 'root', onChange: () => {} })
    for (const entry of entries) fake.emit('subagent/start', { id: entry.id })
    await dock.refresh()
    expect(dock.window().visible).toHaveLength(4)
    expect(dock.overflowCount()).toBe(16)
    expect(dock.entryIds()).toHaveLength(5)
  })

  it('大量出列不因容量边界复活', async () => {
    const entries = Array.from({ length: 300 }, (_, index) => ({
      id: `s${index}`,
      mode: 'continuable',
    }))
    let now = 1_000_000
    const fake = fakeCtx({ entries })
    const dock = startDock({
      ctx: fake.ctx,
      rootId: 'root',
      onChange: () => {},
      now: () => now,
    })
    for (const entry of entries) fake.emit('subagent/start', { id: entry.id })
    await dock.refresh()
    for (const entry of entries)
      fake.emit('subagent/end', { id: entry.id, stopReason: 'completed' })
    await dock.refresh()
    now += DOCK_GRACE_MS
    await dock.refresh()
    expect(dock.entryIds()).toEqual([])
    now += 1
    await dock.refresh()
    expect(dock.entryIds()).toEqual([])
  })
})
