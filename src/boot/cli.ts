/**
 * CLI 解析与启动模式互斥（spec 2026-11-02-nano-session-lifecycle §3.1）。
 *
 * `--root` 的值不参与子命令判断：`nano --root purge` 里的 `purge` 是会话 id。
 * `-r` 的值同理；`-r` 后面没有值（或下一个 token 以 `-` 开头）时是面板模式。
 */

/** 官方 base 的 3 个 preset；顺序用于报错时列出可选项。 */
export const PERMISSION_MODES = ['read-only', 'workspace-write', 'danger-full-access'] as const
export type PermissionMode = (typeof PERMISSION_MODES)[number]

export interface CliArgs {
  readonly help: boolean
  readonly version: boolean
  readonly purge: boolean
  readonly yes: boolean
  /** `--root <id>`：精确会话身份的低级逃生口。 */
  readonly rootId?: string
  /** `--root` 缺值；不在解析期抛错，让 help / version / purge 的顺序不变。 */
  readonly rootMissing: boolean
  /** `-c` / `--continue`：续接当前 cwd 最近的顶层会话。 */
  readonly continueSession: boolean
  /** `-r <id>`：精确恢复；与 `resumePanel` 互斥（解析时只会命中一个）。 */
  readonly resumeId?: string
  /** `-r` / `--resume` 不带 id：先建新会话，再打开会话面板。 */
  readonly resumePanel: boolean
  /** `--permission-mode <preset>`：本次进程的权限 preset。 */
  readonly permissionMode?: string
  /** `--permission-mode` 缺值；同样不在解析期抛错。 */
  readonly permissionModeMissing: boolean
  /** `--dangerously-skip-permissions`：等价 danger-full-access。 */
  readonly dangerouslySkipPermissions: boolean
}

export function parseCli(argv: readonly string[]): CliArgs {
  let help = false
  let version = false
  let purge = false
  let yes = false
  let rootId: string | undefined
  let rootMissing = false
  let continueSession = false
  let resumeId: string | undefined
  let resumePanel = false
  let permissionMode: string | undefined
  let permissionModeMissing = false
  let dangerouslySkipPermissions = false

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--permission-mode') {
      const value = argv[index + 1]
      if (value === undefined) {
        permissionModeMissing = true
        continue
      }
      permissionMode = value
      index += 1
      continue
    }
    if (arg?.startsWith('--permission-mode=') === true) {
      permissionMode = arg.slice('--permission-mode='.length)
      continue
    }
    if (arg === '--dangerously-skip-permissions') {
      dangerouslySkipPermissions = true
      continue
    }
    if (arg === '--root') {
      const value = argv[index + 1]
      if (value === undefined) {
        rootMissing = true
        continue
      }
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
    rootMissing,
    continueSession,
    ...(resumeId !== undefined ? { resumeId } : {}),
    resumePanel,
    ...(permissionMode !== undefined ? { permissionMode } : {}),
    permissionModeMissing,
    dangerouslySkipPermissions,
  }
}

/**
 * 权限开关的启动前检查：缺值、两个开关互斥、purge 与权限开关互斥、未知 preset。
 * 必须在 purge 分支之前调用；`--permission-mode purge` 已把 purge 当值吃掉，
 * 所以不会误进 purge 分支。
 */
export function assertPermissionArgs(args: CliArgs): void {
  if (args.permissionModeMissing) throw new Error('nano: --permission-mode 需要一个值')
  if (args.permissionMode !== undefined && args.dangerouslySkipPermissions) {
    throw new Error('nano: --permission-mode 不能和 --dangerously-skip-permissions 同时使用')
  }
  const permissionFlag = args.permissionMode !== undefined || args.dangerouslySkipPermissions
  if (args.purge && permissionFlag) {
    throw new Error(
      'nano: purge 不能和 --permission-mode / --dangerously-skip-permissions 同时使用',
    )
  }
  const requested = args.dangerouslySkipPermissions ? 'danger-full-access' : args.permissionMode
  if (requested !== undefined && !isPermissionMode(requested)) {
    throw new Error(unknownPermissionMode(requested))
  }
}

/** CLI > DSH_PERMISSION_MODE > nano 默认 danger-full-access。 */
export function resolvePermissionMode(args: CliArgs, envValue: string | undefined): PermissionMode {
  const requested =
    args.dangerouslySkipPermissions === true
      ? 'danger-full-access'
      : (args.permissionMode ?? (envValue === '' ? undefined : envValue) ?? 'danger-full-access')
  if (!isPermissionMode(requested)) throw new Error(unknownPermissionMode(requested))
  return requested
}

export function isPermissionMode(value: string): value is PermissionMode {
  return (PERMISSION_MODES as readonly string[]).includes(value)
}

function unknownPermissionMode(value: string): string {
  return `nano: 未知权限模式 ${value}；可选值：${PERMISSION_MODES.join('、')}`
}

/**
 * 判断子命令前先剥掉带值的参数，进度与 main 的解析保持一致：
 * `nano --root purge`、`nano -r purge`、`nano --permission-mode purge --yes`
 * 里的 `purge` 都是值，不是子命令。
 */
export function commandArgs(args: readonly string[]): string[] {
  const out: string[] = []
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--root' || arg === '--permission-mode') {
      index += 1
      continue
    }
    if (arg?.startsWith('--root=') === true) continue
    if (arg?.startsWith('--permission-mode=') === true) continue
    if (arg === '-r' || arg === '--resume') {
      const value = args[index + 1]
      if (value !== undefined && !value.startsWith('-')) index += 1
      continue
    }
    if (arg?.startsWith('--resume=') === true) continue
    if (arg !== undefined) out.push(arg)
  }
  return out
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
