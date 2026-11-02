/**
 * 启动模式与选根（spec 2026-11-02-nano-session-lifecycle §3）。
 * `-c` / `-r <id>` 的候选过滤、last-session 提示与 resume-only 在这里纯测。
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { assertLaunchMode, parseCli } from '../../src/boot/cli.ts'
import { recordLastSession } from '../../src/boot/last-session.ts'
import type { SessionIndex } from '../../src/boot/session-index.ts'
import {
  CONTINUE_EMPTY_MESSAGE,
  crossDirectoryMessage,
  resumeNotFoundMessage,
  selectStartupRoot,
} from '../../src/boot/startup.ts'
import type { SessionRecordView } from '../../src/sessions/filters.ts'

function record(
  id: string,
  cwd: string,
  createdAt: number,
  extra: Partial<SessionRecordView['header']> = {},
): SessionRecordView {
  return { header: { id, cwd, createdAt, ...extra } }
}

function fakeIndex(records: readonly SessionRecordView[]): SessionIndex {
  return {
    list: async () => [...records],
    close: async () => {},
  }
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'nano-startup-'))
}

describe('CLI 启动模式', () => {
  it('解析 -c / -r / --root，并让 id 值不参与子命令判断', () => {
    expect(parseCli(['-c'])).toMatchObject({ continueSession: true, resumePanel: false })
    expect(parseCli(['--continue'])).toMatchObject({ continueSession: true })
    expect(parseCli(['-r'])).toMatchObject({ resumePanel: true })
    expect(parseCli(['-r', 'abc'])).toMatchObject({ resumeId: 'abc', resumePanel: false })
    expect(parseCli(['--resume=abc'])).toMatchObject({ resumeId: 'abc' })
    expect(parseCli(['--root', 'purge'])).toMatchObject({ rootId: 'purge', purge: false })
    expect(parseCli(['-r', 'purge'])).toMatchObject({ resumeId: 'purge', purge: false })
    expect(parseCli(['-r', '--help'])).toMatchObject({ resumePanel: true, help: true })
    expect(parseCli(['--root'])).toMatchObject({ rootMissing: true })
    expect(parseCli(['--help', '--root'])).toMatchObject({ help: true, rootMissing: true })
    expect(parseCli(['--version', '--root'])).toMatchObject({ version: true, rootMissing: true })
  })

  it('拒绝互斥组合', () => {
    expect(() => assertLaunchMode(parseCli(['--root', 'x', '-c']))).toThrow(
      '--root 不能和 -c / -r 同时使用',
    )
    expect(() => assertLaunchMode(parseCli(['-c', '-r']))).toThrow('-c 和 -r 只能选一个')
    expect(() => assertLaunchMode(parseCli(['-c', '-r', 'x']))).toThrow('-c 和 -r 只能选一个')
    expect(() => assertLaunchMode(parseCli(['-c']))).not.toThrow()
  })
})

describe('selectStartupRoot', () => {
  it('默认生成新会话；--root 用指定 id', async () => {
    const dir = tempDir()
    try {
      const generated = await selectStartupRoot({
        args: parseCli([]),
        dataRoot: dir,
        cwd: dir,
        openIndex: async () => {
          throw new Error('默认模式不应读会话列表')
        },
      })
      expect(generated.resumeOnly).toBe(false)
      expect(generated.rootId).toMatch(/^[0-9]{8}-[0-9]{6}-[0-9a-f]{8}$/u)

      const explicit = await selectStartupRoot({
        args: parseCli(['--root', 'pinned']),
        dataRoot: dir,
        cwd: dir,
        openIndex: async () => {
          throw new Error('--root 不应读会话列表')
        },
      })
      expect(explicit.rootId).toBe('pinned')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('-r 不带 id：生成新会话并打开面板', async () => {
    const dir = tempDir()
    try {
      const selection = await selectStartupRoot({
        args: parseCli(['-r']),
        dataRoot: dir,
        cwd: dir,
        openIndex: async () => {
          throw new Error('面板模式在启动后读取列表')
        },
      })
      expect(selection.openSessionsPanel).toBe(true)
      expect(selection.resumeOnly).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('-c 优先 last-session，否则取官方新优先的第一条', async () => {
    const dir = tempDir()
    try {
      recordLastSession(dir, dir, 'older', 1)
      const index = fakeIndex([
        record('sub', dir, 500, { origin: 'subagent', delegationDepth: 1 }),
        record('other-cwd', '/elsewhere', 600),
        record('older', dir, 100),
        record('newer', dir, 400),
      ])
      const selection = await selectStartupRoot({
        args: parseCli(['-c']),
        dataRoot: dir,
        cwd: dir,
        openIndex: async () => index,
      })
      expect(selection).toMatchObject({
        rootId: 'older',
        resumeOnly: true,
        notFoundMessage: CONTINUE_EMPTY_MESSAGE,
      })

      const fallback = await selectStartupRoot({
        args: parseCli(['-c']),
        dataRoot: join(dir, 'no-last-session'),
        cwd: dir,
        openIndex: async () => index,
      })
      expect(fallback.rootId).toBe('newer')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('-c 接受 cwd 的 realpath 写法；last-session 损坏只写诊断', async () => {
    const dir = tempDir()
    try {
      const real = realpathSync.native(dir)
      const dataRoot = join(dir, 'data')
      mkdirSync(dataRoot, { recursive: true })
      writeFileSync(join(dataRoot, 'last-session.json'), '{oops')
      const diagnostic = vi.fn()
      const selection = await selectStartupRoot({
        args: parseCli(['-c']),
        dataRoot,
        cwd: dir,
        openIndex: async () => fakeIndex([record('remembered', real, 100)]),
        onDiagnostic: diagnostic,
      })
      expect(selection.rootId).toBe('remembered')
      expect(diagnostic).toHaveBeenCalledWith(expect.stringMatching(/损坏/))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('-c 无候选时报错，不创建', async () => {
    const dir = tempDir()
    try {
      await expect(
        selectStartupRoot({
          args: parseCli(['-c']),
          dataRoot: dir,
          cwd: dir,
          openIndex: async () => fakeIndex([record('other', '/elsewhere', 1)]),
        }),
      ).rejects.toThrow(CONTINUE_EMPTY_MESSAGE)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('-r <id> 精确恢复并拒绝跨目录', async () => {
    const dir = tempDir()
    try {
      const index = fakeIndex([
        record('target', dir, 1),
        record('elsewhere', '/other/dir', 2),
        record('sub', dir, 3, { origin: 'subagent' }),
      ])
      const selection = await selectStartupRoot({
        args: parseCli(['-r', 'target']),
        dataRoot: dir,
        cwd: dir,
        openIndex: async () => index,
      })
      expect(selection).toMatchObject({ rootId: 'target', resumeOnly: true })

      await expect(
        selectStartupRoot({
          args: parseCli(['-r', 'elsewhere']),
          dataRoot: dir,
          cwd: dir,
          openIndex: async () => index,
        }),
      ).rejects.toThrow(crossDirectoryMessage('/other/dir'))

      await expect(
        selectStartupRoot({
          args: parseCli(['-r', 'sub']),
          dataRoot: dir,
          cwd: dir,
          openIndex: async () => index,
        }),
      ).rejects.toThrow(resumeNotFoundMessage('sub'))

      await expect(
        selectStartupRoot({
          args: parseCli(['-r', 'missing']),
          dataRoot: dir,
          cwd: dir,
          openIndex: async () => index,
        }),
      ).rejects.toThrow(resumeNotFoundMessage('missing'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('会话索引打不开时给出可操作错误', async () => {
    const dir = tempDir()
    try {
      await expect(
        selectStartupRoot({
          args: parseCli(['-c']),
          dataRoot: dir,
          cwd: dir,
          openIndex: async () => {
            throw new Error('boom')
          },
        }),
      ).rejects.toThrow(/无法读取本地会话列表：boom/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
