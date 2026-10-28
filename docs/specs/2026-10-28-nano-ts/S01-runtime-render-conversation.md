# [2026-10-28-nano-ts/S01] α：运行时、渲染与对话

- 组标识：`2026-10-28-nano-ts`；角色与编号：子件 S01；目标是一个能在真实终端里启动、独占终端、完成真实对话与阅读决策的完整可验收成果。
- 总纲：[共享约定与依据](README.md)。上游依赖：官方公开导出；下游影响：S02、S03。
- 合入前提：phase-0 已通过（见总纲 §3.1 与 [spike-phase0.md](spike-phase0.md)）；α 验收通过。发布由 S03 承担。

## 1. 边界与文件 owner

拥有：`package.json`、`src/boot/`、`src/runtime/`、`src/render/`、`src/input/`、`src/theme/`、`src/conversation/`、`src/transcript/`、`src/decisions/`、`tests/unit/`、`docs/evidence/2026-10-28-nano-ts/alpha/`。

不碰：S02 的 `src/attachments`、`src/sessions`、`src/controls`、`src/skills`、`src/terminal`、`src/jobs`、`src/monitor`、`src/schedule`、`src/subagents`；S03 的 `packaging/`、`tests/e2e/`、`docs/release/`、README；官方存储与凭据。

`package.json` 由本份独占；S02/S03 的依赖变更与 npm manifest 清单经 S01 合入。

## 2. 运行时与组装

- **应用自持 profile**：放在数据根（`~/.dsh-tui-nano/profile`）；用 `loadProfileDirectory` 读取，不写 `$DSH_HOME/profiles`。
- **组装配方**（phase-0 实测）：
  1. `loadProfileDirectory` + `readProfilePatches`；
  2. 追加 `tool-ask-user`、`file-reference-local`、`terminal-controller` 三行；
  3. 追加 `session-persistence-jsonl.root`、`storage-json.root` 的 storage 根 patch；
  4. `createRuntimeResolution` → `boot()`，注入 `profileContext`、`cmdlineArgs`、`appExit`、`appReady`，挂 `PluginPackages`；
  5. `appReady.commit()`。
- **首帧**：pre-boot 先画最小骨架（标题/输入框轮廓）；核心就绪后接管并画正式首帧；首帧不等模型/会话列表。
- **终端所有权**：nano 独占 fd 0/1；raw mode、resize、备用屏、鼠标、光标均由 nano 管理；官方日志走文件或受控 stderr，运行期也要守护，不只启动期。
- **能力快照**：boot 之后逐项断言必需服务与工具（含 `ask_user_question`、`terminalController`、`fileReferences`、`approval`、`userQuestions`）；缺失即失败并点名。
- **HMR**：关闭（沿用 v1）；profile/settings 写入应用自持 profile。
- **会话挂载账本**：沿用 v1 S01 §2.1，pid 改为本进程 pid；同机双窗口争同一根会话时第二窗口被拒且保留草稿。
- **关停**：停输入 → 取消在飞请求/子代理 → 停监听 → 释放 PTY → 排空持久化 → 释放认领/租约 → 恢复终端（raw/光标/备用屏/鼠标/kitty/paste）→ 退出；10s 优雅 + 3s 强制，逐项报告；`uncaughtException`/`unhandledRejection` 同路径；SIGKILL 不承诺恢复，下次启动检测脏状态并提示 `reset`。
- **不做回退**：phase-0 已通过；若未来核心组装不可行，停止并重定方案，不切 `dsh --profile`（用户 2026-10-28 决定）。

## 3. 渲染与输入

### 3.1 渲染宿主

- 一帧 = 计算 → diff → 生成字节 → 单次写 fd 1；禁止边算边写；输出可重放。
- cell 二维缓冲；宽字符占两格；样式稀疏变更；**所有用户/工具/模型文本先做控制字符与 ESC/OSC 净化**，原始转义序列不得进入写往 fd 1 的字节。
- 双缓冲 + 最小 diff；整屏滚动用区域滚动序列；虚拟化含行高估算、overscan、挂载上限、滚动锚点与粘底；缓存有界（LRU）。
- 性能目标：1000 行 transcript 下滚动 p95 ≤ 33ms、流式追加 p95 ≤ 50ms、resize p95 ≤ 80ms；5000 行内存增长有界（记录曲线）；实测基线写入证据。

