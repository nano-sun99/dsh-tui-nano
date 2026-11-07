# [2026-11-07-nano-research-discipline] 需求阶段强制调研：常驻纪律 + plan 五阶段

- 组标识：`2026-11-07-nano-research-discipline`
- 角色：单份 spec（批次 1）；批次 2「只读 research 子代理」不在本 spec，另立
- 状态：实施中（代码与证据就绪，待实施审核）
- Issue：#174
- 结构：不拆——1 份 spec + 1 张执行 issue
- 机制范围：**2 个提示层机制**——① 新增根 agent 常驻段 `nano:research-discipline`；② 覆盖官方 `plan-mode` 的 `section` 配置。无新增运行时机制、无新依赖、不改工具目录
- 上游：Claude Code 2.1.88 源码调研（`~/Downloads/归档/06-软件与安装包/ClaudeCode/src`）；nano 既有 `nano:question-discipline`（[ADR-20261103](../../decisions/2026-11-03-question-trigger-discipline.md)）、`nano:delegation-responsiveness`
- 替代关系：无——不改旧 spec；与 `2026-10-30-nano-main-agent-responsive` 的委派纪律并列，不重叠
- ADR：本次新增 [ADR-20261107-research-discipline](../../decisions/2026-11-07-research-discipline.md)
- 下游：执行 issue #174；批次 2 另开

## 1. 目标

把「先调研、再给方案」从一句期望变成模型在非平凡需求上照着走的固定动作：

1. 非平凡需求下，模型先给一份**可核对的调研清单**（关键文件与路径 / 可复用函数或模式 / 调用链 / 风险 / 验证方式），再给方案。
2. 模型会在非平凡需求上主动建议 `/plan`；用户进 plan 后，按「并行调研 → 设计 → 复核 → 写计划 → 交审」五阶段走。
3. 小改、纯查事实、用户说「直接干」不触发完整调研；即使走例外，也先读要改的文件。

不承诺：模型 100% 遵守（提示词是软约束）；不承诺调研深度可量化；不做只读子代理（批次 2）。批次 1 也不做 Claude Code 的 `EnterPlanMode` 工具（见 §3.2），所以这里只承诺「建议 `/plan`」，不承诺「模型自己把会话切进 plan」。行为是否生效由 §6 的 3 场真实会话证据判定，不设上线后观察期，也不做统计承诺。

## 2. 当前事实与根因

调查基线：`origin/main` @ `204dfeb`；官方 `@deepseek-ai/dsh` 0.2.2-rc.1；Claude Code 2.1.88。

| 事实 | 证据 |
|---|---|
| nano 只有两段自定提示，都在根 agent 作用域 | `src/conversation/controller.ts:150-163` |
| nano 的 `/plan` 命令已注册，但模型没有 `EnterPlanMode` 工具（`dsh-plan-mode` 只注册 `exit_plan_mode`） | 2026-11-07 实测 boot 后命令列表：`compact, feedback, goal, permission, plan`；系统提示段无 plan 工具 |
| Claude Code 2.1.88 的模型可主动调用 `EnterPlanMode`（需用户批准）进入 plan；这是「抄调研机制」里 nano 目前没有的一环 | `ClaudeCode/src/tools/EnterPlanModeTool/prompt.ts:22-33`（`Use this tool proactively when you're about to start a non-trivial implementation task`） |
| 官方 plan 引导已有「Explore first」、只读、`todo_write` 禁令、decision-complete 计划清单、`exit_plan_mode` 交审；缺的是分阶段与调研清单模板 | `node_modules/@deepseek-ai/dsh-base/cordis.patch.yml:340-350` |
| profile 补丁能整段替换官方 plan 引导 | 2026-11-07 探针（本 PR 可复跑）：patch `{ id: 'plan-mode', config: { section: '<marker>' } }` 后，plan 未激活时组装结果不含 marker，激活后含 marker、不含官方 `Explore first.`；见 §8.1 |
| 段 order 先例：question=10145、delegation=10150 | `controller.ts:152`、`:159` |
| 现单测断言根 agent 恰好 2 段 | `tests/unit/conversation-delivery.test.ts:253-277` |

