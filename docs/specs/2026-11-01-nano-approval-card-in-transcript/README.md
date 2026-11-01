# [2026-11-01-nano-approval-card-in-transcript] 审批卡进正文流（对齐 Claude Code）

- 组标识：`2026-11-01-nano-approval-card-in-transcript`
- 角色：单份 spec，总纲与执行规格合一
- 状态：草案，待过闸
- Issue：spec 合并后开（段一第 6 步）
- 结构：不拆——1 份 spec + 1 张执行 issue
- 机制范围：**3 项新增机制**——① 审批卡并入正文滚动序列；② 命令区块（`callId` → `ToolEntry.args`）；③ 删除 `Overlay` 原语。其余复用现有 `DecisionManager`、transcript 渲染与主题 token
- 上游：
  - Claude Code 2.1.88 源码（本机归档 `/Users/sunchongsheng/Downloads/归档/06-软件与安装包/ClaudeCode/src`）：`screens/REPL.tsx:4519,4565`、`components/FullscreenLayout.tsx:361`、`components/permissions/PermissionDialog.tsx`、`components/permissions/BashPermissionRequest/BashPermissionRequest.tsx:84-88`、`components/permissions/BashPermissionRequest/bashToolUseOptions.tsx`
  - 设计稿 `docs/design/2026-10-17-dsh-tui-ux-research/preview/`（`choices.js:177-188`、`index.html` `.choice-*`）
  - [visual-v1 §2/§4.2](../../specs/2026-10-22-nano-visual-v1/README.md)、[design-contract §1/§2](../../release/design-contract.md)
- 替代关系：本 spec **修订** `design-contract` §1 覆盖层规则与 `visual-v1`「主界面槽位」条（`README.md:39`）中「决策卡打开时输入块隐藏」的**审批卡**部分；问题卡、计划审阅卡不变。不回写旧 spec 正文，按修订记录处理
- ADR：新增 [ADR-20261101-approval-card-in-transcript](../../decisions/2026-11-01-approval-card-in-transcript.md)
- 下游：spec 合并后开执行 issue；问题卡选项卡（`← →`、反色）另立 spec
- 合入前提：实施须单测 + 渲染断言全绿，并按 §6 留 100/60 列真实终端证据

## 1. 目标

让审批卡与 Claude Code 2.1.88 的形态一致，而不是继续做一个会错位的浮层：

1. **落点**：审批卡作为正文滚动内容的一部分，接在最后一条消息之后；输入块固定在底部、保持可见。
2. **信息**：卡片显示问句标题、原因、**完整命令**（`muted`，超出可用高度时截断并提示）、4 个选项与键位提示。
3. **操作**：`↑`/`↓` 移焦点、`Enter` 确认、`1`–`4` 直选、`Esc` 取消；`PageUp`/`PageDown` 与滚轮滚正文。
4. **清理**：删除 `Overlay` 原语，消除「重绘冲掉定位」的整类缺陷。

### 非目标

- **问题卡 / 选项卡**：落点与视觉均不变（仍占输入位）；`← →` 箭头、当前项反色另立 spec。
- **持久权限规则**（「始终允许」）：官方 seam 无规则存储，本次不做。
- **fail-closed 语义**：4 个结果（`allowed-once` / `rejected` / `cancelled` / `unavailable`）与现有键位分流不变。
- **计划审阅卡**：与问卷共用一张卡，本次不重做。
- **倒计时**：设计稿无此形态，不在范围。

## 2. 现状与证据

调查基线：`origin/main` @ `1d29c4c`；官方 `@deepseek-ai/dsh` 0.2.1-rc.2。

| 事实 | 证据 |
|---|---|
| 审批卡是全屏浮层，面板宽 `min(72, max(30, width-8))`，居中、`clear` | `src/app/App.tsx:375-421` |
| 浮层的绝对定位是创建时注入的合成 props（`position:absolute; left/top:0; width/height:100%`） | `src/render/host.ts:353-377` |
| `commitUpdate` 每次重绘用元素原始 props 覆盖，合成定位丢失 | `src/render/host.ts:459-473` |
| 重绘后浮层退化成普通列尾子节点：118×37 下标题行 13 → 22，节点 layout `top` 0 → 19、高度 37 → 18 | 2026-11-01 本机复现（临时用例已撤销） |
| 审批挂起时输入块仍渲染，仅占位「等待你处理上面的确认…」 | `src/app/App.tsx:588-592`、`src/app/nano-app.ts:287-289` |
| 审批键位全量截获（`↑↓`/`Enter`/`1-4`/`Esc`），`PageUp`/`PageDown` 未放行 | `src/app/nano-app.ts:462-470` |
| 工具入参以 JSON 字符串存在 transcript：`ToolEntry.args`；`parseArgs` 已可解析 | `src/transcript/model.ts:190-200`、`:478-486` |
| 官方 approval 事件只带 `toolName` / `callId` / `reason`，不带入参 | `node_modules/@deepseek-ai/dsh-user-approval/lib/index.js:123-136` |
| 官方 UI 用 `callId` 取 detail 槽渲染工具详情 | `node_modules/@deepseek-ai/dsh-client-ui-approval/lib/client.js:40` |
| Claude Code：审批卡在 `ScrollBox` 内、消息之后；输入框独立固定 | `FullscreenLayout.tsx:361`、`REPL.tsx:4565` |
| Claude Code：命令来自 `toolUseConfirm.input`，用 `BashTool.renderToolUseMessage` 以 dim 渲染 | `BashPermissionRequest.tsx:84-88`、`:414-420` |

