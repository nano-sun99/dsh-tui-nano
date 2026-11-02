/**
 * 启动目标选择（spec 2026-11-02-nano-session-lifecycle §3）。
 *
 * `nano` 默认生成新会话；`-c` / `-r <id>` 是 resume-only，NotFound 不创建；
 * `-r` 不带 id 先建默认新会话再开面板；`--root` 保留 resume-or-create。
 */
import { continueCandidates, cwdVariants, isTopLevelSession, sameCwd } from '../sessions/filters.ts'
import type { CliArgs } from './cli.ts'
import { lookupLastSession, readLastSession } from './last-session.ts'
import { resolveRootId, validateRootId } from './root.ts'
import type { SessionIndex } from './session-index.ts'

export const CONTINUE_EMPTY_MESSAGE = '当前目录没有可续接的会话。直接运行 nano 开新会话。'

export function resumeNotFoundMessage(id: string): string {
  return `会话 ${id} 不存在。用 nano -r 打开选择器（跨目录先按 a 看全部目录）。`
}

export function crossDirectoryMessage(cwd: string): string {
  return `该会话属于 ${cwd}；请在该目录启动 nano。`
}

export interface StartupSelection {
  readonly rootId: string
  /** true 时官方 NotFound 必须报错，不得 create。 */
  readonly resumeOnly: boolean
  /** resume-only 目标在启动时消失时给用户看的文案。 */
  readonly notFoundMessage?: string
  /** `-r` 不带 id：首个正式帧后打开会话面板。 */
  readonly openSessionsPanel: boolean
}

export interface StartupOptions {
  readonly args: CliArgs
  readonly dataRoot: string
  readonly cwd: string
  readonly openIndex: () => Promise<SessionIndex>
  readonly onDiagnostic?: (line: string) => void
}

export async function selectStartupRoot(options: StartupOptions): Promise<StartupSelection> {
  if (options.args.continueSession) return selectContinue(options)
  if (options.args.resumeId !== undefined) return selectResume(options)
  if (options.args.resumePanel) {
    return {
      rootId: resolveRootId().id,
      resumeOnly: false,
      openSessionsPanel: true,
    }
  }
  return {
    rootId: resolveRootId(options.args.rootId).id,
    resumeOnly: false,
    openSessionsPanel: false,
  }
}

async function selectContinue(options: StartupOptions): Promise<StartupSelection> {
  const index = await openIndex(options)
  try {
    const candidates = continueCandidates(await index.list(), options.cwd)
    if (candidates.length === 0) throw new Error(CONTINUE_EMPTY_MESSAGE)
    const { file, error } = readLastSession(options.dataRoot)
    if (error !== undefined) options.onDiagnostic?.(`nano: ${error}`)
    const remembered = lookupLastSession(file, cwdVariants(options.cwd))
    const chosen = candidates.find((record) => record.header.id === remembered) ?? candidates[0]
    if (chosen === undefined) throw new Error(CONTINUE_EMPTY_MESSAGE)
    return {
      rootId: chosen.header.id,
      resumeOnly: true,
      notFoundMessage: CONTINUE_EMPTY_MESSAGE,
      openSessionsPanel: false,
    }
  } finally {
    await index.close()
  }
}

async function selectResume(options: StartupOptions): Promise<StartupSelection> {
  const id = options.args.resumeId
  if (id === undefined) throw new Error('nano: -r 缺少会话 id')
  validateRootId(id)
  const index = await openIndex(options)
  try {
    const record = (await index.list()).find(
      (candidate) => candidate.header.id === id && isTopLevelSession(candidate.header),
    )
    if (record === undefined) throw new Error(resumeNotFoundMessage(id))
    const headerCwd = record.header.cwd
    if (headerCwd !== undefined && !sameCwd(headerCwd, cwdVariants(options.cwd))) {
      throw new Error(crossDirectoryMessage(headerCwd))
    }
    return {
      rootId: id,
      resumeOnly: true,
      notFoundMessage: resumeNotFoundMessage(id),
      openSessionsPanel: false,
    }
  } finally {
    await index.close()
  }
}

async function openIndex(options: StartupOptions): Promise<SessionIndex> {
  try {
    return await options.openIndex()
  } catch (error) {
    throw new Error(`nano: 无法读取本地会话列表：${message(error)}`)
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