信源分档：本机 Claude Code 2.1.88 源码是权威一手源；`Perfumere/how-claude-design` 是基于 v2.0.76 的二手分析（Plan Mode 3 阶段、提示里禁止 build/test），只作交叉参考，不用它覆盖 2.1.88 的 5 阶段；2.1.88 的只读口径是「run any non-readonly tools」，dsh 官方 plan 文本另行允许 non-mutating checks，两者不要混用。

根因：提示层没有「调研完成」的定义，也没有把调研变成动手前的独立阶段；`/plan` 要用户自己想起来了才进，进去后官方引导已有决策完整性要求但没有分阶段；模型也没法像 Claude Code 那样主动调用 `EnterPlanMode`。

## 3. 范围与边界

### 3.1 本次做

**① `src/conversation/controller.ts`**：`setup(agentCtx)` 里新增第三段，注册顺序在提问纪律之前：

```ts
const disposeResearch = agentCtx.systemPrompt.section({
  name: 'nano:research-discipline',
  order: 10140,
  interpolate: false,
  text: RESEARCH_DISCIPLINE,
})
if (typeof disposeResearch === 'function') this.disposers.push(disposeResearch)
```

文本固定为（English，模型面向）：

```text
# Research before proposing
When the user asks for a change, a feature, or a plan, ground it in the repository before proposing anything.
- Read every file you intend to change, plus its callers and tests. Never propose changes to code you have not read.
- Before proposing an approach, list what you found: the files that matter with paths, the existing functions or patterns to reuse, the call chain the change touches, the risks, and how you will verify the result.
- Resolve discoverable facts by inspection. Do not ask the user where code lives or how current behavior works when you can find out.
- If part of the codebase is still unexplored, name that part and say why it cannot change the answer. Never present an assumption as a finding.
- "Non-trivial" means a new feature, a behavior change, a multi-file change, an architectural choice, or unclear scope. For non-trivial work, state that you recommend plan mode (`/plan`) before designing. Do not start editing until the list above is complete.
- Skip the full list only for a one-line or other small local fix, a pure fact lookup, or when the user says to start immediately; even then, read the files first.
```

**② `src/sessions/boot-patches.ts`**：`featureBootPatches()` 增补一条覆盖行（补丁按 id 整段替换 `config`，因此必须带全 `section`）：

```ts
{
  id: 'plan-mode',
  config: { section: PLAN_GUIDANCE },
}
```

文本固定为：

```text
You are in plan mode. Stay in plan mode until the user approves your plan through exit_plan_mode or switches the session mode. Imperative language to implement changes means plan the implementation, not execute it. A user's conversational agreement — including an answer confirming something you asked — approves nothing and does not end plan mode; fold the confirmed decision into the plan and submit it through exit_plan_mode.

Phase 1 — Explore. Use non-mutating reads, searches, static analysis, and checks to ground the plan in the actual repository. Read the files the change will touch, their callers, and their tests. Find the existing functions and patterns to reuse. When the scope is uncertain or several areas are involved, run independent searches in parallel. Do not design until this phase is done.

Phase 2 — Design. Consider at least two approaches when the task has genuine alternatives and state the trade-off you accepted. Follow existing patterns where they exist.

Phase 3 — Review. Read the critical files yourself and check the plan against the user's original words. Resolve discoverable facts by inspection; use ask_user_question only for user-owned choices or material ambiguity that inspection cannot answer. Do not ask where code lives or how current behavior works when you can find out.

Phase 4 — Write the plan. Make it decision-complete: state the goal and success criteria; group implementation changes by subsystem; identify public API, schema, and data-flow changes; list the files to change with paths and the existing functions or utilities to reuse with paths; cover edge cases, failure modes, tests, acceptance criteria, and explicit assumptions; include the verification commands this repository requires (tests, typecheck, lint, or the subset that applies). Keep it concise enough to review but detailed enough that another engineer can implement it without making design decisions; prose that repeats the request is padding, but do not omit a decision-complete item to save lines.

Phase 5 — Call exit_plan_mode with the complete plan markdown, starting with a # title, as the only and final tool call in that response. Do not paste the final plan as a plain reply or ask "should I proceed?" through prose or ask_user_question; that tool presents the plan for approval. If review rejects it, incorporate the feedback and present again. If the review channel is unavailable or aborted, stay in plan mode and ask the user to switch modes manually; do not start implementing.

Do not edit or write files, change configuration, run formatters or code generation that rewrites tracked files, commit, or otherwise carry out the plan. Prefer existing functions and patterns over new machinery. Do not use todo_write to track this planning phase: it tracks implementation after an approved plan, while the plan itself belongs in exit_plan_mode. The tool catalog stays the same across modes for request-cache stability; these rules override any later tool description or guidance that suggests using mutation tools. Those tools remain listed only to keep the request shape stable.
```

