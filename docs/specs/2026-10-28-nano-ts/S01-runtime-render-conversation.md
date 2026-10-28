# [2026-10-28-nano-ts/S01] α：运行时、渲染与对话

- 组标识：`2026-10-28-nano-ts`；角色与编号：子件 S01；目标是一个能在真实终端里启动、独占终端、完成真实对话与阅读决策的完整可验收成果。
- 总纲：[共享约定与依据](README.md)。上游依赖：官方公开导出；下游影响：S02、S03。
- 合入前提：phase-0 已通过（核心 boot 三行实测，见 [spike-phase0.md](spike-phase0.md)）；α 验收通过。β 的 schedule/sessionController/terminal 由 S02 的 spike-0b 另验。发布由 S03 承担。

## 1. 边界与文件 owner

拥有：`package.json`、`src/boot/`、`src/runtime/`、`src/render/`、`src/input/`、`src/theme/`、`src/conversation/`、`src/transcript/`、`src/decisions/`、`tests/unit/`、`docs/evidence/2026-10-28-nano-ts/alpha/`。

不碰：S02 的 `src/attachments`、`src/sessions`、`src/controls`、`src/skills`、`src/terminal`、`src/jobs`、`src/monitor`、`src/schedule`、`src/subagents`；S03 的 `packaging/`、`tests/e2e/`、`docs/release/`、README；官方存储与凭据。

`package.json` 由本份独占；S02/S03 的依赖变更与 npm manifest 清单经 S01 合入。`src/input/keymap.ts` 由本份独占，S02 只经 D01 的注册 API 加功能键。

## 2. 运行时与组装

### 2.1 应用自持 profile

- 位置：数据根 `~/.dsh-tui-nano/profile`；不写 `$DSH_HOME/profiles`。
- 首次初始化：调官方 `initProfile(dir, ['@deepseek-ai/dsh-base'])`；它只写 `package.json`、`cordis.patch.yml`、`pnpm-workspace.yaml`，**不写 `cordis.yml`**，所以随后补写 `cordis.yml` = `[]`。
- 逐文件修复：`package.json` / `cordis.yml` / `cordis.patch.yml` 各自检查；缺失才补。空 YAML 会被 loader 判为非法（`cordis.patch.yml` 必须是顶层数组，`cordis.yml` 必须能被 include 解析），禁止写 0 字节。
- 损坏处置：JSON/YAML 解析失败 → 备份为 `*.corrupt-<时间戳>` → 报错退出，不静默覆盖用户 settings。
- `loadProfileDirectory` 不是纯只读：`dropRetiredBundles` 可能重写 `package.json`；bundle 解析失败收进 `skippedBundles` 而不抛。启动后必须检查 `skippedBundles`，非空即点名失败；`readProfileManifest` 的错误要接住。
- `readProfilePatches` 会合并 `$DSH_HOME/cordis.patch.yml` 与 overlays：沿用官方顺序，不自创；首启来源显示里列出实际生效的层，不复制凭据值。

### 2.2 根会话身份与认领

- 解析顺序：`--root <id>` → 数据根下 `last-root`（0600）→ 生成 `<UTC 时间戳>-<8 hex>`。
- 同一 ID 用于：`session-persistence-jsonl` 根、`storage-json` 根、schedule backend 根（β）、挂载认领、handoff、`sessions.create`。官方 `create` 返回的 ID 与预生成不一致 → 硬失败，不建替代会话。
- 挂载认领：`<数据根>/mount/<id>.lock` 写本进程 pid；在进备用屏前获取。同根第二窗口在此被拒：不建会话、不进备用屏、stderr 说明占用 pid，退出码非零。

### 2.3 启动顺序（硬性）

确保 profile → 解析根身份 → 获取挂载认领 → pre-boot 骨架（**进备用屏、接管 fd 0/1、raw mode**）→ fd 级 stdout/stderr 捕获 → `boot()` → 能力快照 → 挂 UI → 正式首帧 → 接受输入。

