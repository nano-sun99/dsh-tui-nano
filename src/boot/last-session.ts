/**
 * `-c` 的导航提示（spec 2026-11-02-nano-session-lifecycle §3.3 / §7）。
 *
 * `<数据根>/last-session.json` 是 nano 自有的「每个 cwd 最近用过的会话」，
 * 不是官方历史副本；损坏、只读或写入失败都只降级为官方列表排序。
 */
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'

export const LAST_SESSION_VERSION = 1

/** 最多保留的 cwd 条目数；防止文件无限增长。 */
export const LAST_SESSION_LIMIT = 100

export interface LastSessionEntry {
  readonly sessionId: string
  readonly lastUsedAt: number
}

export interface LastSessionFile {
  readonly version: typeof LAST_SESSION_VERSION
  readonly byCwd: Readonly<Record<string, LastSessionEntry>>
}

export function lastSessionPath(dataRoot: string): string {
  return join(dataRoot, 'last-session.json')
}

/**
 * 读导航提示；任何损坏都返回空表并带原因，不抛错。
 * 调用方把原因写诊断，但不得因此阻塞启动或 `-c`。
 */
export function readLastSession(dataRoot: string): {
  file: LastSessionFile
  error?: string
} {
  const empty: LastSessionFile = { version: LAST_SESSION_VERSION, byCwd: {} }
  let raw: string
  try {
    raw = readFileSync(lastSessionPath(dataRoot), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { file: empty }
    return { file: empty, error: message(error) }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return { file: empty, error: `last-session.json 损坏：${message(error)}` }
  }
  if (!isRecord(parsed) || parsed.version !== LAST_SESSION_VERSION) {
    return { file: empty, error: 'last-session.json 版本不支持，已忽略' }
  }
  const rawByCwd = parsed.byCwd
  if (!isRecord(rawByCwd)) {
    return { file: empty, error: 'last-session.json 缺少 byCwd，已忽略' }
  }
  const byCwd: Record<string, LastSessionEntry> = {}
  for (const [cwd, entry] of Object.entries(rawByCwd)) {
    if (!isRecord(entry)) continue
    const sessionId = entry.sessionId
    const lastUsedAt = entry.lastUsedAt
    if (typeof sessionId !== 'string' || sessionId === '') continue
    if (typeof lastUsedAt !== 'number' || !Number.isFinite(lastUsedAt)) continue
    byCwd[cwd] = { sessionId, lastUsedAt }
  }
  return { file: { version: LAST_SESSION_VERSION, byCwd } }
}

/** 在候选 cwd 写法里取 `lastUsedAt` 最新的一条（两个写法都命中时取更晚的）。 */
export function lookupLastSession(
  file: LastSessionFile,
  cwds: readonly string[],
): string | undefined {
  let best: LastSessionEntry | undefined
  for (const cwd of cwds) {
    const entry = file.byCwd[cwd]
    if (entry === undefined) continue
    if (best === undefined || entry.lastUsedAt > best.lastUsedAt) best = entry
  }
  return best?.sessionId
}

/**
 * 记录本次成功启动的会话；原子写（tmp + fsync + rename，0600）。
 * 读取失败时以官方列表为空表继续；写入失败由调用方写诊断。
 */
export function recordLastSession(
  dataRoot: string,
  cwd: string,
  sessionId: string,
  at = Date.now(),
): void {
  const { file } = readLastSession(dataRoot)
  const merged = new Map<string, LastSessionEntry>(Object.entries(file.byCwd))
  merged.set(cwd, { sessionId, lastUsedAt: at })
  const entries = [...merged.entries()]
    .sort((left, right) => right[1].lastUsedAt - left[1].lastUsedAt)
    .slice(0, LAST_SESSION_LIMIT)
  const byCwd: Record<string, LastSessionEntry> = {}
  for (const [key, entry] of entries) byCwd[key] = entry
  const body = JSON.stringify({ version: LAST_SESSION_VERSION, byCwd })

  mkdirSync(dataRoot, { recursive: true, mode: 0o700 })
  const target = lastSessionPath(dataRoot)
  const temporary = `${target}.tmp-${process.pid}`
  const fd = openSync(temporary, 'w', 0o600)
  try {
    writeSync(fd, body)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(temporary, target)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
