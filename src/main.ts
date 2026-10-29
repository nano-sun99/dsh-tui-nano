/**
 * Startup sequence (spec §2.3): version/profile/root/claim failures happen
 * before the alternate screen; the pre-boot skeleton appears before `boot()`;
 * any failure after that restores the terminal and reports visibly.
 */

import { spawn } from 'node:child_process'
import { closeSync, existsSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createElement } from 'react'
import { AppExit, AppRestart, NanoApp } from './app/nano-app.ts'
import { Skeleton } from './app/skeleton.tsx'
import { type PreparedCore, prepareCore, startCore } from './boot/assemble.ts'
import { loadOfficial, type OfficialModules, PINNED_HARNESS_VERSION } from './boot/official.ts'
import { type Paths, resolvePaths } from './boot/paths.ts'
import {
  acquireMountClaim,
  hasStaleMountClaim,
  type MountClaim,
  releaseMountClaim,
  resolveRootId,
  writeLastRoot,
} from './boot/root.ts'
import { Features } from './controls/feature-host.ts'
import { FEATURE_KEYBINDINGS } from './controls/feature-keys.ts'
import { ConversationController } from './conversation/controller.ts'
import { HistoryStore } from './input/history.ts'
import { describeBindings } from './input/keymap.ts'
import { renderKeymapHelp } from './input/keymap-docs.ts'
import { Renderer } from './render/renderer.ts'
import { Terminal } from './runtime/terminal.ts'
import { featureBootPatches } from './sessions/boot-patches.ts'
import { activeTheme } from './theme/theme.ts'

interface CliArgs {
  readonly help: boolean
  readonly version: boolean
  readonly purge: boolean
  readonly yes: boolean
}

export async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv)
  if (args.help) {
    process.stdout.write(helpText())
    return 0
  }
  if (args.version) {
    process.stdout.write(`nano ${nanoVersion()} (harness ${PINNED_HARNESS_VERSION})\n`)
    return 0
  }
  const paths = resolvePaths()
  if (args.purge) {
    // S03 §2.2：普通卸载保留数据根，只有显式 purge 才删；交互确认，--yes 跳过。
    if (!(await confirmPurge(paths.dataRoot, args.yes))) return 1
    rmSync(paths.dataRoot, { recursive: true, force: true })
    process.stdout.write(`nano: 已删除数据根 ${paths.dataRoot}\n`)
    return 0
  }
  if (process.stdin.isTTY !== true) {
    reportVisible('nano: 需要在真实终端中运行（stdin 不是 TTY）。')
    return 1
  }

  // 骨架前：版本 / profile / 根身份 / 认领。
  let official: OfficialModules
  try {
    official = await loadOfficial()
  } catch (error) {
    reportVisible(message(error))
    return 1
  }

  let rootId: string
  try {
    rootId = resolveRootId(paths.dataRoot, argv).id
  } catch (error) {
    reportVisible(message(error))
    return 1
  }

  // Spec order: ensure profile → persist root identity → take the mount claim.
  let prepared: PreparedCore
  try {
    prepared = await prepareCore({
      official,
      dataRoot: paths.dataRoot,
      home: paths.home,
      cwd: process.cwd(),
      rootId,
      extraPatches: featureBootPatches(rootId),
    })
  } catch (error) {
    reportVisible(message(error))
    return 1
  }

  try {
    writeLastRoot(paths.dataRoot, rootId)
  } catch (error) {
    reportVisible(message(error))
    return 1
  }

  const dirty = hasStaleMountClaim(paths.dataRoot, rootId)
  let claim: MountClaim
  try {
    claim = acquireMountClaim(paths.dataRoot, rootId)
  } catch (error) {
    reportVisible(message(error))
    return 1
  }

  const theme = activeTheme()
  const terminal = new Terminal({
    onInput: (events) => app?.handleInput(events),
    onResize: (width, height) => app?.handleResize(width, height),
    onError: (error) => process.stderr.write(`nano: 输入解析失败：${String(error)}\n`),
  })
  let app: NanoApp | undefined
  let core: Awaited<ReturnType<typeof startCore>> | undefined
  const earlySignals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const
  const earlySignalHandler = (signal: NodeJS.Signals) => {
    terminal.restore()
    releaseMountClaim(claim)
    reportVisible(`nano: 启动被 ${signal} 中断`)
    process.exit(1)
  }
  try {
    terminal.enter()
    // Protect the window between taking the terminal and NanoApp registering
    // its own handlers: a signal here must still restore the terminal.
    for (const signal of earlySignals) process.once(signal, earlySignalHandler)
    const renderer = new Renderer({
      write: (bytes) => terminal.write(bytes),
      width: terminal.width,
      height: terminal.height,
      defaultFg: theme.fg,
      onError: (error) => process.stderr.write(`nano: 渲染错误：${String(error)}\n`),
    })
    renderer.mount(
      createElement(Skeleton, {
        theme,
        width: terminal.width,
        height: terminal.height,
        rootId,
        profileDir: prepared.ensuredProfile.dir,
        ...(dirty
          ? { dirtyNotice: '检测到上次异常退出（强杀？）。若终端显示异常，请运行 reset。' }
          : {}),
      }),
    )

    core = await startCore(prepared)
    const history = new HistoryStore(paths.historyFile, process.cwd(), () => rootId)
    const conversation = new ConversationController({
      ctx: core.ctx,
      official,
      rootId,
      cwd: process.cwd(),
      history,
    })
    conversation.model.appendNotice(buildStartupSources(paths, prepared), 'info')
    await conversation.start()
    for (const signal of earlySignals) process.off(signal, earlySignalHandler)
    app = new NanoApp({
      core,
      official,
      terminal,
      renderer,
      claim,
      dataRoot: paths.dataRoot,
      cwd: process.cwd(),
      rootId,
      conversation,
      history,
      writeDiagnostic: (line) => process.stderr.write(`${line}\n`),
      features: new Features(),
    })
    try {
      await app.start()
      return 0
    } catch (error) {
      if (error instanceof AppRestart) return await relaunchInto(error.rootId)
      if (error instanceof AppExit) return error.code
      throw error
    }
  } catch (error) {
    terminal.restore()
    if (core) {
      try {
        await core.dispose()
      } catch {
        // Startup failure already reported; disposal is best effort.
      }
    }
    releaseMountClaim(claim)
    reportVisible(`nano: 启动失败：${message(error)}`)
    return 1
  } finally {
    for (const signal of earlySignals) process.off(signal, earlySignalHandler)
    terminal.restore()
  }
}

