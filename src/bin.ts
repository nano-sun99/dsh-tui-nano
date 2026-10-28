#!/usr/bin/env node
/**
 * CLI entry. Without the fd guard this process re-executes itself once so the
 * runtime's fd 1/2 point at a log file while stdin stays the terminal.
 */
import { fileURLToPath } from 'node:url'
import { resolvePaths } from './boot/paths.ts'
import { main } from './main.ts'
import { isGuarded, launchGuarded } from './runtime/fd-guard.ts'

const argv = process.argv.slice(2)
const plain =
  argv.includes('--help') ||
  argv.includes('-h') ||
  argv.includes('--version') ||
  argv.includes('-v')

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
