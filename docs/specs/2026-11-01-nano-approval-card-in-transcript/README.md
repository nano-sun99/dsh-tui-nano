# [2026-11-01-nano-approval-card-in-transcript] 审批卡进正文流（对齐 Claude Code）

- 组标识：`2026-11-01-nano-approval-card-in-transcript`
- 角色：单份 spec，总纲与执行规格合一
- 状态：已合并（PR #133）；2026-11-01 修订：新增决策留痕（本次 PR 待过闸）
- Issue：#134（实施单）；本次修订合并后回填该单
- 结构：不拆——1 份 spec + 1 张执行 issue
- 机制范围：**5 项新增机制**（M1–M5）——① 审批卡并入正文滚动序列；② 命令区块（`callId` → `ToolEntry.args`）；③ 删除 `Overlay` 原语；④ 审批挂起时的滚动与焦点路由；⑤ 审批决策在正文留痕。其余复用现有 `DecisionManager`、transcript 渲染与主题 token
- 上游：
  - Claude Code 2.1.88 源码（本机归档 `/Users/sunchongsheng/Downloads/归档/06-软件与安装包/ClaudeCode/src`）：`screens/REPL.tsx:4519,4565`、`components/FullscreenLayout.tsx:361`、`components/permissions/PermissionDialog.tsx`、`components/permissions/BashPermissionRequest/BashPermissionRequest.tsx:84-88,437-446`、`components/permissions/BashPermissionRequest/bashToolUseOptions.tsx`
  - 设计稿 `docs/design/2026-10-17-dsh-tui-ux-research/preview/`（`choices.js` 的 `approvalBody()`、`index.html` `.choice-*`）
  - [visual-v1 §4.1/§4.3](../../specs/2026-10-22-nano-visual-v1/README.md)、[design-contract §1/§2](../../release/design-contract.md)
- 替代关系：本 spec **修订**以下条款，**只对审批卡生效**；问题卡、计划审阅卡不变。不回写旧 spec 正文，按修订记录处理：
  1. `design-contract` §1 覆盖层规则「决策卡（审批/问卷/计划审阅）替换输入块」→ 审批卡不再占输入位。
  2. `visual-v1`「主界面槽位」（`README.md:39`）「决策卡打开时：决策卡 → 活动行 → 底栏，输入块隐藏」→ 审批卡在正文流，活动行回到输入块上方，输入块保留。
  3. `visual-v1` 第 6 条（`README.md:65`）「审批命令窗口按卡片可用高度显示完整命令，超出再滚动」→ 审批卡命令区改为 8 行截断 + 「…还有 k 行」。
  4. `design-contract` §2（`:78`）审批卡键位 `1` / `2` / `Esc` → `1`–`4` + `PageUp` / `PageDown` + 滚轮 + 鼠标点击。
- ADR：新增 [ADR-20261101-approval-card-in-transcript](../../decisions/2026-11-01-approval-card-in-transcript.md)；修订新增 [ADR-20261101-approval-decision-visible-in-transcript](../../decisions/2026-11-01-approval-decision-visible-in-transcript.md)
- 下游：Issue #134（已开，待实施委托）；问题卡选项卡（`← →`、反色）另立 spec
- 合入前提：实施须单测 + 渲染断言全绿，并按 §6 留 100/60 列真实终端证据

## 1. 目标

让审批卡与 Claude Code 2.1.88 的形态一致，而不是继续做一个会错位的浮层：

1. **落点**：审批卡作为正文滚动内容的一部分，接在最后一条消息之后；输入块固定在底部、保持可见。
2. **信息**：卡片显示问句标题、原因、**完整命令**（`muted`，超出可用高度时截断并提示）、4 个选项与键位提示。
3. **操作**：`↑`/`↓` 移焦点、`Enter` 确认、`1`–`4` 直选、`Esc` 取消；`PageUp`/`PageDown` 与滚轮滚正文。
4. **清理**：删除 `Overlay` 原语，消除「重绘冲掉定位」的整类缺陷。
5. **留痕**：用户拒绝/取消/无法回答时，正文保留一条决策行（文案见 §3.9）；允许路径由工具结果承担。卡片消失不带走记录——对齐 Claude Code 的拒绝/取消结果行。

