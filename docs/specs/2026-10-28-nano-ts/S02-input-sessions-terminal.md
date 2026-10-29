# [2026-10-28-nano-ts/S02] β：输入、会话与功能面

- 组标识：`2026-10-28-nano-ts`；角色与编号：子件 S02；目标是把输入增强、会话控制、附件/技能、终端/任务/Monitor/调度/子代理全部接进同一界面。
- 总纲：[共享约定与依据](README.md)。上游依赖：S01（render/input/transcript/keymap/scene/D01）。下游影响：S03。
- 合入前提：S01 契约冻结且已合入；spike-0b 通过（`terminal-controller` 行、最小 `sessionController` 适配器、schedule 后端 + `storage-domain` 路由 + probe + 挂载顺序实测）；β 验收通过。发布由 S03 承担。

## 1. 边界与文件 owner

拥有：`src/attachments/`、`src/sessions/`（含 `session-controller-adapter.ts`）、`src/controls/`、`src/skills/`、`src/terminal/`、`src/jobs/`、`src/monitor/`、`src/schedule/`、`src/subagents/`、`tests/feature/`、`docs/evidence/2026-10-28-nano-ts/beta/`。

不碰：S01 的全部文件（`src/boot`、`src/runtime`、`src/render`、`src/input`、`src/theme`、`src/conversation`、`src/transcript`、`src/decisions`、`src/app`、`src/types`、`src/main.ts`、`src/bin.ts`、`tests/unit`、`docs/evidence/alpha`）、`package.json` 与根配置（`tsconfig.json`、`vitest.config.ts`、`biome.json`、`package-lock.json`）、S03 的打包/发布文件。依赖变更经 S01。功能键只经 D01 的 keymap 注册 API，不修改 `src/input`。

**接入点例外（2026-10-29 改旧 spec，用户拍板）**：α 交付了零件但没有交付接线——boot 前补丁行只能加在 `src/main.ts`，S02 模块没有初始化点，`App` 只吃固定 `AppSnapshot`。因此允许 S02 在以下三处 S01 文件里做**只加接线、不改既有行为**的改动；三处之外仍不碰：

1. **boot 前补丁**：`src/boot/assemble.ts` 的 `CoreBootOptions` 增加可选 `extraPatches`；`src/main.ts` 把 S02 的 `scheduleBootPatches(rootId)`（`src/schedule/boot-patches.ts`）传进去。α 的三条既有 patch（`tool-ask-user`/`file-reference-local`、storage 根、HMR）顺序与内容不变。
2. **boot 后初始化**：`src/app/nano-app.ts` 的 `NanoAppOptions` 增加可选 `features`（S02 的 `FeatureHost`：`start()` / `dispose()` / `dispatch(actionId, snapshot)` / `body(snapshot)`）；boot 后与关停时各调一次。未提供时行为与 α 完全一致。
3. **界面槽与动作分发**：`src/app/App.tsx` 与 `AppSnapshot` 增加可选 `featureBody`，`App` 在正文区渲染；`nano-app` 把 `resolveKey()` 解析出、S01 未消费的 action id 交给 `features.dispatch()`。未提供时行为与 α 完全一致。

接缝自身的约束：S01 既有单测在未装 `features` 时全绿；三处新增参数均为可选，不留 S02 专用分支条件在 S01 里。

## 2. 输入、会话与控制

