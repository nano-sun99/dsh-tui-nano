# [2026-10-31-nano-subagent-dock-alignment] 子代理 dock 位置与完成态对齐设计稿

- 组标识：`2026-10-31-nano-subagent-dock-alignment`
- 角色：单份 spec，总纲与执行规格合一
- 状态：方案中（待确认）
- 结构：不拆——1 份 spec + 1 张执行 issue
- 机制范围：**2 个新增机制**——① 子会话 turn 级状态源，② dock 底部占位与正文高度预算
- 上游：设计稿 [`preview/README.md` §子代理交互](../../design/2026-10-17-dsh-tui-ux-research/preview/README.md)、`preview/index.html`（dock 在 `footer.status` 之后）、`preview/subagents.js`、[ADR-20261022-subagent-dock-lifecycle](../../decisions/2026-10-22-subagent-dock-lifecycle.md)、已合并 spec [`2026-10-30-nano-subagent-navigation`](../2026-10-30-nano-subagent-navigation/README.md)
- 替代关系：修正已合并 spec 的两处错误——dock 位置写成「输入框上方」、完成态只认 `subagent/end`；不重开旧 spec，新开本份
- ADR：新增 [ADR-20261031-subagent-turn-settlement](../../decisions/2026-10-31-subagent-turn-settlement.md)，**取代** [ADR-20261022-subagent-dock-lifecycle](../../decisions/2026-10-22-subagent-dock-lifecycle.md) 的保留计时触发点；30 秒时长、状态词、行内容不变，旧 ADR 同变更标记「已被取代」
- 下游：spec 合并后开执行 issue
- 合入前提：spec 合并后开执行 issue；实施需单测 / feature / PTY 证据齐全

## 1. 目标

把子代理 dock 的位置和完成态改成设计稿的样子：

1. **dock 在终端最底部**：输入框 → 状态栏 → dock，而不是输入框上方。
2. **一轮结束就显示完成**：可续聊子代理 `turn/end` 后立即进入完成/终止/错误态，不等 activation 结束；30 秒后出列规则不变。
3. **详情头部对齐设计稿**：左侧 `← 子代理 <名字>`，状态词靠右。
4. **移动后不挤压**：dock 占用的行数从正文高度扣除，100 / 60 列都不压掉输入与状态栏。

## 2. 当前事实与根因

调查基线：`origin/main` @ `b3ce788`；设计稿 `preview/index.html` / `preview/subagents.js`；官方 `@deepseek-ai/dsh-subagent` 0.2.1-rc.2。

| 事实 | 证据 |
|---|---|
| 设计稿的 DOM 顺序是「对话 → 输入 → 状态栏 → dock」 | `preview/index.html:328-339`：`.composer`、`footer.status`、`.subagent-dock` 依次排列；dock 是终端最后一个子元素 |
| 设计稿 dock 左右各 2ch，顶边框 | `preview/index.html:103`：`.subagent-dock { margin:0 2ch; border-top:1px solid var(--rule); padding:5px 0; }` |
| 当前实现把 dock 放在正文区内、输入之前 | `src/app/App.tsx:517-532`：`Transcript` 后接 `featureBody`，再是 `InputLine`、`StatusLine`；dock 由 `SubagentNavigation.body()` 返回 |
| 当前高度预算没有给 dock 留行 | `src/app/App.tsx:263-270` 的 `transcriptBodyHeight` 扣输入、状态、补全、header 与 `modelPanelRows`，但没有 dock；dock 现在挤在正文高度里 |
| 设计稿详情头部是「← 子代理 名字 + 右侧状态」 | `preview/index.html:316-319` 的 DOM：`#subagent-back`、`子代理`、`#subagent-title`、`#subagent-view-status`；`#subagent-title { flex:1 }` 在 `index.html:118`，把状态推到右侧 |
| 当前详情头部是左侧一整行 | `src/subagents/view.ts:920-932`：`‹ 返回 ` + `detailTitle()`；`detailTitle()` 为 `子代理 · 名字 · 状态词`（`src/subagents/detail.ts:23-25`） |
| 设计稿要求一轮结束即完成；当前只认 activation 结束 | 官方 `subagent/end` 的实际 emit 在 `dsh-subagent/lib/index.js:200-204`（`createActivationObserver.settle`）；`settle()` 由 activation teardown 调用（`:2040-2042`，`notifySettlement` 后 `observer.settle`）。可续聊子代理一轮结束仍驻留，activate 结束前不发 `subagent/end` |
| 子会话有独立的 turn 级终态 | 事件在 `dsh-session/lib/types/types.d.ts:256-277`（`turn/start` 263、`turn/end` 274）；`turn/end.reason.kind` 的类型在 `:166-211`，有 `completed / aborted / blocked / error / max-tokens / interrupted / forked` |
| 用户现场症状 | 子代理 `4e6a5ff2`（label `Analyze repo structure`）在 18:05:55 已有 `turn/end completed`，用户截图里 dock 仍显示「执行中」；代码路径也可能落到「未运行」，两者都等不到设计稿的完成态 |

