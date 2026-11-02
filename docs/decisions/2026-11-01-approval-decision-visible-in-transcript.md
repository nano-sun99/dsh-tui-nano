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

1. 拒绝/取消/无法回答结算后，工具行保留，并在其正下方渲染一条决策行（`muted`、缩进 `INDENT`）：
   - `rejected` → `已拒绝 · 未执行`
   - `cancelled` → `已取消 · 未执行`
   - `unavailable` → `无法回答 · 按失败关闭处理`
   - `allowed-once` → 不额外加行；工具结果照常出现。
2. 决策行挂在 `ToolEntry.decision` 上，随 transcript 滚动与分页；卡片消失后仍然可见；不新增 entry，只作为该条目的字段保存。
3. 不依赖官方英文 `reason`；官方工具结果自带的错误行仍按现有 `failureRows` 保留，决策行在前、错误详情在后。
4. `callId` 缺失或找不到工具行时，拒绝/取消/无法回答退化为一条 `notice`（同文案），不吞掉记录；允许路径不需要记录。
5. 本次不触及鲸尾活动栏：`src/activity/*`、`ActivityLine`、`activityRows()`、`render/activity-image.ts` 与动画保持原样。

## 为什么

- Claude Code 在拒绝/取消后不会让记录消失：工具行保留；工具若实现了 `renderToolUseRejectedMessage` 就渲染它自己的拒绝 UI（FileEdit/FileWrite 等），否则回退到 dim 的 `Interrupted · What should Claude do instead?`（`FallbackToolUseRejectedMessage` 与 `UserToolCanceledMessage` 复用 `InterruptedByUser`）。nano 的工具行与官方错误详情本来就在，缺的是「用户选了什么」这条决策记录。
- 决策行的来源是本地结算结果，不依赖官方 seam 的英文 reason；这样四种协议出口都能给出稳定、可读的中文记录。

## 代价与边界

- 拒绝/取消时可能同时出现决策行与官方错误详情（英文），信息有重复；决策行固定在前，详情保留在后，避免丢信息。
- 允许路径不额外加行，用户看到的是工具自身的结果（成功/失败）。
- 决策行不新增 entry（只挂在 `ToolEntry` 上），不改变历史持久化格式。

## 重开条件

- 官方 seam 已经在会话里追加 `approval/asked`（含 `id`/`callId`）与 `approval/decided`（含 `id`/`outcome`）审计对（`node_modules/@deepseek-ai/dsh-user-approval/lib/index.js:132,139`；`dsh-session` 事件白名单 `lib/index.js:82-83`），但 nano 的会话控制器尚未订阅处理。若后续改为消费这两个事件，需要按 `id` 把 outcome 映射回 `callId`，并过滤自动策略/子代理产生的审批；届时删除本地 `ToolEntry.decision`。
- 若实测认为决策行与错误详情重复过多，可将两者合并为一条，但必须保留「未执行」这一事实。
