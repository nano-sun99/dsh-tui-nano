# ADR-20261107-research-discipline：需求阶段先出调研清单，非平凡任务先进 plan

- 状态：生效中
- 日期：2026-11-07
- 决策人：用户
- 适用范围：模型在需求 / 变更类任务上的调研与计划行为；不适用于工具 schema、plan 模式的命令与审批形态、子代理组合
- 取代：无
- 被取代：无
- 决策来源：用户 2026-11-07 原话「要不我们抄一下claude code的调研机制？」；同日两张选择卡分别选定「T3：连只读研究子代理一起抄」与「分两批：先提示层」；Claude Code 2.1.88 源码（`src/constants/prompts.ts`、`src/tools/AgentTool/built-in/exploreAgent.ts`、`planAgent.ts`、`src/utils/messages.ts:3227`、`src/tools/EnterPlanModeTool/prompt.ts`）
- 相关：[spec](../specs/2026-11-07-nano-research-discipline/README.md)

## 决定

1. nano 给根 agent 注册一条 `nano:research-discipline` 系统提示段（order 10140）：非平凡需求先给**调研清单**——关键文件、可复用的函数或模式、调用链、风险、验证方式——再给方案；没读过的文件不许改。
2. 能从代码查到的事实自己去查，不许问用户「代码在哪」「现在是怎么跑的」；确实没查的部分要明说，不许把假设当发现。
3. 非平凡任务主动建议 `/plan`；进 plan 后按五阶段走：并行调研 → 设计（至少两个方案）→ 复核关键文件 → 写计划（含复用点与一条验证命令，40 行内）→ `exit_plan_mode` 交审。
4. 覆盖官方 `plan-mode` 的 `section` 文本；保留官方两条硬语义：用户口头同意不算批准、工具目录跨模式不变（覆盖只为加阶段与模板，不改这两条）。
5. 例外：一行修复、纯查事实、用户明说「直接干」不触发完整调研；即使走例外，也要先读要改的文件。
6. 不做只读 research 子代理（批次 2 另立）；不把 `/plan` 改成模型可主动调用的工具。
7. 本决定不承诺行为 100% 改变：两段都是软约束，硬保证仍来自工具权限、沙箱与审批。

## 依据

- Claude Code 把「调研」做成独立阶段：plan 模式强制只读，五阶段里 Phase 1 只许探索、Phase 2 才设计（`src/utils/messages.ts:3227-3290`）。
- Claude Code 对「彻底」给了可指定的档位：Explore 子代理由调用方指定 quick / medium / very thorough（`src/tools/AgentTool/built-in/exploreAgent.ts:49-62`）。
- Claude Code 的主提示有硬规则：`In general, do not propose changes to code you haven't read.`（`src/constants/prompts.ts:230`）；plan 模式的访谈变体还写明 `Never ask what you could find out by reading the code`。
- nano 现状：官方 plan 引导只有一句 `Explore first.`（`node_modules/@deepseek-ai/dsh-base/cordis.patch.yml:342`），没有阶段与计划模板；模型也没有主动进 plan 的工具（实测只有 `/plan` 命令）。
- 2026-11-07 实测：profile 补丁可按 id 整段替换 plan-mode 的 `section`，激活时渲染、未激活时为空——覆盖方案可行。

## 否决了什么

- **只写一句「要调研」的提示**：不定义「调研完成」，等于没写。
- **直接 fork 官方 plan-mode 包**：引入维护分叉；配置覆盖已够用。
- **把 `/plan` 改成模型可调用的 `enter_plan_mode` 工具**：需要新插件与审批语义，批次 1 不做。
- **批次 1 就上只读 research 子代理**：dsh 的只读要靠 agent preset 复刻一份工具清单，升级会漂移；先验证提示层是否够。
- **加硬闸（强制先出清单才能提交）**：nano 没有可靠的工具级拦截点，且会拖慢小改。

## 接受的代价

- 常驻提示约 +1,100 字符（~300 tokens），每次请求都带。
- 提示是软约束，模型仍可能跳过清单；效果靠真实会话观察，不进单硬验收。
- 覆盖官方 plan 文本后，dsh 升级若改动该段，我们不会自动跟随，升级时需人工对一次。
- 不新增可观测指标（如「调研清单命中率」）。

## 允许重开的条件

- 真实会话证据表明模型仍然不调研就给方案，且提示层无法收敛；届时评估批次 2 的只读子代理或硬闸。
- 官方 `dsh-plan-mode` 的 `section` 配置或 `exit_plan_mode` 语义改变，使覆盖不再成立。
- 用户明确要求恢复「直接动手」的默认行为。

## 关联

- [本次 spec](../specs/2026-11-07-nano-research-discipline/README.md)
- [ADR-20261103-question-trigger-discipline](2026-11-03-question-trigger-discipline.md)：提问纪律，与本条的调研纪律同属提示层
- Claude Code 2.1.88：`src/utils/messages.ts:3227`、`src/tools/AgentTool/built-in/exploreAgent.ts`、`src/tools/EnterPlanModeTool/prompt.ts`
