# [2026-11-03-nano-harness-feel] 版本、提问纪律、决策留痕、流式过程与 Esc 打断

- 组标识：`2026-11-03-nano-harness-feel`
- 角色：单份 spec，总纲与执行规格合一
- 状态：草案（设计已定稿、结构不拆；待审核）
- Issue：待开
- 结构：**不拆**（用户 2026-11-03 点选）：1 份 spec + 1 张执行 issue；7 个目标、4 个机制、4 条 ADR 同批交付。
- 机制范围：M1–M4（见 §4）
- 上游：
  - Claude Code 2.1.88 源码（本机归档 `/Users/sunchongsheng/Downloads/归档/06-软件与安装包/ClaudeCode/src`）：
    `constants/prompts.ts:870-900`（Bias toward action）、`utils/messages.ts:3280-3295`（问卷只用于澄清 / 选方案，不用于计划批准）、`components/Messages.tsx:381-389`/`:714-717`（流式思考可见）、`components/messages/AssistantThinkingMessage.tsx`（折叠态）、`components/messages/UserPromptMessage.tsx`（`❯` + userMessageBackground）、`components/messages/AssistantTextMessage.tsx`（`⏺` + Markdown 2ch）、`components/messages/AssistantToolUseMessage.tsx` + `components/MessageResponse.tsx`（`⏺ Tool(args)` + `  ⎿  ` 分支）、`components/FileEditToolDiff.tsx`（虚线 diff 框）、`components/shell/ShellProgressMessage.tsx`（Bash 运行中最后 5 行）、`tools/BashTool/UI.tsx:131-157`、`tools/AskUserQuestionTool/AskUserQuestionTool.tsx:83-97`（`· 问题 → 答案`）、`keybindings/defaultBindings.ts:66`（`escape: 'chat:cancel'`）。
  - 官方文档：[Interactive mode](https://code.claude.com/docs/en/interactive-mode)（Esc 中断、保留已完成工作、队列消息随后发送）、[Handle approvals and user input](https://code.claude.com/docs/en/agent-sdk/user-input)（AskUserQuestion 的触发场景与 Other 输入）。
  - 官方 `@deepseek-ai/dsh` 0.2.1-rc.2：`dsh-tool-ask-user`（工具描述、`wait.callId`、结果 JSON）、`dsh-tool-bash`（每次调用注册 job）、`dsh-jobs`（`output` 事件与 `readAt`）。
- ADR 检索：按「问卷 / question / 思考 / thinking / Bash / 工具结果 / transcript / 版本 / keymap」检索 `docs/decisions/`。
  - 命中并沿用：[ADR-20261028-nano-process-display](../../decisions/2026-10-28-nano-process-display.md)（过程块默认一行；本次修订第 2/3/4 条：Bash 0 行、思考完成消失、过程行提示与标记）、[ADR-20261101-question-card-cancel](../../decisions/2026-11-01-question-card-cancel.md)（问卷卡 Esc 取消整次提问；本次不改）、[ADR-20261101-approval-decision-visible-in-transcript](../../decisions/2026-11-01-approval-decision-visible-in-transcript.md)（决策行挂 `ToolEntry` 的模式；本次问卷答案沿用该模式）、[ADR-20261102-transcript-display-projection](../../decisions/2026-11-02-transcript-display-projection.md)（工具结果只保留显示投影；本次问卷 JSON 不进 `resultText`）、[ADR-20261030-notice-lifecycle](../../decisions/2026-10-30-notice-lifecycle.md)（启动通知仍走正文持久 notice）、[ADR-20261026-spacing-token-architecture](../../decisions/2026-10-26-spacing-token-architecture.md)（不新增间距 token）。
- ADR：新增 4 条，随本 spec 同一文档 PR：
  - [ADR-20261103-question-trigger-discipline](../../decisions/2026-11-03-question-trigger-discipline.md)
  - [ADR-20261103-streaming-process-preview](../../decisions/2026-11-03-streaming-process-preview.md)（修订 ADR-20261028 第 2、3、4 条）
  - [ADR-20261103-question-answer-visible-in-transcript](../../decisions/2026-11-03-question-answer-visible-in-transcript.md)
  - [ADR-20261103-nano-four-visual-categories](../../decisions/2026-11-03-nano-four-visual-categories.md)（四类视觉标记；修订 ADR-20261028 第 4 条标记）
- 替代关系：局部修订 [2026-10-28-nano-process-display](../../specs/2026-10-28-nano-process-display/README.md) §3.1/§3.2（过程行右侧的「等待结果」「点击展开 / 点击收起」「+N 行」「完成」文字移除；整行点击保留）与 §3.4（流式思考从「只显示一行」改为「最多两行」，且**完成后保留**；只保留最后 1–2 行尾巴；标记从 `▸` / `▾` 改为 `∴`），以及 §3.3 的「成功 Bash 0 行结果」（改为运行中 / 完成后保留最后 5 行；过程行标记改为 `⏺` / `⎿`）；局部修订 [2026-11-01-nano-question-card-parity](../../specs/2026-11-01-nano-question-card-parity/README.md) §3.2/§3.6 的「未聚焦 Other 仍显示 `直接输入`」一条（改为未聚焦且空值时只显示 `N+1. 其他`）。其余条款沿用，不回写冻结正文。
- 下游：无硬依赖。若后续要做后台 job 的实时输出、问卷并发队列或 TUI 内全量 Bash 输出，需另立 spec。
- 合入前提：单测 + feature 渲染断言全绿；typecheck / lint / build / `keymap:docs -- --check` 退出 0；60 / 100 列真实终端证据；文档检查：本仓无 docs 检查脚本（无入口）。

## 1. 目标与边界

把 nano 从「能用的终端壳」往「有 harness 手感」推一档。七件事：

1. **版本可见**：左下角状态行常驻 `v<version> · <cwd>`；顶栏和启动通知不加版本；`nano --version` 不变。
2. **提问纪律**：抄 Claude Code 的「Bias toward action」——能自己判就先做；只有答案会改变做法且代码判不出来时才开问卷卡；不用于确认、计划批准和琐碎实现细节。
3. **决策留痕**：问卷答完后，正文保留 `· 问题 → 答案`；跳过、取消、多选、自定义答案都要能看见，重开会话也能还原。
4. **流式过程**：折叠态思考从静态一行改为**最多两行**（标题 + 最新思考尾句），随流更新，**完成后保留**；Bash 运行中 / 完成后显示**最后 5 行输出**；过程行去掉「等待结果」「点击展开 / 点击收起」「+N 行」「完成」文字。
5. **Other 占位**：未聚焦且空值的「其他」行不再显示 `直接输入`，避免看起来像输入框却敲不进字；聚焦后仍显示占位 + 光标，输入即替换。
6. **Esc 打断**：运行中按 Esc 停止当前回合（保留队列），提示改为 `Esc 停止`；问卷卡 / 补全 / 面板仍优先消费 Esc。
7. **四类视觉**：用户记录 `❯` + 底色、思考 `∴`、执行过程 `⏺` + `⎿`、代码变更 `⏺ Update` + 虚线框、正文 `⏺` + 2ch；见 §3.9。

### 非目标

- **不改模型可见结果**：官方 `tool/result`、session log、模型上下文不动；本次只改 UI 显示与一条系统提示段。
- **不承诺模型 100% 不再主动提问**：提示词是软约束；不新增「每回合限一次」硬闸，不改官方 `ask_user_question` 工具描述。
- **不改问卷卡键位**：仍要求先 ↓ 到「其他」才能输入；不做 type-to-custom。
- **不做后台 job 的实时输出**：只做前台 Bash 运行中的预览；超时转后台后由任务面板负责。
- **不做 TUI 内全量 Bash 输出 pager**：运行中 / 完成后只保留最后 5 行；完整输出仍在官方 session/log。
- **不做双 Esc 回退 / rewind**：本次只加单次 Esc 停止。
- **不改审批卡、计划审阅卡、活动栏鲸尾、间距 token、`maxScroll` 算法**；主题只新增 `userBg` 一个 token，不改现有 token 语义。
- **不新增问卷并发队列 / 跨地址路由**：沿用官方串行 `ask()`。

## 2. 现状与证据

调查基线：`origin/main` @ `9c9a80b`；官方 `@deepseek-ai/dsh` 0.2.1-rc.2。

| 事实 | 证据 |
|---|---|
| 顶栏只渲染 `nano`、模型、状态，没有版本；`StatusLine` 左侧只显示 cwd / notice | `src/app/App.tsx:334-347`、`:194-230` |
| 版本只在 `--version` 输出；版本号来自已安装包 `package.json` | `src/main.ts:50-52`、`:338-344` |
| 启动通知只列 profile / settings / 层 / 凭据 / 全局指令 | `src/main.ts:190`、`:267-289` |
| nano 只注册 `nano:delegation-responsiveness` 一条自有提示段；没有提问纪律 | `src/conversation/controller.ts:39-41`、`:135-140` |
| 官方 `ask_user_question` 的工具描述鼓励「missing information, preferences, or decisions」 | `node_modules/@deepseek-ai/dsh-tool-ask-user/lib/index.js:19` |
| Claude Code 的主提示有「Bias toward action」：按最佳判断做，别为确认而问 | 归档 `constants/prompts.ts:884-896` |
| Claude Code 在 plan mode 明确「AskUserQuestion 只用于澄清需求 / 选方案，不用于计划批准」 | 归档 `utils/messages.ts:3290` |
| 问卷答案结果是 JSON 文本（`{"answers":[...]}`），不是空结果 | `node_modules/@deepseek-ai/dsh-tool-ask-user/lib/index.js:175-178`、`:52-58` |
| 问卷请求带 `wait.callId`，能对上工具行 | 同上 `:195-205`；`node_modules/@deepseek-ai/dsh-user-questions/lib/types/types.d.ts:112-124` |
| 折叠工具行只渲染标题；`decisionRows` 只处理审批决策 | `src/transcript/model.ts:381-457`、`:588-595` |
| 工具行右侧固定渲染 ` · 点击展开` / ` · 点击收起` 后缀 | `src/transcript/model.ts:389` |
| 用户行是 `› ` 粗体、无整行底色；助手正文无 `⏺`；工具行无 `⏺` / `⎿`；思考标记是 `▸` | `src/transcript/model.ts:327-370`、`:381-457`、`:485-506` |
| 流式思考折叠态只有一行静态 `▸ 思考中`；展开才渲染 Markdown | `src/transcript/model.ts:134`、`:485-506` |
| Claude Code 流式思考在正文里带 `isTranscriptMode=true` 全量显示，结束后 30 秒内仍可见 | 归档 `components/Messages.tsx:381-389`、`:714-717`；`components/messages/AssistantThinkingMessage.tsx` |
| Claude Code Bash 运行中显示最后 5 行、`+N lines`、耗时与字节 | 归档 `components/shell/ShellProgressMessage.tsx`；`tools/BashTool/UI.tsx:131-157` |
| dsh 每次 Bash 调用注册 job，job 带 `toolCall.callId` | `node_modules/@deepseek-ai/dsh-tool-bash/lib/index.js:385-410` |
| dsh jobs 有 `output` 事件和 `readAt`（绝对偏移、不推进模型游标） | `node_modules/@deepseek-ai/dsh-jobs/lib/types/types.d.ts:238-261`；`lib/types/index.d.ts:94-105` |
| nano 的会话控制器目前只订阅 session / stream / status / error，不处理 job 事件 | `src/conversation/controller.ts:219-255`、`:270-335` |
| 空 Other 未聚焦时仍渲染 `N+1. 其他：直接输入` | `src/app/question-card.ts:161-173`；`tests/feature/question-render.test.ts:131` |
| 只有 `customMode`（焦点在 Other）才收文本；未聚焦时按键被吞 | `src/app/nano-app.ts:553-566`；`src/decisions/manager.ts:434-436` |
| `conversation.cancel` 只绑 Ctrl+C；Esc 只清选区 | `src/input/keymap.ts:94-100`；`src/app/nano-app.ts:454-457` |
| 运行中提示是 `Enter 插话 · Ctrl+C 停止` | `src/app/App.tsx:192`；`tests/unit/conversation-delivery.test.ts:222` |

## 3. 需求规格

### 3.1 版本展示

- 左下角状态行（`StatusLine` 左侧槽）显示 `v<version> · <cwd>`；版本来自已安装包 `package.json`，由 `main.ts` 传入；cwd 沿用 `displayCwd` 的 `~` 折叠与截断。示例：`v0.2.1 · ~/code/dsh-tui-nano`。
- 有瞬态 notice 时，左槽显示 `v<version> · <notice>`；版本始终保留，notice / cwd 用剩余宽度截断。顶栏不显示版本。
- 启动通知不追加版本行；`nano --version` 输出格式不变。
- 版本缺失（读不到 package.json）时：左槽只显示 cwd，不显示 `v`；不显示 `v0.0.0` 之类的假版本。
- 60 列：`v0.2.1 · <cwd>` + 右侧提示必须完整显示；`StatusLine` 的 `leftBudget` 先扣版本前缀与分隔符，再给 cwd / notice。
- 顶栏保持 `nano` + 模型 + 运行/空闲状态，不加版本。

### 3.2 提问纪律（M1）

- 在 `ConversationController` 的 `setup()` 里注册新的系统提示段：
  - `name: 'nano:question-discipline'`
  - `order: 10145`（在现有 `nano:delegation-responsiveness` 的 10150 之前）
  - `interpolate: false`
  - 文本（英文，与 Claude Code 同义；模型侧提示不随 UI 语言切换）：

    ```text
    # Bias toward action
    Act on your best judgment rather than asking for confirmation.
    - Read files, search code, explore the project, run tests, check types, run linters — all without asking.
    - If you're unsure between two reasonable approaches, pick one and go. You can always course-correct.
    - Use ask_user_question only when the answer changes what gets built and cannot be derived from the code, config, or defaults.
    - Do not use ask_user_question for confirmations ("Should I proceed?"), plan approval, or trivial implementation details. If you already asked, don't ask again.
    - Prefer stating a recommendation and proceeding over asking.
    - If you do not understand why the user denied a tool call, use ask_user_question to ask them.
    ```

- 不修改官方 `ask_user_question` 的工具描述，不新增频率硬闸、不自动代答、不隐藏卡片。
- 该段与 `nano:delegation-responsiveness` 一起随 agent 作用域注册、随会话 dispose；不写全局、不影响子代理（子代理沿用各自作用域的提示）。
- 验收以「提示段已注册且文本一致」为准；模型是否少问是观察项，不进本单硬验收（见 §6）。

### 3.3 问卷决策记录（M4）

- `ToolEntry` 新增：
  - `questionAnswers?: readonly QuestionAnswerLine[]`，`QuestionAnswerLine = { question: string; answer: string; skipped: boolean }`
  - `questionOutcome?: 'answered' | 'skipped' | 'cancelled' | 'pending'`
- 投影时机：`TranscriptModel.completeTool()` 里，若 `entry.name === 'ask_user_question'`：
  1. **在应用 `previewToolResult` 之前**解析原始 `resultText`（答案 JSON 可能因长自定义答案超过单行 500 码元上限；先截断再解析会失败）。解析失败才退回现有预览路径。
  2. 从 `entry.args` 解析 `questions`（id、question、header、options、multiSelect）。
  3. 从原始结果 JSON 解析 `answers` 数组，按 id 映射到问题。
  4. 每个答案的显示值：`selected.join('、')`；有 `custom` 时追加 `、<custom>`（若 selected 为空则只显示 custom）；两者都空 → `（已跳过）`；没有对应答案项 → `（未回答）`。
  5. `questionOutcome`：有答案且至少一题非空 → `answered`；全部空 → `skipped`；结果 JSON 标记 `pending` → `pending`；工具错误且文本匹配 `aborted before the user answered` / `ASK_ABORTED` → `cancelled`。
  6. 成功解析后，`resultText` 置空（原始 JSON 不留在 UI 模型，符合 ADR-20261102）；`cancelled` 也置空并跳过 `failureRows`，避免红色错误摘要；解析失败时保留现有 `previewToolResult` 行为，不抛错。
- 渲染（`toolUnit`，单条工具行）：
  - 标题：`⏺ 问卷`（特判 `toolTitle`，不再显示 `ask_user_question`）；`⏺` 按工具状态着色（成功 `success`；取消按现有错误色或 `muted`，决策行始终 `muted`）。
  - 标题后缀：`answered` 且题数 > 1 → ` · 已回答 N 题`；`skipped` → ` · 已跳过`；`pending` → ` · 等待你的选择`；`cancelled` → ` · 已取消，未提交答案`。
  - 正文行（`muted`、缩进 `INDENT`、单行截断）：每题一行 `· <question> → <answer>`；`cancelled` 只显示一行 `· 已取消，未提交答案`；`pending` 不显示逐题行。
  - 折叠态与展开态都显示这些行；展开态不再显示原始 JSON。
  - 解析失败 / 旧会话无记录时，退回现有工具行（标题 + 预览），不显示半截记录。
- 重开 / 回放：`replay()` 走 `completeTool`，同一投影从 session log 的 args + result 重建；无需新的持久化字段。
- 取消：`Esc` 取消整次提问后，工具结果是 `ASK_ABORTED` 错误；记录为 `cancelled`，不显示 `✗` 红色失败摘要（决策行用 `muted`；标题仍按现有错误 mark，但错误摘要不展开）。若实际渲染需要避免红色，允许把 `ask_user_question` 的取消 mark 固定为 `·`（实现细节，spec 不强制）。

### 3.4 流式思考尾巴（M2）

- `previewUnit` 在 `preview.reasoning !== ''` 且未展开时：
  - 第 1 行：`∴ 思考中`（`muted`、缩进 `EDGE`）。
  - 第 2 行：取 `preview.reasoning` 最后一个非空行，去掉行首尾空白、把连续空白压成一个空格；按显示宽度从**左侧**截断（保留尾部），前缀 `…`；`faint`、缩进 `EDGE`、`wrap={false}`。没有非空行时不加第 2 行。
  - 最多 2 行；不换行、不新增行数。
- 展开态：沿用现有 `renderMarkdown(preview.reasoning, ...)` 全文；不显示尾巴行。
- 思考结束后：**保留该 2 行块，不撤回**。标题从「进行中… · 3s」变为「思考」；最后一句尾巴保留。完整思考正文不保留，点击展开只显示保留的最后 1–2 个非空行（避免长会话内存增长）；不做全文回看。
- 实现：`assistant/message` 到达时，把 `preview.reasoning` 的最后 1–2 个非空行写入新的 `ThinkingEntry`，随 transcript 滚动 / 回放；`preview` 清除后由该 entry 接管渲染。`replay()` 的 reasoning block 也按同一规则只取尾巴。
- 更新频率：随 `preview.revision` 更新，沿用现有渲染调度；不做额外动画/计时器。
- 标记：统一用 `∴`（`muted` + italic）；`THINKING_MARK` 从 `▸` / `▾` 改为 `∴`；展开 / 收起靠整行点击，不再用箭头。
- 60 列下第 2 行必须不折行；空思考不渲染。

### 3.5 运行中 Bash 输出（M3）

- `ToolEntry` 新增：
  - `liveOutput?: readonly string[]`（最多 5 行，已去 ANSI、去空行、单行截断）
  - `liveJobId?: string`（仅用于清理/对账，不渲染）
- 订阅：`ConversationController.attach()` 里，若 `ctx.get('jobs')` 可用：
  - `jobs.events.subscribe({ owner: this.rootId }, listener)`；`disposer` 进现有 `disposers`。
  - `registered`：若 `job.toolCall?.callId` 对应一个 `bash` 工具条目，记 `callId → jobId`，初始化 offset=0。
  - `output`：若 job 已映射，`jobs.readAt(jobId, offset, this.rootId)`；把新 chunks 拼起来、`stripAnsi`、按 `\n` 切行、去空行、去 `\r`；保留最后 5 行写进 `entry.liveOutput`，递增 `entry.rev`；`offset = read.next`。更新合并到 ≤120ms 一次（`setTimeout`/`setImmediate` 合并；同一窗口内多次 output 只渲染一次）。
  - `settled`：保留 `entry.liveOutput`（最后 5 行不撤回），只清 `liveJobId` 与映射；随后正常的 `tool/result` 完成条目，不清空 `liveOutput`。
  - 若 `registered` 早于 `tool/call`（理论上不会），先记映射，等 `tool/call` 建立条目后再套用；不静默丢。
  - 若 `readAt` 抛错（job 已被移除 / 权限），清空映射并停止该 job 的预览，不向用户报错。
- 渲染（`toolUnit`，单条 `bash` 条目、`status === 'running' | 'ok'`）：
  - 标题行：`⏺ Bash(<command>)`；`⏺` 按状态着色（running `muted` / ok `success` / error `danger` / waiting `warning`），`Bash` 加粗，`(<command>)` 正常；不显示 `+N 行`，不显示「完成」。
  - 标题下方用 `  ⎿  ` 分支承载 `liveOutput`：第一行 `⎿`，正文 5ch；最多 5 行，`faint`、`wrap={false}`、单行截断；展开时隐藏（展开体显示完整结果）。
  - 完成后保留最后 5 行，不撤回；失败仍走现有 `failureRows` 3 行，不显示 `liveOutput`。
  - 预览只对前台 job；超时转后台后，`tool/result` 到达即停止更新，后台 job 由任务面板负责。
- ANSI：在 `src/render/ansi.ts` 新增 `stripAnsi(text)`，覆盖 CSI、OSC、单字符 ESC 序列；不引入新依赖。
- 行宽：单行截断，不换行；避免运行中输出把 transcript 顶出屏幕。
- 滚动：沿用现有 `stickBottom` / `compensateScroll`；不新增滚动逻辑。

### 3.6 Other 占位（第 5 条）

- 只改渲染，不改键位：
  - `!focused && custom === ''` → `N+1. 其他`（不显示冒号后的 `直接输入`）。
  - `!focused && custom !== ''` → `N+1. 其他：<custom>`（无光标）。
  - `focused && custom === ''` → `N+1. 其他：直接输入▏`（保留现有占位 + 光标）。
  - `focused && custom !== ''` → `N+1. 其他：<custom>▏`。
- 仍然只有 ↓ / ↑ 到 Other 行才收文本；未聚焦时按键继续被吞（用户已确认「保持先 ↓ 到 Other」）。
- 不新增提示文案、不改 footer、不改数字直选 / 空格多选 / Tab 切题。

### 3.7 Esc 打断（第 6 条）

- `src/input/keymap.ts` 的 `conversation.cancel` 增加 `{ name: 'escape' }`；`scopes: ['running']` 不变；描述改为「停止当前回合（保留队列）」。
- 优先级沿用现有顺序：
  1. `decisions.hasDecision` → `handleDecisionKey`（问卷卡 / 审批卡消费 Esc，行为不变）。
  2. `features.handleKey`（补全、面板、导航）先消费。
  3. keymap → `conversation.cancel` → `conversation.stop()` + notice「已发送停止请求（队列保留）」。
  4. 空闲时 Esc 仍落到 `nano-app.ts` 的选区清理分支。
- `RUNNING_HINT` 改为 `Enter 插话 · Esc 停止`；`Ctrl+C` 保留为同一 action 的别名，不改退出/清输入语义。
- 重新生成 README / README.en.md 的键位区块（`node scripts/keymap-docs.mjs --write`）。
- 不加双 Esc、不加 rewind、不加「Esc 二次确认」。

### 3.8 过程行提示收敛

- 工具行不再渲染 ` · 点击展开` / ` · 点击收起` 文字后缀（`src/transcript/model.ts:389`），也不再显示 `+N 行` 与 `完成` 文字；整行点击保持不变。
- 工具行用 `⏺` 标记，按状态着色（running `muted` / ok `success` / error `danger` / waiting `warning`）；`Read` 组行与 `Bash` 行下方用 `  ⎿  ` 分支显示提示 / 输出。不再用 `▸` / `▾` 作为过程行标记。
- 运行中的工具行不显示「等待结果」之类重复状态；运行状态由活动行（`正在运行…`）表达，工具行只留标题、状态 mark 和输出。
- `Read` 组行折叠态显示一行 `  ⎿  ` 提示（最后读取目标）；展开后隐藏该提示，展开体显示每次调用。
- 完成后保留最后状态：思考 2 行块与 Bash 最后 5 行不撤回；避免运行 → 完成时整块消失造成的闪烁。
- 失败摘要与 diff 折叠提示（`src/transcript/diff.ts:159`）不在本次范围。

### 3.9 四类视觉语言（对齐 Claude Code 2.1.88）

| 类别 | 标记 | 布局 |
|---|---|---|
| 用户输出记录 | `❯`（`muted`） | 整行底色 `userBg`；文本正常字重，不用 accent / 粗体 |
| 思考 | `∴`（`muted` + italic） | 标题与正文 2ch；完成后保留；尾巴 2ch |
| 执行过程 | `⏺`（running `muted` / ok `success` / error `danger` / waiting `warning`） | 工具名 2ch 加粗；结果走 `  ⎿  ` 分支（第一行 `⎿`，正文 5ch）；不显示 `+N` / `完成` / `点击展开` |
| 代码变更 | `⏺ Update(path)`（`success`） | `  ⎿  ` 摘要 5ch；diff 上下 `┄` 虚线框；行号 gutter + `+` / `-` 行色 |
| 正文输出 | `⏺`（`text`） | Markdown 2ch；标题 bold；列表 `-`；段落 1 行间隔 |

- **标记常量**：`USER_MARK = '❯'`、`ASSISTANT_MARK = '⏺'`、`THINKING_MARK = '∴'`、`BRANCH_MARK = '  ⎿  '`。全部是文本字符，不新增图标库；`⏺` 在非 macOS 可回退 `●`（nano 当前只支持 macOS arm64，先固定 `⏺`）。
- **用户行底色**：新增主题 token `userBg`（dark `#23262d` / light `#e9e7e2`）；`Row` 增加可选 `background?: 'userBg'`，`RowView` 用它铺满整行。不改变现有 theme token 语义。
- **用户行**：`❯` 在 `muted`；文本正常字重；不出现 `>`、不加粗、不用 accent。整行底色是唯一的内容块底色。
- **助手正文**：第一行与 `⏺` 同排（`⏺ ` + 第一行 Markdown）；后续行 2ch；列表 `-` 与正文同左缘，不额外缩进；若首行是空行或块级元素，`⏺` 单独占一行，正文从下一行 2ch 开始。
- **思考**：`∴` 在 `muted` + italic；标题 / 正文 / 尾巴统一 2ch；不再用 `▸` / `▾`，展开 / 收起靠整行点击。
- **过程**：`⏺` 的状态色只改标记，不改工具名 / 参数；结果分支 `  ⎿  ` 的 `⎿` 在 2ch，正文 5ch；分支只承载结果 / 提示，不画框。
- **代码变更**：头部 `⏺ Update(path)` + `+N -M`；下一行 `  ⎿  ` 摘要；diff 内容用上下 `┄` 虚线框，左右不封口；行号 gutter、`+` / `-` 行色沿用。
- **不新增**：除用户行底色与 diff 虚线框外，不加边框、圆角、阴影、图标或第二层底色；四类之间 1 行留白。
- 设计稿 `docs/design/2026-10-17-dsh-tui-ux-research/preview/` 已按此表更新；实现以设计稿为准。决策记录见 [ADR-20261103-nano-four-visual-categories](../../decisions/2026-11-03-nano-four-visual-categories.md)。

## 4. 机制清单

| 机制 | 解决什么 | 没有会怎样 |
|---|---|---|
| M1 提问纪律提示段 | 模型一调用就弹问卷卡，打断执行；nano 目前只有官方工具描述在鼓励提问 | 卡片继续在不必要的时候抢输入区；#2 不解决 |
| M2 折叠思考实时尾巴 | 折叠态只有静态「思考中」，思考期间正文像卡死；完成后整块消失会闪烁 | 没有流式感；#4 的思考半边不解决 |
| M3 运行中 / 完成后 Bash 输出 | Bash 运行中只有命令行，长命令只能干等；完成后撤回输出会闪烁 | 用户看不到进度，不知道命令是否在跑；#4 的 Bash 半边不解决 |
| M4 问卷决策记录投影 | 答案只进 tool result JSON，折叠行只剩工具名，选完就丢 | 回看会话不知道当时选了什么；#3 不解决 |

非机制的小改：版本展示（§3.1）、Other 占位（§3.6）、Esc 打断（§3.7）。

## 5. 改动面

| 文件 | 改动 |
|---|---|
| `src/main.ts` | 把 `nanoVersion()` 传给 `NanoApp`；启动通知不追加版本行 |
| `src/app/nano-app.ts` | `NanoAppOptions` / `AppSnapshot` 增加 `version`；快照透传；不改键位路由 |
| `src/app/App.tsx` | `StatusLine` 左侧渲染 `v<version> · <cwd/notice>`；`RUNNING_HINT` 改 `Enter 插话 · Esc 停止`；`RowView` 支持 `Row.background` 整行底色 |
| `src/app/question-card.ts` | Other 行未聚焦且空值时去掉 `直接输入` |
| `src/input/keymap.ts` | `conversation.cancel` 增加 Escape |
| `src/theme/theme.ts` | 新增 `userBg` 主题 token（dark `#23262d` / light `#e9e7e2`）；不改变其他 token |
| `src/transcript/spans.ts` | `Row` 增加可选 `background?: 'userBg'` |
| `src/conversation/controller.ts` | 注册 `nano:question-discipline`；订阅 jobs 的 `registered` / `output` / `settled`；维护 Bash live 状态 |
| `src/transcript/model.ts` | `ToolEntry` 增加 `questionAnswers` / `questionOutcome` / `liveOutput` / `liveJobId`；`completeTool` 投影问卷 JSON；`previewUnit` 加思考尾巴；`toolUnit` 加 live 输出与问卷记录；`toolTitle` 特判 `ask_user_question`；移除 ` · 点击展开/点击收起` 后缀；四类视觉标记（`❯` / `⏺` / `∴` / `⎿`）与用户行底色；`THINKING_MARK` 改 `∴` |
| `src/transcript/diff.ts` | diff 上下虚线框与 `⏺ Update(path)` 头；不改行色与行号 |
| `src/transcript/question-answers.ts`（新） | 问卷 args + result JSON → `QuestionAnswerLine[]` 的纯函数 |
| `src/render/ansi.ts` | 新增 `stripAnsi` |
| `README.md` / `README.en.md` | 键位区块重新生成（Esc 停止） |
| `docs/decisions/2026-11-03-*.md` | 4 条新 ADR；ADR-20261028 修订记录补标记变更 |
| `tests/unit/*` | 版本、问卷投影、思考尾巴、Bash live、Esc 路由、Other 占位、四类标记 / 底色 |
| `tests/feature/*` | 问卷渲染、终端 60/100 列与四类视觉证据 |

## 6. 验收

- [ ] 左下角状态行在 60 / 100 列显示 `v<package version> · <cwd>`；顶栏不含版本；启动通知不含版本行；`nano --version` 不变。
- [ ] 过程行不再显示 ` · 点击展开` / ` · 点击收起`、`+N 行`、`完成` 文字；运行中的工具行不显示「等待结果」；整行点击仍可展开 / 收起。
- [ ] 四类视觉标记：用户行 `❯` + `userBg` 整行底色；助手正文 `⏺` + 2ch；思考 `∴`；工具行 `⏺` 状态色变化（running → ok / error / waiting）+ `  ⎿  ` 分支 5ch；diff `⏺ Update(path)` + `  ⎿  ` 摘要 + 上下虚线框。
- [ ] 60 / 100 列下四类标记、2ch / 5ch 缩进、用户底色与 diff 虚线框不溢出、不折行。
- [ ] `nano:question-discipline` 提示段已注册，文本与 §3.2 一致；官方 `ask_user_question` 工具描述未改。
- [ ] 问卷单选 / 多选 / 自定义 / 跳过 / 取消 / pending 都能在正文产生对应记录；重开会话后仍可见；非法 JSON 退回现有工具行且不抛错。
- [ ] 流式思考折叠态最多 2 行，第 2 行随 revision 更新、左截断、不折行；思考期间展开显示全文，完成后展开只显示保留的最后 1–2 行；**完成后保留该 2 行块，不撤回**。
- [ ] 前台 Bash 运行中最多 5 行输出，ANSI 已剥离；**`settled` 后保留最后 5 行，不撤回**；成功完成后仍显示这 5 行。
- [ ] Other 行未聚焦且空值只显示 `N+1. 其他`；聚焦空值显示 `直接输入▏`；输入后占位消失；光标只在聚焦时出现。
- [ ] 运行中 Esc 停止当前回合、保留队列；问卷卡 / 补全 / 面板打开时 Esc 仍优先关闭它们；空闲 Esc 仍清选区；提示为 `Enter 插话 · Esc 停止`。
- [ ] 现有测试全绿；typecheck、lint、build、`keymap:docs -- --check` 退出 0；新增测试覆盖 §3.1–§3.7 的正常 / 边界 / 回归路径。
- [ ] 60 / 100 列真实终端证据（版本、思考尾巴、Bash live、问卷记录、Esc 提示）。

观察项（不进本单验收）：模型实际少问的比例、真实终端下 Bash 输出的观感。上线后有问题按 bug 单处理。

## 7. 自定细节

- 左下角格式 `v<version> · <cwd>`（有 notice 时 `v<version> · <notice>`）；版本取已安装包 `package.json`；顶栏不加版本，启动通知不加版本行。
- 过程行去掉 ` · 点击展开/点击收起`、`+N 行`、`完成` 文字；运行状态交给活动行；整行点击保留。
- 四类标记固定：`❯` / `⏺` / `∴` / `⎿`；内容缩进 2ch / 5ch；用户行底色 `userBg`（dark `#23262d` / light `#e9e7e2`）；diff 上下 `┄` 虚线框；不新增其他边框 / 圆角 / 阴影。
- 思考尾巴 1 行（总计 2 行）；左截断保留尾部；`faint`；`wrap={false}`；不做打字机动画；完成后保留该块，完整正文不保留，展开只显示最后 1–2 个非空行。
- Bash live 5 行；`faint`；不显示 `+N 行`；120ms 合并；只处理前台 job；完成后保留最后 5 行；ANSI 剥离用本地 `stripAnsi`。
- 问卷标题固定 `问卷`；答案行 `· <question> → <answer>`；多选 / 自定义用 `、` 连接；缩进 `INDENT`；原始 JSON 不留在 `resultText`。
- 取消记录的 mark / 颜色按现有工具状态实现；决策行始终 `muted`，不新增主题 token。
- 提示段 order 10145；文本用英文（与 Claude Code 源码同义），不随 UI 语言切换。
- Esc 提示只保留 `Esc 停止`；Ctrl+C 仍是别名，不写进运行提示，README 键位表保留两者。
- ADR：新增 4 条；ADR-20261028 只在「修订记录」补标记变更，不改其正文决定。

## 8. 审核修订记录

| # | 严重度 | 发现 | 处置 |
|---|---|---|---|
| — | — | 待审核 | — |
