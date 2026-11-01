# ADR-20261101-approval-decision-visible-in-transcript：审批决策在正文留痕

- 状态：生效中（随 spec `2026-11-01-nano-approval-card-in-transcript` 修订合并进入仓库基线）
- 日期：2026-11-01
- 决策人：用户
- 适用范围：审批结果在 transcript 中的呈现（工具行与决策行）
- 取代：无旧 ADR
- 被取代：无
- 决策来源：用户 2026-11-01 原话「我们的选项选了以后直接啥都没了，希望像claude code有一样在正文中展示」；Claude Code 2.1.88 `components/InterruptedByUser.tsx`、`components/FallbackToolUseRejectedMessage.tsx`、`components/messages/UserToolResultMessage/UserToolCanceledMessage.tsx`
- 相关：[spec](../../specs/2026-11-01-nano-approval-card-in-transcript/README.md)、[ADR-20261101-approval-card-in-transcript](2026-11-01-approval-card-in-transcript.md)

## 决定

1. 任一审批结果结算后，工具行保留，并在其正下方渲染一条决策行（`muted`、缩进 `INDENT`）：
   - `rejected` → `已拒绝 · 未执行`
   - `cancelled` → `已取消 · 未执行`
   - `unavailable` → `无法回答 · 按失败关闭处理`
   - `allowed-once` → 不额外加行；工具结果照常出现。
2. 决策行挂在 `ToolEntry.decision` 上，随 transcript 滚动与分页；卡片消失后仍然可见；不额外写入 `entries`。
3. 不依赖官方英文 `reason`；官方工具结果自带的错误行仍按现有 `failureRows` 保留，决策行在前、错误详情在后。
4. `callId` 缺失或找不到工具行时，退化为一条 `notice`（同文案），不吞掉记录。
5. 本次不触及鲸尾活动栏：`src/activity/*`、`ActivityLine`、`activityRows()`、`render/activity-image.ts` 与动画保持原样。

## 为什么

- Claude Code 在拒绝/取消后不会让记录消失：工具行保留，下面跟一行 dim 的 `Interrupted · What should Claude do instead?`（`FallbackToolUseRejectedMessage` 与 `UserToolCanceledMessage` 都复用 `InterruptedByUser`）。nano 之前卡片一关就什么都不剩，用户无法回看刚才选了什么。
- 决策行的来源是本地结算结果，不依赖官方 seam 的英文 reason；这样四种协议出口都能给出稳定、可读的中文记录。

## 代价与边界

- 拒绝/取消时可能同时出现决策行与官方错误详情（英文），信息有重复；决策行固定在前，详情保留在后，避免丢信息。
- 允许路径不额外加行，用户看到的是工具自身的结果（成功/失败）。
- 决策行不进入 `entries`，不改变历史持久化格式。

## 重开条件

- 官方 seam 暴露结构化的 decision 字段并在会话事件中带回时，改用官方字段，删除本地 `ToolEntry.decision`。
- 若实测认为决策行与错误详情重复过多，可将两者合并为一条，但必须保留「未执行」这一事实。