## 3. 交互规格

### 3.1 槽位与形态

- 审批卡**不是**独立槽位：它的行块追加在 transcript 的可见行序列之后，参与同一套滚动与分页。
- 卡片宽度 = 终端宽度减去左右各 2ch（与 transcript 同宽）；不加外框，顶部一条 `accent` 横线（visual-v1 §4.2）。
- 输入块照常渲染在底部；状态行、活动行、dock 位置不变。

### 3.2 行结构

```
──────────────  ← accent 横线，内容宽度
是否运行这条检查命令？          ← 白色加粗问句
当前模式要求逐次确认：…          ← 原因（muted，自动换行）
npm test                       ← 完整命令（muted，最多 N 行，超出显示「…还有 k 行」）
> 1. 允许一次                   ← 焦点指针 + 编号（muted）+ 标签（accent/bold）
     仅允许本次命令，不更改后续权限。   ← 描述，5ch 缩进，muted
  2. 拒绝
     不执行本次命令。
  3. 取消请求
  4. 无法回答（按失败关闭处理）
↑↓ 移动 · Enter 确认 · 1–4 直选 · Esc 取消请求   ← faint
```

- 标题：Bash 用固定问句「是否运行这条检查命令？」；其他工具用「是否允许 `<toolName>` 执行？」。
- 原因：`prompt.reason`，空则不占行。
- 命令：见 §3.3。
- 选项：4 项，见 §3.4。
- 键位提示：1 行，`faint`。

### 3.3 命令区块

- 来源优先级：
  1. `prompt.callId` → transcript 中同 `callId` 的 `ToolEntry` → `parseArgs(args).command`（字符串且非空）；
  2. 取不到 `command` 时，把 `args` 的顶层键值渲染为 `key: value` 行（单行截断）；
  3. 再取不到时，省略命令区（不拿 `reason` 冒充命令）。
- 渲染：`muted`，按内容宽度换行；最多 N 行（自定细节），超出追加「…还有 k 行」。
- 命令区块与原因之间空 1 行；与选项之间空 1 行。

### 3.4 选项

- 保留 4 项，顺序与 `APPROVAL_OPTIONS` 一致。
- 前两项（允许一次 / 拒绝）按设计稿带描述；后两项（取消请求 / 无法回答）保留为协议兜底，不加描述。
- 焦点行：`>` 指针 + 标签 `accent` + `bold`；非焦点行：空格 + 标签 `normal`。
- 编号 `1.` … `4.` 固定 2 列宽，`muted`；描述行缩进 5ch（`NESTED + INLINE`）。
- 数字直选 1–4 与现有 `APPROVAL_OPTIONS` 索引保持一致。

### 3.5 焦点与滚动

- 卡片的焦点行必须在视口内：`↑`/`↓` 移动焦点时，若焦点行滚出可见区，自动调整 `scrollOffset`（沿用问题卡的「焦点跟随」语义）。
- `PageUp`/`PageDown`：审批挂起时改为滚动正文（±5 行），不再被审批键位吞掉。
- 滚轮：沿用现有 `handleMouse` 的 wheel 分支（本就不受决策拦截），确认仍可滚正文。
- 默认 `stickBottom = true`：卡片在底部可见；用户手动上滚后保持手动位置（沿用现有 scroll 语义）。

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
- 活动行保持「等待你的授权」文案（visual-v1 §2），位置不变。
- 状态行右侧仍显「Enter 插话 · Ctrl+C 停止」；`Ctrl+C` 仍走停止流程。

### 3.8 鼠标

- 卡片行沿用 `Row.pressId` → `onPress` 通路；渲染层无需新增机制。
- 点击选项与键盘直选的结算路径一致（`decisions.resolveApproval`）。

## 4. 视觉规格