### 非目标

- **问题卡 / 选项卡**：落点与视觉均不变（仍占输入位）；`← →` 箭头、当前项反色另立 spec。
- **持久权限规则**（「始终允许」）：官方 seam 无规则存储，本次不做。
- **fail-closed 语义**：4 个结果（`allowed-once` / `rejected` / `cancelled` / `unavailable`）与现有键位分流不变。
- **鲸尾活动栏**：`src/activity/*`、`ActivityLine`、`activityRows()`、`render/activity-image.ts` 与鲸尾动画**不做任何改动**。审批挂起时活动行沿用现行静态「等待你的授权」（ADR-20261101-activity-dock：等待授权/选择不冒充仍在计算，无动画）；结算后回到正常活动态。
- **计划审阅卡**：与问卷共用一张卡，本次不重做。
- **倒计时**：设计稿无此形态，不在范围。

## 2. 现状与证据

调查基线：`origin/main` @ `1d29c4c`；官方 `@deepseek-ai/dsh` 0.2.1-rc.2。

| 事实 | 证据 |
|---|---|
| 审批卡是全屏浮层，面板宽 `min(72, max(30, width-8))`，居中、`clear` | `src/app/App.tsx:375-422` |
| 浮层的绝对定位是创建时注入的合成 props（`position:absolute; left/top:0; width/height:100%`） | `src/render/host.ts:354-375` |
| `commitUpdate` 每次重绘用元素原始 props 覆盖，合成定位丢失 | `src/render/host.ts:459-473` |
| 重绘后浮层退化成普通列尾子节点：118×37 下标题行 13 → 22，节点 layout `top` 0 → 19、高度 37 → 18 | 2026-11-01 本机复现：挂载 App（118×37，`decisions.askApproval('bash', reason)`）→ `renderer.update` 一次 → 读 overlay 节点 `getComputedLayout()`。复现用例为临时文件，已撤销；实施期按 §6 落回归测试 |
| 审批挂起时输入块仍渲染，占位「等待你处理上面的确认…」 | `src/app/App.tsx:588-592`；占位分支在 `src/app/App.tsx:227-240`（`decisions.hasDecision`） |
| 审批键位全量截获（`↑↓`/`Enter`/`1-4`/`Esc`），`PageUp`/`PageDown` 未放行 | `src/app/nano-app.ts:465-477` |
| 工具入参以 JSON 字符串存在 transcript：`ToolEntry.args`；`parseArgs` 已可解析但未导出 | `src/transcript/model.ts:190-200`、`:480`（`function parseArgs`，模块私有） |
| 官方 approval 事件只带 `toolName` / `callId` / `reason`，不带入参 | `node_modules/@deepseek-ai/dsh-user-approval/lib/index.js:123-136` |
| 官方 UI 用 `callId` 取 detail 槽渲染工具详情 | `node_modules/@deepseek-ai/dsh-client-ui-approval/lib/client.js:40` |
| Claude Code：审批卡在 `ScrollBox` 内、消息之后；输入框独立固定 | `FullscreenLayout.tsx:361`、`REPL.tsx:4565` |
| Claude Code：命令来自 `toolUseConfirm.input`（`BashTool.inputSchema.parse`），以 dim 渲染完整命令 | `BashPermissionRequest.tsx:84-88`、`:437-446` |

## 3. 交互规格

### 3.1 槽位与形态

- 审批卡**不是**独立槽位：它的行块追加在 transcript 的可见行序列之后，参与同一套滚动与分页。
- 行宽与 transcript 内容一致：`width - EDGE`，左缩进 `EDGE`（`src/transcript/model.ts:311-312` 的 user 行同宽）；不加外框，顶部一条 `accent` 横线（visual-v1 §4.3，`README.md:76`）。
- 输入块照常渲染在底部；状态行、活动行、dock 位置不变（活动行留在输入块上方，不再位于卡片与底栏之间）。

