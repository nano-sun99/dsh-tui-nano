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
import { AppExit, AppRestart, NanoApp, RENDER_INTERVAL_MS } from './app/nano-app.ts'
import { Skeleton } from './app/skeleton.tsx'
import { type PreparedCore, prepareCore, startCore } from './boot/assemble.ts'
import {
  assertLaunchMode,
  assertPermissionArgs,
  parseCli,
  resolvePermissionMode,
} from './boot/cli.ts'
import { recordLastSession } from './boot/last-session.ts'
import { loadOfficial, type OfficialModules, PINNED_HARNESS_VERSION } from './boot/official.ts'
import { type Paths, resolvePaths } from './boot/paths.ts'
import {
  acquireMountClaim,
  hasStaleMountClaim,
  type MountClaim,
  releaseMountClaim,
} from './boot/root.ts'
import { openSessionIndex } from './boot/session-index.ts'
import { type StartupSelection, selectStartupRoot } from './boot/startup.ts'
import { Features } from './controls/feature-host.ts'
import { FEATURE_KEYBINDINGS } from './controls/feature-keys.ts'
import { ConversationController } from './conversation/controller.ts'
import { HistoryStore } from './input/history.ts'
import { describeBindings } from './input/keymap.ts'
import { renderKeymapHelp } from './input/keymap-docs.ts'
import { Renderer } from './render/renderer.ts'
import { writeDiagnostic } from './runtime/diagnostic.ts'
import { startHeapWatch } from './runtime/heap-watch.ts'
import { Terminal } from './runtime/terminal.ts'
import { featureBootPatches } from './sessions/boot-patches.ts'
import { activeTheme } from './theme/theme.ts'