- 输入内容为有序列表（文本段 + 附件段），预览/提交顺序一致；提交失败恢复原文与附件；单次提交上限 32 KiB（含附件引用，不含图片 base64），超限拒绝并保留草稿；多行编辑/撤销/历史沿用 v1 与 `ADR-20261022-input-history`。
- 历史：`history.jsonl` 由 D01 的历史 API 读写；项目过滤为先当前会话、再同项目，最多 100 条；子代理历史来自官方投影，不写文件。
- `@` 引用只在输入开头/空白后触发，路径相对 workspace root 在请求组装时解析；不读取文件内容。
- 补全（文件 / `/` 命令 / 技能）三类可区分；`Tab` 插入不执行；补全打开时 `Enter` 只接受选中项、不提交消息，补全关闭时 `Enter` 才提交，且只提交输入框里明确写下的内容；空结果与失败分开显示；补全源经 D01 的 provider 注册 API 接入。
- 命令面板只检索/转发；同名命令优先于技能；未知 `/name` 按官方 prose 通过并标「未注入」；不可用命令显示原因。
- 附件两条链：图片在提交时以 base64 data 进入 prompt，官方准入时校验/规范化/持久化（无预上传/回执/TTL）；通用文件走 `saveFileStream`，回执一次性、绑定会话、commit 未退休前不可复用；任何一张被拒整条消息失败；顺序可调整但只改本次列表。**不写死 20 MiB**：图片上限以官方准入为准（v1 S06 明确由部署配置决定），超限按官方错误显示；通用文件不设本地大小上限，受磁盘/内存约束即可。
- 会话列表/恢复/改名：列表来自官方 `sessions`/`sessionQuery`；恢复走 `resolveAgent`/`inspect`；新建 ID 用 S01 预生成的根身份，官方返回不一致即硬失败；writer-held 只来自 resume。
- **冷改名 = 受控重启的目标场景**：冻结输入 → 原子写 handoff → 停 schedule/Monitor/PTY → 取消在飞 → flush → 释放 claim → 新进程认领目标根 → resume 拿写锁 → rename → 留在该根。任一时刻只允许一个 live 根；失败矩阵：认领失败显示「被 pid X 占用」；boot 失败恢复终端并保留 handoff；handoff 损坏报错不猜；rename 失败停新进程、保留草稿/锚点、不建替代会话。不得在旧根 live 时先拿新根写锁。
- 上下文：占用 = `projectedTokens / contextWindow`，缺一显示未知；`tokenUsage` 是计费累计，不混用；`/compact` 仅空闲可用、取消后从官方记录重读历史。
- 模型/强度/权限：模型身份为 `provider + model`；强度只列官方 `efforts`；权限切换必须走官方 `/permission <preset>` 命令路径，禁止直接调 `permissionPresets.set()`；失败保留原值并显示原因（§5.2 用户变更），同时重读官方投影，提示「可能已部分生效，请重开 `/permission` 核对」；模型被用户改动时显示 changed-by-user；切 `never` 显示完整后果；选择成功以官方回执为准，不乐观更新。
- 技能/规矩：命令优先、`snapshot().complete=false` 标「可能不完整」、发现失败保留上次目录；预览只读；规矩按官方链顺序/去重/预算展示，不自建 watcher。

## 3. 终端、任务、Monitor、调度与子代理

### 3.1 终端

- 真实 PTY，经官方 `terminalController` 创建/附着/保留/释放/重命名/关闭；它底层用 `terminals`，UI 不直接碰底层服务。
- attach 前 `retain()`；快照 + 单调 sequence；序列缺口/超限/越界 resize 结束该附件并报错（不是丢弃单条继续）；未确认输入不回放；`inputFull` 取消附件；输出背压有界；终端输出不进 transcript/模型上下文；Agent 工具表与 Monitor 路径不得出现 terminal 方法；退出释放 PTY。

### 3.2 任务

- 官方 jobs 只读；`readAt` 绝对偏移非消费；ring 预算/settled 裁剪/gapBefore；停止只报「已请求停止/已结束」，`job/not-found` 与 `already-finished` 分开；不维护第二份任务表。

### 3.3 人工命令 `!`

- 单次 `ShellExecRequest` 传 `danger-full-access`，不改 mount/profile 默认；不注册官方 job；输出以 `bash-mode` 合成 user 注入但不构成授权；`!!` 为 `inject:false`，只本窗口显示；非零退出是结果不是基础设施错误。
- **注入语义沿用官方 inject**：不新建 turn、不立即唤醒；运行中的 Agent 在最近 step boundary 取走，空闲 Agent 等下一次 follow-up/steering；不是「下一条消息才能看到」。

### 3.4 Monitor

- 默认 `quiet`（§5.2 用户变更）。`quiet` = 官方 inject：不唤醒、不新建 turn，内容进入下一个被接受的步骤；**不是「只落 transcript」**。切 `notify` 必须明确告知会唤醒模型/计费。
- 计费口径：quiet 下注入内容会随下一次请求进入上下文并计费，只是不产生独立回合；验收写「不再自动唤醒/不产生独立回合」，不写「不再计费」。
- 初始偏移默认 `output.total`，可选从头；settled 时 `readAt` 补齐；单任务单监听；预算耗尽停止投递并保留监听状态；真实收件以 accepted step / durable user/message 为准，`inserted`/`claimed` 不算；通知显示 `role=user / source=monitor`；停止监听 ≠ 停止任务；切根停旧监听（受控重启前必须停）。

### 3.5 调度

