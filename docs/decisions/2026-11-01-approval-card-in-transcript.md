# ADR-20261101-approval-card-in-transcript：审批卡进正文滚动区，输入块保留

- 状态：待生效（随 spec `2026-11-01-nano-approval-card-in-transcript` 合并）
- 日期：2026-11-01
- 来源：用户 2026-11-01 拍板「那就走B」与「按 Claude Code（推荐）」；Claude Code 2.1.88 源码 `screens/REPL.tsx:4519,4565`、`components/FullscreenLayout.tsx:361`（`overlay` 注释：*Content rendered inside the ScrollBox after messages*）
- 相关：[spec](../../specs/2026-11-01-nano-approval-card-in-transcript/README.md)、[visual-v1](../../specs/2026-10-22-nano-visual-v1/README.md)、[design-contract §1](../../release/design-contract.md)

## 决定

1. 审批卡**不再使用全屏浮层**：它的行块追加在 transcript 的滚动内容末尾，随正文一起滚动；输入块保持在底部可见（审批挂起时不可编辑）。
2. 本决定**取代** `design-contract` §1 覆盖层规则中的「决策卡（审批/问卷/计划审阅）替换输入块」与 `visual-v1`「主界面槽位」条（`README.md:39`）的「决策卡打开时输入块隐藏」，**仅对审批卡**生效；问题卡与计划审阅卡不变。
3. 删除 `Overlay` 原语（`src/render/components.ts` 的导出与 `src/render/host.ts` 的 `'overlay'` 分支）：它唯一的调用方是审批卡，而它在重绘时会丢失合成定位。
4. 审批卡展示完整命令：`callId` → transcript `ToolEntry.args` 的 `command`；取不到时按 args 键值降级，再取不到则省略命令区。

## 为什么

- 现浮层在首帧正确，但任何一次 React 重绘都会让 `commitUpdate` 用元素原始 props 覆盖创建时注入的 `position:absolute; left/top:0; width/height:100%`，卡片退化成列尾子节点，掉到输入块下方、把输入区顶上去。该缺陷从初始实现起就存在（`git log -L 459,474:src/render/host.ts` 只有 `a44fa65`）。
- Claude Code 的审批卡本来就不是浮层：全屏模式下它在 `ScrollBox` 内、消息之后，用户可上滚查看上下文，输入框独立保留。nano 跟随这一形态，同时消灭「绝对定位 + 重绘」的整类问题。
- 保留输入块：审批是单一决策，输入区仍在原位，用户不会丢失输入位置；这与问题卡（需要整块空间逐题作答）的取舍不同，属于有意的差异。

## 代价与边界

- **两张决策卡落点不一致**：审批卡在正文流，问题卡仍在输入位。接受该差异；若后续实测造成认知负担，另立 spec 统一迁移问题卡。
- 审批挂起时 `PageUp`/`PageDown` 改为滚正文，焦点行需自动滚入视野；这会把滚动责任从「卡片内部滚动」挪到「transcript 滚动」。
- 删除 `Overlay` 后，未来若需要真正的模态浮层，必须重新设计并修复 `commitUpdate`，不能复活旧原语。

## 重开条件

- 问题卡与审批卡落点不一致被用户判定为负担，且问题卡迁移有独立 spec 时，重新评估两者是否统一。
- 上游 Claude Code 改变审批卡落点，或官方 seam 开始携带工具入参（届时命令区块的 `callId` 查找可简化）。
