# D01 契约（S01 → S02）· α 冻结

> 本文件是 S01 交付给 S02 的接口清单（总纲 §7 D01）。α 已冻结以下导出；S02 只消费，不复制渲染器。

## 1. 渲染（`src/render/`）

| 导出 | 位置 | 说明 |
|---|---|---|
| `<Box>` / `<Text>` / `<Overlay>` | `src/render/components.ts` | 组件 API；`Box` 支持 flex 子集、padding/margin、`overflow="hidden"`、`onPress`；`Text` 支持颜色/粗斜体/下划线/删除线/反显/`wrap`；`Overlay` 占满屏幕、最后绘制 |
| `Renderer` | `src/render/renderer.ts` | `mount/update/unmount/resize/flushFrame/requestPaint`；单写入器；双缓冲 diff；`hitRegions`、`selection`、`extractText`、`pressIdAt`、`snapshotLines` |
| `<Grid>` / `CellGrid` | `src/render/grid.ts`、`components.ts` | 终端 cell 网格 + VT 解析（SGR/光标/擦除/滚动/滚动区/备用屏忽略）；S02 的 PTY 面板直接喂字节并用 `<Grid>` 绘制 |
| `encodeDiff` / `sgr` / `CONTROL` / `osc52` | `src/render/ansi.ts` | 字节编码、终端控制序列；所有内容先经 `sanitizeText` |
| cell 网格 / 文本度量 | `src/render/text.ts` | grapheme、显示宽度、换行、截断、控制字符净化 |

渲染约束：一帧 = 计算 → diff → 单次写 tty fd；宽字符原子绘制；支持 20/40/60/80/100 列。

## 2. 输入（`src/input/`）

| 导出 | 位置 | 说明 |
|---|---|---|
| `InputParser` / `InputEvent` | `src/input/parser.ts` | 键、修饰键、kitty CSI-u、SGR 鼠标（含滚轮/拖拽）、bracketed paste、focus；跨 chunk 重组；ESC 30ms 定时 flush |
| `registerKeybinding` / `Scope` / `describeBindings` | `src/input/keymap.ts` | 键位单一源；S02 用 `registerKeybinding({ id, keys, scopes, description, owner:'s02' })` 注册功能键；S03 从 `describeBindings()` 生成文档 |
| `FocusStack` | `src/input/focus.ts` | 单焦点层栈；覆盖层优先 |
| `SceneRegistry` | `src/app/scenes.ts` | 场景/焦点注册（`main`/`pane`/`overlay`）；Escape 逐层关闭 |
| `InputSegments` / `INPUT_BYTE_LIMIT` | `src/input/segments.ts` | 有序文本段 + 附件段（`pushText`/`pushAttachment`/`move`/`remove`/`orderedText`/`byteSize`）；32 KiB 上限判定 |
| `CompletionRegistry` / `CompletionSession` | `src/input/completion.ts` | 三类 provider（`file`/`command`/`skill`）注册与查询；补全打开模式（Enter 只接受、不提交），失败逐条上报 |
| `DraftStore` | `src/input/drafts.ts` | 按 `{root, subagent}` 地址保存草稿/光标/阅读锚点；仅内存，不跨进程 |
| `HistoryStore` | `src/input/history.ts` | `<dataRoot>/history.jsonl`，0600；项目过滤、当前会话优先、最多 100 条（ADR-20261022-input-history） |

## 3. 对话 / 阅读（`src/conversation/`、`src/transcript/`）

| 导出 | 说明 |
|---|---|
| `ConversationController` | `start()` 建/恢复根 agent（sessionId = 根身份）；`submit/steer/stop/clear`；`model` 可订阅；`selectionInfo` |
| `TranscriptModel` | `appendUser`、`confirmUser`、`appendAssistant`、`appendTool`、`completeTool`、`appendNotice`、`setPreview`、`clearPreview`、`units()`、`layout()`；条目可选 `address`，`units({address})` 按子代理地址过滤；合成条目：`appendNotice(..., address)` 可承载 `bash-mode`、`role=user/source=monitor` 等展示文案 |
| `renderMarkdown` / `highlightCode` | Markdown 子集、Prism 高亮 |
| `renderDiffs` / `diffsFromMeta` | 工具结果的 `meta.diffs`（`{path, oldText, newText}`）；3 行上下文、8 行预算、无坐标不填行号 |
| 过程显示规则 | `TranscriptModel.units()` 内实现 ADR-20261028：连续读取合并、成功 0 行/失败 3 行、流式思考一行、提交后消失 |

