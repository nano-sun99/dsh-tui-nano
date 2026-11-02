/**
 * Root identity and the pre-alternate-screen mount claim (spec §2.2). One id
 * threads storage, sessions, schedule, handoff and `sessions.create`; a second
 * window on the same root is rejected before the screen is touched.
 *
 * Default startup always generates a fresh id; `last-root` is neither read nor
 * written anymore (spec 2026-11-02-nano-session-lifecycle §3.2).
 */

import { randomBytes } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs'
import { join } from 'node:path'

export interface RootIdentity {
  readonly id: string
  readonly source: 'arg' | 'generated'
}

export class RootInUseError extends Error {
  readonly pid: number
  readonly rootId: string
  constructor(rootId: string, pid: number) {
    super(
      `会话 ${rootId} 已在另一个窗口打开（pid ${pid}）。开新窗口直接运行 nano；换一个会话用 nano -r；如果那个窗口已经不用了，关掉它再试。`,
    )
    this.name = 'RootInUseError'
    this.pid = pid
    this.rootId = rootId
  }
}

const ROOT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** `--root <id>` → that id; otherwise a fresh timestamp-id. Never reads `last-root`. */
export function resolveRootId(fromArg?: string): RootIdentity {
  if (fromArg !== undefined) {
    validateRootId(fromArg)
    return { id: fromArg, source: 'arg' }
  }
  return { id: generateRootId(), source: 'generated' }
}

/** Validate a user-supplied session id before it is used in a lock path. */
export function validateRootId(id: string): void {
  if (!ROOT_PATTERN.test(id)) {
    throw new Error(`nano: 非法会话身份 "${id}"：只允许字母、数字、点、下划线和短横线。`)
  }
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

function generateRootId(): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
  return `${stamp}-${randomBytes(4).toString('hex')}`
}
