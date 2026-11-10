# ADR-20261110-prompt-only-research：调研只做常驻提示，撤回 plan 五阶段

- 状态：生效中
- 日期：2026-11-10
- 决策人：用户
- 适用范围：模型在需求 / 变更类任务上的调研行为与 plan 引导文本；不适用于工具 schema、权限与沙箱、子代理组合
- 取代：[ADR-20261107-research-discipline](2026-11-07-research-discipline.md)
- 被取代：无
- 决策来源：用户 2026-11-10 原话「那大家都没有我也不折腾了，那我们就和 claude code一样只做提示词工程吧，然后撤回plan的我们继续做」；同日前序结论「我基本不可能用它（/plan），我用了那么久的 claude code 和 nano 从来都没调用过这个」
- 相关：[spec](../specs/2026-11-10-prompt-only-research/README.md)

## 决定

1. 调研只做**常驻提示**：根 agent 的 `nano:research-discipline` 段要求影响面清单——改动落点 / 上游调用 / 下游依赖 / 数据层 / 验证方式——每项带读过的路径证据，未读项必须明说原因；不新增运行时守卫、工具或子代理。
2. **撤回 plan 覆盖**：删除 `plan-mode` 的 `section` 覆盖，恢复官方引导；常驻段不再推荐 `/plan`。
3. 0.2.5 的五阶段方案作废；`EnterPlanMode` 工具、影响面工具、读后写守卫、code map / LSP / MCP 接入全部关闭，不再排期。
4. 例外沿用旧 ADR 第 5 条：一行或局部小改、纯查事实、用户明说「直接干」不要求完整影响面清单；走例外也先读要改的文件。

## 依据

- 用户从不使用 `/plan`：一条只在模式内生效的纪律，收益≈0，维护成本>0（每次升 dsh 要人工对一次覆盖文本）。
- 市场调研（2026-11-10，一手源码）：
  - Claude Code 2.1.88 的五阶段只在 `permissionContext.mode === 'plan'` 时挂载（`utils/attachments.ts:1192`；函数自 `:1186` 起），plan 外只有一句「do not propose changes to code you haven't read」。
  - Codex `main` 的 plan 模板是三段对话式（Ground → Intent chat → Implementation chat），没有调用链或数据层的必读要求（`codex-rs/collaboration-mode-templates/templates/plan.md`）。
  - ZCode v3.17.2 同样是 `EnterPlanMode` / `ExitPlanMode` 加 hooks，hooks 只能拦调用，不产出影响面（`apps/zcode-cli/docs/usage/04-tools.md`、`09-hooks.md`）。
  - 影响面类工具只有零件：codemap（静态依赖与 blast radius）、Aider repo map（符号签名）、Serena（LSP 符号与引用）、RepoGraph / LocAgent（研究原型），没有一个同时覆盖代码调用链与数据库结构，也没有一个能强制模型去读。
- **纠正旧记录**：ADR-20261107 记的「nano 没有可靠的工具级拦截点」不成立——`ctx.tools.guard` 在 0.2.2-rc.1 的类型定义里存在（`dsh-tools/lib/types/index.d.ts:136`），2026-11-10 的本地探针也验到 `write` 被拒并返回自定义理由、`read` 放行；该探针未入库，仓库内不可复核。本次按事实记录；能力存在不等于要采用，决定仍是不做。
- 0.2.5 的三场真实会话证据只覆盖旧文案，且 B3 依赖用户主动进 `/plan`，不能支撑「模式内更认真」的收益。

## 否决了什么

- **读后写守卫（`edit` / `write` 前必须读过）**：技术可行，但只覆盖「动手前」，覆盖不了「给结论」；为一个软收益引入硬拒绝与误拦，不划算。
- **`impact` 工具 / code map / LSP / MCP 接入**：市面只有零件，拼装与维护成本高于收益；本仓与用户项目形态不同，做不出一套通用判据。
- **保留五阶段覆盖**：用户不用 `/plan`；保留只会继续制造「进 plan 才认真」的错觉。
- **删除官方 plan 插件**：会连带拆掉 `exit_plan_mode`、plan-review 卡片与 activity 状态，收益为负；保留但不再加东西。

## 接受的代价

- 纯提示层，模型仍可能跳过清单；不设可观测指标，也不做统计承诺。
- 常驻段 1,171 → 1,579 字符（+408，约 +102 tokens/请求）。2026-11-10 首场 B1 真实会话漏了上游 / 下游 / 验证三项，按该证据补「五类面逐行必答」后从 1,401 增至 1,579。
- 撤覆盖后不再有「至少两个方案 / 复核关键文件 / 写验证命令」的分阶段提醒；新文案只保留「name the trade-off」与「Verification」两行，强度更弱。
- 本仓没有数据库 fixture，数据层要求没有行为证据；只由文本断言证明它在。
- 官方 plan 文本若变更，nano 自动跟随；这是收益，也是「我们不再控制 plan 内文案」的代价。

## 允许重开的条件

- 真实会话反复出现「没读就给方案」，且改提示后仍收敛不了；届时再评估守卫或影响面工具。
- 用户明确要求恢复 `/plan` 内的自定义引导，或要求启用读后写守卫。
- 官方 `dsh-plan-mode` 的 `section` 配置或 `exit_plan_mode` 语义变化，使「回到官方」不再成立。

## 关联

- [本次 spec](../specs/2026-11-10-prompt-only-research/README.md)
- [被取代的 ADR-20261107](2026-11-07-research-discipline.md)
- [ADR-20261103-question-trigger-discipline](2026-11-03-question-trigger-discipline.md)：同属提示层的提问纪律
- [ADR-20261102-nano-default-bypass-permissions](2026-11-02-nano-default-bypass-permissions.md)：默认权限口径，plan 不是安全边界
