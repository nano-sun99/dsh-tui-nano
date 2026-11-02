# ADR-20261102-transcript-display-projection：UI transcript 只保留工具结果的显示投影

- 状态：生效中（随 `2026-11-02-nano-tool-result-retention` spec 合并进入仓库基线）
- 日期：2026-11-02
- 决策人：用户
- 适用范围：`src/transcript` 中 `ToolEntry.resultText` 的留存、工具结果行的渲染缓存；不适用于官方 session/log、模型可见结果、`args` 与 `resultMeta`
- 取代：不取代现有 ADR；局部改变 `TranscriptModel` 的留存契约（从原始结果改为显示预览）
- 被取代：无
- 决策来源：用户 2026-11-02 本次对话。方案卡选择「UI 层投影（推荐）」；预览卡选择「头 24 + 尾 16（推荐）」；原问题与证据见 [issue #140](https://github.com/nano-sun99/dsh-tui-nano/issues/140) 与[本次 spec](../specs/2026-11-02-nano-tool-result-retention/README.md)

## 决定

1. **UI transcript 不再保存工具结果的原始全文**。`completeTool` 在写入 `ToolEntry.resultText` 前，把它投影成显示预览：头 24 行 + 尾 16 行 + 一行「省略 K 行」，每条保留行的内容最多 500 个 UTF-16 码元（行内标记另计）。
2. **截断必须产生新字符串**。任何发生截断的预览都用 `Array.from(preview).join('')` 重建，切断 V8 `SlicedString` 对原始大串的父引用；只用 `slice` / `substring` / 字符串拼接不算完成。
3. **模型可见结果不变**。官方 `tool/result` 事件、session log 与模型上下文仍保留完整结果；本决定只处理 UI 留存的那一份。
4. **渲染缓存按条目内容版本失效**。`ToolEntry` 增加 `rev`，`completeTool` 与 `markApprovalDecision` 每次变更递增；`toolUnit` 的昂贵构建移进 `cachedRows` 回调，缓存键使用组内每个条目的 `id:rev`，不再用 `resultText.length`。
5. **前端只按显示契约取数**。默认 40 行；`NANO_TOOL_PREVIEW_LINES`（4–2000 的整数）是排查旋钮，非法值回退 40；不新增第二个行宽旋钮。
6. **官方 pruner 保持不动**。`dsh-compaction-tool-result-pruner` 继续只负责压缩期的模型上下文；不把它的服务实例接进 UI 显示路径。

## 依据

- **代码路径**：`src/transcript/model.ts:233-245` 原样保存结果；渲染层最多显示 40 行（`:554-557`）或错误 3 行（`:594-600`）；`cachedRows` 存在（`:281-295`），但 `rows` 在查缓存前已构建（`:390-443`）。
- **V8 行为**：13 字符以上的 `SlicedString` 保留父串，官方文档写明 “Keeps the parent string alive in memory, even if only a small slice is needed.”；[nodejs/node#31891](https://github.com/nodejs/node/issues/31891) 复现了 13 字符切片导致 OOM。`String(x)`、`x + ''`、模板字符串可能仍是引用父串的 `ConsString`，所以必须真正复制。
- **官方 pruner 的定位**：默认 8192 字符阈值、头 4096 + 尾 1024；只在压缩压力/溢出触发时跑；README 明确完整原始结果仍留在 session log；它改变模型可见内容，目标不是释放进程内存。因此不能替代 UI 侧投影。
- **Claude Code 参考**：Bash 默认取头部 30,000 字符，超出追加剩余行数；issue #140 里“取尾部”的说法与源码不符。本决定取头 + 尾，是为了错误/日志结尾可读，不是因为 Claude Code 取尾。
- **本机实测**：114 个会话中仅 1 条结果 >64 KB（65.5 KB），最大 args 28 KB；正常使用几乎不受影响，病态大输出仍会被本决定收敛。850 KB 样本不在现存会话文件中，但 #138 的崩溃证据证明该路径存在。

## 否决了什么

- **只调截断阈值/只在渲染时 slice**：不减少留存；V8 还会把原串钉住，等于白截。
- **用 64 KB 作为 UI 阈值**：64 KB 对 UI 仍是“存了不显示”；按行数 + 行宽拍才是显示契约。
- **用官方 pruner 作为本问题的修复**：它是压缩期模型上下文服务，压缩前不管、原始结果仍留 session log、且会改变模型可见内容；与本 issue 的边界冲突。
- **把完整原文留在 UI 模型、另做 pager**：本轮不做；未来需要时读官方 session/log 或另立 spec。
- **同时处理 `args` / `resultMeta`**：实测 args 最大 28 KB 且受模型输出上限约束；diff 大文本需要单独的裁剪语义，另立 issue。

## 接受的代价

- 展开体从“头 40 行”变成“头 24 + 标记 + 尾 16”；中间被省略的内容不再出现在 UI，只能去 session/log 查。折叠失败摘要取自预览前 3 行，超长行会带行内截断标记。
- 每条有界不等于总量有界；长会话的条目数仍会增长，整段 transcript 的淘汰/分页另立 issue。
- 首次进 transcript 会扫描原文一次（计数与定位头尾），这是 O(N) 的一次成本；不得退化成每次重排都扫描。
- `NANO_TOOL_PREVIEW_LINES` 调大等于让 UI 多存，是调试旋钮，不是内存优化。
- 未来任何需要 TUI 全量工具输出的功能，都必须显式读官方 session/log 或另做 pager，不能假设 `ToolEntry.resultText` 是原文。

## 允许重开的条件

- 真实终端证据表明用户需要在 TUI 内查看超过预览范围的工具输出，且 session/log 路径不可接受。
- 官方 DSH 提供稳定的“显示预览/分页”API，可直接复用而不必自己维护投影。
- 长会话实测表明“每条有界”仍不足以控制总内存，需要 transcript 淘汰/分页。
- 新的工具结果类型（富文本、图片、结构化块）需要不同的留存策略。
- V8 字符串实现改变，`SlicedString` 不再保留父串，M2 的必要性消失。

## 关联

- [本次执行规格](../specs/2026-11-02-nano-tool-result-retention/README.md)
- [issue #140](https://github.com/nano-sun99/dsh-tui-nano/issues/140)
- [issue #138](https://github.com/nano-sun99/dsh-tui-nano/issues/138)（长会话 OOM 的上一轮止血）
- [ADR-20261028-nano-process-display](2026-10-28-nano-process-display.md)：过程行显示规则继续有效；本 ADR 只改变结果文本的留存，不改变其显示语义。
- 官方参考：`node_modules/@deepseek-ai/dsh-compaction-tool-result-pruner`（语义参考，不接入）；V8 `docs/objects/strings.md`；Claude Code `src/utils/shell/outputLimits.ts`。
