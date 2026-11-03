# ADR-20261103-question-answer-visible-in-transcript：问卷答案在正文留下「问题 → 答案」

- 状态：生效中
- 日期：2026-11-03
- 决策人：用户
- 适用范围：`ask_user_question` 工具行在 transcript 中的显示与 UI 留存；不适用于官方 session log、模型可见结果、问卷卡本身的交互
- 取代：无
- 被取代：无
- 决策来源：用户 2026-11-03 原话「选项选过决策记录就丢了，在正文一点展示都没有，请你看看 claude code是怎么做的」；Claude Code 2.1.88 `tools/AskUserQuestionTool/AskUserQuestionTool.tsx:83-97`（`· 问题 → 答案`）；沿用 [ADR-20261101-approval-decision-visible-in-transcript](2026-11-01-approval-decision-visible-in-transcript.md) 的「决策行挂 `ToolEntry`」模式
- 相关：[spec](../../specs/2026-11-03-nano-harness-feel/README.md)

## 决定

1. 问卷答案从官方 tool result 的 JSON 投影到 `ToolEntry.questionAnswers`，形如 `{ question, answer, skipped }[]`；同时记录 `questionOutcome`（`answered` / `skipped` / `cancelled` / `pending`）。
2. 折叠态与展开态都在工具行下方显示 `· <问题> → <答案>`（`muted`、缩进 `INDENT`、单行截断）；不再显示原始 JSON。
3. 文案：多选 / 自定义用 `、` 连接；跳过的题显示 `（已跳过）`；没有对应答案项显示 `（未回答）`；整次取消只显示一行 `· 已取消，未提交答案`；pending 不显示逐题行，标题后缀 `· 等待你的选择`。
4. 原始 JSON 不留在 `ToolEntry.resultText`；成功解析后置空，符合 [ADR-20261102-transcript-display-projection](2026-11-02-transcript-display-projection.md) 的「只保留显示投影」。
5. 投影在 `completeTool` 中执行，实时事件与 `replay()` 共用同一条路径；不新增持久化字段，重开会话从 session log 的 args + result 重建。
6. 解析失败、旧会话没有 JSON、或结果结构不认识时，退回现有工具行（标题 + 预览），不抛错、不显示半截记录。
7. 不改变官方 `ask_user_question` 的 seam、答案结构、取消语义（`ASK_ABORTED` 仍由 ADR-20261101-question-card-cancel 约束）。

## 依据

- Claude Code 的 `AskUserQuestionResultMessage` 在正文渲染 `User answered Claude's questions:` 与每组 `· questionText → answer`（`tools/AskUserQuestionTool/AskUserQuestionTool.tsx:83-97`）。
- nano 的问卷结果是 JSON 文本：`dsh-tool-ask-user` 的 `render` 返回 `JSON.stringify(value)`（`node_modules/@deepseek-ai/dsh-tool-ask-user/lib/index.js:175-178`），结果里有 `answers` 数组（`:52-58`）；`textOf` 能取到这段文本，但折叠工具行只显示标题，所以用户看不到（`src/transcript/model.ts:381-457`）。
- 问卷请求带 `wait.callId`（同包 `:195-205`；`dsh-user-questions/lib/types/types.d.ts:112-124`），工具行的 `callId` 能对应上；本次投影按 args 里的问题 id 映射，不依赖 `wait.callId`，但 `callId` 仍可用于未来把记录挂到指定条目。
- 审批决策行已经采用「挂 `ToolEntry`、不新增 entry」的模式（ADR-20261101-approval-decision-visible-in-transcript）；问卷答案沿用，避免两套记录机制。
- 原始 JSON 属于「UI 永远用不到的载荷」，不应进 `resultText`；ADR-20261102 已确立显示投影原则。

## 否决了什么

- **新增独立 entry / notice 存答案**：与审批决策行的既有模式不一致，且会在 transcript 里多一条脱离工具上下文的记录。
- **保留原始 JSON，仅展开时显示**：折叠态仍然看不到记录，未满足用户诉求。
- **只在展开时显示 `问题 → 答案`**：用户要的是「正文一点展示都没有」的反面，折叠态必须可见。
- **改官方工具结果结构 / 自定义 `ask_user_question` 工具**：引入维护分叉，且官方结果已包含所需数据。

## 接受的代价

- 一次最多 4 题 → 最多 4 行记录；问题文本过长时会被单行截断。
- 取消时工具结果本身是 `ASK_ABORTED` 错误，工具行 mark 可能仍是错误色；决策行用 `muted` 说明「已取消，未提交答案」。
- 旧会话如果没有可解析的 JSON（例如 timed pending 或人工改过的日志），只能退回标题，不保证所有历史记录都能还原。
- 不记录用户作答耗时、focus 轨迹等过程信息。

## 允许重开的条件

- 官方 DSH 提供结构化的 `user-questions` 答案投影（而不是 JSON 文本），可直接复用。
- 问卷开始支持并发 / 跨地址作答，单条 `ToolEntry` 不再能承载记录。
- 用户要求更紧凑的展示（例如只显示计数），或要求记录答案耗时等额外信息。

## 关联

- [本次 spec](../../specs/2026-11-03-nano-harness-feel/README.md)
- [ADR-20261101-approval-decision-visible-in-transcript](2026-11-01-approval-decision-visible-in-transcript.md)：决策行挂 `ToolEntry` 的既有模式
- [ADR-20261102-transcript-display-projection](2026-11-02-transcript-display-projection.md)：工具结果只保留显示投影
- [ADR-20261101-question-card-cancel](2026-11-01-question-card-cancel.md)：Esc 取消整次提问的语义
- Claude Code 2.1.88：`tools/AskUserQuestionTool/AskUserQuestionTool.tsx:83-97`