### 3.2 行结构

```
──────────────  ← accent 横线，内容宽度
是否运行这条检查命令？          ← 白色加粗问句
当前模式要求逐次确认：…          ← 原因（muted，自动换行）
npm test                       ← 完整命令（muted，最多 8 行，超出显示「…还有 k 行」）
  1. 允许一次
     仅允许本次命令，不更改后续权限。
> 2. 拒绝                      ← 默认焦点（fail-closed，`selected: 1`）
     不执行本次命令。
  3. 取消请求
  4. 无法回答（按失败关闭处理）
↑↓ 移动 · Enter 确认 · 1–4 直选 · Esc 取消请求   ← faint
```

- 默认焦点：「拒绝」（与 `src/decisions/manager.ts:5` 注释、`:104` 的 `selected: 1` 一致）；设计稿与实施都不改成「允许一次」。

- 标题：Bash 用固定问句「是否运行这条检查命令？」；其他工具用「是否允许 `<toolName>` 执行？」。
- 原因：`prompt.reason`，空则不占行。
- 命令：见 §3.3。
- 选项：4 项，见 §3.4。
- 键位提示：1 行，`faint`。

### 3.3 命令区块

- 来源优先级（对所有工具一致）：
  1. `prompt.callId` → transcript 中同 `callId` 的 `ToolEntry` → `parseArgs(args).command`（字符串且非空）；
  2. 取不到 `command` 时，把 `args` 的顶层键值渲染为 `key: value` 行（单行截断）；
  3. 再取不到时，省略命令区（不拿 `reason` 冒充命令）。
- 渲染：`muted`，按内容宽度换行；最多 8 行，超出追加「…还有 k 行」。**不做卡片内滚动**——超出部分由正文滚动查看；这条取代 `visual-v1` 第 6 条（`README.md:65`）的「超出再滚动」。
- 命令区块与原因之间空 1 行；与选项之间空 1 行。

### 3.4 选项

- 保留 4 项，顺序与 `APPROVAL_OPTIONS` 一致。
- 前两项（允许一次 / 拒绝）按设计稿带描述；后两项（取消请求 / 无法回答）保留为协议兜底，不加描述。
- 焦点行：`>` 指针 + 标签 `accent` + `bold`；非焦点行：空格 + 标签 `normal`。
- 编号 `1.` … `4.` 固定 2 列宽，`muted`；描述行缩进 5ch（`NESTED + INLINE`）。
- 数字直选 1–4 与现有 `APPROVAL_OPTIONS` 索引保持一致。

### 3.5 焦点与滚动

- 卡片的焦点行必须在视口内：`↑`/`↓` 移动焦点时，若焦点行滚出可见区，自动调整 `scrollOffset`（沿用问题卡的「焦点跟随」语义）。
- `PageUp`/`PageDown`：审批挂起时改为滚动正文（±5 行），由 `handleDecisionKey` 放行给 `scrollBy`，不再被审批键位吞掉。
- 滚轮：沿用现有 `handleMouse` 的 wheel 分支（本就不受决策拦截），确认仍可滚正文。
- 默认 `stickBottom = true`：卡片在底部可见；用户手动上滚后保持手动位置。审批挂起期间的重绘不得强制把滚动位置拉回底部——只有首次打开或焦点移动允许调整。

### 3.6 键位总表（审批挂起）

| 键 | 行为 |
|---|---|
| `↑` / `↓` | 移动焦点（焦点行自动滚入视野） |
| `Enter` | 选中焦点项 |
| `1`–`4` | 直选对应结果 |
| `Esc` | 取消请求（`cancelled`，不等于允许） |
| `PageUp` / `PageDown` | 滚动正文 ±5 行 |
| 滚轮 | 滚动正文 |
| 鼠标左键点击选项 | 选中对应结果（`decision:approval:<index>`） |

### 3.7 输入块与活动行

