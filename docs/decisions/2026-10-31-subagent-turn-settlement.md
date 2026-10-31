# ADR-20261031-subagent-turn-settlement：dock 完成态以子会话 turn/end 为准

- 状态：生效中
- 日期：2026-10-31
- 决策人：用户
- 适用范围：子代理 dock 的完成态信号、位置与详情头部
- 取代：无
- 被取代：无
- 补充：[ADR-20261022-subagent-dock-lifecycle](2026-10-22-subagent-dock-lifecycle.md)（30 秒清理与状态词不变）
- 决策来源：用户 2026-10-31 原话「subagent出现的位置你都还没弄明白，是在底部啊，不是在输入框上面！请你深度梳理」；随后选择「开新spec」并确认机制「全要」

## 决定

- dock 固定在状态栏之后、终端最底部，左右各 2ch；不再放在输入框上方。
- 可续聊子代理的 dock 完成态以子会话 `turn/end` 为准：
  - `completed` → 完成；`aborted` / `max-tokens` → 终止；`error` → 错误；`blocked` / `interrupted` / `forked` / 未知 → 未运行。
  - `turn/start` 把同一 id 复位为「执行中」，清 `terminalAt` 与 `dismissed`。
- `subagent/end` 仍作为 activation 结束的兜底信号；若该 turn 已有终态，不覆盖 `terminalAt`、不延长保留时间。
- 30 秒 grace、`x` 仅终态行、4 行上限、状态词集合全部沿用 ADR-20261022-subagent-dock-lifecycle。
- 详情头部改为左侧 `← 子代理 <名字>`、右侧状态词。

## 依据

- 设计稿 DOM：`preview/index.html:328-339` 的 `.composer` → `footer.status` → `.subagent-dock`；dock 是终端最后一个块。
- 官方 `subagent/end` 在 activation teardown 时发（`dsh-subagent/lib/index.js:2040-2042`），不是每轮结束；可续聊子代理一轮结束仍驻留，不能拿它当轮级完成态。
- 子会话 `turn/end` 带 `reason.kind`（`dsh-session/lib/types/types.d.ts:166-211`），是设计稿「一轮结束」的直接信号。
- 实测：子代理 `4e6a5ff2` 在 18:05:55 已有 `turn/end completed`，dock 仍显示「执行中」。

## 否决了什么

- 继续只监听 `subagent/end`：可续聊子代理在 activation 结束前永远显示执行中。
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
- 被补充：`ADR-20261022-subagent-dock-lifecycle`
- 相关：`ADR-20261022-input-history`
