# [2026-11-07-nano-research-discipline] 需求阶段强制调研：常驻纪律 + plan 五阶段

- 组标识：`2026-11-07-nano-research-discipline`
- 角色：单份 spec（批次 1）；批次 2「只读 research 子代理」不在本 spec，另立
- 状态：方案中（实施版，待审）
- 结构：不拆——1 份 spec + 1 张执行 issue
- 机制范围：**2 个提示层机制**——① 新增根 agent 常驻段 `nano:research-discipline`；② 覆盖官方 `plan-mode` 的 `section` 配置。无新增运行时机制、无新依赖、不改工具目录
- 上游：Claude Code 2.1.88 源码调研（`~/Downloads/归档/06-软件与安装包/ClaudeCode/src`）；nano 既有 `nano:question-discipline`（[ADR-20261103](../../decisions/2026-11-03-question-trigger-discipline.md)）、`nano:delegation-responsiveness`
- 替代关系：无——不改旧 spec；与 `2026-10-30-nano-main-agent-responsive` 的委派纪律并列，不重叠
- ADR：本次新增 [ADR-20261107-research-discipline](../../decisions/2026-11-07-research-discipline.md)
- 下游：spec 合并后开执行 issue；批次 2 另开

## 1. 目标

把「先调研、再给方案」从一句期望变成模型每次都能照着走的固定动作：

1. 非平凡需求下，模型先给一份**可验收的调研清单**（关键文件 / 可复用函数 / 调用链 / 风险 / 验证方式），再给方案。
2. 模型会在非平凡需求上主动建议 `/plan`；用户进 plan 后，按「并行调研 → 设计 → 复核 → 写计划 → 交审」五阶段走。
3. 小改、纯查事实、用户说「直接干」不触发完整调研。

不承诺：模型 100% 遵守（提示词是软约束）；不承诺调研深度可量化；不做只读子代理（批次 2）。

## 2. 当前事实与根因

调查基线：`origin/main` @ `204dfeb`；官方 `@deepseek-ai/dsh` 0.2.2-rc.1；Claude Code 2.1.88。

| 事实 | 证据 |
|---|---|
| nano 只有两段自定提示，都在根 agent 作用域 | `src/conversation/controller.ts:150-163` |
| `/plan` 命令已注册，但模型没有「主动提议进 plan」的工具 | 2026-11-07 实测 boot 后命令列表：`compact, feedback, goal, permission, plan`；系统提示段无 plan 工具；`dsh-plan-mode` 只注册 `exit_plan_mode` |
| 官方 plan 引导只有一句「Explore first」，无分阶段、无计划模板 | `node_modules/@deepseek-ai/dsh-base/cordis.patch.yml:337-349` |
| profile 补丁能整段替换官方 plan 引导 | 2026-11-07 临时探针：patch `{ id: 'plan-mode', config: { section: '<marker>' } }` 后，plan 激活时组装结果出现 marker，未激活时不出现 |
| 段 order 先例：question=10145、delegation=10150 | `controller.ts:152`、`:159` |
| 现单测断言根 agent 恰好 2 段 | `tests/unit/conversation-delivery.test.ts:253-277` |

根因：提示层没有「调研完成」的定义，也没有把调研变成动手前的独立阶段；`/plan` 要用户自己想起来了才进，进去后官方引导也不要求分阶段。

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
- For non-trivial work, state that you recommend plan mode (`/plan`) before designing. Do not start editing until the list above is complete.
- Skip the full list only for a one-line fix, a pure fact lookup, or when the user says to start immediately; even then, read the files first.
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
You are in plan mode. Stay in plan mode until the user approves your plan through exit_plan_mode or switches the session mode. Imperative language to implement changes means plan the implementation, not execute it. A user's conversational agreement — including an answer confirming something you asked — approves nothing; fold the confirmed decision into the plan and submit it through exit_plan_mode.

Phase 1 — Explore. Use non-mutating reads, searches, static analysis, and checks to ground the plan in the actual repository. Read the files the change will touch, their callers, and their tests. Find the existing functions and patterns to reuse. When the scope is uncertain or several areas are involved, run independent searches in parallel. Do not design until this phase is done.

Phase 2 — Design. Consider at least two approaches when the task has genuine alternatives and state the trade-off you accepted. Follow existing patterns where they exist.