- 后端：注册命名后端 `nano-schedule-json`（官方 `JsonStorageBackend`，root = `<数据根>/runtime-data/<root>/storage`），并用 `storageBackendServiceKey('nano-schedule-json')` `provide` 服务键——storage-domain 靠这个键激活。
- 路由：`storage-domain` 行 config 配 `{ backend: 'json', routes: { schedule: 'nano-schedule-json', nano_probe: 'nano-schedule-json' } }`；`storage-json` 行 root 指向同一目录。**不 `provide('storageDomain')`**，该服务由官方插件提供；routes 的值是后端名，不是路径。
- 探针：`nano_probe` 域写入 `<root>/nano_probe.json`；打开前清掉损坏残留并重试一次；探针失败点名路径。
- 挂载顺序：boot → 等 storage hub / `storageDomain` → 注册 `nano-schedule-json` 并 `provide` service key → 等 `storageDomain` 按路由激活 → 探针通过 → 经 D01 的 boot 后扩展点手动挂 `@deepseek-ai/dsh-schedule`（官方 `ScheduleService`）。schedule row 不写进 profile patch，避免探针前打开表。
- 结论矩阵（只有一种结论）：后端/路由/探针/适配器/服务任一缺失或失败 = **启动失败并点名**（β 把调度列为必需能力，不提供 `unsupported` 降级）。v1 的 `unsupported` 状态在 v2 取消；若未来要降级，另开 ADR。
- 一个根会话一个 scheduler；租约被活 pid 持有显示「调度由 pid X 持有」；无暂停/恢复，停止即删除；投递非严格一次、只补最近一次；创建/修改用 CAS/`schedule_conflict`；两根本会话表互不可见。

### 3.6 子代理

- 目录/活动/时间来自官方；one-shot 只读、external 不可导航、unknown 确认 mode 后恢复输入；continuable ≠ 可输入，只有 exact parent live 才保留输入；子代理审批官方钉死 `never`，不渲染可放行审批卡；续聊走 `subagents/prompt` queue/steer，Stop 走 `interruptByParent`（排队保留、后代继续），`dispose` 不冒充 UI 取消；fork seed 是例外必须显示；结束原因原样；子地址订阅按地址过滤；dock 按 `ADR-20261022-subagent-dock-lifecycle`（行内容、30 秒清理、无标题、状态词、external 不进 dock 全部照 ADR；**不增加成本字段**）。

## 4. 跨份共同约束

- 文件隔离：本份不修改 S01 文件与 `package.json`；键位只经 D01 注册。
- 证据：每项真实官方服务验证，含负向安全用例；证据写 `docs/evidence/2026-10-28-nano-ts/beta/`。
- 跨根会话：transcript/草稿/队列/附件/审批/问卷/终端/Monitor/调度逐面隔离；双窗口同根拒绝、双 root 并发、调度表隔离。
- 性能/长会话：沿用 S01 的 p95 指标；终端/Monitor 输出背压有界。
- 成本：不新增第二个计费模型；子代理/Monitor 的成本以官方投影为准，不常驻 dock。

## 5. 验收

- 输入：多行/IME 组合态 Enter 不发送、`@` 语法、三类补全、补全打开时 Enter 只接受选中项、命令同名优先、未知 `/name`、`history.jsonl`（项目过滤/100 条/子代理投影）、32 KiB 超限拒绝并保留草稿、提交失败恢复原文与附件。
- 附件：官方图片准入上限（超限/多图一张超限/模型不支持图片）、通用文件 >20MiB 仍可提交、子代理通用文件、回执复用拒绝。
- 会话：列表/恢复/not-found/损坏/writer-held/新建 ID 不一致、压缩取消重读、上下文三投影分开；冷改名走受控重启、任一时刻只有一个 live 根、claim/boot/handoff/rename 四种失败路径各有用例。
- 权限：走官方 `/permission <preset>` 路径；失败保留原值 + 重读投影 + 警告；`never` 后果可见；模型 changed-by-user 可见。
- 模型/强度：身份为 `provider + model`；强度只列官方 `efforts`；选择成功以官方回执为准，不乐观更新。
- 技能/规矩：命令同名优先；`snapshot().complete=false` 标「可能不完整」；发现失败保留上次目录；预览只读。
- 终端：创建/附着/输入/缩放/关闭；序列缺口/`inputFull`/背压；输出不进 transcript；Agent 工具表无 terminal。
- 任务：游标不推进、停止分类、裁剪/缺口。
- `!`：工作区外写文件可用；Agent 同路径仍审批；输出不进 job 表、不构成授权；运行中在 step boundary 入模、空闲等下一次 follow-up/steering；`!!` inject:false。
- Monitor：`quiet` 不唤醒/不产生独立回合、注入内容随下一次请求计费、`notify` 真实收件与计费提示、初始偏移、settled 补齐、预算耗尽、切根停止、按 dock/ADR 的收件口径。
- 调度：`nano-schedule-json` 后端 + service key、routes/probe、探针后挂载、失败即启动失败、per-root 表隔离、租约持有显示、无暂停、非严格一次、CAS 冲突。
- 子代理：one-shot/external/exact-parent-live/审批 never/interruptByParent/fork seed/内容隔离/dock ADR（含 30 秒清理、无标题、状态词、external 不进 dock）。
- 会话控制器：nano 自提供的最小 `sessionController` 只暴露 `resolveAgent`（schedule 用），不加载官方 row；`resolveAgent` 返回 `{agent}`/`{error}` 两种形状；能力快照断言该方法存在；不存在同名服务重复注册。
- 跨根：九个面逐面隔离；双窗口同根拒绝；双 root 并发。
- 键位：经 D01 注册表汇总并可被 S03 生成 README/`--help`。
- 接入点：未装 `features` 时 α 既有单测全绿且界面与 α 一致；装 `features` 后 `terminal-controller` 行与 `storage-domain` 路由在 boot 前生效、S02 键位经 keymap 派发、S02 正文区可见。