结论：问题不是「模型没结束」，而是 **dock 选错了终态信号 + 布局顺序反了**。设计稿把 dock 放在状态栏之后；实现把 dock 放在输入之前。可续聊子代理的完成态要听子会话 `turn/end`，`subagent/end` 只在 activation 结束时兜底；当前实现可能停在「执行中」或「未运行」，都不是完成态。

## 3. 范围与边界

### 3.1 本次做

- dock 移到状态栏之后、终端最底部；左右 2ch；顶部一条边框。
- dock 行数参与正文高度预算：边框 + 最多 4 行 + 溢出 1 行；不可见时为 0。
- 子会话 `turn/start` → 执行中；`turn/end` → 按 reason 进入完成/终止/错误/未运行；30 秒后出列规则不变。
- `subagent/start` 仍作 activation 入列/复位兜底；`subagent/end` 仍作 activation 结束兜底。
- 详情头部改成 `← 子代理 <名字>` 左对齐、状态词右侧。
- 测试、PTY 证据、spec / ADR 回写。

### 3.2 本次不做

- 不改全局状态栏内容（设计稿的「权限 + cwd」是另一处差异，不在本 spec）。
- 不改 30 秒清理、`x` 仅终态行、4 行上限、键位与焦点规则。
- 不改官方 subagent 服务、不改 `steer` / `followup` 语义。
- 不做鼠标悬停、拖选跨视图、不做 dock 用时 / token 计数。
- 不改全部列表的数据源、计数与诊断规则。

## 4. 交互规格

### 4.1 dock 位置与形状

- 顺序固定：正文 → 输入框 → 状态栏 → dock；dock 是终端最后一个块。
- dock 左右各留 `EDGE = 2` 列；顶部一条 `─` 边框；无标题、无用时。
- 行内容不变：` ` / `›` + 状态灯 + 名字（弹性截断）+ 右侧状态词；最多 4 行，第 5 个起合并为 `还有 N 个子代理`。
- dock 只在主视图显示；进入详情或全部列表后隐藏。
- `/model` 面板打开（`modelPanelRows > 0`）时 dock 隐藏、`dockRows = 0`；关闭后按当前行数恢复。
- dock 不可见时高度为 0；可见时高度 = 1 条边框 + 可见行数 + 溢出 1 行（若有）。

### 4.2 高度预算

- `transcriptBodyHeight` 在现有扣除项之外再扣 `dockRows`；`dockRows` 由 S02 提供，主视图且 dock 可见时按 §4.1 计算，其余为 0。
- 正文高度最小 1 行；窄屏（60 列）与 100 列都不允许 dock 压掉输入框或状态栏。

### 4.3 完成态状态源

- 对每个 live 子代理，订阅其 agent scoped context 的 `session/event`：
  - 回调必须过滤 `session === child.session`，且只处理 `event.type === 'turn/start' | 'turn/end'`；agent scoped context 会收到后代 scope 的事件，不过滤会把后代的 turn 记到直接子代理行。
  - `turn/start`：状态设为 `running`；清 `terminalAt`、`dismissed` 与 activation 兜底用的 `terminal` 状态（新的一轮要重新出现，旧终态不能残留）。
  - `turn/end`：按 `reason.kind` 映射状态；turn 状态是权威状态，即使 activation end 先到也以 turn 为准；`terminalAt` 只由第一条终态信号写入，后续不覆盖。
- `reason.kind` 映射：
  - `completed` → 完成（done）
  - `aborted` → 终止（killed）
  - `error` → 错误（error）
  - `max-tokens` → 终止（killed）
  - `blocked` / `interrupted` / `forked` / 未知 → 未运行（idle），仍保留 30 秒后出列