- 顶部横线：`accent`，宽度 = 内容宽度（terminal width − 2 × `EDGE`）。
- 标题：`bold`、正文色（visual-v1 §4.2「首行白色加粗问句」）。**不复用** 现有 `warning` 色。
- 原因 / 命令 / 描述：`muted`。
- 选项标签：焦点 `accent` + `bold`；其余正文色。
- 键位提示：`faint`。
- 宽度 60 / 100 列使用同一行结构；描述按可用宽度换行，不横向溢出。
- 主题：只用现有 token（`accent` / `fg` / `muted` / `faint`），不新增颜色。

## 5. 实现落点

| 文件 | 改动 |
|---|---|
| `src/app/approval-card.ts`（新） | 把 `ApprovalPrompt` + 命令来源构造成 `Row[]`；导出高度与焦点行号，供滚动追随 |
| `src/app/App.tsx` | `TranscriptView` 接受附加 rows 并计入滚动窗口；删除 `ApprovalOverlay`；`transcriptBodyHeight` 不再为审批卡扣除输入块 |
| `src/app/nano-app.ts` | snapshot 提供审批卡 rows / 命令查找；审批挂起时放行 `PageUp`/`PageDown` 给 `scrollBy`；删除 overlay 相关 |
| `src/decisions/manager.ts` | `APPROVAL_OPTIONS` 增加 `description?`（前两项）；不改正结果集合 |
| `src/render/host.ts` | 删除 `type === 'overlay'` 分支 |
| `src/render/components.ts` | 删除 `Overlay` 导出与 `'overlay'` 元素类型 |
| `tests/unit/approval-card.test.ts`（新） | 见 §6 |
| `docs/decisions/2026-11-01-approval-card-in-transcript.md`（新） | 本 spec 的 ADR |

## 6. 验收标准

### 单测

1. 审批挂起 + 一次重绘后，卡片仍位于 transcript 行序列中、输入块仍在底部（不再出现「掉到输入块下方」）。
2. `callId` 命中 `ToolEntry` 时渲染命令；未命中时按 args 键值降级；再缺则省略命令区。
3. 4 个选项顺序与 `APPROVAL_OPTIONS` 一致，`1`–`4` 直选与 `Enter` 结果不变。
4. `PageUp`/`PageDown` 在审批挂起时滚动正文；`↑`/`↓` 焦点行始终可见。
5. 仓库内不再有 `Overlay` / `'overlay'` 引用。

### 渲染与证据

- 真实终端 100 / 60 列 × 深 / 浅主题：审批卡在正文末尾、输入块可见、命令区可见。
- 现有全量测试、`npm run typecheck`、`npm run lint` 全绿。

## 7. 机制清单

| # | 机制 | 解决什么 | 没有会怎样 |
|---|---|---|---|
| M1 | 审批卡并入正文滚动序列 | 卡片随正文滚动、输入块保留；与 Claude Code 一致；消灭浮层定位缺陷 | 退回底部槽位或继续浮层，与上游不同 |
| M2 | 命令区块（`callId` → `ToolEntry.args`） | 用户看到实际要执行的命令，而不是只有原因 | 设计稿「完整命令」条款落空 |
| M3 | 删除 `Overlay` 原语 | 去掉无调用方、重绘即坏的死组件 | 复用它的人会再踩同一个坑 |

## 8. 自定细节

- 命令最多显示 8 行；超出显示「…还有 k 行」。
- 描述缩进 5ch（`NESTED + INLINE`）。
- 指针用 `>`（设计稿），不使用 `▸`。
- 标题用正文色加粗（visual-v1），不沿用 `warning`。
- 命令区缺失时不渲染，也不拿 `reason` 冒充。
- 非 Bash 工具的命令区渲染 `args` 顶层键值（值为字符串时原样、其他 JSON 序列化后截断）。
- 活动行保留「等待你的授权」，与卡片不重复。
- 卡片行 block 追加在 transcript 末尾，不写入 `TranscriptModel.entries`（不参与历史持久化）。

## 9. 调研取舍（Claude Code 2.1.88）

- **采纳**：审批卡进正文滚动区、输入框保留（`REPL.tsx:4565` + `FullscreenLayout.tsx:361`）；完整命令展示（`BashPermissionRequest.tsx:84-88`）。
- **不采纳**：「Yes, and don't ask again」（依赖权限规则存储，nano 没有）；`Tab to amend`（无编辑命令流程）。
- **保留差异**：nano 的 4 个协议结果（含取消 / 无法回答），Claude Code 为 Yes / always-allow / No。
- **理由**：落点决定体验与缺陷面；结果集合由官方 fail-closed seam 决定，不能为了照抄上游而删出口。

## 10. 审核修订记录

（待过闸后追加）
