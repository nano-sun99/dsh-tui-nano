# [2026-11-02-nano-tool-result-retention] 工具结果进 transcript 前收敛为显示预览

- 组标识：`2026-11-02-nano-tool-result-retention`
- 角色：单份 spec，总纲与执行规格合一
- 状态：已完成（PR #156，2026-11-02；验收回填见 issue #140）
- 实施 issue：[#140](https://github.com/nano-sun99/dsh-tui-nano/issues/140)
- 结构：不拆——1 份 spec + 沿用 #140 作为执行单；本改动无多阶段里程碑
- 机制范围：M1–M4（见 §6）
- 上游：
  - 原 issue #140 的现状、证据与边界。
  - V8 字符串文档与 Node 子串内存问题：[V8 `docs/objects/strings.md`](https://github.com/v8/v8/blob/main/docs/objects/strings.md)、[nodejs/node#31891](https://github.com/nodejs/node/issues/31891)。
  - 官方 `@deepseek-ai/dsh-compaction-tool-result-pruner` 0.2.1-rc.2：头/尾/标记语义参考；**不是本次实现**，也不替代它。
  - Claude Code 2.1.88 源码（本机归档 `/Users/sunchongsheng/Downloads/归档/06-软件与安装包/ClaudeCode/src`）：`src/utils/shell/outputLimits.ts`、`src/tools/BashTool/utils.ts:147-160`、`src/components/shell/OutputLine.tsx`。
  - 本机 114 个会话的实测（见 §2）。
- ADR 检索：按「transcript / 工具结果 / 截断 / 缓存 / 显示」检索 `docs/decisions/`；命中 [ADR-20261028-nano-process-display](../../decisions/2026-10-28-nano-process-display.md)（成功 0 行、失败 3 行、展开原位点击），本 spec 沿用其显示语义，无取代；本次新增见下条。
- ADR：新增 [ADR-20261102-transcript-display-projection](../../decisions/2026-11-02-transcript-display-projection.md)
- 替代关系：**不替代**官方 compaction/pruner；**不改变**模型可见结果；**局部改变** `TranscriptModel` 的留存契约——`ToolEntry.resultText` 从“原始结果”改为“显示预览”。
- 下游：无硬依赖。未来若要在 TUI 内查看工具全量输出，必须读官方 session/log 或另做 pager；不能假设 `ToolEntry.resultText` 仍是原文。
- 合入前提：单测、类型检查、lint 全绿；PR 附 1 MB × N 条的内存对比证据。文档检查：本仓无 docs 检查脚本（无入口）。

## 1. 目标与边界

目标：把 UI 侧工具结果的**留存**从“收到多少存多少”改成“渲染层最多能显示多少就存多少”，并让已有的渲染缓存真正生效。三件事：

1. **进 transcript 前投影**：`completeTool` 收到原始结果后，立即生成显示预览——头 24 行 + 尾 16 行 + 一行“省略 K 行”，单行内容最长 500 个 UTF-16 码元（行内标记另计）；小结果原样保留。
2. **强制新串**：只要发生截断，预览必须由新字符串构成，切断 V8 `SlicedString` 对原始大串的父引用；否则“截了”但内存不会降。
3. **修好缓存**：把 `toolUnit` 的所有昂贵构建（`parseArgs`、`split`、`wrapSpans`、`renderDiffs` 之外的行组装）移进 `cachedRows` 的回调，并用条目内容版本 `rev` 作缓存键；重排命中缓存时不再重复全文 `split`。

### 非目标

- **不改模型可见结果**：官方 `tool/result` 事件、session log、模型上下文里的完整结果都不动；本 spec 只处理 UI 留存的那一份。
- **不替代官方 pruner**：`dsh-compaction-tool-result-pruner` 是压缩期模型上下文服务（压力/溢出才跑，原始结果仍留在 session log）；它解决不了压缩前的 UI 驻留，也解决不了每次重排的 `split`。
- **不处理 `args`**：实测 114 个会话最大 args 28 KB，且受模型输出上限约束；本次缓存修复会顺带消除重排时的重复 `JSON.parse`，但不改变 args 的留存。
- **不处理 `resultMeta` 的 diff 大文本**：`FileDiff.oldText/newText` 可能很大；另立 issue。
- **不做整段 transcript 的淘汰/分页**：本 spec 只保证“每条有界”，不保证“总条数有界”；长会话总占用仍是后续问题。
- **不改渲染布局算法**：`layout()` 仍按 `revision` 重算整段；本次只让单条 unit 的行构建可缓存。
- **不改工具执行语义、键位、主题、审批卡、活动栏、diff 渲染、`args` 展开体的 24 行预算。**
- **不使用官方 pruner 的服务实例**：不复用其 Cordis 服务、不调用 `pruneSession`、不改变 session surface；只借它的头/尾/标记语义。

## 2. 现状与证据

调查基线：`origin/main` @ `5f26659`；官方 `@deepseek-ai/dsh` 0.2.1-rc.2。

| 事实 | 证据 |
|---|---|
| `completeTool` 把传入的 `resultText` 原样存进 `ToolEntry` | `src/transcript/model.ts:233-245` |
| 实时入口与回放入口都汇到 `completeTool` | `src/conversation/controller.ts:198`、`:317`；`src/subagents/detail.ts:73`、`:124` |
| 展开态只显示前 40 行结果 | `src/transcript/model.ts:554-557` |
| 折叠失败态只显示前 3 行 | `src/transcript/model.ts:594-600` |
| 读类工具的展开体只显示目标与失败摘要，成功结果文本本来就不显示 | `src/transcript/model.ts:407-420` |
| 渲染缓存是 LRU，但 `rows` 在 `cachedRows` 之前就构建完了 | `src/transcript/model.ts:281-295`、`:390-443` |
| 布局缓存键含 `revision`；每次 `notify` 都递增 | `src/transcript/model.ts:149`、`:462` |
| `toolTitle` / `readTarget` 每次构建都会 `JSON.parse` args | `src/transcript/model.ts:524-540` |
| V8 对 13 字符以上的 `slice/substring` 建 `SlicedString`，保留“父串 + 偏移”；父串在切片存活期间不能回收 | V8 `docs/objects/strings.md`：“Keeps the parent string alive in memory, even if only a small slice is needed.”；[nodejs/node#31891](https://github.com/nodejs/node/issues/31891) |
| V8 `String(x)`、`x + ''`、模板字符串可能生成仍引用父串的 `ConsString`；需要真正复制 | 上条 Node/V8 讨论与堆快照实践 |
| 官方 pruner 默认 8192 字符阈值、头 4096 + 尾 1024（按 Unicode 码点）；只在压缩压力/溢出触发时跑；完整原始结果仍留在 session log；它改变模型可见内容 | `node_modules/@deepseek-ai/dsh-compaction-tool-result-pruner/lib/index.js:12-74`；同包 `README.md`〈When trimming runs〉〈Use this package〉；`node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js:926-944`（overflow 与 pressure 两个 `pruneSession` 分支） |
| Claude Code Bash 默认取**头部** 30,000 字符（上限 150,000），超出追加 `... [N lines truncated] ...` | `src/utils/shell/outputLimits.ts`；`src/tools/BashTool/utils.ts:145-166` |
| issue #140 说 Claude Code “取的是尾部”，与源码不符；实际是 `content.slice(0, maxOutputLength)` | 同上；本 spec 的“头 + 尾”是为错误/日志结尾可读而做的主动选择，不是因为 Claude Code 取尾 |
| Claude Code 的 UI 还按终端列宽做 `renderTruncatedContent`；工具结果在进入 UI 前已有工具层上限 | `src/components/shell/OutputLine.tsx`；`src/utils/file.ts:48`（`MAX_OUTPUT_SIZE` 0.25 MB） |
| 本机 114 个会话扫描：仅 1 条工具结果 >64 KB（65.5 KB，`web_fetch`）；最大 args 28 KB（`write`）；`preview-main` 长会话总结果约 0.65 MB；UI 实际持有一份 args 约 0.51 MB（日志内 `tool/call` 与 `assistant/message` 各记一份，合计约 1.03 MB） | 2026-11-02 本次扫描 `~/.dsh-tui-nano/sessions/**/session.v4.jsonl.zstd`；850 KB 样本不在本次扫描的会话文件中 |
| 现有测试已覆盖展开体与失败摘要，但未覆盖“大结果留存上界”和“缓存命中不重复 split” | `tests/unit/transcript.test.ts:124-143`、`:161-168`；`tests/unit/perf.test.ts` |

**结论**：当前不是“阈值不够小”，而是**存了渲染层永远用不到的全量文本**；且朴素 `slice` 在 V8 上反而把原串钉住。官方 pruner 是另一层（模型上下文、压缩期、保留原日志），不能替代本修复。

## 3. 行为规格

### 3.1 数据契约

- `ToolEntry.resultText` 改为**显示预览**，不再是原始工具结果。唯一写入点是 `completeTool`；`replay`、子代理详情、实时事件都走它。
- 预览上界：
  - 最多 `previewLines` 条原始行（默认 40：头 24 + 尾 16）；
  - 最多一行中间标记 `… 省略 K 行 …`；
  - 每条保留行的**内容**最多 500 个 UTF-16 码元（行内标记另计）；超长行截到 500 码元后追加 `…（本行已截断）`。
- 小结果（行数 ≤ `previewLines` 且没有超长行）原样保留，不做复制。
- 被省略的中间部分不进入 UI 模型；完整原文仍在官方 session/log 中，模型侧不受影响。
- 失败结果：预览头部仍包含前 3 行，折叠态 `failureRows` 仍取前 3 行；超长行会多一个行内截断标记。控制器前置的 `reason` 行属于头部。
- 子代理回执：`started subagent <id>` 在首行，24 行头部覆盖；`activationFromResult` 继续工作。
- 恢复会话：`completeTool` 在 replay 时同样投影，恢复后的 UI 也不会重新持有整段原文。

### 3.2 预览算法

`previewToolResult(text, maxLines)`：

1. `totalLines = 1 + count('\n')`。
2. 若 `totalLines > maxLines`：
   - `headLines = ceil(maxLines * 0.6)`，`tailLines = maxLines - headLines`；
   - 头部取前 `headLines` 行，尾部取后 `tailLines` 行；
   - `omitted = totalLines - maxLines`，在头尾之间插入 `… 省略 ${omitted} 行 …`。
3. 若 `totalLines <= maxLines`：保留全部行，不插中间标记。
4. 对每条保留行的内容做 500 码元上限（行内标记另计）；若切点落在代理对中间，回退一个码元，保证不产生孤立代理项。
5. 若没有任何截断，返回原文；否则用**新字符串**重建预览（`Array.from(preview).join('')`），切断对原文的父引用。
6. 计数用一次 `indexOf` 扫描（不要先 `split('\n')` 成整行数组）；头尾用 `indexOf` / `lastIndexOf` 只切必要块，再只对头尾块 `split`。

边界：

- 空串 → 空串。
- 只有一个超长行 → 取前 500 码元内容 + `…（本行已截断）`，没有中间标记。
- 末尾换行 → `totalLines` 多计一条空行，与 `split('\n')` 语义一致。
- CRLF → 按 `\n` 切行，`\r` 保留在行尾；不改变现有行为。
- 代理对 → 不切开；不使用 UTF-8 往返，避免把孤立代理项替换成 `U+FFFD`。
- 头尾不重叠：仅当 `totalLines > maxLines` 时才取尾，故 `headLines + tailLines = maxLines < totalLines`。

### 3.3 环境变量

- `NANO_TOOL_PREVIEW_LINES`：预览保留的总行数，默认 40，合法范围 4–2000 的整数。
- 非法值、0、负数、非整数、超过 2000 → 回退默认 40；不静默放大。
- 每次生成预览时读取；修改需重启进程。
- 这是排查/调试旋钮，不是内存修复：调大就是让 UI 多存；README 的环境变量说明里要写清楚。`nano --help` 只列启动开关，不列环境变量，本次不新增帮助条目。

### 3.4 渲染

- `expandedToolRows` 渲染预览的全部行，**不再二次 `.slice(0, 40)`**；预览本身 ≤ `previewLines` 行 + 标记（默认 40 + 1）。
- 折叠失败摘要（前 3 行）同样取自预览，超长行会带行内截断标记；不额外保留原文。
- `args` 的 `JSON.stringify(...).split('\n').slice(0, 24)` 保留不变；diff 渲染保留不变。
- `failureRows` 仍取前 3 行；读类展开体仍只显示目标与失败摘要，不因本次改动开始显示成功结果全文。
- 中间标记是预览中的普通一行，沿用结果行的 tone（成功 `muted`，失败 `danger`）；不新增主题 token。
- 行渲染仍是 `wrap={false}` 的宽度裁剪；500 码元内容上限是留存上界，不是新的换行规则。

### 3.5 缓存

- `ToolEntry` 新增只读 `rev: number`；`appendTool` 置 0；`completeTool`、`markApprovalDecision` 每次变更 `rev + 1`。
- `toolUnit` 的缓存键改为 `id|width|expanded|` + 组内每个条目的 `id:rev`；`status` / `decision` / `resultText` / `resultMeta` 的变化都由 `rev` 覆盖。
- 把 `toolTitle`、`readTarget`、`decisionSummary`、`failureRows`、`expandedToolRows` 以及 `rows` 的组装全部移进 `cachedRows` 的 `build` 回调；缓存命中时不执行任何解析/切分/换行。
- `RENDER_CACHE_MAX` 仍为 400；`layout` 的缓存策略不变。

### 3.6 明确不变

- 官方 `tool/result` 事件、session log、模型上下文、压缩行为。
- 工具执行、审批卡、活动栏、diff 渲染、输入/键位、主题。
- `args` 的留存与展开体 24 行预算；`resultMeta` 的留存。
- 折叠态成功 0 行、失败 3 行；展开态默认 40 行结果（24 头 + 16 尾 + 标记），不是只取头 40 行。
- `RENDER_CACHE_MAX`、`layout` 的 revision 语义、滚动行为。

## 4. 改动面

| 文件 | 改动 |
|---|---|
| `src/transcript/preview.ts`（新增） | 常量、`resolvePreviewLines()`、`previewToolResult()`、行计数/头尾定位/行截断/新串重建 |
| `src/transcript/model.ts` | `ToolEntry.rev`；`appendTool` / `completeTool` / `markApprovalDecision` 维护 rev；`toolUnit` 缓存键与构建回调；`expandedToolRows` 去掉二次 40 行切片 |
| `tests/unit/preview.test.ts`（新增） | 行数/头尾/标记/超长行/代理对/环境变量/小结果不变 |
| `tests/unit/transcript.test.ts` | 1 MB 结果留存上界；展开体头/标记/尾；失败前三行；子代理 activation；缓存命中不重复 split |
| `tests/unit/perf.test.ts`（可选） | 100 × 1 MB 结果的留存上界；不引入时间型脆弱断言；确定性上界测试以 `transcript.test.ts` 为准 |
| `README.md` | 在环境变量/调试说明中补 `NANO_TOOL_PREVIEW_LINES`（默认 40、范围 4–2000、调大等于多存）；不改 `nano --help` |
| `docs/decisions/2026-11-02-transcript-display-projection.md`（新增） | 长期决定：UI 只留显示投影，不留原始工具载荷 |

不改 `src/conversation/controller.ts`、`src/subagents/detail.ts`：它们只调用 `completeTool`，投影在模型入口完成。

## 5. 失败与不变量

1. **模型可见结果不变**：本 spec 不写 session、不改事件、不调官方 pruner。UI 预览再短，模型拿到的仍是完整结果。
2. **官方 session/log 仍持有原文**：这是模型上下文和精确回放的需要；本 spec 只把 UI 这一份从无界变有界，不能宣称整个进程内存归零。
3. **每条有界，不等于总量有界**：条目数仍随会话增长；整段 transcript 的淘汰/分页另立 issue。
4. **截断必须复制**：任何“只 slice 不复制”的实现都视为未完成；V8 的 `SlicedString` 会让父串继续驻留。
5. **不切代理对**：切点回退一个码元；不使用 UTF-8 往返，避免替换孤立代理项。
6. **缓存不得返回陈旧行**：`rev` 必须覆盖 `status`、`decision`、`resultText`、`resultMeta` 的每次变化；漏一个就会出现“结果变了但界面没变”。
7. **环境变量不得放大到无界**：非法/越界回退默认；上限 2000 行，且每行内容仍有 500 码元上限。
8. **渲染器信任入口不变量**：`expandedToolRows` 不再二次截断；如果未来有别的路径直接写 `ToolEntry.resultText`，必须同样投影。当前 `entries` 私有、`completeTool` 是唯一写入点。
9. **压缩替换可重入**：官方压缩若发出新的 `tool/result` 替换事件，`completeTool` 会重新投影并 bump rev；旧预览被替换，不叠加。
10. **首次扫描是 O(N)**：计数与定位头尾会扫描原文一次；这是进 transcript 时的一次成本，不是每次重排的成本。不得退化成每次渲染都扫描整串。
11. **不新增依赖**：不引入官方 pruner 服务、不新增 npm 包；只用现有 TypeScript/Node 能力。
12. **可见行为变化要说清**：展开体从“头 40 行”变成“头 24 + 标记 + 尾 16”；中间被省略的内容不再出现在 UI，只在 session/log 中。折叠失败摘要取自预览前 3 行，超长行会带行内截断标记。

## 6. 机制清单

| 机制 | 解决什么 / 没有会怎样 | 确认与代价 |
|---|---|---|
| M1 显示预览投影（入口 `completeTool`） | UI 不再存渲染层永远用不到的整段结果；没有则 850 KB 结果整段陪跑会话 | 用户 2026-11-02 选择“UI 层投影（推荐）”；代价是中间内容不在 UI 显示 |
| M2 截断后强制新串 | 切断 V8 `SlicedString` 的父串引用，让原文真正可回收；没有则“截了”但内存不降 | 用 `Array.from(preview).join('')`，不依赖 `slice`/字符串拼接；代价是一次 ≤ 约 21 KB 的复制 |
| M3 内容版本 + 缓存内构建 | 重排命中缓存时不再 `split`/`JSON.parse`/`wrap`；没有则每次流式增量都重复全文工作 | 新增 `ToolEntry.rev`；缓存键含组内所有 `id:rev`；不改 LRU 大小 |
| M4 `NANO_TOOL_PREVIEW_LINES` | 排查时能临时多看几行；没有则只能改代码重启 | 默认 40，范围 4–2000，非法回退；调大等于多存；README 写清，`nano --help` 不新增条目 |

## 7. 自定细节

- 默认预览 40 行：头 `ceil(40 * 0.6) = 24`，尾 16。奇数行数时头向上取整。
- 单行内容上限 500 个 UTF-16 码元（`…（本行已截断）` 另计）；切点落在高代理项 + 低代理项之间时回退 1 个码元。
- 中间标记文案：`… 省略 ${omitted} 行 …`；行内截断文案：`…（本行已截断）`。不使用英文标记，不新增主题 token。
- 小结果原样返回，不做无谓复制；只有发生截断/超长行时才 `Array.from(preview).join('')`。
- `previewToolResult` 的第二个参数 `maxLines` 供测试显式传入；默认值来自 `resolvePreviewLines()`。
- `resolvePreviewLines()` 只在调用时读 `process.env.NANO_TOOL_PREVIEW_LINES`；不缓存，避免测试之间互相污染。
- `NANO_TOOL_PREVIEW_LINES` 的文档落点是 `README.md` 的环境变量/调试说明；`nano --help` 只列启动开关，不列环境变量，本次不新增帮助条目，避免两处漂移。
- `ToolEntry.rev` 从 0 开始；`completeTool` 和 `markApprovalDecision` 各 bump 一次；`appendTool` 不 bump。
- 缓存键为 `${id}|${width}|${expanded ? 1 : 0}|${group.map(e => `${e.id}:${e.rev}`).join(',')}`；不再用 `resultText.length`。
- `expandedToolRows` 不再二次 `slice(0, 40)`；如果预览为空或只有空白，仍按现有 `trim() !== ''` 跳过。
- 读类成功结果仍会存一份预览（不特判丢弃），因为统一不变量更简单，且预览本身有界；它不会被渲染。
- 不使用 issue #140 建议的 64 KB 阈值：64 KB 对 UI 仍是“存了不显示”；按行数 + 行宽拍才是渲染层真正能用到的最多内容。
- 不把 Claude Code 的“取尾部”说法当事实：源码是取头部 30,000 字符；本 spec 取头 + 尾是主动选择，理由是错误/日志结尾可读。
- 不改 `args`；缓存修复会让 args 的 `JSON.parse` 只在缓存未命中时发生。
- 不改 `resultMeta`；diff 大文本另立 issue。
- 本次不新增 `NANO_TOOL_PREVIEW_LINE_CHARS`；500 码元内容上限是安全上界，不做第二个旋钮。

## 8. 审核修订记录

| # | 严重度 | 发现 | 处置 |
|---|---|---|---|
| 1 | 重要 | 用户指出官方已有 pruner，需比较后再定方案 | 已核：官方 pruner 是压缩期模型上下文服务，只在压力/溢出触发，原始结果仍留 session log，且改变模型可见内容；本 spec 明确它是另一层，不替代 UI 投影。见 §1 非目标、§2 证据、§6 M1 |
| 2 | 重要 | issue #140 说 Claude Code “取尾部”，与源码不符 | 已改：§2 明确实际是 `content.slice(0, maxOutputLength)` 取头部；本 spec 的头 + 尾是主动选择 |
| 3 | 重要 | 朴素 `slice` 在 V8 上会保留父串，截断可能无效 | 已改：M2 强制新串；§3.2 第 5 步、§5 第 4 条 |
| 4 | 轻微 | 现有缓存键用 `resultText.length`，同长度不同内容可能碰撞 | 已改：改用 `ToolEntry.rev`，覆盖 status/decision/resultText/resultMeta 全部变更 |
| 5 | 轻微 | 渲染器二次 `.slice(0, 40)` 会切掉尾部标记后的最后一行 | 已改：`expandedToolRows` 渲染预览全部行；预览本身有界 |
| 6 | 轻微 | 末尾换行/空行在头尾切分时容易丢 | 已改：§3.2 边界明确按 `split('\n')` 语义计数；尾部空行也保留 |
| 7 | 轻微 | 轻审：§2 的 1.03 MB 把日志内 `tool/call` 与 `assistant/message` 两份 args 都算进去了；UI 实际只持有一份约 0.51 MB | 已改：§2 改为“UI 一份约 0.51 MB；日志两份合计约 1.03 MB” |
| 8 | 轻微 | 轻审：§3.4/§3.6 把 40 行写成折叠态；现状是折叠成功 0 行、失败 3 行、展开 40 行 | 已改：§3.4 改为 `previewLines` + 标记；§3.6 改为折叠成功 0 行 / 失败 3 行 / 展开默认 40 行 |
| 9 | 轻微 | 轻审：500 码元是否含行内标记未说清；失败摘要前 3 行也会带标记 | 已改：§1/§3.1/§7 明确“内容 500、标记另计”；§3.1/§3.4/§5.12 披露失败摘要 |
| 10 | 轻微 | 轻审：M4 承诺“文档和帮助”但 §4 无 README/帮助落点 | 已改：§3.3/§4/§6/§7 明确 README 落点；不改 `nano --help` |
| 11 | 轻微 | 轻审：spec 头部缺 ADR 检索词与“沿用/无取代”结论 | 已改：头部新增 ADR 检索行，命中 ADR-20261028、沿用显示语义、无取代 |
| 12 | 轻微 | 轻审：`dsh-compaction-basic` 只引了 overflow 分支，pressure 分支在 `:942-944` | 已改：§2 引用改为 `:926-944`，覆盖两个 `pruneSession` 分支 |

2026-11-02 轻审（1 个 agent，主会话派出）：6 条轻微，用户选择“改”，已全部修订；结论见 PR #155 评论。

2026-11-02 实施期轻审（PR #156，1 个 agent，主会话派出）：2 条轻微；用户选择「改 #1、接受 #2」。#1 已修：空白预览（含省略/行内截断标记）不再展开渲染，新增 `previewHasContent` 与测试；#2 接受：§3.3 已披露旋钮代价，§6 M2 的 21 KB 对应默认预算，代码仍以 ≤2000 行 × 500 码元有界，不改冻结正文。结论见 PR #156 评论。