/**
 * 受控重启：终端已恢复、认领已释放，交回 launcher 以 `--root <rootId>` 重新拉起。
 * 清掉 `NANO_GUARDED`，让新进程重新走 fd 守护。
 */
function relaunchInto(rootId: string): Promise<number> {
  return new Promise((resolve) => {
    const env = { ...process.env }
    delete env.NANO_GUARDED
    const child = spawn(process.execPath, [process.argv[1] as string, '--root', rootId], {
      stdio: ['inherit', 'inherit', 'inherit'],
      env,
    })
    child.on('error', (error) => {
      reportVisible(`nano: 重启失败：${String(error)}`)
      resolve(1)
    })
    child.on('exit', (code, signal) => resolve(signal ? 1 : (code ?? 1)))
  })
}

/** B8: show where configuration, credentials and global instructions came from. */
function buildStartupSources(paths: Paths, prepared: PreparedCore): string {
  const credential = join(paths.home, '.credentials.yaml')
  const credentials = existsSync(credential)
    ? `${credential}（不显示值）`
    : `${credential}（未找到）`
  const globalInstructions =
    [join(paths.home, 'AGENTS.md'), join(homedir(), '.agents', 'AGENTS.md')]
      .filter((path) => existsSync(path))
      .join(' → ') || '无'
  const layers = Array.isArray(prepared.profile.layers)
    ? prepared.profile.layers
        .map((layer: any) => String(layer.packageName ?? layer.name ?? '?'))
        .slice(0, 6)
    : []
  return [
    '已加载来源：',
    `profile ${prepared.ensuredProfile.dir}`,
    `settings ${prepared.ensuredProfile.patchPath}`,
    `生效层 ${layers.length > 0 ? layers.join('、') : '无'}`,
    `凭据 ${credentials}`,
    `全局指令 ${globalInstructions}`,
  ].join(' ')
}

function parseArgs(argv: readonly string[]): CliArgs {
  let help = false
  let version = false
  let purge = false
  let yes = false
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    // `--root <id>` 的值不是子命令：root id 允许叫 `purge`。
    if (arg === '--root') {
      index += 1
      continue
    }
    if (arg?.startsWith('--root=') === true) continue
    if (arg === '--help' || arg === '-h') help = true
    else if (arg === '--version' || arg === '-v') version = true
    else if (arg === 'purge' || arg === '--purge') purge = true
    else if (arg === '--yes' || arg === '-y') yes = true
  }
  return { help, version, purge, yes }
}

/** 删除数据根前的人类确认；非交互环境必须显式 `--yes`，不默认放行。 */
async function confirmPurge(dataRoot: string, yes: boolean): Promise<boolean> {
  if (yes) return true
  if (process.stdin.isTTY !== true) {
    reportVisible('nano: 删除数据根需要交互确认；非交互环境请用 `nano purge --yes`。')
    return false
  }
  // 提示必须落在终端上：stdout 被重定向（`nano purge > log`、管道、IDE 捕获）时
  // 写 stdout 会让用户只看见光标在等，不知道在等什么。
  writeToTty(`将删除数据根 ${dataRoot}（含 profile、会话、历史），不可撤销。\n输入 yes 继续：`)
  const { createInterface } = await import('node:readline')
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  try {
    const answer = await new Promise<string>((resolve) => {
      rl.once('line', (line) => resolve(line))
      rl.once('close', () => resolve(''))
    })
    return answer.trim().toLowerCase() === 'yes'
  } finally {
    rl.close()
  }
}

function helpText(): string {
  return [
    'nano — DeepSeek Harness 的终端界面',
    '',
    '用法：nano [--root <id>] [--help] [--version] [purge [--yes]]',
    '',
    '  --root <id>   指定根会话身份（默认沿用上一次的根）',
    '  --help        显示本帮助与键位表',
    '  --version     显示版本',
    '  purge         删除数据根（含 profile；不可撤销；交互确认）',
    '  --yes, -y     配合 purge，跳过交互确认',
    '',
    renderKeymapHelp([...describeBindings(), ...FEATURE_KEYBINDINGS]),
    '',
  ].join('\n')
}

/** 版本号来自已安装包自己的 package.json，升级后 `--version` 才会跟着变。 */
function nanoVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version?: string
    }
    return pkg.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Write a fatal message to the log and directly to the terminal. */
/** 同时写 stderr 与 `/dev/tty`；没有控制终端时至少 stderr 有。 */
function writeToTty(text: string): void {
  process.stderr.write(text)
  try {
    const fd = openSync('/dev/tty', 'w')
    try {
      writeSync(fd, text)
    } finally {
      closeSync(fd)
    }
  } catch {
    // No controlling terminal; stderr already carries the message.
  }
}

function reportVisible(text: string): void {
  writeToTty(`${text}\n`)
}