**③ 测试**：`tests/unit/conversation-delivery.test.ts` 的「在根 agent 作用域注册提问纪律与委派纪律段」改为三段，顺序 10140 / 10145 / 10150，并逐字断言研究纪律正文。

**④ 证据**：spec 期 `probe-plan-section.mjs`（覆盖可行性，见 §8.1）；实施期 `prompt-evidence.mjs`——真 boot + 真 `ConversationController.start()`，断言：根 agent sections 含新段且顺序正确、真实子 agent（带 `parentAgent` 创建）不含、plan 未激活时 `plan:policy` 为空、激活后命中 `Phase 1 — Explore`、不命中官方 `Explore first.`、且 §5.4 的官方约束语义逐条仍在。

### 3.2 本次不做

- 不新建 agent preset、不做只读 research 子代理、不引入 quick/medium/very thorough 档位（批次 2）。
- 不改 `/plan` 命令、`exit_plan_mode`、权限与沙箱。
- 不改 AGENTS.md / spec-flow 的调研要求；不改官方工具描述。
- 不新增运行时开关、配置项、持久化格式；不新增依赖。
- 不把 `/plan` 改成模型可主动调用的 `EnterPlanMode` 工具：Claude Code 2.1.88 有该工具（模型主动调用、用户批准后进入 plan），nano 批次 1 只做文字建议；加工具需要新插件与审批语义，批次 2 评估。

## 4. 主路（步｜触发 → 响应｜失败 / 空态｜落点 · 依据 · 证据）

| 步 | 触发 → 响应 | 失败 / 空态 | 落点 · 依据 · 证据 |
|---|---|---|---|
| 1 常驻纪律 | 根 agent `start()` → 注册 `nano:research-discipline`(10140)，disposer 收进 `this.disposers` | 注册抛错 → `start()` 失败，不静默吞；agent 销毁 → disposer 解绑 | `controller.ts` `setup()`；依据 §2 行 1、6；证据 A1 |
| 2 plan 覆盖 | 每次 boot `featureBootPatches()` 返回覆盖行 → 与官方 plan-mode 行按 id 合并 | 覆盖行缺 `section` 或 `section` 为空 → `dsh-plan-mode` 插件加载抛错、boot 失败；不会静默变成空引导 | `src/sessions/boot-patches.ts`；依据 §2 行 4、5；证据 A3 |
| 3 行为生效 | 非平凡需求 → 模型先给五项清单并建议 `/plan`；plan 激活 → 五阶段文本渲染 | 模型跳过清单（软约束）→ 按 §6.2 B1/B2 记录并修订提示；plan 未激活 → `plan:policy` 空 | 提示层；依据 §7；证据 A1/A3/B1-B3 |
| 4 回归 | 改完跑 `npm test` / `typecheck` / `lint` | 任一失败 → 不合并 | 仓库现有脚本；证据 A4 |

### 4.1 样例：场景 → 是否走完整调研（决策表）