- 输入块保持可见、不可编辑（现状）：占位「等待你处理上面的确认…」。
- 活动行保持「等待你的授权」文案（visual-v1 §4.1，`README.md:53`），位置在输入块上方（普通状态的位置），不随卡片移动；挂起期间为静态提示（无鲸尾动画），结算后回到正常活动态。
- 状态行右侧仍显「Enter 插话 · Ctrl+C 停止」；`Ctrl+C` 仍走停止流程。

### 3.8 鼠标

- 卡片行沿用 `Row.pressId` → `onPress` 通路；渲染层无需新增机制。
- 点击选项与键盘直选的结算路径一致（`decisions.resolveApproval`）。

### 3.9 决策留痕（对齐 Claude Code）

Claude Code 在用户拒绝/取消后不会让记录消失：工具行保留，下面跟一行 dim 的 `Interrupted · What should Claude do instead?`（`components/InterruptedByUser.tsx`；`FallbackToolUseRejectedMessage`、`UserToolCanceledMessage` 都复用它）。nano 按同一形态落地：

- 结算时按 `prompt.callId` 把结果记到对应 `ToolEntry`（`decision?: ApprovalOutcome`），渲染在工具行正下方 1 行、`muted`、缩进 `INDENT`：
  - `rejected` → `已拒绝 · 未执行`
  - `cancelled` → `已取消 · 未执行`
  - `unavailable` → `无法回答 · 按失败关闭处理`
  - `allowed-once` → 不加额外行；工具结果照常出现（成功/失败由工具自身结果决定）。
- 决策行属于 transcript 内容：随正文滚动、参与分页、在卡片消失后仍然存在。它不新增 entry，而是作为 `ToolEntry.decision` 字段随该条保存。
- 不依赖官方英文 reason；官方工具结果若自带错误行，仍按现有 `failureRows` 展示，决策行在前、错误详情在后。
- `callId` 缺失或找不到对应工具行时，`rejected` / `cancelled` / `unavailable` 退化为一条 `notice`（同文案），不吞掉记录；`allowed-once` 不需要记录。
- 连续 read-like 工具会合并成组行：组行追加 ` · 已拒绝` / ` · 已取消` / ` · 无法回答` 摘要；展开后在该条目行下显示完整决策行。

## 4. 视觉规格

- 顶部横线：`accent`，宽度 = 行宽 `width - EDGE`（左缩进 `EDGE`）。
- 标题：`bold`、正文色（visual-v1 §4.3，`README.md:76`「首行白色加粗问句」）。**不复用** 现有 `warning` 色。
- 原因 / 命令 / 描述：`muted`。
- 选项标签：焦点 `accent` + `bold`；其余正文色。
- 键位提示：`faint`。
- 宽度 60 / 100 列使用同一行结构；描述按可用宽度换行，不横向溢出。
- 主题：只用现有 token（`accent` / `fg` / `muted` / `faint`），不新增颜色。

## 5. 实现落点

| 文件 | 改动 |
|---|---|
| `src/app/approval-card.ts`（新） | 把 `ApprovalPrompt` + 命令来源构造成 `Row[]`；导出高度与焦点行号，供滚动追随 |
| `src/app/App.tsx` | `TranscriptView` 接受附加 rows 并计入可见窗口；删除 `ApprovalOverlay`；`transcriptBodyHeight` **维持现状**（输入块照常占位；审批卡不占底部槽位，`questionCardRows` 对审批已返回 0） |
| `src/app/nano-app.ts` | snapshot 提供审批卡 rows / 命令查找；`total` 与 `maxScroll` 必须把附加 rows 计入（现只取 `model.layout`，`:712-719`、`:789-791`），否则卡片底部滚不到；审批挂起时放行 `PageUp`/`PageDown` 给 `scrollBy`；四个用户结算路径（↑↓+Enter、`1–4`、`Esc`、鼠标）统一在结算前调用 `model.markApprovalDecision(callId, outcome)`；官方 `request.signal` abort 触发的 `cancelled`（`src/decisions/manager.ts:107-112`，不经过用户键位）也必须走同一记录函数——由 `DecisionManager` 提供结算回调或在 abort 分支调用注入的记录器；删除 overlay 相关 |
| `src/transcript/model.ts` | 新增公开查询 `toolEntryByCallId(callId)`（`entries` 是 private，`:130`；`parseArgs` 也是模块私有，`:480`），供命令区块取 `args`；新增 `markApprovalDecision(callId, outcome)` 并在 `toolUnit` 的工具行下方渲染 §3.9 的决策行；`decision` 必须纳入 `toolUnit` 的行缓存键（`src/transcript/model.ts:349-352`）并在标记后 `notify()`，否则重绘仍命中旧 rows |
| `src/decisions/manager.ts` | `APPROVAL_OPTIONS` 增加 `description?`（前两项）；不改正结果集合 |
| `src/render/host.ts` | 删除 `type === 'overlay'` 分支 |
| `src/render/components.ts` | 删除 `Overlay` 导出与 `'overlay'` 元素类型 |
| `tests/unit/approval-card.test.ts`（新） | 见 §6 |
| `tests/unit/renderer.test.ts` | 现有 `createElement('overlay')` 用例（`:67`）改为普通 box，或删除该断言 |
| `docs/decisions/2026-11-01-approval-card-in-transcript.md`（新） | 本 spec 的 ADR |

