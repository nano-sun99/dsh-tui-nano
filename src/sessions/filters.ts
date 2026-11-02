/**
 * 会话候选的公共过滤（spec 2026-11-02-nano-session-lifecycle §3.3 / §3.4）。
 *
 * 身份只认官方 `sessionId` 与 header 字段；不按 cwd 名、标题或文件路径猜。
 */
import { realpathSync } from 'node:fs'

export interface SessionHeaderView {
  readonly id: string
  readonly cwd?: string
  readonly createdAt: number
  readonly parentSession?: string
  readonly origin?: 'subagent'
  readonly delegationDepth?: number
}

export interface SessionRecordView {
  readonly header: SessionHeaderView
  readonly live?: boolean
  readonly persisted?: boolean
}

/**
 * 当前 cwd 的两种合法写法：`process.cwd()` 与 `realpathSync.native()`。
 * 任一与 header.cwd 相等即视为同目录。
 */
export function cwdVariants(cwd: string): string[] {
  const variants = [cwd]
  try {
    const real = realpathSync.native(cwd)
    if (real !== cwd) variants.push(real)
  } catch {
    // cwd 已不存在时只保留原写法；比较会自然落空。
  }
  return variants
}

export function sameCwd(headerCwd: string | undefined, variants: readonly string[]): boolean {
  return headerCwd !== undefined && variants.includes(headerCwd)
}

/** 顶层会话：没有父会话、不是 subagent、委派深度为 0。 */
export function isTopLevelSession(header: SessionHeaderView): boolean {
  return (
    header.parentSession === undefined &&
    header.origin !== 'subagent' &&
    (header.delegationDepth ?? 0) === 0
  )
}

/** 官方列表已是新优先；这里再做一次确定性排序，避免测试依赖实现细节。 */
export function sortNewestFirst(records: readonly SessionRecordView[]): SessionRecordView[] {
  return [...records].sort(
    (left, right) =>
      right.header.createdAt - left.header.createdAt ||
      left.header.id.localeCompare(right.header.id),
  )
}

/** `-c` 候选：同 cwd 的顶层会话，按官方新优先排序。 */
export function continueCandidates(
  records: readonly SessionRecordView[],
  cwd: string,
): SessionRecordView[] {
  const variants = cwdVariants(cwd)
  return sortNewestFirst(
    records.filter(
      (record) => isTopLevelSession(record.header) && sameCwd(record.header.cwd, variants),
    ),
  )
}