### 3.2 布局子集（写死）

固定高度、内容高度、按比例分配、最小/最大、水平/垂直堆叠、溢出裁剪、粘底滚动；Yoga 只用这一子集；不做浏览器级完整 flex。

### 3.3 输入

- 键盘：普通键、修饰键、多字节序列；kitty keyboard 只在已知支持时启用，不做阻塞探测；bracketed paste 批量输入。
- 鼠标：点击、滚轮、拖拽选择、分栏拖拽（仅 v1 design-contract 允许的槽位）；分片 SGR 可重组；拖选优先于点击。
- 复制：全屏 + 鼠标捕获下必须提供 OSC 52 / pbcopy 或释放鼠标模式；选区按 grapheme 边界，不切 ZWJ/宽字符。
- 焦点：单一焦点；覆盖层优先；Escape 逐层退出；无法识别输入限流可诊断。
- 键位单一源：`src/input/keymap.ts`；S02 注册功能键；S03 生成 README/`--help`。

### 3.4 主题与视觉

- 沿用 `ADR-20261022-independent-tui-theme`、`ADR-20261022-nano-theme-scope`、`ADR-20261026-spacing-token-architecture`；深/浅、60/100 列、间距 token、4ch/2ch、diff 8 行预算都要有验收；不新增第二套视觉体系。

## 4. 对话、阅读与决策

- **对话**：`requestId` 提交身份、本地回显与退休、`assistant/attempt`、queue/steer/stop/clear（停止保留队列；清空是复合动作）、断线/未知显示「未确认」；消息身份用官方 `seq`/`callId`/`toolCallId`。
- **流式**：预览不是历史；正式消息替换预览；允许丢中间帧，不允许丢字符；思考/过程沿用 `ADR-20261028-nano-process-display`（默认收起、点击展开、提交后整行消失）。
- **阅读**：Markdown 子集、代码高亮、工具卡、diff（坐标/行号/8 行预算/无坐标不填）、阅读锚点、滚轮/粘底；超长内容裁剪并标注完整位置。
- **决策**：审批只回四种官方结果；无有效回答即拒绝/取消；默认焦点在拒绝；无 `callId` 不猜命令；问卷走官方契约（每题 `{id,selected,custom?}`、blocking/timed、失败分类）；注册唯一 answerer；计划审阅与只读回看沿用 v1。
- **场景**：导出可交互 transcript、焦点、场景注册给 S02；不复制渲染器。

## 5. 验收

### 5.1 phase-0（已通过）

自建根 + 官方核心 505–826ms、87 服务、必需服务齐全、启动 stdout 0 写入、storage 根写入数据根、会话创建/flush 成功；证据见 [spike-phase0.md](spike-phase0.md)。

### 5.2 α

- 真实对话/流式/工具/差异/审批/问卷可用；单进程、无 `nano.*` 协议、无第二宿主。
- 1000 行滚动/流式/resize 达到 §3.1 的 p50/p95 目标；5000 行内存有界。
- CJK/emoji/ZWJ/组合字符、中文输入法组合态、粘贴、鼠标拖选与复制各有测试或人工记录。
- 主题/间距/深色/浅色/60/100 列按 §3.4 验收。
- 终端恢复：正常退出 + SIGINT/SIGTERM/SIGHUP；`uncaughtException`/`unhandledRejection`；强杀后下次启动提示 `reset`。
- 控制字符/ESC/OSC 注入不改变屏幕、光标、剪贴板和标题。

## 6. 本份机制与自定细节

- 机制：自建根 + boot 组装、应用自持 profile、pre-boot 首帧、reconciler/Yoga、cell 双缓冲/diff/单写入器、终端独占与运行时守护、storage 根 patch；见总纲 §9。
- 目录按总纲 §6；组件 API（`<Box>`/`<Text>`/`<Overlay>`）实施时冻结并写入 README 由 S03 承接。
- React/react-reconciler/Yoga/官方包版本实施时锁定；未知官方版本拒绝启动。
- 备用屏由本份决定并写入 README；图片协议不在本次范围。

## 7. 审核修订记录

- 2026-10-28 重审 8 份后按发现重写：组装 API、storage 根、v1 承接、终端运行时守护、转义净化、性能阈值、owner；完整清单位于 PR #84 评论。
