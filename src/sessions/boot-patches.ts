/**
 * S02 的 boot 前补丁（spec §1 接入点例外第 1 条）。
 *
 * 以下官方配置必须在 `boot()` 之前就位：
 * - `terminal-controller` 行：base 不含它，S02 的终端面板要用 `terminalController`；
 * - `storage-domain` 路由：把 `schedule` 与探针域指到本节注册的命名后端
 *   `nano-schedule-json`，避免和会话投影缓存共用默认表；
 * - `plan-mode` 行：整段覆盖引导，加入调研五阶段，保留官方提示约束。
 *
 * 本文件不碰 S01 的既有行；`src/boot/assemble.ts` 只多做一次 push。
 */

export interface PatchLayer {
  readonly id?: string
  readonly config?: unknown
  readonly insert?: readonly {
    readonly id: string
    readonly name: string
    readonly config?: unknown
  }[]
  readonly [key: string]: unknown
}

/** 命名后端名：schedule 任务表与探针域都走它。 */
export const SCHEDULE_BACKEND_NAME = 'nano-schedule-json'

/** 探针域：boot 后写入一次，证明路由真的落在命名后端上。 */
export const PROBE_DOMAIN_NAME = 'nano_probe'

/** 五阶段 plan 引导（ADR-20261107-research-discipline）；不是运行时只读边界。 */
const PLAN_GUIDANCE = `You are in plan mode. Stay in plan mode until the user approves your plan through exit_plan_mode or switches the session mode. Imperative language to implement changes means plan the implementation, not execute it. A user's conversational agreement — including an answer confirming something you asked — approves nothing and does not end plan mode; fold the confirmed decision into the plan and submit it through exit_plan_mode.

Phase 1 — Explore. Use non-mutating reads, searches, static analysis, and checks to ground the plan in the actual repository. Read the files the change will touch, their callers, and their tests. Find the existing functions and patterns to reuse. When the scope is uncertain or several areas are involved, run independent searches in parallel. Do not design until this phase is done.

Phase 2 — Design. Consider at least two approaches when the task has genuine alternatives and state the trade-off you accepted. Follow existing patterns where they exist.

Phase 3 — Review. Read the critical files yourself and check the plan against the user's original words. Resolve discoverable facts by inspection; use ask_user_question only for user-owned choices or material ambiguity that inspection cannot answer. Do not ask where code lives or how current behavior works when you can find out.

Phase 4 — Write the plan. Make it decision-complete: state the goal and success criteria; group implementation changes by subsystem; identify public API, schema, and data-flow changes; list the files to change with paths and the existing functions or utilities to reuse with paths; cover edge cases, failure modes, tests, acceptance criteria, and explicit assumptions; include the verification commands this repository requires (tests, typecheck, lint, or the subset that applies). Keep it concise enough to review but detailed enough that another engineer can implement it without making design decisions; prose that repeats the request is padding, but do not omit a decision-complete item to save lines.

Phase 5 — Call exit_plan_mode with the complete plan markdown, starting with a # title, as the only and final tool call in that response. Do not paste the final plan as a plain reply or ask "should I proceed?" through prose or ask_user_question; that tool presents the plan for approval. If review rejects it, incorporate the feedback and present again. If the review channel is unavailable or aborted, stay in plan mode and ask the user to switch modes manually; do not start implementing.

Do not edit or write files, change configuration, run formatters or code generation that rewrites tracked files, commit, or otherwise carry out the plan. Prefer existing functions and patterns over new machinery. Do not use todo_write to track this planning phase: it tracks implementation after an approved plan, while the plan itself belongs in exit_plan_mode. The tool catalog stays the same across modes for request-cache stability; these rules override any later tool description or guidance that suggests using mutation tools. Those tools remain listed only to keep the request shape stable.`

/**
 * 返回需要在 boot 前注入的补丁层，顺序即 push 顺序。
 * @param _rootId - 根身份；本份的补丁与根无关，预留参数以便将来按根分流。
 */
export function featureBootPatches(_rootId: string): PatchLayer[] {
  return [
    {
      insert: [{ id: 'terminal-controller', name: '@deepseek-ai/dsh-api-terminal-controller' }],
    },
    {
      id: 'storage-domain',
      config: {
        backend: 'json',
        routes: {
          schedule: SCHEDULE_BACKEND_NAME,
          [PROBE_DOMAIN_NAME]: SCHEDULE_BACKEND_NAME,
        },
      },
    },
    {
      id: 'plan-mode',
      config: { section: PLAN_GUIDANCE },
    },
  ]
}