Phase 3 — Review. Read the critical files yourself and check the plan against the user's original words. Resolve discoverable facts by inspection; use ask_user_question only for user-owned choices or material ambiguity that inspection cannot answer. Do not ask where code lives or how current behavior works when you can find out.

Phase 4 — Write the plan. Include the goal and success criteria, the files to change with paths, the existing functions or utilities to reuse with paths, the edge cases and failure modes, and one verification command. Keep it under 40 lines; prose that repeats the request is padding.

Phase 5 — Call exit_plan_mode with the complete plan markdown, starting with a # title, as the only and final tool call in that response. If review rejects it, incorporate the feedback and present again. If the review channel is unavailable, stay in plan mode and ask the user to switch modes manually; do not start implementing.

Do not edit or write files, change configuration, run formatters or code generation that rewrites tracked files, commit, or otherwise carry out the plan. Prefer existing functions and patterns over new machinery. The tool catalog stays the same across modes for request-cache stability; these rules override any later guidance that suggests using mutation tools.
```

**③ 测试**：`tests/unit/conversation-delivery.test.ts` 的「在根 agent 作用域注册提问纪律与委派纪律段」改为三段，顺序 10140 / 10145 / 10150，并逐字断言研究纪律正文。

**④ 证据**：`docs/evidence/2026-11-07-nano-research-discipline/prompt-evidence.mjs`——真 boot + 真 `ConversationController.start()`，断言：根 agent sections 含新段且顺序正确、子 agent 不含、plan 未激活时 `plan:policy` 为空、激活后命中 `Phase 1 — Explore` 且不命中官方 `Explore first`。

### 3.2 本次不做

- 不新建 agent preset、不做只读 research 子代理、不引入 quick/medium/very thorough 档位（批次 2）。
- 不改 `/plan` 命令、`exit_plan_mode`、权限与沙箱。
- 不改 AGENTS.md / spec-flow 的调研要求；不改官方工具描述。
- 不新增运行时开关、配置项、持久化格式；不新增依赖。
- 不把 `/plan` 改成模型可主动调用的工具（需要新插件，另议）。

## 4. 主路（步｜触发 → 响应｜失败 / 空态｜落点 · 依据 · 证据）

| 步 | 触发 → 响应 | 失败 / 空态 | 落点 · 依据 · 证据 |
|---|---|---|---|
| 1 常驻纪律 | 根 agent `start()` → 注册 `nano:research-discipline`(10140)，disposer 收进 `this.disposers` | 注册抛错 → `start()` 失败，不静默吞；agent 销毁 → disposer 解绑 | `controller.ts` `setup()`；依据 §2 行 1、5；证据 A1 |
| 2 plan 覆盖 | 每次 boot `featureBootPatches()` 返回覆盖行 → 与官方 plan-mode 行按 id 合并 | 覆盖行缺 `section` 键 → plan 引导为空；boot 报错前不静默 | `src/sessions/boot-patches.ts`；依据 §2 行 3、4；证据 A3 |
| 3 行为生效 | 非平凡需求 → 模型先给五项清单；plan 激活 → 五阶段文本渲染 | 模型跳过清单（软约束）→ 观察项，不进单；plan 未激活 → `plan:policy` 空 | 提示层；依据 §7；证据 A1/A3 |
| 4 回归 | 改完跑 `npm test` / `typecheck` / `lint` | 任一失败 → 不合并 | 仓库现有脚本；证据 A4 |

### 4.1 样例：场景 → 是否走完整调研（决策表）

| 场景 | 走完整调研？ | 输出要求 |
|---|---|---|
| 新功能 / 改行为 / 多文件 | 是 | 五项清单 + 建议 `/plan` |
| 单文件小修（一行、明显 bug） | 否 | 直接改；说明读了哪些文件 |
| 纯查事实（函数在哪、怎么用） | 否 | 给路径与行号 |
| 用户明说「直接干 / 别走流程」 | 否 | 先读要改的文件，再动手；未查部分明说 |
| 调研中发现范围变大 | 升级为「是」 | 回到清单，写清新范围与风险 |

## 5. 行为规则

1. 研究纪律段只注册在根 agent 作用域，子代理不继承（沿用现有 `setup` 语义）。
2. `order = 10140`：排在提问纪律（10145）之前，先调研、再决定要不要问；不越过 `deployment:persona-suffix`（10200）。
3. plan 覆盖段只在 plan 激活时渲染；未激活时 `plan:policy` 文本为空（官方既有条件渲染不变）。
4. 覆盖是整段替换：官方原文中的「用户口头同意不算批准」「只读」「工具目录不变」等约束必须保留在新文本中，不得因覆盖丢失。
5. 两段都是软约束；硬保证仍来自工具权限、沙箱与审批。
6. 写路径单一入口：段只在 `setup()` 注册一处；plan 覆盖只在 `featureBootPatches()` 一处。plan 激活态由官方 `planMode` 持有，读侧是官方 `systemPrompt.section` 的条件渲染，nano 不另存状态。

## 6. 验收

- **A1** 根 agent sections 依次为 `nano:research-discipline`(10140)、`nano:question-discipline`(10145)、`nano:delegation-responsiveness`(10150)，正文与 §3.1 逐字一致。
- **A2** 子 agent 的 sections 不含 `nano:research-discipline`。
- **A3** plan 未激活：`plan:policy` 段文本为空；激活后：含 `Phase 1 — Explore`，不含官方 `Explore first.`。
- **A4** `npm test` 全绿；`npm run typecheck`、`npm run lint` 通过。
- **A5** 证据脚本可复跑，输出与 `docs/evidence/2026-11-07-nano-research-discipline/README.md` 记录一致。

## 7. 机制清单

| 机制 | 解决什么 | 没有会怎样 |
|---|---|---|
| `nano:research-discipline` 常驻段 | 平时没有「调研完成」的定义，模型两下搜索就给方案 | 继续拍脑袋：漏关键文件、漏复用点、漏验证方式 |
| `plan-mode` 的 `section` 覆盖 | 官方引导只有「Explore first」，没有阶段、没有计划模板 | 即使进了 `/plan`，也可能只浅搜一轮就交计划 |

## 8. 自定细节

- 段名 `nano:research-discipline`；order `10140`；`interpolate: false`。
- 两段正文一律英文，与既有两段一致；界面语言不受影响。
- 五阶段不点名 `subagent` 工具：批次 1 没有只读子代理，点名会被拿去干写活的差事。
- 例外三条写死为：一行修复、纯查事实、用户明说「直接干」。
- 计划长度上限 40 行、必须含一条验证命令；不采用「计划文件」形态（dsh 的 `exit_plan_mode` 接受 markdown，不落盘）。
- 覆盖文本保留官方「口头同意不算批准」「工具目录不变」两条，避免覆盖造成语义回退。
- 决策依据落 [ADR-20261107-research-discipline](../../decisions/2026-11-07-research-discipline.md)；本 spec 不再另立载体。

## 9. 证据

- `docs/evidence/2026-11-07-nano-research-discipline/prompt-evidence.mjs`：组装证据（A1/A2/A3）。
- `docs/evidence/2026-11-07-nano-research-discipline/README.md`：脚本输出原文 + 复跑命令。
- 行为观察（不进单，作为上线后观察项）：非平凡需求是否先给清单、是否主动建议 `/plan`；小改是否被流程拖慢。

## 10. 风险与回退

- **提示变长**：常驻段约 +1,100 字符（~300 tokens），每次请求都带；可接受，若上下文吃紧再压缩。
- **软约束不生效**：模型可能仍跳过清单；本 spec 不承诺行为 100% 改变，靠真实会话观察。
- **覆盖漂移**：官方升级若改动 plan 引导，我们的覆盖不会自动跟随；升级 dsh 时需人工对一次 `dsh-base/cordis.patch.yml` 的 plan-mode 段。
- **回退**：删常驻段 + 删 `plan-mode` 覆盖补丁，两步即回到现状。

## 11. DoR 自查

| 条 | 结论 |
|---|---|
| 1 承重规则单一结论、无 TBD | 过：两段文本定稿，例外三条写死 |
| 2 每步有触发 → 响应与失败 / 空态 | 过：§4 四行齐全 |
| 3 写路径单一入口；状态有字段有读侧 | 过：段在 `setup()` 一处、覆盖在 `featureBootPatches()` 一处；plan 激活态由官方持有，读侧为条件渲染 |
| 4 验收可执行 | 过：A1–A5 均为命令或断言 |
| 5 迁移 / 回填 / 回滚 / 兼容 | 迁移与回填不适用（纯提示层）；回滚见 §10 |
| 6 外部合同影响 | 不适用：不对外暴露 API / 报表 / 消息通道 |
| 7 ADR supersede 链 | 过：新增 ADR-20261107，无取代；正文与 ADR 一致 |