## 6. 本份机制与自定细节

- 机制：消费 S01 契约（D01：有序输入段、地址隔离、草稿/锚点、cell 网格、lifecycle hooks、补全/历史/合成条目/boot 扩展/handoff）；官方服务是唯一事实源；最小 `sessionController` 适配器；schedule 命名后端 + service key + routes/probe + boot 后挂载；单进程切根 = 受控重启 + handoff；附件两条链；终端官方 controller；Monitor 预算/收件；子代理地址过滤。
- 最小 `sessionController`：只因 base 不含官方 session-controller row（它要 12 个服务 + `nativeOpen`），而 schedule 需要 `ctx.sessionController.resolveAgent(sessionId)`。适配器只实现该方法，`{agent}`/`{error}` 与官方一致；其余会话操作走官方 `sessions`/`agents`，不再造第二套会话服务。v1 已在 `bridge/runtime/host.mjs` 的 `provideSessionController` 用过同一 stub，v2 沿用。
- handoff：仅用于受控切根；原子写（tmp + fsync + rename）、0600、版本号、读后删除；普通关窗不恢复草稿（`ADR-20261022-input-history` 的显式例外，合并前补 ADR 修订）；不写 `history.jsonl`。
- 附件暂存/补全排序/Monitor 默认预算/调度租约阈值沿用 v1（30s、0600、`runtime/attachment-staging`、官方目录顺序）；v1 的 48 KiB `nano.attachment.chunk` 是协议分片上限，v2 无协议，不沿用。
- 接入点：S01 提供三处可选接缝（boot 前 `extraPatches`、boot 后 `features.start/dispose`、界面 `featureBody` 与未消费 action 分发）；S02 的全部界面与功能经这三处挂上，不另建入口。
- 键位：S01 持有 `src/input/keymap.ts`；本份只注册功能键；S03 只生成文档。
- 不新增 Agent 工具、第二份任务表、第二份队列、自建 Cron。
- bridge 吸收范围见总纲 §8.2：controls/sessions/skills/attachments/jobs/monitor/schedule/subagents/shell/terminal 由本份吸收并验收，S03 只删除。

## 7. 审核修订记录

- 2026-10-28 重审 8 份后按发现重写：调度隔离/启动顺序、D01 契约、`!` 安全、附件两条链、终端/任务/子代理语义、跨根隔离、验收负向；三处用户变更见总纲 §5.2；完整清单在 PR #84 评论。
- 2026-10-28 轻审修订：补 sessionController 适配器与 schedule 后端 provide/routes/lease、单进程切根改受控重启 + handoff、`!` 不唤醒、补全 Enter 语义、`/permission`、Monitor quiet 计费核实、子代理成本可见、bridge 吸收范围、32 KiB 上限。
- 2026-10-28 二次轻审修订：官方 session-controller 不可直接挂载、改为最小适配器；storage-domain 不重复 provide、routes 用后端名；schedule 探针后挂载与单一失败结论；`!` 恢复 step boundary 语义；Monitor quiet 恢复 inject 语义；删除子代理成本字段；删除 20 MiB 硬编码；冷改名补失败矩阵；补 D01 补全/历史/合成条目；删除 48 KiB 协议残留。
- 2026-10-29 实施发现修订（用户选择「改旧 spec 开三道缝」）：α 只交付零件未交付接线，S02 无法在不改 S01 的前提下上线界面。§1 增加接入点例外（`extraPatches`、`nano-app` 的 `features`、`App` 的 `featureBody` 与动作分发），§5 增加接入点验收项。spike-0b 已实测通过（`terminal-controller` 行可检出、命名后端 + routes + 探针落盘、最小适配器让官方 schedule 挂起并落 `schedule.json`）。