## 6. 验收标准

### 单测

1. 审批挂起 + 一次重绘后，卡片仍位于 transcript 行序列中、输入块仍在底部（不再出现「掉到输入块下方」）。
2. `callId` 命中 `ToolEntry` 时渲染命令；未命中时按 args 键值降级；再缺则省略命令区。
3. 4 个选项顺序与 `APPROVAL_OPTIONS` 一致，默认焦点为「拒绝」，`1`–`4` 直选与 `Enter` 结果不变。
4. `PageUp`/`PageDown` 在审批挂起时滚动正文；`↑`/`↓` 焦点行始终可见。
5. 渲染原语层不再有 `Overlay` 导出与 `type === 'overlay'` 分支；`src/app/scenes.ts`、`src/input/keymap*.ts` 里表示「场景 / 作用域」的 `overlay` 词义不受影响；`tests/unit/renderer.test.ts:67` 的 `createElement('overlay')` 已改为普通 box 或删除。
6. 拒绝 / 取消 / 无法回答各留下决策行（文案见 §3.9）；允许不额外加行、工具结果照常出现。卡片消失后该行仍在（重绘/滚动后仍可见）。
7. `callId` 缺失时，拒绝/取消/无法回答退化为 `notice`，仍可见。
8. **鲸尾回归**：`src/activity/*`、`ActivityLine`、`activityRows()`、`render/activity-image.ts` 未被改动；`tests/unit/activity.test.ts` 全绿；审批挂起时活动行是静态「等待你的授权」（无动画），结算后回到正常活动态。

### 渲染与证据

- 真实终端 100 / 60 列 × 深 / 浅主题：审批卡在正文末尾、输入块可见、命令区可见。
- 现有全量测试、`npm run typecheck`、`npm run lint` 全绿。

## 7. 机制清单

| # | 机制 | 解决什么 | 没有会怎样 |
|---|---|---|---|
| M1 | 审批卡并入正文滚动序列 | 卡片随正文滚动、输入块保留；与 Claude Code 一致；消灭浮层定位缺陷 | 退回底部槽位或继续浮层，与上游不同 |
| M2 | 命令区块（`callId` → `ToolEntry.args`） | 用户看到实际要执行的命令，而不是只有原因 | 设计稿「完整命令」条款落空 |
| M3 | 删除 `Overlay` 原语 | 去掉无调用方、重绘即坏的死组件 | 复用它的人会再踩同一个坑 |
| M4 | 审批挂起时的滚动与焦点路由 | `PageUp`/`PageDown` 滚正文、焦点行自动滚入视野、重绘不抢滚动 | 卡片进正文后仍被审批键位锁死，看不到上下文 |
| M5 | 审批决策留痕（`ToolEntry.decision` + 决策行） | 选完以后正文留下决策记录（拒绝/取消/无法回答各有文案）；与 Claude Code 的拒绝/取消结果行一致 | 卡片一消失就看不到决策，用户无法回看刚才选了什么 |

