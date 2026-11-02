/**
 * 会话面板（spec 2026-11-02-nano-session-lifecycle §3.4 / §3.6）：
 * 默认只看当前 cwd 的顶层会话，`a` 切全部目录，跨目录选择直接拒绝。
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { SessionsPanel } from '../../src/sessions/list.ts'

interface Header {
  id: string
  cwd?: string
  createdAt: number
  parentSession?: string
  origin?: 'subagent'
  delegationDepth?: number
}

function record(header: Header) {
  return { header, live: false, persisted: true }
}

function fakeCtx(records: ReturnType<typeof record>[]) {
  return {
    get: (name: string) =>
      name === 'sessionQuery'
        ? {
            listSessions: async () => records,
            readTitle: async (id: string) => ({ title: `标题-${id}` }),
          }
        : undefined,
  }
}

/** 把自定义组件的元素树里的字符串拼起来；只用于断言提示文案。 */
function textOf(node: unknown): string {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return textOf((node as { props?: { children?: unknown } }).props?.children)
}

function makePanel(records: ReturnType<typeof record>[], dir: string) {
  const onSwitch = vi.fn()
  const panel = new SessionsPanel({
    ctx: fakeCtx(records) as any,
    rootId: 'current',
    cwd: dir,
    onChange: () => {},
    writeDiagnostic: () => {},
    onSwitch,
  })
  return { panel, onSwitch }
}

describe('SessionsPanel', () => {
  it('默认只列当前 cwd 的顶层会话', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nano-panel-'))
    try {
      const real = realpathSync.native(dir)
      const { panel } = makePanel(
        [
          record({ id: 'current', cwd: real, createdAt: 1 }),
          record({ id: 'other-cwd', cwd: '/elsewhere', createdAt: 2 }),
          record({ id: 'sub', cwd: real, createdAt: 3, origin: 'subagent', delegationDepth: 1 }),
          record({ id: 'faulted', cwd: real, createdAt: 4, parentSession: 'current' }),
        ],
        dir,
      )
      panel.toggle()
      await panel.refresh()
      expect((panel as any).rows.map((row: { id: string }) => row.id)).toEqual(['current'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a 切全部目录，仍不列子代理；选跨目录会话直接拒绝', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nano-panel-'))
    try {
      const { panel, onSwitch } = makePanel(
        [
          record({ id: 'current', cwd: dir, createdAt: 1 }),
          record({ id: 'other-cwd', cwd: '/elsewhere', createdAt: 2 }),
          record({ id: 'sub', cwd: dir, createdAt: 3, origin: 'subagent' }),
        ],
        dir,
      )
      panel.toggle()
      await panel.refresh()
      panel.handleKey({ name: 'char', text: 'a', ctrl: false, alt: false } as any)
      await panel.refresh()
      expect((panel as any).rows.map((row: { id: string }) => row.id)).toEqual([
        'current',
        'other-cwd',
      ])

      panel.handleKey({ name: 'down' } as any)
      panel.handleKey({ name: 'enter' } as any)
      expect(onSwitch).not.toHaveBeenCalled()
      expect((panel as any).notice).toBe('该会话属于 /elsewhere；请在该目录启动 nano。')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('空列表 / 只有当前新会话时显示可恢复空态文案', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nano-panel-'))
    try {
      const empty = makePanel([], dir)
      empty.panel.toggle()
      await empty.panel.refresh()
      expect(textOf(empty.panel.render(80, 20))).toContain(
        '没有可恢复的会话；直接在新会话里开始，或按 a 看全部目录',
      )

      const onlyCurrent = makePanel([record({ id: 'current', cwd: dir, createdAt: 1 })], dir)
      onlyCurrent.panel.toggle()
      await onlyCurrent.panel.refresh()
      expect(textOf(onlyCurrent.panel.render(80, 20))).toContain(
        '没有可恢复的会话；直接在新会话里开始，或按 a 看全部目录',
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('同 cwd 会话 Enter 交给受控重启', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nano-panel-'))
    try {
      const { panel, onSwitch } = makePanel(
        [
          record({ id: 'current', cwd: dir, createdAt: 1 }),
          record({ id: 'peer', cwd: dir, createdAt: 2 }),
        ],
        dir,
      )
      panel.toggle()
      await panel.refresh()
      panel.handleKey({ name: 'down' } as any)
      panel.handleKey({ name: 'enter' } as any)
      expect(onSwitch).toHaveBeenCalledWith('peer')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
