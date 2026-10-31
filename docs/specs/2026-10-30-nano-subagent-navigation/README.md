# [2026-10-30-nano-subagent-navigation] 子代理三层导航与消失

- 组标识：`2026-10-30-nano-subagent-navigation`
- 角色：单份 spec，总纲与执行规格合一
- 状态：已合并（PR #118）；实施 PR #120 重审修订中
- 结构：不拆——1 份 spec + 1 张执行 issue
- 机制范围：**7 个新增机制**——① 视图状态机（含 dock / 结果卡 / 列表三种来源），② 每地址界面状态，③ dock 展示窗口（入列 / 出列 / 不复活），④ 全部子代理列表，⑤ 一次性可读性探测，⑥ 按地址输入历史，⑦ activation 回执文本识别
- 上游：设计稿 [`preview/README.md` §子代理交互](../../design/2026-10-17-dsh-tui-ux-research/preview/README.md)、`2026-10-20-nano-v1` S12、[ADR-20261022-subagent-dock-lifecycle](../../decisions/2026-10-22-subagent-dock-lifecycle.md)、[ADR-20261022-input-history](../../decisions/2026-10-22-input-history.md)（子代理草稿只存内存、按地址投影）
- 替代关系：本 spec 补齐 v1 S12 在 TypeScript 重写中未接上的导航与列表部分；dock 生命周期沿用 ADR 的 30 秒，设计稿样稿的 1.5 秒不再适用
- ADR：**不新增**。30 秒自动清理完全沿用 ADR-20261022-subagent-dock-lifecycle：所有官方 `subagent/end`（含未知终态）都保留 30 秒；`x` 只提前移除**终态行**，不改自动规则
- 下游：实施 issue [#119](https://github.com/nano-sun99/dsh-tui-nano/issues/119)；[#106](https://github.com/nano-sun99/dsh-tui-nano/issues/106) 与本单无关
- 合入前提：本 spec 合并后开执行 issue；实施需单测 / feature 测试全绿，并按 §7 留证据

## 1. 目标

把设计稿的子代理交互在 TUI 里做实，重点是「会消失」：

1. **三层导航**：原对话 → 子代理详情 → 返回原入口；另外一层可随时打开的「全部子代理」列表。
2. **消失可证**：dock 只显示「最近活跃」的窗口，终态 30 秒后移除且不复活；历史记录留在父对话回执与全部列表里。
3. **每地址独立**：草稿、光标、滚动位置按子代理分别保存，退出再进原样恢复。

不承诺：一次性（one-shot）子代理能在详情里回放正文——没有 live session 时是否可读官方历史投影，实施前先验。**验得通**就进只读详情；**验不通**就退成「不可导航的只读行」，把验证结论写进证据目录。A10 按这个条件验收，不把「一定能导航」当承诺。当前部署的 provider 集未产出 one-shot / external 记录；本次用官方类型与夹具验证降级分支，真实 provider 验证列入证据目录的已知限制。

## 2. 当前事实与根因

调查基线：`origin/main` @ `ee3da2d`；官方 `@deepseek-ai/dsh-subagent` 0.2.1-rc.2；设计稿 `preview/README.md` §子代理交互 + `preview/subagents.js`。

| 事实 | 证据 |
|---|---|
| 持久目录是 append-only 账本，只记「创建过谁」，不记「谁还在跑」 | `dsh-subagent/lib/types/catalog.js:62`（`subagentCatalogEntries` 遍历全部 `subagent/catalog` 事件、无删除分支）；`projection-types.d.ts` 的 `SubagentCatalogEntry` 只有 `id` / `createdAt` / `mode` / `label`。运行态来源有三处：活对象 `agents.get(id).status`、控制面 `SubagentCatalogRow.activity`（`control-types.d.ts:20-27`，只用于列表诊断）与生命周期事件 |
| 终态判不出来：`endStatus` 读 `status / result.status / cause`，官方 `subagent/end` 只带 `stopReason` | `src/subagents/dock.ts:68`；官方 emit `dsh-subagent/lib/index.js:200-205`（`{...identity, stopReason, lastAssistantMessage}`）；`types.d.ts:101` 的 `SubagentRunEndInfo.stopReason`。缺失字段 → `endStatus` 恒返回 `idle` |
| 所以 dock 当前的实际症状是「永久未运行」，不是「30 秒后复活」 | `dock.ts:151` 读 `listChildren`；`:164` 无 live agent 判 `idle`；`:166` 收到 end 时 `endStatus(info)` 只认 `stopReason`，rc.2 的 end 已带该字段，实际路径是 running→未运行；若漏收 end，才会出现 running→done→下一轮 `previous.status` 已是 done 又回 `idle`。冷启动把历史全画成「未运行」，行永远进不了终态 |
| 一旦修好终态映射，「30 秒清理自我复活」立刻暴露 | `dock.ts:172` `finishedAt: previous?.finishedAt ?? now`：行被 `pruneRows`（`:91`）删掉后，下一轮 refresh 从目录/活对象重建，`previous` 为 undefined → 计时重置 → 再等 30 秒，无限循环。已用同逻辑 node 复刻：假设终态在 t=31s 删除，t=32s 重建且 `finishedAt=32000` |
| 没有上限、没有导航 | `dock.ts:187` 逐行渲染，无 4 行上限、无溢出、无指针、无 press；`renderAllTitle()`（`:203`）无调用方；全仓无子代理详情页 |
| 历史记录已有落点 | 父对话收到官方 settlement notice（`dsh-subagent/lib/types/continuation-messages.d.ts:26-34`，`SubagentSettledMessageSource`，`form:'notice'`），`src/conversation/controller.ts:253-258` 对任意 notice 都渲染；dock 消失不等于记录丢失 |
| 官方 `stopReason` 是可合并扩展的联合 | `dsh-subagent/lib/types/types.d.ts:215-233`：已知 `completed / aborted / error / max-tokens / refusal`，后端可加变体，消费方必须走 default |

结论：dock 的病根是**把持久账本当成了运行时状态**。当前这一版直接表现为「永久未运行」；终态映射修好后，`finishedAt` 的计时重置才会变成真正的复活 bug。修法必须同时覆盖三层——事件入列、终态映射、出列后不复活，缺一层都会回到「只增不减」。

背景参照（**非本仓依据**）：Claude Code 面板读内存任务表、终态 `evictAfter = now + 30s`、按 `x` 立即隐藏（`utils/task/framework.ts`、`state/teammateViewHelpers.ts`，不随本仓依赖分发，实施时不引用其行号）。

## 3. 范围与边界

### 3.1 本次做

- dock 展示窗口：入列 / 出列 / 不复活 / 4 行上限 / 溢出入口 / 焦点指针 / 点击进入。
- 子代理详情：顶部标识、正文渲染、可续聊输入、Esc / ← / 返回按钮退出、回原入口。
- 全部子代理列表：Overlay、`全部子代理 · N` 标题、滚动、进入本地子代理、关闭。
- 每地址界面状态：草稿、光标、滚动位置。
- 状态词与状态灯按官方 `stopReason` 正确映射。
- 结果卡入口：`activation` 工具结果点进该子代理详情。
- 测试与证据。

### 3.2 本次不做

- 不做整回合后台化（#106），不改官方 subagent 服务、不改 `steer` / `followup` 语义。
- 不改主对话 transcript 的渲染规则（预算、分组、卡片样式）；只在 activation 结果上加导航入口。官方 subagent 工具不产出 `resultMeta`，实现从稳定回执文本 `started subagent <id>` 识别。
- 不做鼠标悬停、拖选跨视图、不做 dock 用时 / token 计数（ADR 已否决）。
- 不接管输入框可打印字符。新增键位只有：dock 的 `↑` / `↓` / `Enter` / `→` / `Space` / `x`（`x` 仅 dock 聚焦且仅终态行），以及 Alt+L（全部列表）与 Alt+K（停止本轮，沿用 S12 键位）。
- 不改 `src/transcript` 的渲染预算与过程分组。

## 4. 交互规格

### 4.1 dock（默认态）

- 位置不变：输入框上方；一条顶边框，无标题、无用时、无 mode 后缀。
- 行内容：` ` 或 `›`（聚焦）+ 状态灯 + 名字（弹性截断）+ 右侧状态词。
- 最多 4 行；第 5 个起合并为一行 `还有 N 个子代理`，点击/Enter 打开全部列表。
- 只列本地直接子代理；`external` 不进 dock。
- 排序按目录 order（即 `createdAt` 升序），新行追加在末尾。
- 状态灯与状态词一一对应：`执行中` / `完成` / `终止` / `错误` / `未运行`。
- 聚焦：输入草稿为空时 `↑` / `↓` 聚焦 dock；聚焦后 `↑` / `↓` 换行，`Enter` / `→` / `Space` 进入，`Esc` 回输入框。输入框非空时 `↑` / `↓` 不抢焦点。
- `x`：仅当 dock 聚焦且选中行处于终态时立即出列；运行中行不响应。其余可打印键不进 dock 动作，仍然进输入框。
- `Alt+L`：任何时候打开全部列表（包括 dock 为空时）。

### 4.2 进入与返回

- 进入：点击行，或聚焦后 `Enter` / `→` / `Space`；`external` 行不响应。
- 结果卡进入：工具结果带 activation 标识时（`resultMeta` 或官方稳定回执 `started subagent <id>`），该卡点击进入对应本地子代理详情（不再切换展开）；其余工具卡维持「点击展开」。主对话暂无卡片键盘焦点，`Enter` 进卡片不在本次范围（§3.2 不新增键位）。
- 进入后：dock 与主对话隐藏，顶部一行 `子代理 · 名字 · 状态词`（左侧一个可点击的 `‹ 返回`）。
- 返回：`Esc` 在输入框、正文、工具详情、发送按钮上都直接退出；**例外**：IME 组合态与问卷/审批焦点优先按 S03 的规则处理，不强行退出。空输入时 `←` 等价；顶部返回按钮等价。
- 返回落点按来源：从 dock 进 → 回该行；从结果卡进 → 回该结果卡；从列表进 → 回列表该行（再 `Esc` 才关列表）。
- 原入口已消失时回落到主输入框。
- 返回必须复原：主对话草稿 / 光标 / 滚动位置；子代理自己的草稿与滚动位置留在它名下。

### 4.3 详情

- 正文只显示该子代理地址的内容，复用主对话的 transcript 渲染器，不复制渲染逻辑。
- **exact parent live**（`agents.get(rootId)` 存在）：可续聊子代理显示输入框，child 运行中也可发送；`Enter` 发送（官方 `subagents.prompt`，`delivery: 'queue'`），`Shift+Enter` 换行，`Alt+Enter` 插话（`delivery: 'steer'`），IME 组合态中 `Enter` 不发送；child 运行中 `Alt+K` 停止本轮。
- **parent 不可用**：child 未运行时是只读 composer（输入框可见但禁用、无发送）；child 运行中输入 / Send 禁用，但独立的 `Alt+K` Stop 仍可用。按 S12 §2 与不变量 10 执行，不把 parent 不可用误判成「整个详情只读」。
- 一次性历史：按 §1 的条件验收（可读则只读详情，不可读则不可导航的只读行）。
- 未知 mode：读取 child history 确认支持前只读并显示原因（S12 不变量 11）。
- 子代理内审批固定 `never`：不渲染可点「允许」的卡片，只显示拒绝结果。

### 4.4 全部子代理列表

- 打开：`Alt+L`，或点 dock 的溢出行。
- 数据源：`subagents.listDescendants(rootId)`（官方递归发现，含 `kind:'diagnostic'` 分支）。
- 行：递归后代，带父级关系；`external` 显示为不可进入的叶子；diagnostic 行显示原因（`corrupt` / `unsupported` / `unavailable`），不静默丢弃；读取中显示「读取中…」，整次读取失败显示诊断行。
- 标题 `全部子代理 · N`，N 只数本地直接子代理，不含 `external` 与已出列；**列表行数可以大于 N**（含递归后代）。
- 行显示：名字 + 状态词 + mode 标记（mode 只在列表显示，不进 dock）。
- 键盘：`↑` / `↓` 选择，`Enter` 进入本地子代理，`PageUp` / `PageDown` 翻页，`Esc` 关闭。
- 列表是「记录视图」：dock 上已消失的子代理仍在这里，直到会话结束。

### 4.5 消失与清理（核心）

三条不变量，缺一条就会出现「只增不减」：

- **I1 入列只靠事件**：只有 `subagent/start` 或首次观察到 `running` 才建行；「观察到 running」的来源是活对象 `agents.get(childId)` 存在且 `deriveStatus` 为 running。目录只提供 label / mode，不负责建行；控制面 `activity` 只用于列表诊断。
- **I2 出列只靠两件事**：终态后满 `DOCK_GRACE_MS = 30_000`，或用户在 dock 对**终态行**按 `x`；其余一律不出列。`x` 不是自动规则，ADR 的 30 秒不改。
- **I3 出列后不复活**：出列时把 id 写入 `dismissed`（会话内按 id 保存，规模与目录同阶，不设 64 截断）；目录或活对象里仍有该 id 也不重建；只有同一 id 再次 `subagent/start` 才清除 `dismissed` 与 `terminalAt`，重新完整计时。

补充规则：

- 终态映射以官方 `stopReason` 为准：`completed` → 完成；`aborted` / `refusal` / `max-tokens` → 终止；`error` → 错误；缺失或未知 → 未运行，**仍保留 30 秒后出列**（ADR：unknown 终态并入未运行，所有 `subagent/end` 都保留 30 秒）。
- 冷启动 dock 必须 0 行——除非确有 live child。历史子代理只能从全部列表看到。
- 正在查看的详情不被 30 秒定时关掉；行被出列时，视图停留在原地，直到用户返回。
- 父对话的回执不受影响：官方 settlement notice 照常出现，dock 消失不删记录。

## 5. 状态模型

```ts
type ViewState =
  | {
      mode: 'main'
      dockFocusId?: string
      listOpen: boolean
      listFocusId?: string
      listScrollTop: number
    }
  | { mode: 'child'; id: string; origin: 'dock' | 'result' | 'list' }

type Address = 'root' | string                 // 子代理 id
type Draft = { text: string; cursor: number; scrollAnchor: number }  // 复用 DraftStore；scrollAnchor 仍为 0

type DockEntry = {
  id: string
  name: string
  local: boolean
  mode: 'one-shot' | 'continuable' | 'external' | 'unknown'
  status: 'running' | 'done' | 'killed' | 'error' | 'idle'
  terminalAt?: number      // 首次观察到终态的时间，不被 refresh 重置
}

type DockWindowState = { dismissed: Set<string> }
```

- 视图状态、每地址草稿、dock 窗口三者都是纯数据；渲染只读状态，导航由纯函数改状态（可单测）。
- 草稿**复用** `src/input/drafts.ts` 的 `DraftStore`（`DraftAddress.subagent` 已支持子地址，`tests/unit/d01.test.ts` 已覆盖），不新建第二份存储；它保存文本与光标。
- 子代理正文滚动位置另存 `scrollMemory`（按 id 隔离，进程内存）；`DraftStore.scrollAnchor` 保持 0，不把输入框滚动与正文滚动混用。
- `DockEntry.terminalAt` 只在第一次进入终态时写入，refresh 不得覆盖；同一 id 再次 `subagent/start` 时清零。这是修 I2/I3 的关键。
- `dockFocusId` 放在 `ViewState`，不塞进 `DockEntry`；`DockWindowState.dismissed` 与渲染行分开。

## 6. 改动面

| 文件 | 改动 |
|---|---|
| `src/subagents/dock.ts` | 重写为展示窗口：事件入列、`terminalAt` 持久与复位、`dismissed` 按 id 保存、4 行 + 溢出、指针、press id |
| `src/subagents/view.ts`（新） | `ViewState`、进入 / 返回 / 列表开关的纯函数与选择逻辑 |
| `src/subagents/detail.ts`（新） | 详情顶部行、正文数据源、可续聊判定、输入路由 |
| `src/subagents/list.ts`（新） | 全部列表的渲染、`listDescendants` 读取与诊断行 |
| `src/app/App.tsx` | 按 `ViewState` 切换主对话 / 详情 / 列表 |
| `src/app/nano-app.ts` | 按键优先级、press 分发、`x` 与 Alt+L / Alt+K 路由 |
| `src/controls/feature-host.ts` | 组装三块，接 `requestRender` |
| `src/transcript/model.ts` | activation 结果卡识别 `resultMeta` 或官方回执文本并暴露子代理导航目标；press 映射 |
| `src/input/drafts.ts` | 复用现有按地址 `DraftStore`；本次未改文件 |
| `tests/unit/` | 窗口生命周期、状态映射、导航纯函数、dismissed 边界、详情 / 列表 / 结果卡 / 输入门控 |
| `tests/feature/` | 既有子代理 `pruneRows` 夹具；进入 / 返回 / 草稿隔离由 `tests/unit/` 覆盖 |
| `tests/e2e/` | 真 PTY 启动与子代理 dock 场景（`mock-model.mjs` / `pty-start.py` / `subagent-dock.test.mjs`） |
| `docs/evidence/2026-10-30-subagent-navigation/` | 测试输出 + PTY 文本捕获（dock / list / detail / 30 秒消失）；无冷启动捕获、无录屏；one-shot / external 真实 provider 验证列为已知限制 |

## 7. 验收

- [ ] A1 冷启动 dock 0 行（无 live child 时）；`Alt+L` 能从空 dock 打开全部列表看到历史子代理。
- [ ] A2 子代理终态 30 秒后行消失，之后连续 3 次 refresh 都不复活。
- [ ] A3 dock 聚焦终态行按 `x` 立即移除该行，目录里仍有也不回来；运行中行按 `x` 不响应；同一 id 再次 `subagent/start` 后重新出现并完整保留 30 秒。
- [ ] A4 连续跑 20 个子代理，dock 始终 ≤ 4 行 + 1 行溢出，行数不随时间增长；单测模拟超过 256 次出列，`dismissed` 不截断、不因容量边界复活。
- [ ] A5 三种来源（dock / 结果卡 / 列表）进入后返回，落点各自正确；入口消失时回输入框。
- [ ] A6 `Esc` 在输入框、正文、工具详情、发送按钮上都直接退出；空输入 `←` 与顶部按钮同效；IME 组合态与问卷/审批焦点不强行退出（按 S03）。
- [ ] A7 两个子代理各写一半草稿（含字符 `x`），来回切换后内容、光标、滚动位置均不串，`x` 能正常输入。
- [ ] A8 `stopReason` 五种已知取值分别显示正确状态词与灯；未知/缺失显示「未运行」并仍保留 30 秒后出列。
- [ ] A9 `external` 不进 dock；在全部列表里是不可进入的叶子；mode 标记只在列表显示。
- [ ] A10 一次性子代理：官方历史可读时为只读详情（无输入框、无发送按钮、无「等待输入」）；不可读时退为不可导航的只读行，验证结论进证据目录；未知 mode 在确认支持前只读并显示原因。
- [ ] A11 全部列表标题计数正确（N 只数本地直接子代理）、可滚动、`Enter` 进入本地子代理、`Esc` 关闭；diagnostic 行显示原因；读取中/失败有可见状态。
- [ ] A12 dock 消失后，父对话的 settlement notice 回执仍在。
- [ ] A13 `npm test`、`npm run typecheck`、`npm run lint` 全绿。

## 8. 自定细节

- `DOCK_GRACE_MS = 30_000`（沿用 ADR，不采用设计稿的 1.5 秒）。
- dock 上限 4 行、溢出 1 行（设计稿值）。
- `dismissed` 在会话内按 id 保存，规模与目录同阶，不设 64 截断；同一 id `subagent/start` 清除 `dismissed` 与 `terminalAt`。
- `subagent/start` 后目录可能晚一拍：先建占位行，保留最多 `PROVISIONAL_MS = 10_000`；目录列出后以 `listChildren(rootId)` 的直接子代理为准，外部与后代行不会常驻。
- 状态灯字形沿用现状：`●` / `✓` / `■` / `✕` / `○`；颜色与闪烁按 S13 design-contract：running 亮/暗 0.8s 闪烁、completed 绿、aborted/refusal/max-tokens 黄、error 红、unknown/inactive muted；reduced-motion 开启时闪烁静止（检测方式由 design-contract 定义）。
- 顶部标识格式：`子代理 · <名字> · <状态词>`。
- 列表标题 `N` 只数本地直接子代理，不含 external 与已出列；行数可大于 N（递归后代）。
- 详情正文数据源优先 `agents.get(childId).session`；拿不到时走官方历史投影；仍拿不到则显示诊断。子代理正文滚动位置按 id 存 `scrollMemory`，不写 `DraftStore.scrollAnchor`。
- 键盘优先级：列表 / 详情 > 全局 > 输入框；`Esc` 永远只退一层；IME 组合态与问卷/审批焦点优先按 S03。
- 键位：dock 聚焦 `↑` / `↓`（草稿为空时），`Enter` / `→` / `Space` 进入，`x` 仅对终态行；`Alt+L` 打开全部列表；详情内 `Alt+K` 停止本轮，`Alt+Enter` 插话；空输入 `←` / 顶部按钮返回。
- `x` 只对 dock 聚焦行生效，不对列表批量停止，也不在详情输入框里拦截字符。
- 结果卡识别：优先 `resultMeta.kind === 'activation'` 且带 `subagentId`；官方工具不产出该字段时，按工具名 `subagent` + 稳定回执文本 `started subagent <id>` 识别；只对本地子代理生效，external 不导航。主视图里导航被拒时（external）回落到该工具卡自己的展开；子详情内的 activation 卡在 maxDepth>1 时仍不展开（当前默认配置不可达）。
- 只读输入门控：`inputEditable` 为 false 时，paste、Shift+Enter / Ctrl+Enter / Alt+Enter 换行、可打印字符都不得改写输入；覆盖只读 composer、一次性 / unknown 详情与列表打开态。
- 详情输入可用时 `↑` / `↓` 翻该子地址历史；`Home` / `End` 归输入框行首 / 行尾。只读或输入隐藏时 `Home` / `End` 滚正文。`Ctrl+End` 与 `Shift+↑` / `↓` 是全局 transcript 滚动键，详情里改为滚子正文，不漏给主对话。
- 列表返回保留进入前的 `listScrollTop`，并把焦点行拉回视口；结果卡返回保留主对话滚动位置。
- 一次性可读性探测只在成功时缓存；瞬时失败下轮刷新会重试，不把该子代理整场锁成不可读。
- 列表数据源 `subagents.listDescendants(rootId)`：读取中显示「读取中…」，失败显示诊断行；diagnostic 行不可进入。
- parent live 判定：exact parent 的 `agents.get(rootId)` 存在；child live 判定 `agents.get(childId)` 存在。
- 子代理发送：`Enter` → `delivery: 'queue'`；`Alt+Enter` → `delivery: 'steer'`；发送失败保留草稿。
- 子代理输入历史：从该子地址的本会话用户消息投影读取，不写文件、不跨会话（ADR-20261022-input-history）。
- 草稿复用 `DraftStore`，不新建存储；字段不够时扩展现有接口。
- 未知 mode：读取 child history 确认支持前只读显示原因，确认后才恢复输入（S12 不变量 11）。
- 一次性子代理：详情可导航性按 §1 的条件验收；退化成不可导航只读行时，列表与 dock 都不把它画成可输入。

## 9. 机制清单

| 机制 | 解决什么 | 没有会怎样 |
|---|---|---|
| 视图状态机（含三种来源） | 一层界面表达「主对话 / 详情 / 列表」三种视图与来源 | 只能用布尔开关，回不到原入口，草稿与滚动位置全丢 |
| 每地址界面状态 | 草稿、光标、滚动按子代理隔离 | 切换子代理串内容，返回后主对话草稿被覆盖 |
| dock 展示窗口 | 把持久账本变成「最近活跃」的有限窗口 | 只能把历史全画出来、永远停在「未运行」，终态映射修好后又会复活 |
| 全部子代理列表 | 消失后的回看入口与计数 | 子代理一消失就再也找不到，只能翻父对话回执 |
| 一次性可读性探测 | 进入详情前确认官方历史投影可读，决定「只读详情」还是「不可导航只读行」 | 不可读的一次性会话也会进详情，正文空白且无法返回有效信息 |
| 按地址输入历史 | 详情输入框只翻该子代理的用户消息，不串主会话历史 | 在子代理里按 ↑ 会把主会话历史发给子代理 |
| activation 回执文本识别 | 官方工具不产出 `resultMeta` 时仍能识别结果卡并进入详情 | 结果卡入口在真实会话里不可达，只能展开工具卡 |

## 10. 审核修订记录

2026-10-30 轻审（用户点「轻审」；1 个只读 agent：规格符合性 + 两张清单）。原始结论见 [PR #118 评论](https://github.com/nano-sun99/dsh-tui-nano/pull/118#issuecomment-6523690507)。

| # | 严重度 | 发现 | 处置 |
|---|---|---|---|
| 1 | 阻断 | §2 根因与 rc.2 实际不符：终态恒 `idle`，行永久「未运行」；「30 秒复活」是映射修好后才暴露的潜在 bug | 已修：§2 表格重写，复活改为「修好 #2 后立刻暴露」并用复刻结果作证 |
| 2 | 阻断 | 未知终态「立即出列」与 `x` 作用于运行中行绕过 30 秒 ADR | 已修：未知终态仍保留 30 秒；`x` 仅终态行；ADR 不改 |
| 3 | 阻断 | 裸 `x` 在详情输入框会吞掉字符 | 已修：`x` 仅 dock 聚焦终态行，不接管输入；A7 增加 `x` 输入用例 |
| 4 | 阻断 | parent 不可用 / child 运行中与 S12 composer、Stop 规则冲突 | 已修：§4.3 按 S12 区分 parent live / 不可用 + child 运行中（输入禁用 + `Alt+K`） |
| 5 | 阻断 | 「Esc 任意焦点直接退出」与 S12 的 IME / 问卷审批例外冲突 | 已修：§4.2 补 IME 与问卷/审批焦点例外 |
| 6 | 建议 | 全部列表没有打开入口，空 dock 不可达；dock 无聚焦规则 | 已修：`Alt+L` 随时打开；dock 空草稿 `↑↓` 聚焦；A1/A11 同步 |
| 7 | 建议 | 「结果卡」未定义，`transcript/model.ts` 未列入改动面 | 已修：§4.2 定义 `activation` 结果入口；§6 加 `src/transcript/model.ts`；A5 同步 |
| 8 | 建议 | 列表数据源、诊断、模式标记缺失 | 已修：§4.4 用 `listDescendants`，补 diagnostic / 读取中失败 / mode / N 与行数关系 |
| 9 | 建议 | `DockEntry` 缺字段；草稿字段与现有 `DraftStore` 不一致，易再建存储 | 已修：§5 复用 `DraftStore`；`DockEntry` 补 name/local/mode；`dockFocusId` 进 `ViewState` |
| 10 | 建议 | `dismissed` 64 条截断会复活；`terminalAt` 未规定 start 时复位 | 已修：`dismissed` 按 id 保存不截断；start 同时清 `terminalAt`；A3/A4 覆盖 |
| 11 | 建议 | §1 与 A10 对一次性详情自相矛盾；unknown mode 未覆盖 | 已修：A10 改条件验收并定义回落；§4.3/§8 补 unknown mode |
| 12 | 建议 | 「立即出列」与 A8「显示未运行」矛盾；`stopReason` 可扩展 | 已修：未知显示未运行并保留 30 秒；A8 写「五种已知 + unknown fallback」 |
| 13 | 建议 | §8 缺状态灯颜色/闪烁、parent live 判定、queue/steer、子地址历史等默认值 | 已修：§8 逐条补齐 |
| 14 | 事实澄清 | `catalog.js:60` 行号不准；运行态数据源未写明 | 已修：改 `:62`；I1 写明活对象 `agents.get` 为入列来源，activity 只用于列表 |
| 15 | 事实澄清 | `stopReason` 联合可合并扩展 | 已修：§2 写明 merge-extensible；A8 用 fallback |
| 16 | 事实澄清 | settlement notice 被误称「续聊消息」 | 已修：§2/§4.5/A12 统一改称 settlement notice |
| 17 | 事实澄清 | Claude Code 引用不在本仓，无法核对 | 已修：§2 标为外部背景，不作为实施依据 |
| 18 | 建议 | §6 缺 `transcript/model.ts`、`drafts.ts`；A5/A8/A10/A11 依赖未定义语义 | 已修：§6 补齐；A5/A8/A10/A11 与正文同步 |

2026-10-31 重审（用户点「重审」；2 个只读 agent：规格符合性 + 对抗找 bug）。原始结论见 [PR #120 评论](https://github.com/nano-sun99/dsh-tui-nano/pull/120#issuecomment-6539631906)。

| # | 严重度 | 发现 | 处置 |
|---|---|---|---|
| R1 | 阻断 | 官方 `subagent` 工具不产出 `resultMeta`，结果卡入口真实不可达；且主对话无卡片键盘焦点 | 已修：按工具名 + 稳定回执 `started subagent <id>` 识别；§4.2 改为点击进入并说明 `Enter` 不在本次范围 |
| R2 | 阻断 | 同一 id 续聊再次 `subagent/start` 不清已有行 `terminalAt`，运行中行会被 30 秒规则出列并 `dismissed` | 已修：start 同时清行内 `terminalAt` 与 `status`；补「行仍存在时再次 start」用例 |
| R3 | 建议 | external / 后代 start 会进 dock | 已修：start 过滤 `local === false`；占位行最多保留 10 秒，目录列出后以 `listChildren(rootId)` 的直接子代理为准；补 external / 后代用例 |
| R4 | 建议 | 详情里 `↑` 落到主会话历史，会把主历史发给子代理 | 已修：输入可用时 `↑` / `↓` 只翻子地址历史；补真实按键路径用例 |
| R5 | 建议 | 从列表进入详情再返回，列表滚回顶部、焦点行在视口外 | 已修：保存进入前主视图，返回恢复 `listScrollTop` 并 `ensureListVisible`；补 30 行列表用例 |
| R6 | 建议 | 不可读一次性行第二次 `Enter` 反而进入详情 | 已修：只有成功才缓存 `true`，失败仍拦截并允许重试；补二次 Enter 用例 |
| R7 | 建议 | 主草稿非空时返回，`x` 被 dock 吃掉并误删终态行 | 已修：主草稿非空时不恢复 dock 焦点，`x` 落回输入框；补用例 |
| R8 | 建议 | dock 行出列后 `dockFocusId` 残留，`Enter` 打开已消失详情 | 已修：焦点候选校验 + `activateDockFocus` 兜底；补用例 |
| R9 | 建议 | diagnostic 行只写「诊断」，不显示 `corrupt` / `unsupported` / `unavailable` | 已修：渲染 `诊断 · <reason>`；更新断言 |
| R10 | 建议 | unknown mode 详情只读但不显示原因 | 已修：详情顶部渲染原因行；补渲染断言 |
| R11 | 建议 | 一次性可读性一次探测失败后整场会话锁死 | 已修：失败不缓存为终态，下轮刷新重试；补瞬时失败用例 |
| R12 | 建议 | 只读 composer / 列表打开时 paste 与 Shift+Enter 仍能改写输入 | 已修：新增 `inputEditable` 门控，paste / 换行 / 可打印字符都不写入；补 NanoApp 用例 |
| R13 | 建议 | 详情内 Home/End 被正文滚动占用，覆盖输入框行首/行尾 | 已修：输入可用时交给 S01；只读时才滚正文 |
| R14 | 建议 | dock 溢出行可聚焦但无焦点标识 | 已修：溢出行渲染 `›` 与焦点背景；补渲染用例 |
| R15 | 事实澄清 | §2 运行态来源漏写活对象；running→done→idle 描述不准确 | 已修：§2 两行改写 |
| R16 | 事实澄清 | §9 机制清单缺一次性可读性探测、按地址历史、回执文本识别 | 已修：机制清单补 3 行，头部改为 7 个新增机制 |
| R17 | 事实澄清 | `DraftStore.scrollAnchor` 未被使用，正文滚动另存 | 已修：§5 / §8 写明文本光标用 `DraftStore`、正文滚动用 `scrollMemory` |
| R18 | 事实澄清 | IME 组合态无应用内实现或真实验证 | 已记录：证据目录已知限制；实现依赖终端吞键 |
| R19 | 事实澄清 | A10 一次性可读性未在真实 provider 下先验 | 已记录：§1 与证据目录写明默认 provider 集未产出 one-shot / external，真实 provider 验证为已知限制 |
| R20 | 事实澄清 | I1「首次观察到 running」被实现成「活对象存在」 | 已修：只在 `deriveStatus(live) === 'running'` 时建行；补 idle live 用例 |
| R21 | 事实澄清 | 证据映射有 4 处与测试实际不符；§6 范围外变更未列 | 已修：证据 README 与 §6 按实际测试 / 文件更新 |
| R22 | 事实澄清 | 主输入占位符多一个前导空格 | 已修：`App.tsx` 默认占位改为 `输入消息…` |

2026-10-31 修订后轻审（用户点「轻审」；1 个只读 agent：对抗找 bug + 范围外对账）。原始结论见 [PR #120 评论](https://github.com/nano-sun99/dsh-tui-nano/pull/120#issuecomment-6541629526)。

| # | 严重度 | 发现 | 处置 |
|---|---|---|---|
| R23 | 建议 | 可编辑详情里 `Ctrl+End` 漏给主对话，返回后主对话停在底部 | 已修：详情消费 `Ctrl+End` 与 `Shift+↑` / `↓` 滚子正文；补用例 |
| R24 | 建议 | unknown 详情多一行原因，滚动上限少算 1 行，正文第一行到不了 | 已修：`childViewHeight()` 扣掉原因行；补 Home 到第一行用例 |
| R25 | 建议 | 新 NanoApp 用例在挂起渲染未完成时卸载，触发被吞掉的 Yoga 越界 | 已修：用例在 unmount 前 `settle()`；错误行消失 |
| R26 | 事实澄清 | external activation 卡导航失败后既不导航也不展开 | 已修主视图：导航被拒时回落到该工具卡的展开；子详情内同类卡（maxDepth>1）仍不展开，已记为已知限制；补 App 用例 |