- 画骨架必须先占终端，不能等 boot；能力快照只能在 boot 后。
- 启动失败分两段：骨架前失败（profile/版本/认领）直接写 stderr 退出；骨架后失败（boot/快照）恢复终端、写 fd 2、非零退出。未知 harness 版本在骨架前拦截。

### 2.4 α 组装配方

1. 确保应用 profile（§2.1）。
2. `loadProfileDirectory` + `readProfilePatches`；检查 `skippedBundles`。
3. 追加 patch 行：`tool-ask-user`（默认 blocking；timed 的配置必须落在 active preset 的 config，不能放顶层 patch）、`file-reference-local` `{ maxResults: 20 }`。
4. 追加 storage patch：`session-persistence-jsonl.root = <数据根>/sessions`、`storage-json.root = <数据根>/runtime-data/<root>/storage`；`storage-domain` 沿用 base 的 `{ backend: 'json' }`；关 HMR。
5. `createRuntimeResolution` → `boot()`，注入 `profileContext`、`cmdlineArgs`、`appExit`、`appReady`，挂 `PluginPackages`；`appReady.commit()`。
6. β 才加 `@deepseek-ai/dsh-api-terminal-controller` 行、schedule 后端与最小 `sessionController` 适配器；α 不加载。

| row id | 包名 | config | 断言服务/工具 | 消费方 |
|---|---|---|---|---|
| tool-ask-user | `@deepseek-ai/dsh-tool-ask-user` | 默认 blocking；timed 落 active preset config | `ask_user_question` / `userQuestions` | S01 |
| file-reference-local | `@deepseek-ai/dsh-file-reference-local` | `maxResults: 20` | `fileReferences` | S02 |
| terminal-controller | `@deepseek-ai/dsh-api-terminal-controller` | 无 | `terminalController` | S02 |
| schedule | `@deepseek-ai/dsh-schedule` | `deliveryHistory*` 用默认 | `schedule` + `sessionController.resolveAgent` | S02 |
| storage-domain / storage-json | base 行 | `backend: json` + `root` patch | `storageDomain` | S02 |

禁止：
- 不加载官方 `@deepseek-ai/dsh-api-session-controller` row（它要求 12 个注入服务 + 必填 `nativeOpen`，base 缺 `fileUploads`/`workspaceRegistry`；同名服务自 provide 会被 Cordis 拒绝）。
- 不 `provide('storageDomain')`；该服务由 base 的官方 storage-domain 插件提供。
- 不保留 `dsh --profile` 回退。

### 2.5 终端、守护与关停

- 终端所有权：nano 独占 fd 0/1；raw mode、resize、备用屏、鼠标、光标均由 nano 管理；官方日志走文件或受控 sink。
- stdout/stderr 捕获必须是 **fd 级**：渲染器保留一份 dup 出来的 tty fd，把 fd 1/2 重定向到日志/管道；只包 `process.stdout.write` 抓不到原生模块直写。
- 能力快照（α）：`ask_user_question`、`fileReferences`、`approval`、`userQuestions`；β 追加 `terminalController`、`sessionController.resolveAgent`、`schedule`。缺失即启动失败并点名。
- 关停阶段：冻结输入 → 排空生产者（schedule/Monitor/PTY/取消根回合，由 S02 注册的 hooks 执行）→ 排空持久化 → 释放 schedule 租约 → 释放挂载认领 → 恢复终端（finally，预留固定预算）→ 退出。
- 预算：每阶段独立截止时间；总优雅上限 10s；「3s 强制」= 直接恢复终端并非零退出（单进程没有子进程 TERM/KILL 对象）；重复信号跳到恢复阶段。
- 报告：逐项 `stopped / failed / unknown`；清理失败保留认领并报告；`uncaughtException`/`unhandledRejection` 走同一路径；SIGKILL 不承诺恢复，下次启动检测脏状态并提示 `reset`。
- lifecycle hooks 契约（D01）：`registerLifecycleHook(phase, name, fn)` 返回 disposer；阶段固定为 `freeze / drain / flush / release / restore`；每 hook 有截止时间、错误隔离、幂等；关停开始后拒绝注册。S01 只调用阶段，不枚举 S02 资源。

