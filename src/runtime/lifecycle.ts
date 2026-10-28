/**
 * Ordered shutdown with lifecycle hooks (D01). S01 owns the phases; S02
 * registers drain work (schedule, monitor, PTY, root turn cancellation) without
 * S01 knowing what those resources are.
 *
 * Budgets: every phase has its own deadline, the whole graceful path is capped
 * at 10s, and a repeated signal jumps straight to terminal restore.
 */

export type LifecyclePhase = 'freeze' | 'drain' | 'flush' | 'release' | 'restore'

export const PHASE_ORDER: readonly LifecyclePhase[] = [
  'freeze',
  'drain',
  'flush',
  'release',
  'restore',
]

export interface LifecycleHookResult {
  readonly phase: LifecyclePhase
  readonly name: string
  readonly status: 'stopped' | 'failed' | 'unknown'
  readonly error?: unknown
}

export interface LifecycleHook {
  readonly phase: LifecyclePhase
  readonly name: string
  readonly run: (signal: AbortSignal) => void | Promise<void>
  readonly deadlineMs: number
}

export interface ShutdownReport {
  readonly reason: string
  readonly results: readonly LifecycleHookResult[]
  readonly totalMs: number
  readonly forced: boolean
}

const PHASE_DEADLINE_MS: Record<LifecyclePhase, number> = {
  freeze: 500,
  drain: 3000,
  flush: 3000,
  release: 2000,
  restore: 1500,
}

const TOTAL_BUDGET_MS = 10_000

export class Lifecycle {
  private readonly hooks: LifecycleHook[] = []
  private readonly abortControllers = new Map<LifecyclePhase, AbortController>()
  private shuttingDown = false
  private forceRestore = false
  private report: ShutdownReport | undefined
  private shutdownPromise: Promise<ShutdownReport> | undefined

  get isShuttingDown(): boolean {
    return this.shuttingDown
  }

  /** Register a hook. Registration after shutdown starts is rejected. */
  register(
    phase: LifecyclePhase,
    name: string,
    run: (signal: AbortSignal) => void | Promise<void>,
    deadlineMs = PHASE_DEADLINE_MS[phase],
  ): () => void {
    if (this.shuttingDown)
      throw new Error(`lifecycle: cannot register ${name} after shutdown started`)
    const hook: LifecycleHook = { phase, name, run, deadlineMs }
    this.hooks.push(hook)
    return () => {
      const index = this.hooks.indexOf(hook)
      if (index >= 0) this.hooks.splice(index, 1)
    }
  }

  /**
   * Start the graceful path. A repeat request only forces restore when the
   * caller marks it `force` (a genuinely repeated signal, not the terminal
   * delivering the same signal to the launcher and the runtime).
   */
  requestShutdown(reason: string, force = false): Promise<ShutdownReport> {
    if (this.report) return Promise.resolve(this.report)
    if (this.shuttingDown) {
      if (force) {
        this.forceRestore = true
        for (const controller of this.abortControllers.values()) controller.abort()
      }
      return this.shutdownPromise ?? Promise.resolve(this.emptyReport(reason))
    }
    this.shuttingDown = true
    this.shutdownPromise = this.run(reason)
    return this.shutdownPromise
  }

  private async run(reason: string): Promise<ShutdownReport> {
    const startedAt = Date.now()
    const results: LifecycleHookResult[] = []
    for (const phase of PHASE_ORDER) {
      const phaseStart = Date.now()
      if (this.forceRestore && phase !== 'restore') {
        for (const hook of this.hooks.filter((entry) => entry.phase === phase)) {
          results.push({ phase, name: hook.name, status: 'unknown' })
        }
        continue
      }
      const controller = new AbortController()
      this.abortControllers.set(phase, controller)
      const phaseHooks = this.hooks.filter((hook) => hook.phase === phase)
      for (const hook of phaseHooks) {
        if (this.forceRestore && phase !== 'restore') {
          results.push({ phase, name: hook.name, status: 'unknown' })
          continue
        }
        const remainingBudget = TOTAL_BUDGET_MS - (Date.now() - startedAt)
        if (remainingBudget <= 0) {
          results.push({ phase, name: hook.name, status: 'unknown' })
          continue
        }
        const deadline = Math.max(1, Math.min(hook.deadlineMs, remainingBudget))
        results.push(await runHook(hook, deadline, controller))
      }
      void phaseStart
    }
    const report: ShutdownReport = {
      reason,
      results,
      totalMs: Date.now() - startedAt,
      forced: this.forceRestore,
    }
    this.report = report
    return report
  }

  private emptyReport(reason: string): ShutdownReport {
    return { reason, results: [], totalMs: 0, forced: true }
  }
}

async function runHook(
  hook: LifecycleHook,
  deadlineMs: number,
  controller: AbortController,
): Promise<LifecycleHookResult> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<LifecycleHookResult>((resolve) => {
    timer = setTimeout(() => {
      resolve({ phase: hook.phase, name: hook.name, status: 'unknown', error: 'deadline' })
    }, deadlineMs)
  })
  const execution = (async (): Promise<LifecycleHookResult> => {
    try {
      await hook.run(controller.signal)
      return { phase: hook.phase, name: hook.name, status: 'stopped' }
    } catch (error) {
      return { phase: hook.phase, name: hook.name, status: 'failed', error }
    }
  })()
  const result = await Promise.race([execution, timeout])
  if (timer) clearTimeout(timer)
  return result
}

/** Human-readable one-line summary for the shutdown report. */
export function formatShutdownReport(report: ShutdownReport): string {
  const lines = [
    `nano: 关停（${report.reason}，${report.totalMs}ms${report.forced ? '，强制' : ''}）`,
  ]
  for (const result of report.results) {
    const detail = result.error !== undefined ? ` (${String(result.error)})` : ''
    lines.push(`  ${result.phase}/${result.name}: ${result.status}${detail}`)
  }
  return lines.join('\n')
}
