/**
 * CLI 解析与启动模式互斥（spec 2026-11-02-nano-session-lifecycle §3.1）。
 *
 * `--root` 的值不参与子命令判断：`nano --root purge` 里的 `purge` 是会话 id。
 * `-r` 的值同理；`-r` 后面没有值（或下一个 token 以 `-` 开头）时是面板模式。
 */

export interface CliArgs {
  readonly help: boolean
  readonly version: boolean
  readonly purge: boolean
  readonly yes: boolean
  /** `--root <id>`：精确会话身份的低级逃生口。 */
  readonly rootId?: string
  /** `-c` / `--continue`：续接当前 cwd 最近的顶层会话。 */
  readonly continueSession: boolean
  /** `-r <id>`：精确恢复；与 `resumePanel` 互斥（解析时只会命中一个）。 */
  readonly resumeId?: string
  /** `-r` / `--resume` 不带 id：先建新会话，再打开会话面板。 */
  readonly resumePanel: boolean
}

export function parseCli(argv: readonly string[]): CliArgs {
  let help = false
  let version = false
  let purge = false
  let yes = false
  let rootId: string | undefined
  let continueSession = false
  let resumeId: string | undefined
  let resumePanel = false

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--root') {
      const value = argv[index + 1]
      if (value === undefined) throw new Error('nano: --root 需要一个值')
      rootId = value
      index += 1
      continue
    }
    if (arg?.startsWith('--root=') === true) {
      rootId = arg.slice('--root='.length)
      continue
    }
    if (arg === '-c' || arg === '--continue') {
      continueSession = true
      continue
    }
    if (arg === '-r' || arg === '--resume') {
      const value = argv[index + 1]
      if (value !== undefined && !value.startsWith('-')) {
        resumeId = value
        resumePanel = false
        index += 1
      } else {
        resumeId = undefined
        resumePanel = true
      }
      continue
    }
    if (arg?.startsWith('--resume=') === true) {
      resumeId = arg.slice('--resume='.length)
      resumePanel = false
      continue
    }
    if (arg === '--help' || arg === '-h') help = true
    else if (arg === '--version' || arg === '-v') version = true
    else if (arg === 'purge' || arg === '--purge') purge = true
    else if (arg === '--yes' || arg === '-y') yes = true
  }

  return {
    help,
    version,
    purge,
    yes,
    ...(rootId !== undefined ? { rootId } : {}),
    continueSession,
    ...(resumeId !== undefined ? { resumeId } : {}),
    resumePanel,
  }
}

/** 启动模式的互斥检查；帮助 / 版本 / purge 在调用前已经短路。 */
export function assertLaunchMode(args: CliArgs): void {
  const resume = args.continueSession || args.resumeId !== undefined || args.resumePanel
  if (args.rootId !== undefined && resume) {
    throw new Error('--root 不能和 -c / -r 同时使用')
  }
  if (args.continueSession && (args.resumeId !== undefined || args.resumePanel)) {
    throw new Error('-c 和 -r 只能选一个')
  }
}
