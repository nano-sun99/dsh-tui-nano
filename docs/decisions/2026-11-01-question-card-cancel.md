# ADR-20261101-question-card-cancel：问卷卡 `Esc` 取消整次提问，不提交半成品答案

- 状态：生效中（随 spec `2026-11-01-nano-question-card-parity` 合并生效）
- 日期：2026-11-01
- 来源：用户 2026-11-01 原话「我的要求是完全实现设计稿的效果」；设计稿 `docs/design/2026-10-17-dsh-tui-ux-research/preview/choices.js:104-109`（`Escape` → `{kind:'cancelled'}`）、`preview/choices.js:166-170`（「已取消，未提交答案」）
- 相关：[S03 §4.5 / §4.6](../../specs/2026-10-20-nano-v1/S03-reading-decisions.md)、spec [`2026-11-01-nano-question-card-parity`](../../specs/2026-11-01-nano-question-card-parity/README.md)

## 决定

1. 问卷卡上按 `Esc` = **取消整次提问**：不提交任何答案，answerer 以 `UserQuestionError(ASK_ABORTED)` 拒绝这次等待，模型看到的是「用户没有回答」而不是一组空答案。
2. 想「跳过某一题」改用 `Alt+N`：该题以 `{ id, selected: [] }` 结算，其余题照常作答；这条保留 S03 §4.5 的 Skip 口径。
3. 因此 `Esc` 不再等于「跳过并提交当前草稿」；现行 `DecisionManager.escape()` → `submitQuestions()`（`src/decisions/manager.ts:266-277`）随之废除，`askQuestions()` 的 abort 分支（`:129-134`，现在结算成每题空答案）也改走同一拒绝路径。
4. 这条同时取代 S03 §4.6 的「关闭卡片 ≠ 作答、工具行可重新打开」：取消之后不再保留可重开的卡。

## 为什么

- 「跳过一题」和「拒绝这次提问」是两种意图。现状把两者都压成「提交空数组」，模型无法区分「用户答了空」和「用户不想答」，会照着空答案继续推断。
- 设计稿与 Claude Code 在这点上是同一结论：取消不携带数据（Claude Code 走 reject，工具侧回 `User declined to answer questions`）。官方 seam 的对应出口是 answerer 拒绝并让 `ask()` 还原成 `UserQuestionError`——**不是** abort 调用方的 `request.signal`：那个 signal 属于调用方，answerer 无权触发（`node_modules/@deepseek-ai/dsh-user-questions/lib/index.js:669,688`；`lib/types/types.d.ts:124`）。
- 实现路径：`waiter.reject({ name: 'UserQuestionError', code: 'ASK_ABORTED', message: 'ask_user_question was aborted before the user answered' })`，官方 `restoreUserQuestionError` 会按 `name`/`code` 还原（`lib/index.js:437-441`），工具侧得到 `Error: ask_user_question was aborted before the user answered`。
- 保留 `Alt+N` 而不是直接砍掉跳过：`design-contract` §2 已冻结该键位，多题批次里也确实需要一个「这题我不答」的出口。

## 代价与边界

- 工具侧会多一种失败结果（`ASK_ABORTED`），模型提示里会出现「用户取消」，不再是静默空答案；调用方若依赖「一定有 answers」需自行处理。
- 单题场景下 `Esc` 与 `Alt+N` 的效果接近（都是不答），区别在多题批次：`Esc` 丢弃整批，`Alt+N` 只丢一题。
- 不改变官方 seam 形状：答案仍是 `{ id, selected, custom? }`；取消不写任何答案。

## 重开条件

- 官方 `ask()` 增加显式的「用户拒绝」结果形状（而不是 abort 错误），本决定应改为使用该结果。
- 若实测显示模型无法区分 aborted 与网络故障，而误判为工具异常，可重新评估是否改用带标记的空答案。