## 8. 调研取舍（Claude Code 2.1.88）

- **采纳**：审批卡进正文滚动区、输入框保留（`REPL.tsx:4565` + `FullscreenLayout.tsx:361`）；完整命令展示（`BashPermissionRequest.tsx:84-88`）；拒绝/取消后保留工具行并在下方渲染 dim 的 `Interrupted · What should Claude do instead?`（`components/InterruptedByUser.tsx`，`FallbackToolUseRejectedMessage` / `UserToolCanceledMessage` 复用）。
- **不采纳**：「Yes, and don't ask again」（依赖权限规则存储，nano 没有）；`Tab to amend`（无编辑命令流程）。
- **保留差异**：nano 的 4 个协议结果（含取消 / 无法回答），Claude Code 为 Yes / always-allow / No；决策行文案用中文并区分四种结果，Claude Code 只有笼统的 `Interrupted`。
- **理由**：落点决定体验与缺陷面；结果集合由官方 fail-closed seam 决定，不能为了照抄上游而删出口；留痕让四种出口都可回看。

## 9. 自定细节

- 命令最多显示 8 行；超出显示「…还有 k 行」；不做卡片内滚动。
- 默认焦点「拒绝」（`selected: 1`，fail-closed）。
- 描述缩进 5ch（`NESTED + INLINE`）。
- 指针用 `>`（设计稿），不使用 `▸`。
- 标题用正文色加粗（visual-v1 §4.3），不沿用 `warning`。
- 命令区缺失时不渲染，也不拿 `reason` 冒充。
- 无 `command` 字段时，所有工具都走 `args` 顶层键值降级（值为字符串时原样、其他 JSON 序列化后截断）。
- 活动行保留「等待你的授权」，与卡片不重复。
- 卡片行 block 追加在 transcript 末尾，不写入 `TranscriptModel.entries`（不参与历史持久化）。
- 决策行挂在 `ToolEntry.decision` 上（1 行、`muted`、缩进 `INDENT`），不新增 entry；卡片消失后仍随工具行渲染。
- 设计稿在结算后保留一行结果作演示（样稿惯例）：拒绝/取消/无法回答与 §3.9 文案一致；允许路径显示 `已允许一次 · 演示不执行命令`（样稿不执行命令），真实 TUI 不加演示行、由工具结果承担。

## 10. 审核修订记录

### 2026-11-01 spec 期轻审（1 个 agent，用户点档）

| # | 严重度 | 发现 | 处置 |
|---|---|---|---|
| 1 | 重要 | ADR 状态「待生效」不合规、缺字段 | 改「生效中」；补决策人 / 适用范围 / 取代 / 被取代 |
| 2 | 重要 | 自定细节不在 spec 末尾 | 调研取舍前移为 §8，自定细节改 §9 |
| 3 | 重要 | `transcriptBodyHeight` 表述与「输入块保留」矛盾 | 改为「维持现状」，明确审批卡不占底部槽位 |
| 4 | 重要 | `nano-app` 的 `total`/`maxScroll` 未计附加 rows | §5 增补 `src/app/nano-app.ts` 的滚动上限改动 |
| 5 | 重要 | `entries` private、`parseArgs` 未导出 | §5 增补 `src/transcript/model.ts` 公开查询 |
| 6 | 重要 | 「不再有 Overlay 引用」过宽 | 收窄到渲染原语层，点名 `renderer.test.ts` 更新 |
| 7 | 重要 | 替代关系漏 3 处 | 补 `visual-v1:65`、`design-contract:78`、槽位序 |
| 8 | 重要 | 两处代码引用错 | 更正 `App.tsx:227-240`、`nano-app.ts:465-477`、`BashPermissionRequest.tsx:437-446` |
| 9 | 重要 | visual-v1 章节号错指、上游行号漂移 | 改 §4.3 / §4.1；上游改为按方法名引用 |
| 10 | 重要 | 设计稿默认焦点「允许一次」违背 fail-closed | 设计稿与 spec 均改为「拒绝」 |
| 11 | 重要 | 命令区滚动 vs 8 行截断冲突 | 明确取代 `visual-v1:65`；设计稿改 8 行 + 「…还有 k 行」 |
| 12 | 重要 | 设计稿 PageUp/PageDown 被吞、每次重绘强制回底 | 改为滚正文 ±5 行；去掉每次 `draw()` 的强制回底 |
| 13 | 重要 | 从问卷切审批时旧卡残留在 `#choice-host` | `showApproval` 先清空并隐藏 host |
| 14 | 轻微 | §7 未列滚动/焦点路由机制 | 增 M4 |
| 15 | 轻微 | 设计稿 Tab、占位、结算演示 | 去掉 Tab；占位改「等待你处理上面的确认…」；结算演示写入 §9 |
| 16 | 轻微 | 设计研究文档口径陈旧 | 更新为 4 个协议出口与 8 行截断 |
| 17 | 轻微 | 引用区间与复现证据 | 更正区间；§2 补复现步骤说明 |
| 18 | 轻微 | 行宽口径、args 降级限定 | 改 `width - EDGE` + 左缩进；统一为所有工具 |

