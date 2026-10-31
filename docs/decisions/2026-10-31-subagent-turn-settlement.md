# ADR-20261031-subagent-turn-settlement：dock 完成态以子会话 turn/end 为准

- 状态：生效中
- 日期：2026-10-31
- 决策人：用户
- 适用范围：子代理 dock 的位置、完成态信号、行内容与详情头部
- 取代：[ADR-20261022-subagent-dock-lifecycle](2026-10-22-subagent-dock-lifecycle.md)
- 被取代：无
- 决策来源：用户 2026-10-31 原话「subagent出现的位置你都还没弄明白，是在底部啊，不是在输入框上面！请你深度梳理」；随后选择「开新spec」并确认机制「全要」

> 本 ADR 取代旧 ADR 的**保留计时触发点**：旧规则从官方 `subagent/end` 起算 30 秒；新规则从第一条轮级/activation 终态信号起算。旧 ADR 的 30 秒时长、状态词、行内容与「不显示用时/token」继续有效，本文一并承接。

## 决定

### 承接旧 ADR

- dock 无标题、无用时、无 mode 后缀；行内容为焦点指针、状态灯、名字（弹性）、右侧一个状态词。
- 只显示本地直接子代理；external 不进 dock。
- 状态词：`执行中` / `完成` / `终止` / `错误` / `未运行`；unknown 终态并入 `未运行`。
- 终态行保留 30 秒后出列；`x` 仅对终态行生效；同一 id 再次 `subagent/start` 清除 hidden。
- dock 最多 4 行，第 5 个起合并为 `还有 N 个子代理`。

### 本次改变

- dock 固定在状态栏之后、终端最底部，左右各 2ch；不再放在输入框上方。
- 可续聊子代理的 dock 完成态以子会话 `turn/end` 为准：
  - `completed` → 完成；`aborted` / `max-tokens` → 终止；`error` → 错误；`blocked` / `interrupted` / `forked` / 未知 → 未运行。
  - `turn/start` 把同一 id 复位为「执行中」，清 `terminalAt`、`dismissed` 与 activation 兜底用的 `terminal` 状态。
- `subagent/end` 仍作为 activation 结束的兜底信号：
  - 尚无终态时写入状态与 `terminalAt`；
  - 已有 turn 终态时只保留 turn 状态，不覆盖、不延长保留时间。
- 30 秒从第一条终态信号（turn/end 或 activation end）起算，不再固定从 `subagent/end` 起算。
- 详情头部改为左侧 `← 子代理 <名字>`、右侧状态词。

## 依据

- 设计稿 DOM：`preview/index.html:328-339` 的 `.composer` → `footer.status` → `.subagent-dock`；dock 是终端最后一个块。
- 官方 `subagent/end` 的实际 emit 在 `dsh-subagent/lib/index.js:200-204`（`createActivationObserver.settle`），`settle()` 由 activation teardown 调用（`:2040-2042`），不是每轮结束；可续聊子代理一轮结束仍驻留，不能拿它当轮级完成态。
- 子会话 `turn/end` 带 `reason.kind`（`dsh-session/lib/types/types.d.ts:166-211`），事件本身在 `SessionEventMap`（`:256-277`），是设计稿「一轮结束」的直接信号。
- 用户现场观察（2026-10-31）：子代理 `4e6a5ff2` 在 18:05:55 已有 `turn/end completed`，dock 仍显示「执行中」；代码路径也可能落到「未运行」。两者都等不到设计稿的完成态。

## 否决了什么

- 继续只监听 `subagent/end`：可续聊子代理在 activation 结束前可能停在「执行中」或「未运行」，永远等不到设计稿的完成态。
- 把 dock 留在输入框上方：与设计稿的 DOM 顺序相反。
- 改 30 秒为设计稿样稿的 1.5 秒：ADR-20261022 的 30 秒是用户已拍板的决定，不在本次重开。

## 接受的代价

- dock 多占用终端底部若干行，正文可用高度相应减少；60 列窄屏下正文更短。
- continuation 的 `turn/start` 会让已按 `x` 隐藏的行重新出现；这是「新的一轮」的预期行为。
- turn 终态与 activation 终态可能先后到达，需要幂等去重，避免重复计时。

## 允许重开的条件

- 官方提供统一的轮级 settlement 事件，可替代 `turn/end`。
- 设计稿把 dock 移回输入框上方，或用户明确要求改回。
- 30 秒 grace 被用户重新拍板。

## 关联

- spec：`docs/specs/2026-10-31-nano-subagent-dock-alignment/README.md`
- 取代：`ADR-20261022-subagent-dock-lifecycle`
- 相关：`ADR-20261022-input-history`