export async function main(argv: readonly string[]): Promise<number> {
  const args = parseCli(argv)
  // 状态行与 `--version` 共用同一份读取结果，避免两次读盘结果不一致。
  const version = nanoVersion()
  if (args.help) {
    process.stdout.write(helpText())
    return 0
  }
  if (args.version) {
    process.stdout.write(`nano ${version ?? 'unknown'} (harness ${PINNED_HARNESS_VERSION})\n`)
    return 0
  }
  try {
    // purge 之前先拦：`--permission-mode purge` 已把 purge 当值吃掉，
    // 这里再拒未知 preset，确保不会误删数据根。
    assertPermissionArgs(args)
  } catch (error) {
    reportVisible(message(error))
    return 1
  }
  const paths = resolvePaths()
  if (args.purge) {
    // S03 §2.2：普通卸载保留数据根，只有显式 purge 才删；交互确认，--yes 跳过。
    if (!(await confirmPurge(paths.dataRoot, args.yes))) return 1
    rmSync(paths.dataRoot, { recursive: true, force: true })
    process.stdout.write(`nano: 已删除数据根 ${paths.dataRoot}\n`)
    return 0
  }
  // `--root` 缺值不在解析期抛错：help / version / purge 的顺序保持不变。
  if (args.rootMissing) {
    reportVisible('nano: --root 需要一个值')
    return 1
  }
  try {
    assertLaunchMode(args)
    // 在 prepareCore 读取 profile patch 之前落定；CLI > 环境 > nano 默认。
    process.env.DSH_PERMISSION_MODE = resolvePermissionMode(args, process.env.DSH_PERMISSION_MODE)
  } catch (error) {
    reportVisible(message(error))
    return 1
  }
  if (process.stdin.isTTY !== true) {
    reportVisible('nano: 需要在真实终端中运行（stdin 不是 TTY）。')
    return 1
  }

  // 骨架前：版本 / profile / 会话目标 / 认领。
  let official: OfficialModules
  try {
    official = await loadOfficial()
  } catch (error) {
    reportVisible(message(error))
    return 1
  }

  let startup: StartupSelection
  try {
    startup = await selectStartupRoot({
      args,
      dataRoot: paths.dataRoot,
      cwd: process.cwd(),
      openIndex: () => openSessionIndex(official, paths.dataRoot),
      onDiagnostic: (line) => process.stderr.write(`${line}\n`),
    })
  } catch (error) {
    reportVisible(message(error))
    return 1
  }
  const rootId = startup.rootId

  // Spec order: ensure profile → take the mount claim (root identity is chosen above).
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
      // 动画节拍与内容刷新共用同一个常量（spec §5.2，单一来源在 app 层）。
      activityIntervalMs: RENDER_INTERVAL_MS,
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
      resumeOnly: startup.resumeOnly,
      ...(startup.notFoundMessage !== undefined
        ? { notFoundMessage: startup.notFoundMessage }
        : {}),
    })
    conversation.model.appendNotice(buildStartupSources(paths, prepared), 'info')
    await conversation.start()
    // `-c` 的导航提示：成功启动后更新；写失败只写诊断，不阻塞启动。
    try {
      recordLastSession(paths.dataRoot, process.cwd(), rootId)
    } catch (error) {
      process.stderr.write(`nano: last-session 写入失败：${message(error)}\n`)
    }
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
      ...(version !== undefined ? { version } : {}),
      openSessionsPanel: startup.openSessionsPanel,
      writeDiagnostic: (line) => writeDiagnostic(line),
      features: new Features(),
    })
    // 只看不救：真炸时日志里至少要有一行「当时堆多大」（issue #138）。
    startHeapWatch({ report: (line) => process.stderr.write(`${line}\n`) })
    try {
      await app.start()
      return 0
    } catch (error) {
      if (error instanceof AppRestart) {
        return await relaunchInto(error.rootId, error.resumeOnly)
      }
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
 * 受控重启：终端已恢复、认领已释放，交回 launcher 重新拉起。
 * 目标已存在（面板切换 / 冷改名）用 `-r <id>`，NotFound 不创建；
 * 只有显式 `--root` 路径才保留 resume-or-create。清掉 `NANO_GUARDED` 重新走 fd 守护。
 */
function relaunchInto(rootId: string, resumeOnly: boolean): Promise<number> {
  return new Promise((resolve) => {
    const env = { ...process.env }
    delete env.NANO_GUARDED
    const mode = resumeOnly ? ['-r', rootId] : ['--root', rootId]
    const child = spawn(process.execPath, [process.argv[1] as string, ...mode], {
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

/** 删除数据根前的人类确认；非交互环境必须显式 `--yes`，不默认放行。 */
async function confirmPurge(dataRoot: string, yes: boolean): Promise<boolean> {
  if (yes) return true
  if (process.stdin.isTTY !== true) {
    reportVisible('nano: 删除数据根需要交互确认；非交互环境请用 `nano purge --yes`。')
    return false
  }
  // 提示必须落在终端上：stdout 被重定向（`nano purge > log`、管道、IDE 捕获）时
  // 写 stdout 会让用户只看见光标在等，不知道在等什么。
  writeToTty(`将删除数据根 ${dataRoot}（含 profile、会话、历史），不可撤销。\n输入 yes 继续：\n`)
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
    '用法：nano [-c | -r [<id>] | --root <id>] [--permission-mode <preset> | --dangerously-skip-permissions] [--help] [--version] [purge [--yes]]',
    '',
    '  无参数          新建会话（每次启动都是新上下文）',
    '  -c, --continue  续接当前目录最近使用的会话（不存在则报错，不新建）',
    '  -r, --resume    打开会话选择器；-r <id> 精确恢复（不存在则报错）',
    '  --root <id>     使用指定会话身份（不存在则新建；日常续接用 -c / -r）',
    '  --permission-mode <preset>  设置本次会话的权限模式（默认 danger-full-access）',
    '                  可选：read-only、workspace-write、danger-full-access',
    '  --dangerously-skip-permissions  等同 --permission-mode danger-full-access',
    '  --help          显示本帮助与键位表',
    '  --version       显示版本',
    '  purge           删除数据根（含 profile；不可撤销；交互确认）',
    '  --yes, -y       配合 purge，跳过交互确认',
    '',
    renderKeymapHelp([...describeBindings(), ...FEATURE_KEYBINDINGS]),
    '',
  ].join('\n')
}

/**
 * 版本号来自已安装包自己的 package.json，升级后 `--version` 与状态行才会跟着变。
 * 读不到时返回 undefined：状态行只显示 cwd，不显示假版本（spec §3.1）。
 */
function nanoVersion(): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version?: string
    }
    return typeof pkg.version === 'string' && pkg.version !== '' ? pkg.version : undefined
  } catch {
    return undefined
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Write a fatal message to the log and directly to the terminal. */
/** 同时写 stderr 与 `/dev/tty`；没有控制终端时至少 stderr 有。 */
function writeToTty(text: string): void {
  writeDiagnostic(text)
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