- `subagent/start`：沿用现有行为，复位 `terminalAt` / `dismissed` / `terminal` / `status`，作为 activation 级兜底。
- `subagent/end`：保留 `stopReason` 映射兜底；若已有终态，不改状态、不重置 `terminalAt`、不延长保留时间；若无终态，写入状态与 `terminalAt`。
- 订阅跟随 child agent 的 live 生命周期：行出列或被 `x` 隐藏不释放；agent 释放或进程退出才释放。
- 冷启动仍 0 行；历史子代理只从全部列表看。

### 4.4 详情头部

- 一行两段：左侧 `← 子代理 <名字>`，右侧 `<状态词>`。
- `←` 可点击返回；名字弹性截断；状态词不截断。
- dock 在详情 / 列表打开时隐藏。

## 5. 状态模型

```ts
type TurnStatus = 'running' | 'done' | 'killed' | 'error' | 'idle'

type DockRow = {
  id: string
  name: string
  mode: 'one-shot' | 'continuable' | 'external' | 'unknown'
  status: TurnStatus
  terminalAt?: number   // 首次 turn/end 或 activation end；refresh 不覆盖
}
```

- `terminalAt` 由第一条终态信号写入；后续 signal 不覆盖时间。
- 状态优先级：`turn/end` 是权威状态；`subagent/end` 只在尚无终态时补状态，不覆盖 turn 状态。
- `turn/start` 清 `terminalAt`、`dismissed` 与 `terminal`，状态回 running。
- `subagent/start` 仍清 `terminalAt`、`dismissed`、`terminal`，作为新 activation 的完整复位。
- dock 的可见性、30 秒 grace、`x` 规则不变。

## 6. 改动面

| 文件 | 改动 |
|---|---|
| `src/app/App.tsx` | 新增独立 `dockBody` 节点：主视图顺序为正文 → 输入 → 状态栏 → dock；`transcriptBodyHeight` 扣 `dockRows`；dock 容器加左右 2ch；`modelPanelRows > 0` 时 dock 隐藏 |
| `src/app/nano-app.ts` | snapshot 暴露 `dockBody` / `dockRows`；`currentBodyHeight` 与高度计算同步 |
| `src/controls/feature-host.ts` | 把 dock 从 `body()` 的全文面板栈中拆出，单独提供 `dock()` / `dockRows()`；terminal/info/sessions/jobs 仍走 `body()` |
| `src/subagents/view.ts` | dock 高度、详情头部布局；dock 订阅与 turn 状态委托给 `dock.ts` |
| `src/subagents/detail.ts` | 详情头部拆成名字与状态两段 |
| `src/subagents/dock.ts` | live child 的 `turn/start` / `turn/end` 订阅与过滤、turn 状态应用、activation 兜底去重、`rows()` 高度 |
| `tests/unit/` | turn/end 映射、turn/start 复位、高度预算、头部布局 |
| `tests/e2e/` | PTY 截图：dock 在状态栏之后、100/60 列不压输入、完成态出现 |
| `docs/evidence/2026-10-31-subagent-dock-alignment/` | 测试输出 + PTY 对照截图 + 验收映射 |
| `docs/decisions/2026-10-31-subagent-turn-settlement.md` | 新 ADR：turn 级终态信号，30 秒不变 |

## 7. 验收

- [ ] A1 dock 在状态栏之后、终端最底部；无 dock 时布局与现在一致。
- [ ] A2 dock 左右各 2 列、顶部一条边框；4 行 + 溢出仍成立。
- [ ] A3 100 列与 60 列下，dock 不压掉输入框与状态栏；正文高度随 dock 行数变化。
- [ ] A4 可续聊与 one-shot live 子代理：`turn/end completed` 后立即显示「完成」，30 秒后出列；连续 refresh 不复活。
- [ ] A5 同一 id 的 `turn/start` 让行回到「执行中」，清 `dismissed` 与 `terminal`；新 `turn/end` 后重新完整计时。
- [ ] A6 `completed` / `aborted` / `error` / `max-tokens` / `blocked` / `interrupted` / `forked` / 未知 reason 分别显示正确状态词；未知仍保留 30 秒。
- [ ] A7 `subagent/end` activation 兜底仍工作；已有 turn 终态时，后到的 activation end 不改状态、不改 `terminalAt`、不延长保留时间。
- [ ] A8 详情头部为 `← 子代理 <名字>` + 右侧状态词；dock 在详情 / 列表隐藏。
- [ ] A9 dock 焦点、`x`、Alt+L、返回落点、草稿隔离无回归。
- [ ] A10 `npm test`、`npm run typecheck`、`npm run lint`、PTY e2e 与文档检查全绿。
- [ ] A11 冷启动 dock 0 行；历史子代理只从全部列表可见。
- [ ] A12 `/model` 面板打开时 dock 隐藏、`dockRows = 0`；关闭后按当前行数恢复，正文高度同步。