## 4. 生命周期与根（`src/runtime/`、`src/boot/`）

| 导出 | 说明 |
|---|---|
| `Lifecycle.register(...)` / `registerLifecycleHook(lifecycle, phase, name, fn, deadlineMs)` | 阶段固定 `freeze / drain / flush / release / restore`；截止时间、错误隔离、幂等；关停开始后拒绝注册（S02 注册 drain：schedule/Monitor/PTY/取消根回合）；`onResult` 回调让应用看到超时 |
| `writeHandoff` / `takeHandoff` / `HANDOFF_VERSION` | `<dataRoot>/handoff.json`；tmp+fsync+rename、0600、版本化、读后删 |
| `resolveRootId` / `acquireMountClaim` / `releaseMountClaim` | 根身份 `--root → last-root → <UTC>-<8hex>`；`<dataRoot>/mount/<id>.lock` 先于备用屏 |
| `prepareCore` / `startCore` / `snapshotCapabilities` | 两段装配；能力快照（α：`ask_user_question`、`fileReferences`、`approval`、`userQuestions`） |

## 5. 决策（`src/decisions/`）

| 导出 | 说明 |
|---|---|
| `DecisionManager.register(ctx)` | 各注册一个 answerer：`approval/request` 与 `user-questions/request`，互不共用 |
| 审批 | 四结果 `allowed-once / rejected / cancelled / unavailable`；默认焦点「拒绝」；Esc = cancelled；abort signal → cancelled |
| 问卷 | 单/多选、`custom`、跳过项 `{id,selected:[]}`、`plan-review` intent 原样展示并由 UI 回答 |

## 6. 终端与守护（`src/runtime/`）

- `Terminal`：`/dev/tty` 独立 fd、raw mode、备用屏、鼠标/粘贴/focus 开关、`SIGWINCH`、`copyToClipboard`（OSC 52 + pbcopy）。
- fd 级守护：`src/runtime/fd-guard.ts` 在启动时 re-exec 一次，把 fd 1/2 绑到 `<dataRoot>/logs/*.log`；运行时的唯一终端写入是 `/dev/tty`。偏差说明：Node 无 `dup2`，等价实现为「stdio 重定向 + 独立 tty 句柄」。
- 根切换 handoff、关停顺序、信号处理均在 `src/app/nano-app.ts`；S02 只注册 hook。

## 7. S02 使用注意

- **boot 后扩展点**：`startCore(prepared)` 返回的 `core.ctx` 即官方 Cordis 根；S02 在 boot 后按服务名 `ctx.get(...)` 注册 schedule 后端/适配器（D02 契约），不需要改 S01。
- **子代理地址**：`TranscriptModel` 的条目可带 `address`；S02 为每个子代理地址建视图时传 `units({address})`/`layout({address})` 过滤。子代理输入历史来自官方投影，本契约不读 `history.jsonl`。
- **timed question**：`DecisionManager` 立即返回答案；α 不消费 `request.wait.timed` / `attachWait`。S02 若接 timed 面板，需在 `askQuestions` 之前处理 `wait`（官方契约见 `dsh-user-questions`），不改 S01 的两个 answerer 槽位语义。
- **补全打开模式**：`CompletionSession.isOpen` 为真时，Enter 必须先 `accept()` 而不是提交；会话关闭后再走 `conversation.submit`。
- **有序输入段**：`InputSegments` 与提交文本一致；提交前用 `exceedsLimit()` 检查 32 KiB，本份已接入 submit/steer 的文本路径，附件段由 S02 追加。

## 8. 自定细节（spec 要求写进本文件）

- 根身份格式：`<UTC 时间戳 YYYYMMDD-HHMMSS>-<8 hex>`，仅 `[A-Za-z0-9._-]`。
- 启动失败文案：骨架前写 `/dev/tty` + stderr（如「nano: 根 "x" 已被进程 123 占用…」）；骨架后「nano: 启动失败：…」。
- 备用屏：`ESC[?1049h`；关停恢复顺序：关 mouse/paste/focus → 显示光标 → 离备用屏。
- 进程显示细节：组行右侧固定「点击展开 / 点击收起」；思考行用 `▸`/`▾`，无文字提示。
