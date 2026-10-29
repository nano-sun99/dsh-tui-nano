/** Filesystem anchors: Nano's data root and the official DSH home. */
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface Paths {
  readonly dataRoot: string
  readonly home: string
  readonly profileDir: string
  readonly sessionsDir: string
  readonly storageDir: (rootId: string) => string
  readonly mountDir: string
  readonly logsDir: string
  readonly historyFile: string
}

/** `NANO_DATA_ROOT` exists for tests and evidence runs; production uses ~/.dsh-tui-nano. */
export function resolveDataRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.NANO_DATA_ROOT && env.NANO_DATA_ROOT !== ''
    ? env.NANO_DATA_ROOT
    : join(homedir(), '.dsh-tui-nano')
}

export function resolveDshHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.DSH_HOME && env.DSH_HOME !== '' ? env.DSH_HOME : join(homedir(), '.dsh')
}

export function resolvePaths(env: NodeJS.ProcessEnv = process.env): Paths {
  const dataRoot = resolveDataRoot(env)
  return {
    dataRoot,
    home: resolveDshHome(env),
    profileDir: join(dataRoot, 'profile'),
    sessionsDir: join(dataRoot, 'sessions'),
    storageDir: (rootId: string) => join(dataRoot, 'runtime-data', rootId, 'storage'),
    mountDir: join(dataRoot, 'mount'),
    logsDir: join(dataRoot, 'logs'),
    historyFile: join(dataRoot, 'history.jsonl'),
  }
}