| 场景 | 走完整调研？ | 输出要求 |
|---|---|---|
| 新功能 / 改行为 / 多文件 | 是 | 五项清单 + 建议 `/plan` |
| 多个可行方案 / 架构选择 | 是 | 五项清单 + 建议 `/plan`，并列取舍 |
| 需求不清、要先探 scope | 是 | 先探，再给清单；不猜 |
| 单文件小修（一行或局部小改，不跨文件） | 否 | 直接改；说明读了哪些文件 |
| 纯查事实（函数在哪、怎么用） | 否 | 给路径与行号 |
| 用户明说「直接干 / 别走流程」 | 否 | 先读要改的文件，再动手；未查部分明说 |
| 调研中发现范围变大 | 升级为「是」 | 回到清单，写清新范围与风险 |

## 5. 行为规则

1. 研究纪律段只注册在根 agent 作用域，子代理不继承（沿用现有 `setup` 语义）。
2. `order = 10140`：排在提问纪律（10145）之前，先调研、再决定要不要问；不越过 `deployment:persona-suffix`（10200）。
3. plan 覆盖段只在 plan 激活时渲染；未激活时 `plan:policy` 文本为空（官方既有条件渲染不变）。
4. 覆盖是整段替换：官方原文的约束语义必须全部保留——用户口头同意不算批准、只读、工具目录不变、不用 `todo_write`、计划决策完整（含测试 / 验收 / 假设）、只经 `exit_plan_mode` 交审、不得用散文或 `ask_user_question` 求批准；不得因覆盖丢失。这些是提示文本约束，不是运行时强制。
5. 两段都是软约束；plan 模式的「只读」也只是提示约束，不是硬闸。`dsh-plan-mode` 明确沙箱 / 审批「do not read or write plan state」；nano 新会话默认 `danger-full-access` + 审批 `never`（ADR-20261102）。要硬只读，用 `/permission read-only` 或沙箱 preset，不能把 plan 模式当安全边界。
6. 写路径单一入口：段只在 `setup()` 注册一处；plan 覆盖只在 `featureBootPatches()` 一处。plan 激活态由官方 `planMode` 持有，读侧是官方 `systemPrompt.section` 的条件渲染，nano 不另存状态。

## 6. 验收

### 6.1 机械验收（合并前必须全绿）

- **A1** 根 agent 的 `nano:` 段按 order 依次为 `nano:research-discipline`(10140)、`nano:question-discipline`(10145)、`nano:delegation-responsiveness`(10150)（忽略官方段），正文与 §3.1 逐字一致。
- **A2** 真实子 agent（带 `parentAgent` 创建，不是另建一个没 setup 的 agent）的 sections 不含 `nano:research-discipline`。
- **A3** plan 未激活：`plan:policy` 段文本为空；激活后：含 `Phase 1 — Explore`，不含官方 `Explore first.`，且 §5.4 列出的官方约束语义逐条仍在。
- **A4** `npm test` 全绿；`npm run typecheck`、`npm run lint` 通过。
- **A5** spec 期 `probe-plan-section.mjs` 与实施期 `prompt-evidence.mjs` 都可复跑，输出与 `docs/evidence/2026-11-07-nano-research-discipline/README.md` 记录一致。

### 6.2 行为验收（同单证据，不设观察期）

在真实 TUI 里跑下面 3 个固定场景，transcript 存 `docs/evidence/2026-11-07-nano-research-discipline/session-*.md`；没有配置真实模型时标「未执行」，不得用假 transcript 代替：

| 场景 | 固定输入 | 通过判据 |
|---|---|---|
| B1 非平凡 | 「给 nano 加一个跨 2–3 个文件的功能，先别改代码」 | 给方案前输出五项清单（文件路径 / 复用点 / 调用链 / 风险 / 验证），并建议 `/plan`；不要求模型自动进入 plan（批次 1 没有 `EnterPlanMode` 工具） |
| B2 小改 | 实施前在一个临时 worktree 固定一个一行 typo（文件 / 行写在 transcript 首行），输入「把这个 typo 修掉」 | 不出现五项清单仪式；仍先读该文件 |
| B3 plan | 进 `/plan` 后给一个多文件任务 | 按五阶段走；不改文件；最终只经 `exit_plan_mode` 提交完整计划 |

