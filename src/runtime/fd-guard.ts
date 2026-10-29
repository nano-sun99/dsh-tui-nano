/**
 * fd-level stdout/stderr guard. Node cannot dup2 its own fds, so the launcher
 * re-executes the runtime with fd 1/2 bound to a log file while stdin stays
 * the terminal. The runtime then renders through an independent `/dev/tty`
 * handle: no library writing to fd 1/2 can ever reach the screen.
 */
import { spawn } from 'node:child_process'
import { closeSync, mkdirSync, openSync } from 'node:fs'
import { join } from 'node:path'

export const GUARD_ENV = 'NANO_GUARDED'

export function isGuarded(): boolean {
  return process.env[GUARD_ENV] === '1'
}

export interface GuardOptions {
  readonly argv: readonly string[]
  readonly logsDir: string
  readonly entryScript: string
}

/** Re-exec once with redirected fds; returns the child's exit code. */
export function launchGuarded(options: GuardOptions): Promise<number> {
  mkdirSync(options.logsDir, { recursive: true, mode: 0o700 })
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-')
  const logPath = join(options.logsDir, `nano-${stamp}-${process.pid}.log`)
  const logFd = openSync(logPath, 'a', 0o600)
  try {
    const child = spawn(process.execPath, [options.entryScript, ...options.argv], {
      stdio: ['inherit', logFd, logFd],
      env: { ...process.env, [GUARD_ENV]: '1', NANO_LOG_FILE: logPath },
    })
    const forward = (signal: NodeJS.Signals) => {
      try {
        child.kill(signal)
      } catch {
        // Child already exited.
      }
    }
    const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP']
    for (const signal of signals) process.on(signal, forward)
    return new Promise<number>((resolve) => {
      child.on('error', (error) => {
        process.stderr.write(`nano: 启动运行时失败：${String(error)}\n`)
        resolve(1)
      })
      child.on('exit', (code, signal) => {
        for (const entry of signals) process.off(entry, forward)
        if (signal) {
          process.stderr.write(`nano: 运行时被信号 ${signal} 终止；日志：${logPath}\n`)
          resolve(signal === 'SIGINT' ? 0 : 1)
          return
        }
        resolve(code ?? 1)
      })
    })
  } finally {
    closeSync(logFd)
  }
}
