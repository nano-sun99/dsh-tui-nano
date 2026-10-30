# [2026-10-30-nano-subagent-navigation] 子代理三层导航与消失

- 组标识：`2026-10-30-nano-subagent-navigation`
- 角色：单份 spec，总纲与执行规格合一
- 状态：方案中（草案）
- 结构：不拆——1 份 spec + 1 张执行 issue
- 机制范围：**4 个新增机制**——① 视图状态机，② 每地址界面状态，③ dock 展示窗口（入列 / 出列 / 不复活），④ 全部子代理列表
- 上游：设计稿 [`preview/README.md` §子代理交互](../../design/2026-10-17-dsh-tui-ux-research/preview/README.md)、`2026-10-20-nano-v1` S12、[ADR-20261022-subagent-dock-lifecycle](../../decisions/2026-10-22-subagent-dock-lifecycle.md)、[ADR-20261022-input-history](../../decisions/2026-10-22-input-history.md)（子代理草稿只存内存、按地址投影）
- 替代关系：本 spec 补齐 v1 S12 在 TypeScript 重写中未接上的导航与列表部分；dock 生命周期沿用 ADR 的 30 秒，设计稿样稿的 1.5 秒不再适用
- ADR：**不新增**。消失策略按 ADR-20261022 执行；本次只把它的 30 秒从「有倒计时」修成「真能消失」。手动 `x` 是提前出列的界面动作，不改 ADR 的自动 30 秒规则
- 下游：spec 合并后开执行 issue；[#106](https://github.com/nano-sun99/dsh-tui-nano/issues/106) 与本单无关
- 合入前提：本 spec 合并后开执行 issue；实施需单测 / feature 测试全绿，并按 §7 留证据

## 1. 目标

把设计稿的子代理交互在 TUI 里做实，重点是「会消失」：

1. **三层导航**：原对话 → 子代理详情 → 返回原入口；另外一层可随时打开的「全部子代理」列表。
2. **消失可证**：dock 只显示「最近活跃」的窗口，终态 30 秒后移除且不复活；历史记录留在父对话回执与全部列表里。
3. **每地址独立**：草稿、光标、滚动位置按子代理分别保存，退出再进原样恢复。

不承诺：一次性（one-shot）子代理能在详情里回放正文——没有 live session 时是否可读官方历史投影，实施前先验；验不通就退成「不可导航的只读行」，不伪造。

## 2. 当前事实与根因

调查基线：`origin/main` @ `ee3da2d`；官方 `@deepseek-ai/dsh` 0.2.1-rc.2；设计稿 `preview/README.md` §子代理交互 + `preview/subagents.js`。

| 事实 | 证据 |
|---|---|
| 官方目录是 append-only 账本，只记「创建过谁」，不记「谁还在跑」 | `dsh-subagent/lib/types/catalog.js:60`（遍历全部 `subagent/catalog` 事件、无删除分支）；`projection-types.d.ts` 的 `SubagentCatalogEntry` 只有 `id` / `createdAt` / `mode` / `label`，没有状态字段 |
| dock 直接投影目录，等于把历史全画出来 | `src/subagents/dock.ts:151` 读 `listChildren`；`:164` 无 live agent 一律判 `idle` → 「未运行」，且 `idle` 不是终态，不进清理 |
| 终态判不出来 | `src/subagents/dock.ts:68` 读 `info.status ?? info.result?.status ?? info.cause`；官方 `subagent/end` 携带的是 `stopReason`（`dsh-subagent/lib/types/types.d.ts:101`），取值 `completed / aborted / error / max-tokens / refusal` |
| 30 秒清理会自我复活 | `src/subagents/dock.ts:172` `finishedAt: previous?.finishedAt ?? now`：行被 `pruneRows`（`:91`）删掉后，下一轮 refresh 从目录重建，`previous` 为 undefined → 计时重置 → 再等 30 秒，无限循环 |
| 没有上限、没有导航 | `src/subagents/dock.ts:187` 逐行渲染，无 4 行上限、无溢出、无指针、无 press；`renderAllTitle()`（`:203`）无调用方；全仓无子代理详情页 |
| 历史记录已有落点 | 父对话收到官方 `subagent-settled` 续聊消息（`dsh-subagent/lib/types/continuation-messages.d.ts:27`），dock 消失不等于记录丢失 |

结论：dock 的问题不是「清理窗口不够长」，而是**把持久账本当成了运行时状态**。CC 的做法相反：面板读内存任务表，终态设 `evictAfter = now + 30s`，GC 直接从状态里删（`utils/task/framework.ts:136`、`:241`），`retain` 例外，用户按 `x` 置 0 立即隐藏（`state/teammateViewHelpers.ts:113`）。

## 3. 范围与边界

### 3.1 本次做

- dock 展示窗口：入列 / 出列 / 不复活 / 4 行上限 / 溢出入口 / 焦点指针 / 点击进入。
- 子代理详情：顶部标识、正文渲染、可续聊输入、Esc / ← / 返回按钮退出、回原入口。
- 全部子代理列表：Overlay、`全部子代理 · N` 标题、滚动、进入本地子代理、关闭。
- 每地址界面状态：草稿、光标、滚动位置。
- 状态词与状态灯按官方 `stopReason` 正确映射。
- 测试与证据。

### 3.2 本次不做

- 不做整回合后台化（#106），不改官方 subagent 服务、不改 `steer` / `followup` 语义。
- 不改主对话 transcript 的渲染规则，不做子代理嵌套超过官方 `maxDepth` 的展示。
- 不做鼠标悬停、拖选跨视图、不做 dock 用时 / token 计数（ADR 已否决）。
- 不新增全局快捷键以外的键位；`x` 是本次唯一新增的单键动作（仅在 dock 聚焦或详情内）。
- 不改 `src/transcript` 的渲染预算与过程分组。

## 4. 交互规格

### 4.1 dock（默认态）

- 位置不变：输入框上方；一条顶边框，无标题、无用时、无 mode 后缀。
- 行内容：` ` 或 `›`（聚焦）+ 状态灯 + 名字（弹性截断）+ 右侧状态词。
- 最多 4 行；第 5 个起合并为一行 `还有 N 个子代理`，点击/Enter 打开全部列表。
- 只列本地直接子代理；`external` 不进 dock。
- 排序按目录 order（即 `createdAt` 升序），新行追加在末尾。
- 状态灯与状态词一一对应：`执行中` / `完成` / `终止` / `错误` / `未运行`。

### 4.2 进入与返回

- 进入：点击行，或聚焦后 `Enter` / `→` / `Space`；`external` 行不响应。
- 进入后：dock 与主对话隐藏，顶部一行 `子代理 · 名字 · 状态词`（左侧一个可点击的 `‹ 返回`）。
- 返回：`Esc` 在任意焦点下直接退出；空输入时 `←` 等价；顶部返回按钮等价。
- 返回落点按来源：从 dock 进 → 回该行；从结果卡进 → 回该结果卡；从列表进 → 回列表该行（再 `Esc` 才关列表）。
- 原入口已消失时回落到主输入框。
- 返回必须复原：主对话草稿 / 光标 / 滚动位置；子代理自己的草稿与滚动位置留在它名下。

### 4.3 详情

- 正文只显示该子代理地址的内容，复用主对话的 transcript 渲染器，不复制渲染逻辑。
- 可续聊且父会话 live：显示输入框；`Enter` 发送（官方子代理 prompt 通道），`Shift+Enter` 换行，IME 组合态中 `Enter` 不发送。
- 父会话不可用或非 live：只读，输入框与发送按钮都不显示，不画「等待输入」。
- 一次性历史：只读详情；取不到正文时显示官方诊断，不编造。
- 子代理内审批固定 `never`：不渲染可点「允许」的卡片，只显示拒绝结果。

### 4.4 全部子代理列表

- Overlay 打开，标题 `全部子代理 · N`，N 只数本地直接子代理（不含 `external`、不含已出列）。
- 行显示：名字 + 状态词；有多级后代时标出父级关系。
- 可滚动；`↑` / `↓` 选择，`Enter` 进入本地子代理，`Esc` 关闭。
- 列表是「记录视图」：dock 上已消失的子代理仍在这里，直到会话结束。

### 4.5 消失与清理（核心）

三条不变量，缺一条就会出现「只增不减」：

- **I1 入列只靠事件**：只有 `subagent/start` 或首次观察到 `running` 才建行；目录只提供 label / mode，不负责建行。
- **I2 出列只靠两件事**：终态后满 `DOCK_GRACE_MS = 30_000`，或用户按 `x`；其余一律不出列。
- **I3 出列后不复活**：出列时把 id 写入 `dismissed`（有界，最近 64 条）；目录里仍有该 id 也不重建，只有同一 id 再次 `subagent/start` 才清除。

补充规则：

- 终态映射以官方 `stopReason` 为准：`completed` → 完成；`aborted` / `refusal` / `max-tokens` → 终止；`error` → 错误；缺失或未知 → 未运行（并立即出列，不占 30 秒）。
- 冷启动 dock 必须 0 行——除非确有 live child。历史子代理只能从全部列表看到。
- 正在查看的详情不被 30 秒定时关掉；细节被出列时，视图停留在原地，直到用户返回。
- 父对话的回执不受影响：`subagent-settled` 消息照常出现，dock 消失不删记录。

## 5. 状态模型

```ts
type ViewState =
  | { mode: 'main'; list?: { focusId?: string } }
  | { mode: 'child'; id: string; origin: 'dock' | 'result' | 'list' }

type Address = 'root' | string                 // 子代理 id
type Draft = { text: string; caret: number; scrollTop: number }

type DockEntry = {
  id: string
  status: 'running' | 'done' | 'killed' | 'error' | 'idle'
  terminalAt?: number      // 首次观察到终态的时间，不被 refresh 重置
  dismissed?: boolean
}
```

- 视图状态、每地址草稿、dock 窗口三者都是纯数据；渲染只读状态，导航由纯函数改状态（可单测）。
- `DockEntry.terminalAt` 只在第一次进入终态时写入，refresh 不得覆盖——这是修 I2/I3 的关键。

## 6. 改动面

| 文件 | 改动 |
|---|---|
| `src/subagents/dock.ts` | 重写为展示窗口：事件入列、`terminalAt` 持久、`dismissed` 有界、4 行 + 溢出、指针、press id |
| `src/subagents/view.ts`（新） | `ViewState`、进入 / 返回 / 列表开关的纯函数与选择逻辑 |
| `src/subagents/detail.ts`（新） | 详情顶部行、正文数据源、可续聊判定、输入路由 |
| `src/subagents/list.ts`（新） | 全部列表的渲染与选择 |
| `src/app/App.tsx` | 按 `ViewState` 切换主对话 / 详情 / 列表 |
| `src/app/nano-app.ts` | 按键优先级与 press 分发 |
| `src/controls/feature-host.ts` | 组装三块，接 `requestRender` |
| `tests/unit/` | 窗口生命周期、状态映射、导航纯函数 |
| `tests/feature/` | 进入 / 返回 / 草稿隔离 / 列表 |
| `docs/evidence/2026-10-30-subagent-navigation/` | 测试输出 + PTY 截图 + 冷启动 / 30 秒消失录屏 |

## 7. 验收

- [ ] A1 冷启动 dock 0 行（无 live child 时）；历史子代理只能从全部列表看到。
- [ ] A2 子代理终态 30 秒后行消失，之后连续 3 次 refresh 都不复活。
- [ ] A3 dock 聚焦按 `x` 立即移除该行，目录里仍有也不回来。
- [ ] A4 连续跑 20 个子代理，dock 始终 ≤ 4 行 + 1 行溢出，行数不随时间增长。
- [ ] A5 三种来源（dock / 结果卡 / 列表）进入后返回，落点各自正确；入口消失时回输入框。
- [ ] A6 `Esc` 在输入框、正文、工具详情、发送按钮上都直接退出；空输入 `←` 与顶部按钮同效。
- [ ] A7 两个子代理各写一半草稿，来回切换后内容、光标、滚动位置均不串。
- [ ] A8 `stopReason` 五种取值分别显示正确状态词与灯；缺失时显示「未运行」并立即出列。
- [ ] A9 `external` 不进 dock；在全部列表里是不可进入的叶子。
- [ ] A10 一次性子代理详情只读：无输入框、无发送按钮、无「等待输入」。
- [ ] A11 全部列表标题计数正确、可滚动、`Enter` 进入本地子代理、`Esc` 关闭。
- [ ] A12 dock 消失后，父对话的 `subagent-settled` 回执仍在。
- [ ] A13 `npm test`、`npm run typecheck`、`npm run lint` 全绿。

## 8. 自定细节

- `DOCK_GRACE_MS = 30_000`（沿用 ADR，不采用设计稿的 1.5 秒）。
- dock 上限 4 行、溢出 1 行（设计稿值）。
- `dismissed` 保留最近 64 条，FIFO 淘汰。
- 状态灯字形沿用现状：`●` / `✓` / `■` / `✕` / `○`。
- 顶部标识格式：`子代理 · <名字> · <状态词>`。
- 列表打开时 `N` 只数本地直接子代理，不含 external。
- 详情正文数据源优先 `agents.get(childId).session`；拿不到时走官方历史投影，仍拿不到则显示诊断。
- 键盘优先级：列表 / 详情 > 全局 > 输入框；`Esc` 永远只退一层。
- `x` 只对 dock 聚焦行与当前详情生效，不对列表批量停止。

## 9. 机制清单

| 机制 | 解决什么 | 没有会怎样 |
|---|---|---|
| 视图状态机 | 一层界面表达「主对话 / 详情 / 列表」三种视图与来源 | 只能用布尔开关，回不到原入口，草稿与滚动位置全丢 |
| 每地址界面状态 | 草稿、光标、滚动按子代理隔离 | 切换子代理串内容，返回后主对话草稿被覆盖 |
| dock 展示窗口 | 把持久账本变成「最近活跃」的有限窗口 | 只增不减，冷启动满屏「未运行」，30 秒清理自我复活 |
| 全部子代理列表 | 消失后的回看入口与计数 | 子代理一消失就再也找不到，只能翻父对话回执 |

## 10. 审核修订记录

（待审核后追加）