## 3. 渲染与输入

### 3.1 渲染宿主

- 一帧 = 计算 → diff → 生成字节 → 单次写渲染器持有的 tty fd；禁止边算边写；输出可重放。
- cell 二维缓冲；宽字符占两格；样式稀疏变更；**所有用户/工具/模型文本先做控制字符与 ESC/OSC 净化**，原始转义序列不得进入写往终端的字节。
- 双缓冲 + 最小 diff；整屏滚动用区域滚动序列；虚拟化含行高估算、overscan、挂载上限、滚动锚点与粘底；缓存有界（LRU）。
- 性能目标：1000 行 transcript 下滚动 p95 ≤ 33ms、流式追加 p95 ≤ 50ms、resize p95 ≤ 80ms；5000 行内存增长有界（记录曲线）；实测基线写入证据。只承诺 p95，不写 p50。

### 3.2 布局子集（写死）

固定高度、内容高度、按比例分配、最小/最大、水平/垂直堆叠、溢出裁剪、粘底滚动；Yoga 只用这一子集；不做浏览器级完整 flex。

### 3.3 输入

- 键盘：普通键、修饰键、多字节序列；kitty keyboard 只在已知支持时启用，不做阻塞探测；bracketed paste 批量输入。
- 鼠标：点击、滚轮、拖拽选择、分栏拖拽（仅 v1 design-contract 允许的槽位）；分片 SGR 可重组；拖选优先于点击。
- 复制：全屏 + 鼠标捕获下必须提供 OSC 52 / pbcopy 或释放鼠标模式；选区按 grapheme 边界，不切 ZWJ/宽字符。
- 焦点：单一焦点；覆盖层优先；Escape 逐层退出；无法识别输入限流可诊断。
- 键位单一源：`src/input/keymap.ts`；S02 经 D01 注册功能键；S03 生成 README/`--help`。

### 3.4 主题与视觉

- 沿用 `ADR-20261022-independent-tui-theme`（已取代 `nano-theme-scope`）、`ADR-20261026-spacing-token-architecture`；深/浅、60/100 列、间距 token、4ch/2ch、diff 8 行预算都要有验收；不新增第二套视觉体系。

## 4. 对话、阅读与决策

- **对话**：`requestId` 提交身份、本地回显与退休、`assistant/attempt`、queue/steer/stop/clear（停止保留队列；清空是复合动作）、断线/未知显示「未确认」；消息身份用官方 `seq`/`callId`/`toolCallId`。
- **流式**：预览不是历史；正式消息替换预览；允许丢中间帧，不允许丢字符；思考/过程沿用 `ADR-20261028-nano-process-display`（默认收起、点击展开、提交后整行消失；连续 Read/Grep/Glob/List 合并；成功输出 0 行、失败 3 行）。
- **阅读**：Markdown 子集、代码高亮、工具卡、diff（坐标/行号/8 行预算/无坐标不填）、阅读锚点、滚轮/粘底；超长内容裁剪并标注完整位置。
- **决策**：审批只回四种官方结果；无有效回答即拒绝/取消；默认焦点在拒绝；无 `callId` 不猜命令；问卷走官方契约（每题 `{id,selected,custom?}`、blocking/timed、失败分类）；**审批与问卷是两个独立 seam，各自只注册一个 answerer，不能共用**；计划审阅与只读回看沿用 v1。
- **场景与 D01 契约**：导出可交互 transcript（含子代理地址）、场景/焦点注册、keymap 注册 API、有序输入段与附件段、草稿/光标/阅读锚点保存恢复、审批/问卷地址隔离、终端 cell 网格/VT、根会话身份、mount claim/release、lifecycle hooks（阶段/截止/隔离）、补全 provider 注册、补全打开输入模式、历史读写 API（项目过滤/100 条/子代理投影）、合成 transcript 条目（`bash-mode`、`role=user/source=monitor`）、boot 后服务/挂载扩展点、handoff 读写。S02 只消费，不复制渲染器。

