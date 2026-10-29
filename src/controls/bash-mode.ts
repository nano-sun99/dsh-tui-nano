/**
 * 人工命令 `!`（S02 spec §3.3）。
 *
 * 用户亲手打的命令，单次按 `danger-full-access` 执行：只覆盖这一次的
 * sandbox policy，不改会话/mount/profile 的默认值；不注册官方 job，输出
 * 也不进任务表。非零退出是结果，不是基础设施错误。
 *
 * `!cmd` 的输出会以合成 user 消息注入模型（不新开回合、不当场唤醒）；
 * `!!cmd` 只在本窗口显示（inject:false）。
 */
export interface BashRunOptions {
  readonly ctx: any
  readonly command: string
  readonly workdir: string
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
}

export interface BashRunResult {
  readonly command: string
  readonly exitCode: number | null
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
  readonly aborted: boolean
}

function collect(output: any): string {
  if (!output) return ''
  if (typeof output === 'string') return output
  if (typeof output.text === 'string') return output.text
  if (typeof output.data === 'string') return output.data
  return ''
}

/** 解析输入框里的 `!` / `!!` 命令；不是人工命令时返回 undefined。 */
export function parseBashInput(text: string): { command: string; inject: boolean } | undefined {
  const trimmed = text.trimStart()
  if (!trimmed.startsWith('!')) return undefined
  const double = trimmed.startsWith('!!')
  const command = (double ? trimmed.slice(2) : trimmed.slice(1)).trim()
  if (command === '') return undefined
  return { command, inject: !double }
}

/** 单次 danger-full-access 执行；不改任何默认值。 */
export async function runBash(options: BashRunOptions): Promise<BashRunResult> {
  const { ctx, command, workdir, signal } = options
  const shell = ctx.get('shell')
  if (!shell) throw new Error('shell 服务不可用')
  const policyService = ctx.get('sandboxPolicy')
  const policy = policyService?.resolve?.({ mode: 'danger-full-access' })
  const spec = shell.resolve({
    command,
    workdir,
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    ...(signal ? { signal } : {}),
  })
  const execution = await shell.execute(policy ? { ...spec, sandboxPolicy: policy } : spec)
  const result = await execution.result()
  return {
    command,
    exitCode: result.exitCode,
    stdout: collect(result.stdout),
    stderr: collect(result.stderr),
    timedOut: result.timedOut === true,
    aborted: result.aborted === true,
  }
}

/** 给模型看的注入文本：命令、退出码与合并输出，明确不是用户指令。 */
export function renderBashInjection(result: BashRunResult): string {
  const status =
    result.timedOut ? '超时' : result.aborted ? '已取消' : `退出码 ${String(result.exitCode ?? 'null')}`
  const body = [result.stdout, result.stderr].filter((part) => part !== '').join('\n')
  return `[人工命令] $ ${result.command}\n${status}\n${body}`.trimEnd()
}