> B 判据是一次行为证据，不是统计承诺；一次不达标就改提示再测，不把失败解释成「软约束正常」。

## 7. 机制清单

| 机制 | 解决什么 | 没有会怎样 |
|---|---|---|
| `nano:research-discipline` 常驻段 | 平时没有「调研完成」的定义，模型两下搜索就给方案 | 继续拍脑袋：漏关键文件、漏复用点、漏验证方式 |
| `plan-mode` 的 `section` 覆盖 | 官方引导已有研究要求，但没有分阶段与调研清单模板 | 即使进了 `/plan`，也可能只浅搜一轮就交计划 |

## 8. 证据

### 8.1 spec 期探针（本 PR 可复跑）

- `docs/evidence/2026-11-07-nano-research-discipline/probe-plan-section.mjs`：真 boot + 真 `ConversationController.start()`，注入 marker 覆盖 `plan-mode`，断言 plan 未激活无 marker、激活后只有 marker、没有官方 `Explore first.`。
- `docs/evidence/2026-11-07-nano-research-discipline/README.md`：复跑命令与输出原文。

### 8.2 实施期证据

- `prompt-evidence.mjs`：组装证据（A1/A2/A3）。
- `session-1.md` / `session-2.md` / `session-3.md`：§6.2 的真实会话 transcript（B1–B3）。
- 行为观察不进单：上线后是否长期保持、是否拖慢小改，按 §6.2 的即时证据判定，不设观察期。

## 9. 风险与回退

- **提示变长**：常驻段约 +1,100 字符（~300 tokens），每次请求都带；可接受，若上下文吃紧再压缩。
- **软约束不生效**：模型可能仍跳过清单；§6.2 用 3 场真实会话做即时证据，不承诺 100%，也不把一次失败当统计结论。
- **能力差距**：批次 1 只能建议 `/plan`，不能像 Claude Code 那样由模型调用 `EnterPlanMode` 自动进入；这是已知差距，批次 2 评估。
- **覆盖漂移**：官方升级若改动 plan 引导，我们的覆盖不会自动跟随；升级 dsh 时需人工对一次 `dsh-base/cordis.patch.yml` 的 plan-mode 段。
- **回退**：删常驻段 + 删 `plan-mode` 覆盖补丁，两步即回到现状。

## 10. DoR 自查

| 条 | 结论 |
|---|---|
| 1 承重规则单一结论、无 TBD | 过：两段文本定稿，例外三条写死 |
| 2 每步有触发 → 响应与失败 / 空态 | 过：§4 四行齐全 |
| 3 写路径单一入口；状态有字段有读侧 | 过：段在 `setup()` 一处、覆盖在 `featureBootPatches()` 一处；plan 激活态由官方持有，读侧为条件渲染 |
| 4 验收可执行 | 过：A1–A5 为命令 / 断言；B1–B3 为固定输入 + transcript 判据，均已写清 |
| 5 迁移 / 回填 / 回滚 / 兼容 | 迁移与回填不适用（纯提示层）；回滚见 §9 |
| 6 外部合同影响 | 不适用：不对外暴露 API / 报表 / 消息通道 |
| 7 ADR supersede 链 | 过：新增 ADR-20261107，无取代；正文与 ADR 一致 |

## 11. 自定细节

- 段名 `nano:research-discipline`；order `10140`；`interpolate: false`。
- 两段正文一律英文，与既有两段一致；界面语言不受影响。
- 五阶段不点名 `subagent` 工具：批次 1 没有只读子代理，点名会被拿去干写活的差事。
- 例外三条写死为：一行修复或局部小改、纯查事实、用户明说「直接干」。
- 计划保留官方「详细到另一个工程师不必再做设计决策」的要求，不设行数硬上限；必须含本仓实际需要的验证命令（test / typecheck / lint 或适用的子集）。不采用「计划文件」形态（dsh 的 `exit_plan_mode` 接受 markdown，不落盘）。
- 覆盖文本不保留官方 `Explore first.` 字面标签，改为 `Phase 1 — Explore`；A3 因此断言官方标签不出现。
- 覆盖文本保留官方全部提示约束（见 §5.4），避免覆盖造成语义回退。
- 决策依据落 [ADR-20261107-research-discipline](../../decisions/2026-11-07-research-discipline.md)；本 spec 不再另立载体。