## 5. 验收

### 5.1 phase-0（已通过）

自建根 + 官方核心 505–826ms、87 服务、必需服务齐全、启动 stdout 0 写入、storage 根写入数据根、会话创建/flush 成功；证据见 [spike-phase0.md](spike-phase0.md)。实测只覆盖 `tool-ask-user` / `file-reference-local` / `terminal-controller` 三行；`sessionController`、`schedule`、HMR 关闭未实测，属 S02 的 spike-0b 门槛。

### 5.2 α

- 干净机器（无数据根、无 profile）首次启动可用；profile 损坏/版本不支持有可见错误；升级保留 settings。
- 同根第二窗口在进备用屏前被拒，保留占用信息；不创建会话。
- 启动失败可见：骨架前写 stderr；骨架后恢复终端、写 stderr、非零退出。
- 首启显示配置/凭据/全局指令的**来源**（profile 路径、settings 路径、凭据来源、全局指令链），不复制任何凭据值（B8）。
- 真实对话/流式/工具/差异/审批/问卷可用；单进程、无 `nano.*` 协议、无第二宿主。
- 过程显示按 `ADR-20261028-nano-process-display` 验收：思考默认一行、点击展开、提交后消失；连续读取合并；成功工具 0 行、失败 3 行。
- 1000 行滚动/流式/resize 达到 §3.1 的 p95 目标；5000 行内存有界。
- CJK/emoji/ZWJ/组合字符、中文输入法组合态、粘贴、鼠标拖选与复制各有测试或人工记录。
- 主题/间距/深色/浅色/60/100 列按 §3.4 验收。
- 终端恢复：正常退出 + SIGINT/SIGTERM/SIGHUP；`uncaughtException`/`unhandledRejection`；强杀后下次启动提示 `reset`。
- 关停故障注入：活动回合、挂起 hook、flush 失败时仍能恢复终端并逐项报告；清理失败保留认领。
- 控制字符/ESC/OSC 注入不改变屏幕、光标、剪贴板和标题。

## 6. 本份机制与自定细节

- 机制：自建根 + boot 组装、应用自持 profile（`initProfile` + 逐文件修复）、根身份 + 认领先于备用屏、pre-boot 首帧、reconciler/Yoga、cell 双缓冲/diff/单写入器、fd 级守护、storage 根 patch、lifecycle hooks 阶段；见总纲 §9。
- 目录按总纲 §6；组件 API（`<Box>`/`<Text>`/`<Overlay>`）实施时冻结并写入 README 由 S03 承接。
- React/react-reconciler/Yoga/官方包版本实施时锁定；未知 harness 版本拒绝启动。
- 备用屏由本份决定并写入 README；图片协议不在本次范围。
- 进程显示、根身份格式、handoff 路径与格式、启动失败文案由本份自定，写进 D01 接口文件。

## 7. 审核修订记录

- 2026-10-28 重审 8 份后按发现重写：组装 API、storage 根、v1 承接、终端运行时守护、转义净化、性能阈值、owner；完整清单位于 PR #84 评论。
- 2026-10-28 轻审修订：补 profile 首次初始化/升级、启动顺序（先占终端再 boot）、能力快照后置、feature 行补齐（session-controller/schedule）、关停改 lifecycle hooks、D01 契约展开、theme ADR 去掉已取代项。
- 2026-10-28 二次轻审修订：`initProfile` 不写 `cordis.yml`、空 YAML 必失败、`loadProfileDirectory` 副作用与 `skippedBundles`、根身份与认领前移、不加载官方 session-controller、不 provide storageDomain、fd 级守护、hook 阶段与截止时间、启动失败两段处置、p95 口径、B8 来源验收、phase-0 覆盖范围澄清。