## 8. 自定细节

- `dockRows` 公式：`visible ? 1 + min(4, rows) + (overflow > 0 ? 1 : 0) : 0`。
- dock 左右边距复用 `EDGE = 2`，与输入框/状态栏同一列宽基准。
- `turn/end` 的未知 reason 映射到 `idle`（未运行），不丢 30 秒清理；与旧 stopReason fallback 一致。
- turn 终态与 activation 终态都到时不重复计时：先到者写 `terminalAt`；turn 状态权威，activation end 不覆盖状态、不改时间。
- `turn/start` 清 `dismissed` 与 `terminal`，保证用户按 `x` 后新的一轮仍会重新出现，旧终态不残留。
- 子会话事件订阅在子代理 live 时建立，跟随 agent live 生命周期；行出列、`x` 隐藏、30 秒出列都不释放，agent 释放或进程退出才释放；不订阅历史会话。
- 订阅回调过滤 `session === child.session` 且 `event.type` 属于 `turn/start` / `turn/end`；agent scoped context 会收到后代事件，不过滤会串行。
- 详情头部 `←` 的可点击区域与现有 `subagent:back` 一致。

## 9. 机制清单

| 机制 | 解决什么 | 没有会怎样 |
|---|---|---|
| 子会话 turn 级状态源 | 可续聊子代理一轮结束立即进入完成/终止/错误态；`turn/start` 复位 | dock 可能停在「执行中」或「未运行」，直到 activation 结束；设计稿的完成态不成立 |
| dock 底部占位与正文高度预算 | dock 移到底部后仍不挤压输入/状态栏，正文高度按 dock 行数收放 | 移到底部会溢出终端或压掉输入行/状态栏 |

详情头部是纯视觉对齐，不单列机制；由 A8 验收。

## 10. 审核修订记录

2026-10-31 轻审（用户点「轻审」；1 个只读 agent：规格符合性 + 两张清单）。原始结论见 [PR #121 评论](https://github.com/nano-sun99/dsh-tui-nano/pull/121#issuecomment-6542331839)。

| # | 严重度 | 发现 | 处置 |
|---|---|---|---|
| R1 | 阻断 | 新 ADR 实际改了旧 ADR 的 30 秒计时触发点，却写「补充」、旧 ADR 仍生效 | 已修：新 ADR 改为「取代」并承接旧决定；旧 ADR 标「已被取代」并链回新 ADR |
| R2 | 建议 | 订阅按行出列释放，会让按 `x` 后的 `turn/start` 收不到 | 已修：订阅跟随 child agent live 生命周期，行出列/隐藏不释放 |
| R3 | 建议 | 未写 `session/event` 按 session 与类型过滤，后代的 turn 会串行 | 已修：§4.3/§8 写明过滤 `session === child.session` 与 `turn/start`/`turn/end` |
| R4 | 建议 | `turn/start` 未清 `terminal`，旧 activation 终态会残留 | 已修：§4.3/§5/§8 明确清 `terminalAt`、`dismissed`、`terminal` |
| R5 | 建议 | 后到 `subagent/end` 是否改状态四处写法不一致 | 已修：turn 状态权威；activation end 仅在无终态时补，不覆盖状态/时间 |
| R6 | 建议 | 验收缺 one-shot、blocked/interrupted/forked、不延长、冷启动 | 已修：A4/A6/A7/A11 补项 |
| R7 | 建议 | 模型面板分支与独立 dock 通道未写 | 已修：§4.1 定义面板打开时隐藏；§6 增加 `dockBody`/`dockRows` 独立通道 |
| R8 | 建议 | 详情头部未在机制清单说明归属 | 已修：§9 注明它是视觉对齐，不单列机制，由 A8 验收 |
| R9 | 事实澄清 | 当前症状可能是「未运行」而非一直「执行中」 | 已修：§2/§9 改为「执行中或未运行」，根因不变 |
| R10 | 事实澄清 | 证据目录截图不存在 | 已修：改为「用户现场症状」，不引用未落盘证据 |
| R11 | 事实澄清 | 多处 file:line 引用不准 | 已修：turn 事件、flex、subagent emit、modelPanelRows、旧 ADR 出处、view/dock 归属全部改正 |