## 12. 审核修订记录

2026-11-07 自查 + 轻审修订（自查：主 agent 对源码；轻审：1 个 spec-compliance 分身，非独立第三方，结论见 PR 评论）：

| # | 严重度 | 发现 | 处置 |
|---|---|---|---|
| 1 | 高 | §2 把官方 plan 文本读成「只有 Explore first、无计划模板」 | §2 改为官方已有 decision-complete 清单与禁令，缺的是分阶段；引用 `cordis.patch.yml:340-350` |
| 2 | 高 | 覆盖文本丢了 `todo_write` 禁令与 decision-complete 清单，弱化「不得用散文 / 问卷求批准」，且只要求一条验证命令、40 行上限 | §3.1② 重写，保留官方全部约束语义；Phase 4 用本仓 test/typecheck/lint；去掉 40 行硬上限 |
| 3 | 高 | A1–A5 只证明文本装上，不证明「模型会先调研」 | §6 增加 B1–B3 真实会话证据；§1 明确即时证据、不设观察期 |
| 4 | 高 | 调研漏了 Claude Code 2.1.88 的 `EnterPlanMode` 工具，把「建议 `/plan`」当成等价机制 | §2 补事实；§3.2 明确批次 1 不做、批次 2 评估；§6.2 B1 只判「建议 `/plan`」 |
| 5 | 中 | §4 步 2 失败态写成「plan 引导为空」 | 改为插件加载抛错、boot 失败 |
| 6 | 中 | A2 用「另建一个没 setup 的 agent」代理子 agent | A2 改为带 `parentAgent` 的真子 agent；§8 说明 |
| 7 | 中 | §2/§8 的探针没有可复跑脚本 | 新增 §8.1 `probe-plan-section.mjs` 与 README 输出 |
| 8 | 低 | Claude Code 引用行号偏差 | 修正为 `exploreAgent.ts:61-62`、`messages.ts:3233` |
| 9 | 阻断 | §5.5「硬保证仍来自工具权限、沙箱与审批」在 plan 期不成立；沙箱 / 审批不读 plan 状态，nano 默认 `danger-full-access` + 审批 `never` | §5.5 改写为「plan 模式的只读只是提示约束，不是安全边界」；§5.4 注明提示约束不等于运行时强制 |
| 10 | 提示 | §2 把 dsh 的 `non-mutating checks` 口径写成 Claude Code 2.1.88 的说法 | §2 分开：2.1.88 是 `run any non-readonly tools`，dsh plan 文本另允许 `non-mutating checks` |
| 11 | 提示 | 覆盖文本两处收窄：`tool description or guidance` 少了 `tool description`；`detailed enough…` 被短句替代 | 恢复官方原句；§11 补计划详细度取舍 |
| 12 | 提示 | §8 自定细节不在末尾 | 移到 §11（其后只剩 §12 审核修订记录） |
| 13 | 提示 | §8 漏列「去掉官方 `Explore first.` 标签」的自定取舍 | §11 补一条 |
| 14 | 提示 | A1「根 agent sections 依次为（三段）」字面不可执行 | 改为「根 agent 的 `nano:` 段按 order 依次为…（忽略官方段）」 |
| 15 | 提示 | B2 固定输入「修掉这个一行 bug」没有具体缺陷，transcript 不可复现 | 改为临时 worktree 固定一个 typo，文件 / 行写在 transcript 首行 |
| 16 | 提示 | evidence README 复跑缺 `npm install` | 补 `npm install` 前提 |
| 17 | 提示 | PR 正文 A3 漏「只经 `exit_plan_mode` 交审」 | PR 正文补上 |
