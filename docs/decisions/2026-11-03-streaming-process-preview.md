# ADR-20261103-streaming-process-preview：流式思考最多两行、运行中 Bash 显示最后五行

- 状态：生效中
- 日期：2026-11-03
- 决策人：用户
- 适用范围：transcript 中流式思考与前台 Bash 运行中 / 完成后的最后状态预览；不适用于完整思考回看、后台 job 输出、TUI 内全量输出 pager
- 取代：修订 [ADR-20261028-nano-process-display](2026-10-28-nano-process-display.md) 第 2 条（成功 Bash 默认 0 行结果）、第 3 条（流式思考只显示一行标题、提交后整行消失）与第 4 条（过程行固定显示「点击展开 / 点击收起」）
- 被取代：无
- 决策来源：用户 2026-11-03 原话「由于思考过程全部折叠，所以只看得到三个字思考中，完全没有harness该有的那种流式输出的感觉」「我说的是正文中被我们折叠的思考和bash 你看看claude code」「把等待结果和点击展开去掉，属于多余的东西没必要，看着还乱」「+15 行 完成这个我觉得也没必要，并且我期望就一直保持执行中的状态，不然执行完又撤回流流式的两行会闪烁」；Claude Code 2.1.88 `components/Messages.tsx:381-389`/`:714-717`、`components/messages/AssistantThinkingMessage.tsx`、`components/shell/ShellProgressMessage.tsx`、`tools/BashTool/UI.tsx:131-157`
- 相关：[spec](../../specs/2026-11-03-nano-harness-feel/README.md)

## 决定

1. **流式思考折叠态最多两行，完成后保留**：
   - 第 1 行保持 `∴ 思考中`（`muted`，缩进 `EDGE`）。
   - 第 2 行显示 `preview.reasoning` 最后一个非空行的尾部：压空白、按显示宽度从左侧截断、前缀 `…`；`faint`、缩进 `EDGE`、不换行。
   - 没有非空行时不加第 2 行；空思考不渲染。
   - 思考结束后**保留该 2 行块，不撤回**；标题从「进行中…」变为「思考」。完整思考正文不保留，点击展开只显示保留的最后 1–2 个非空行；不做全文回看（避免长会话内存增长）。
2. **前台 Bash 运行中 / 完成后显示最后 5 行输出**：
   - 用官方 `jobs` 服务的 `registered` / `output` / `settled` 事件；`output` 时用 `readAt` 按绝对偏移读取，不推进模型游标。
   - 去 ANSI、去空行、去 `\r`、单行截断；最多保留 5 行；不显示 `+N 行`。
   - **完成后保留最后 5 行，不撤回**；失败仍保留现有 3 行失败摘要，不显示 `liveOutput`。
   - 只处理前台 job；超时转后台后，工具结果到达即停止更新，后台 job 由任务面板负责。
3. **不新增轮询**：以 jobs 事件驱动，输出更新合并到 ≤120ms 一次；不新增加速动画、计时器或状态行字段。
4. **不改活动栏鲸尾**：`src/activity/*`、`ActivityLine`、`activityRows()`、`render/activity-image.ts` 与动画保持原样。
5. **过程行去掉重复文字提示**：不再显示 ` · 点击展开` / ` · 点击收起`、`+N 行`、`完成`；运行中的工具行不显示「等待结果」，运行状态由活动行（`正在运行…`）承担。整行点击仍可展开 / 收起；标记与缩进按 [ADR-20261103-nano-four-visual-categories](2026-11-03-nano-four-visual-categories.md)（`∴` / `⏺` / `⎿`），不再用 `▸` / `▾`。

## 依据

