/**
 * Root identity and the pre-alternate-screen mount claim (spec §2.2). One id
 * threads storage, sessions, schedule, handoff and `sessions.create`; a second
 * window on the same root is rejected before the screen is touched.
 */

import { randomBytes } from 'node:crypto'
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'

export interface RootIdentity {
  readonly id: string
  readonly source: 'arg' | 'last-root' | 'generated'
}

export class RootInUseError extends Error {
  readonly pid: number
  readonly rootId: string
  constructor(rootId: string, pid: number) {
    super(`nano: 根 "${rootId}" 已被进程 ${pid} 占用；同一根只允许一个窗口。`)
    this.name = 'RootInUseError'
    this.pid = pid
    this.rootId = rootId
  }
}

const ROOT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** `--root <id>` → `<dataRoot>/last-root` → generated timestamp-id. */
export function resolveRootId(dataRoot: string, argv: readonly string[]): RootIdentity {
  const fromArg = readRootArg(argv)
  if (fromArg !== undefined) {
    if (!ROOT_PATTERN.test(fromArg)) {
      throw new Error(`nano: 非法根身份 "${fromArg}"：只允许字母、数字、点、下划线和短横线。`)
    }
    return { id: fromArg, source: 'arg' }
  }
  const lastRootPath = join(dataRoot, 'last-root')
  try {
    const saved = readFileSync(lastRootPath, 'utf8').trim()
    if (saved !== '' && ROOT_PATTERN.test(saved)) return { id: saved, source: 'last-root' }
  } catch {
    // No previous root: generate one below.
  }
  return { id: generateRootId(), source: 'generated' }
}

/** Persist the chosen root as 0600 (atomic tmp + fsync + rename). */
export function writeLastRoot(dataRoot: string, id: string): void {
  mkdirSync(dataRoot, { recursive: true, mode: 0o700 })
  const target = join(dataRoot, 'last-root')
  const temporary = `${target}.tmp-${process.pid}`
  const fd = openSync(temporary, 'w', 0o600)
  try {
    writeSync(fd, `${id}\n`)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(temporary, target)
}

export interface MountClaim {
  readonly rootId: string
  readonly path: string
  /** True when a dead process's lock was reclaimed (dirty shutdown). */
  readonly recovered: boolean
}

/**
 * Acquire `<dataRoot>/mount/<id>.lock` with the process pid. Returns the claim
 * or throws `RootInUseError`; a lock from a dead pid is reclaimed and reported.
 */
export function acquireMountClaim(dataRoot: string, rootId: string): MountClaim {
  const mountDir = join(dataRoot, 'mount')
  mkdirSync(mountDir, { recursive: true, mode: 0o700 })
  const path = join(mountDir, `${rootId}.lock`)
  let recovered = false
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx', 0o600)
      try {
        writeSync(fd, JSON.stringify({ pid: process.pid, rootId, startedAt: Date.now() }))
      } finally {
        closeSync(fd)
      }
      return { rootId, path, recovered }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const pid = readLockPid(path)
      if (pid !== undefined && isProcessAlive(pid)) throw new RootInUseError(rootId, pid)
      // Dead owner: reclaim once, then retry the exclusive create.
      unlinkQuietly(path)
      recovered = true
    }
  }
  throw new RootInUseError(rootId, readLockPid(path) ?? -1)
}

/** Release the claim; only removes a lock that still belongs to this process. */
export function releaseMountClaim(claim: MountClaim): void {
  const pid = readLockPid(claim.path)
  if (pid === undefined || pid === process.pid) unlinkQuietly(claim.path)
}

/** True when a stale lock exists without us owning it (strong-kill detection). */
export function hasStaleMountClaim(dataRoot: string, rootId: string): boolean {
  const path = join(dataRoot, 'mount', `${rootId}.lock`)
  const pid = readLockPid(path)
  return pid !== undefined && !isProcessAlive(pid)
}

function readLockPid(path: string): number | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { pid?: unknown }
    return typeof parsed.pid === 'number' ? parsed.pid : undefined
  } catch {
    return undefined
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function unlinkQuietly(path: string): void {
  try {
    unlinkSync(path)
  } catch {
    // ignore
  }
}

function readRootArg(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--root') {
      const value = argv[i + 1]
      if (value === undefined) throw new Error('nano: --root 需要一个值')
      return value
    }
    if (arg?.startsWith('--root=')) return arg.slice('--root='.length)
  }
  return undefined
}

function generateRootId(): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
  return `${stamp}-${randomBytes(4).toString('hex')}`
}
