# ADR-20261103-nano-four-visual-categories：四类视觉语言（用户 / 思考与执行 / 代码变更 / 正文）

- 状态：生效中
- 日期：2026-11-03
- 决策人：用户
- 适用范围：transcript 中四类内容的标记、缩进、底色与 diff 框；不适用于输入区、状态行、问卷卡（它们保持现有设计）
- 取代：修订 [ADR-20261028-nano-process-display](2026-10-28-nano-process-display.md) 第 4 条的思考标记（`▸` / `▾` 改为 `∴`，过程行改为 `⏺` / `⎿`）
- 被取代：无
- 决策来源：用户 2026-11-03 原话「现在看起来非常的好了，现在请你再次调研一下 claude code 的视觉语言，我认为他的视觉大概分了四类 用户输出记录 思考和执行过程 代码变更 和 正文输出，他的排版非常的美观易于阅读」「设计定稿了」；Claude Code 2.1.88 源码 `components/messages/UserPromptMessage.tsx`、`HighlightedThinkingText.tsx`、`AssistantTextMessage.tsx`、`AssistantToolUseMessage.tsx`、`MessageResponse.tsx`、`CollapsedReadSearchContent.tsx`、`tools/BashTool/UI.tsx`、`components/FileEditToolDiff.tsx`、`constants/figures.ts`
- 相关：[spec](../../specs/2026-11-03-nano-harness-feel/README.md)、[设计稿](../../design/2026-10-17-dsh-tui-ux-research/preview/index.html)

## 决定

transcript 按四类内容使用固定标记与缩进，全仓一致：

1. **用户输出记录**：`❯`（`muted`）+ 整行底色 `userBg`；正文正常字重，不用 `>` / accent / 粗体。用户行是唯一带整行底色的内容块。
2. **思考**：`∴`（`muted` + italic）；标题与正文 2ch；流式尾巴 2ch；完成后保留；不用 `▸` / `▾` 作思考标记。
3. **执行过程**：`⏺` 标记（running `muted` / ok `success` / error `danger` / waiting `warning`）；工具名 2ch 加粗，参数 / 目标正常字重；结果走 `  ⎿  ` 分支，第一行 `⎿`，正文 5ch；不画实线框，不显示 `+N 行`、`完成`、`点击展开 / 点击收起`。
4. **代码变更**：`⏺ Update(path)` 头 + `  ⎿  Updated ...` 摘要 + 上下 `┄` 虚线 diff 框；行号 gutter、`+` / `-` 行色保持。代码变更是唯一使用虚线框的内容。
5. **正文输出**：`⏺`（`text`）+ Markdown 2ch；标题 bold；列表 `-` 与正文同左缘；段落间隔 1 行。
6. **节奏**：四类之间 1 行留白；内容缩进只用 2ch / 5ch 两档；除 diff 虚线框外不新增边框、底色块、圆角或阴影。

## 依据

- Claude Code 的 `UserPromptMessage` 用 `figures.pointer`（`❯`）+ `userMessageBackground` 整行底色，文本正常字重（`components/messages/UserPromptMessage.tsx`、`HighlightedThinkingText.tsx`）。
- `AssistantTextMessage` 用 `BLACK_CIRCLE`（`⏺`）+ Markdown 2ch；`MessageResponse` 用 `"  ⎿  "` 作为工具结果 / 进度的分支前缀（`components/messages/AssistantTextMessage.tsx`、`components/MessageResponse.tsx`、`constants/figures.ts`）。
- `AssistantToolUseMessage` 用 `ToolUseLoader` 的 `⏺` 状态色（running dim / success / error）+ 加粗工具名 + `(参数)`；`ToolUseLoader` 的 `⏺` 在解析中闪烁、成功转绿、失败转红（`components/ToolUseLoader.tsx`）。
- `AssistantThinkingMessage` 折叠态是 `∴ Thinking`（dim italic），正文 `paddingLeft=2`；没有 `⎿`（`components/messages/AssistantThinkingMessage.tsx`）。
- `FileEditToolDiff` 的 `DiffFrame` 用 `borderStyle="dashed"` 的上下边框包住 diff；`StructuredDiff` 用行号 gutter + `+`/`-` 行色（`components/FileEditToolDiff.tsx`、`components/StructuredDiff.tsx`）。
- 用户 2026-11-03 看过样稿后明确「设计定稿了」。

## 否决了什么

- **用户行继续用 `>` + accent 粗体**：Claude Code 的 `❯` + 底色更安静，用户记录不需要抢正文的强调色。
- **思考继续用 `▸` / `▾`**：箭头是展开控件，不是内容标记；思考用 `∴`，展开靠整行点击。
- **工具行用实线框 / 卡片**：Claude Code 的过程块是 `⏺` + `⎿` 的树形文本，不加框。
- **代码变更继续用实线框**：Claude Code 是上下虚线框，轻于实线卡片。
- **保留 `+N 行` / `完成` / `点击展开` 文字**：用户已明确这些是噪声。

## 接受的代价

- 新增主题 token `userBg`（dark `#23262d` / light `#e9e7e2`）与 `Row.background` 渲染能力；用户行与其他行的选择 / 复制边界要单独测试。
- `⏺` / `❯` / `∴` / `⎿` 的字形宽度依赖终端字体；窄终端或非 macOS 需要回退（`⏺` 在非 macOS 可用 `●`）。
- 整行底色会让用户消息在视觉上比助手正文更重；如果实测抢注意力，可降低 `userBg` 对比度，但不能去掉标记。
- 代码变更的虚线框在窄终端可能折行；只保留上下两条，不画左右边。

## 允许重开的条件

- 真实终端证据表明 `⏺` / `❯` / `∴` / `⎿` 在目标字体下宽度或辨识度不可接受。
- 用户要求恢复 `>` / `▸` / 实线框等旧标记。
- 用户行的整行底色影响文本选择 / 复制或对比度不达标。
- Claude Code 的新版本改变了四类内容的骨架（例如不再用 `⎿`）。

## 关联

- [本次 spec](../../specs/2026-11-03-nano-harness-feel/README.md)
- [ADR-20261028-nano-process-display](2026-10-28-nano-process-display.md)：过程块默认一行；本次修订第 4 条的标记
- [ADR-20261103-streaming-process-preview](2026-11-03-streaming-process-preview.md)：流式思考 / Bash 预览；本次提供四类标记
- [ADR-20261103-question-answer-visible-in-transcript](2026-11-03-question-answer-visible-in-transcript.md)：问卷记录沿用 `⏺` 工具行 + 决策行
- Claude Code 2.1.88：`UserPromptMessage.tsx`、`AssistantTextMessage.tsx`、`AssistantToolUseMessage.tsx`、`MessageResponse.tsx`、`FileEditToolDiff.tsx`、`ToolUseLoader.tsx`
