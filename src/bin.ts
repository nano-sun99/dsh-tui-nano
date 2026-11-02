#!/usr/bin/env node
/**
 * CLI entry. Without the fd guard this process re-executes itself once so the
 * runtime's fd 1/2 point at a log file while stdin stays the terminal.
 */
// 必须是第一个 import：ESM 按 import 声明顺序求值，晚一步 react 就已经按
// 开发构建加载了（issue #138）。
import './boot/env.ts'
import { fileURLToPath } from 'node:url'
import { commandArgs } from './boot/cli.ts'
import { resolvePaths } from './boot/paths.ts'
import { main } from './main.ts'
import { isGuarded, launchGuarded } from './runtime/fd-guard.ts'

const argv = process.argv.slice(2)

const commands = commandArgs(argv)
// 非 TUI 命令不套 fd 守护：purge 的报错和确认必须留在用户终端上，
// 不能跟着 stdout/stderr 一起被绑进数据根的日志（而 purge 正要删它）。
const plain = commands.some((arg) =>
  ['--help', '-h', '--version', '-v', 'purge', '--purge'].includes(arg),
)

// S03 §2.1：engines 只警告，入口必须真拦。低于 22.19 的 Node 会在类型剥离、
// import.meta 等特性上直接炸出难懂的栈，这里先给可操作的错误。
type Semver = readonly [number, number, number]

const MIN_NODE: Semver = [22, 19, 0]

/** 预发布后缀（`22.19.0-rc.1`）按 semver 低于同号正式版。 */
function parseSemver(text: string): { core: Semver; prerelease: boolean } {
  const [coreText, ...rest] = text.split('-')
  const parts = (coreText ?? '').split('.').map((part) => Number.parseInt(part, 10))
  return {
    core: [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0],
    prerelease: rest.length > 0,
  }
}

function atLeast(actual: { core: Semver; prerelease: boolean }, minimum: Semver): boolean {
  for (let index = 0; index < 3; index++) {
    const a = actual.core[index] ?? 0
    const b = minimum[index] ?? 0
    if (a > b) return true
    if (a < b) return false
  }
  return !actual.prerelease
}

if (!atLeast(parseSemver(process.versions.node), MIN_NODE)) {
  process.stderr.write(
    `nano: 需要 Node.js >= ${MIN_NODE.join('.')}，当前 ${process.versions.node}。\n` +
      '请升级 Node 后重试，例如：nvm install 22.19 && nvm use 22.19\n',
  )
  process.exit(1)
}

try {
  if (!isGuarded() && !plain) {
    const code = await launchGuarded({
      argv,
      logsDir: resolvePaths().logsDir,
      entryScript: fileURLToPath(import.meta.url),
    })
    process.exit(code)
  }
  const code = await main(argv)
  process.exit(code)
} catch (error) {
  process.stderr.write(
    `nano: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  )
  process.exit(1)
}