### 2026-11-01 追加需求：决策留痕

| # | 严重度 | 发现 | 处置 |
|---|---|---|---|
| 19 | 需求 | 选择后卡片消失、正文没有留下任何决策记录 | 新增 §3.9 决策留痕与 M5：拒绝/取消/无法回答各留一条决策行，允许路径由工具结果承担 |
| 20 | 约束 | 本次改动不得覆盖鲸尾活动栏 | §1 非目标显式排除 `src/activity/*`、`ActivityLine`、`activityRows()`、`render/activity-image.ts`；§6 增鲸尾回归验收 |

### 2026-11-02 轻审（PR #135）修订

| # | 严重度 | 发现 | 处置 |
|---|---|---|---|
| 21 | 阻断 | §6 要求审批中活动行带动画，与活动栏 ADR/测试冲突 | §6 第 8 条改为：挂起=静态「等待你的授权」（无动画），结算后回到正常活动态 |
| 22 | 重要 | 官方 signal abort 的 `cancelled` 不经过用户键位，未被记录 | §5 要求 `DecisionManager` abort 分支也调用同一记录函数 |
| 23 | 重要 | ADR 重开条件失实：官方 `approval/asked`/`decided` 事件已存在 | 改写重开条件，说明本地记录的理由与后续迁移条件 |
| 24 | 重要 | `toolUnit` 行缓存键未含 `decision`，标记后可能仍渲染旧行 | §5 要求把 `decision` 纳入缓存键并 `notify()` |
| 25 | 重要 | 「挂在 ToolEntry 上」与「不进入 entries」自相矛盾 | 统一为「不新增 entry，作为 `ToolEntry.decision` 字段随条保存」 |
| 26 | 轻微 | 摘要与细则文案不一致（允许不额外加行、无法回答不带「未执行」） | §1 / §6 / M5 / ADR 全部按细则改写 |
| 27 | 轻微 | 设计稿允许文案与「与 §3.9 一致」不符 | 改为 `已允许一次 · 演示不执行命令`，并注明样稿不执行命令 |
| 28 | 轻微 | Claude Code 拒绝路径只写了 fallback；「什么都不剩」不准确 | ADR 收窄为「工具自定义拒绝 UI 或 Interrupted fallback；nano 缺的是决策记录」 |
| 29 | 轻微 | 机制计数 4 与 M1–M5 不符 | 改 5 项，并把 M4 计入 |
| 30 | 轻微 | 「下游：spec 合并后开 issue」已过时 | 改为 Issue #134（已开，待实施委托） |
| 31 | 轻微 | `callId` 退化未限定结果集 | §3.9 / §6 第 7 条 / ADR 限定为拒绝/取消/无法回答 |
| 32 | 轻微 | read-like 组行的决策行落点未定义 | §3.9 增组行摘要 + 展开后条目行决策行 |