- Claude Code 的流式思考在正文里用 `AssistantThinkingMessage` 且 `isTranscriptMode={true}`，即**流式期间显示完整思考 Markdown**；结束后 `streamingThinking` 再保留 30 秒，然后折叠为 `∴ Thinking`（`components/Messages.tsx:381-389`、`:714-717`；`components/messages/AssistantThinkingMessage.tsx`）。
- Claude Code 的 Bash 运行中由 `ShellProgressMessage` 显示最后 5 行非空输出、`+N lines` / `~N lines`、耗时和字节；无输出时显示 `Running…` 与计时（`components/shell/ShellProgressMessage.tsx`、`tools/BashTool/UI.tsx:131-157`）。
- 用户明确要求「在折叠节省空间的前提下」有流式感，因此不照搬 Claude Code 的全量思考显示，改为最多两行的尾巴。
- 官方 dsh 的每个 Bash 调用在 `jobs` 可用的 profile 下都会注册 job，job 记录 `toolCall.callId`，并有 `output` 事件与 `readAt` 绝对偏移读取（`node_modules/@deepseek-ai/dsh-tool-bash/lib/index.js:385-410`；`node_modules/@deepseek-ai/dsh-jobs/lib/types/types.d.ts:238-261`；`lib/types/index.d.ts:94-105`）。nano 的会话控制器目前没有订阅这些事件（`src/conversation/controller.ts:219-255`、`:270-335`）。
- ADR-20261028 当前的流式思考规则是「默认只显示一行标题」（第 3 条）；用户 2026-11-03 明确要求改变，故本条修订该款。

## 否决了什么

- **照搬 Claude Code 的完整流式思考**：会占掉大量屏幕，与用户「折叠节省空间」的前提冲突。
- **只做活动行动画，不改正文**：用户点名要的是正文里被折叠的思考与 Bash，不是底部状态。
- **轮询 `jobs.readAt`**：官方已有 `output` 事件，轮询会多耗 CPU 且更容易抖。
- **完成后撤回运行输出**：用户明确要求保持执行中的最后状态，撤回会造成闪烁；保留最后 5 行。
- **保留过程行右侧的「点击展开 / 点击收起」文字**：用户明确说多余、看着乱；行首箭头 + 整行点击足够。
- **保留 `+N 行` / `完成` 文字**：用户明确说没必要；输出本身已经可见，行数不是必须信息。
- **后台 job 也做实时预览**：后台任务由任务面板负责，本次不扩大范围。

## 接受的代价

- 思考正文只保留最后 1–2 行，可能断章取义；完整思考不回看，想看全文只能在流式期间展开。
- Bash 只保留 5 行，完整输出需要去 session/log 或任务面板查；完成后保留 5 行会比原来的 0 行多占屏幕。
- 依赖官方 jobs 服务；服务不可用时 Bash 预览退化为静态命令行，不影响执行。
- 过程行去掉文字提示后，可发现性下降；设计稿保留行首 `▸` / `▾`，实际 TUI 依赖整行点击。若后续实测用户不知道可展开，再单独评估图标方案。
- 运行中的工具行不再显示「等待结果」，状态由活动行承担；活动行被其他内容占满时，用户需要看状态 mark 或展开详情。

## 允许重开的条件

- 用户要求完整思考回看（不是只保留尾巴），或要求完成后重新撤回输出。
- 官方 jobs 事件 / `readAt` API 变更，或 profile 不再注册前台 job。
- 真实长命令证据表明 5 行不够，需要更多行或可展开的实时输出。

## 关联

- [本次 spec](../../specs/2026-11-03-nano-harness-feel/README.md)
- [ADR-20261028-nano-process-display](2026-10-28-nano-process-display.md)：过程块默认一行；本次修订第 2、3、4 条
- [ADR-20261102-transcript-display-projection](2026-11-02-transcript-display-projection.md)：工具结果只保留显示投影；本次沿用
- Claude Code 2.1.88：`components/Messages.tsx`、`components/messages/AssistantThinkingMessage.tsx`、`components/shell/ShellProgressMessage.tsx`
- 官方 dsh：`dsh-tool-bash`、`dsh-jobs`
