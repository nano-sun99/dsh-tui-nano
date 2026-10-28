/**
 * Root-switch handoff (explicit exception recorded against the input-history
 * ADR): an atomic tmp+fsync+rename file, 0600, versioned, read once then
 * deleted. S01 owns path/format; S02 writes/reads it when switching roots.
 */
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

export const HANDOFF_VERSION = 1

export interface HandoffRecord {
  readonly version: number
  readonly rootId: string
  readonly sessionId: string
  /** Monotonic creation time, used to reject stale files. */
  readonly createdAt: number
  readonly reason: 'root-switch' | 'cold-rename'
  readonly payload?: Record<string, unknown>
}

export function handoffPath(dataRoot: string): string {
  return join(dataRoot, 'handoff.json')
}

/** Atomically persist a handoff record (tmp + fsync + rename, 0600). */
export function writeHandoff(
  dataRoot: string,
  record: Omit<HandoffRecord, 'version' | 'createdAt'>,
): string {
  mkdirSync(dataRoot, { recursive: true, mode: 0o700 })
  const target = handoffPath(dataRoot)
  const temporary = `${target}.tmp-${process.pid}`
  const body = JSON.stringify({ ...record, version: HANDOFF_VERSION, createdAt: Date.now() })
  const fd = openSync(temporary, 'w', 0o600)
  try {
    writeSync(fd, body)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(temporary, target)
  return target
}

/**
 * Read and delete the handoff record. A malformed or version-mismatched file
 * is removed and reported as an error so the caller does not silently continue.
 */
export function takeHandoff(dataRoot: string): HandoffRecord | undefined {
  const target = handoffPath(dataRoot)
  let raw: string
  try {
    raw = readFileSync(target, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  let parsed: HandoffRecord
  try {
    parsed = JSON.parse(raw) as HandoffRecord
  } catch {
    deleteQuietly(target)
    throw new Error('handoff 文件损坏，已丢弃；请重试切换')
  }
  deleteQuietly(target)
  if (parsed.version !== HANDOFF_VERSION) {
    throw new Error(`handoff 版本不支持：${String(parsed.version)}（期望 ${HANDOFF_VERSION}）`)
  }
  if (typeof parsed.rootId !== 'string' || parsed.rootId === '') {
    throw new Error('handoff 缺少根身份，已丢弃')
  }
  return parsed
}

function deleteQuietly(path: string): void {
  try {
    unlinkSync(path)
  } catch {
    // ignore
  }
}
