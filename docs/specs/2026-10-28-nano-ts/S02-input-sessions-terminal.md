# [2026-10-28-nano-ts/S02] β：输入、会话与功能面

- 组标识：`2026-10-28-nano-ts`；角色与编号：子件 S02；目标是把输入增强、会话控制、附件/技能、终端/任务/Monitor/调度/子代理全部接进同一界面。
- 总纲：[共享约定与依据](README.md)。上游依赖：S01（render/input/transcript/keymap/scene）。下游影响：S03。
- 合入前提：S01 契约冻结且已合入；β 验收通过。发布由 S03 承担。

## 1. 边界与文件 owner

拥有：`src/attachments/`、`src/sessions/`、`src/controls/`、`src/skills/`、`src/terminal/`、`src/jobs/`、`src/monitor/`、`src/schedule/`、`src/subagents/`、`tests/feature/`、`docs/evidence/2026-10-28-nano-ts/beta/`。

不碰：`src/render/`、`src/input/`、`src/theme/`、`src/conversation/`、`src/transcript/`、`src/decisions/`、`package.json`、S03 的打包/发布文件。依赖变更经 S01。

## 2. 输入、会话与控制

- 输入内容为有序列表（文本段 + 附件段），预览/提交顺序一致；提交失败恢复原文与附件；单次提交上限 32 KiB（含附件引用，不含图片 base64），超限拒绝并保留草稿；多行编辑/撤销/历史（`history.jsonl`，根跨会话、子代理会话内）沿用 v1 与 `ADR-20261022-input-history`。
- `@` 引用只在输入开头/空白后触发，路径相对 workspace root 在请求组装时解析；不读取文件内容。
- 补全（文件 / `/` 命令 / 技能）三类可区分；`Tab` 插入不执行；补全打开时 `Enter` 只接受选中项、不提交消息，补全关闭时 `Enter` 才提交，且只提交输入框里明确写下的内容；空结果与失败分开显示；键位在 `src/input/keymap.ts` 注册，本份不自造第二份。
- 命令面板只检索/转发；同名命令优先于技能；未知 `/name` 按官方 prose 通过并标「未注入」；不可用命令显示原因。
- 附件两条链：图片在提交时以 base64 data 进入 prompt，官方准入时校验/规范化/持久化（无预上传/回执/TTL）；通用文件走 `saveFileStream`，回执一次性、绑定会话、commit 未退休前不可复用；任何一张被拒整条消息失败；顺序可调整但只改本次列表。
- 会话列表/恢复/改名：列表来自官方查询；恢复走 `resolveAgent`/`inspect`；新建 ID 不一致即硬失败；writer-held 只来自 resume；冷会话改名允许先取写权限（§5.2 用户变更），但必须显示会 resume/拿写锁/产生 live Agent，并保持单主会话状态。
- **单进程切根**：不做在线 storage 路由替换。切根采用**受控进程重启**：保存 handoff（草稿/光标/阅读锚点/目标 rootSessionId）→ 停 schedule/Monitor/PTY → flush → 释放 claim → exec 自身带 `--root <新 id>` → 新进程读 handoff 恢复。冷改名即切到该会话（保持单主会话），改名后留在该根。旧进程不得与新进程并存；handoff 文件位置由 S01 定。
- 上下文：占用 = `projectedTokens / contextWindow`，缺一显示未知；`tokenUsage` 是计费累计，不混用；`/compact` 仅空闲可用、取消后从官方记录重读历史。
- 模型/强度/权限：模型身份为 `provider + model`；强度只列官方 `efforts`；权限走 `/permission` 面板（只读展示 + 切换），失败保留原值并显示原因（§5.2 用户变更），同时提示「可能已部分生效，请重开 `/permission` 核对」；切 `never` 显示完整后果；选择成功以官方回执为准，不乐观更新。
- 技能/规矩：命令优先、`snapshot().complete=false` 标「可能不完整」、发现失败保留上次目录；预览只读；规矩按官方链顺序/去重/预算展示，不自建 watcher。

## 3. 终端、任务、Monitor、调度与子代理

- **终端**：真实 PTY，经官方 `terminalController` 创建/附着/保留/释放/重命名/关闭；attach 前 `retain()`；快照 + 单调 sequence；序列缺口/超限/越界 resize 结束该附件并报错（不是丢弃单条继续）；未确认输入不回放；`inputFull` 取消附件；输出背压有界；终端输出不进 transcript/模型上下文；Agent 工具表与 Monitor 路径不得出现 terminal 方法；退出释放 PTY。
- **任务**：官方 jobs 只读；`readAt` 绝对偏移非消费；ring 预算/settled 裁剪/gapBefore；停止只报「已请求停止/已结束」，`job/not-found` 与 `already-finished` 分开；不维护第二份任务表。
- **人工命令 `!`**：单次 `ShellExecRequest` 传 `danger-full-access`，不改 mount/profile 默认；不注册官方 job；输出以 `bash-mode` 合成 user 注入但不构成授权；`!!` 为 `inject:false`，只本窗口显示；非零退出是结果不是基础设施错误。`!` 不唤醒模型、不新建 turn；只在用户下一次提交时把输出作为上下文带入。
- **Monitor**：默认 `quiet`（§5.2 用户变更）；切 `notify` 必须明确告知会唤醒模型/计费，并在每次切到 `notify` 时重复确认；初始偏移默认 `output.total`，可选从头；settled 时 `readAt` 补齐；单任务单监听；预算耗尽停止投递并保留监听状态；真实收件以 accepted step / durable user/message 为准，`inserted`/`claimed` 不算；通知显示 `role=user / source=monitor`；停止监听 ≠ 停止任务；切根停旧监听（受控重启前必须停）。`quiet` 下只落 transcript，不触发模型调用，证据需含「切回 quiet 后不再计费」的实测。
- **调度**：官方 `dsh-schedule` + per-root storage 后端 + `storage-domain.routes` + `nano_probe`。
  - 后端用 `provide('storageDomain', ...)` 注册，`routes` 按根会话映射到 `<数据根>/runtime-data/<root>/schedule`；`nano_probe` 只读探测后端可用性。
  - 启动顺序：storage 后端先于 loader settle → 认领根会话并持 `schedule.lock` → 才挂 schedule；仅后端/路由缺失才 `unsupported`。
  - 一个根会话一个 scheduler；租约被活 pid 持有显示「调度由 pid X 持有」；无暂停/恢复，停止即删除；投递非严格一次、只补最近一次；创建/修改用 CAS/`schedule_conflict`；两根本会话表互不可见。
  - `session-controller` 经 `provide('sessionController', rootOnlyAdapter)` 提供：只暴露当前根的 create/resume/list，不跨根；`schedule` 行与适配器缺失时调度不可用，不得静默降级。
- **子代理**：目录/活动/时间来自官方；one-shot 只读、external 不可导航、unknown 确认 mode 后恢复输入；continuable ≠ 可输入，只有 exact parent live 才保留输入；子代理审批官方钉死 `never`，不渲染可放行审批卡；续聊走 `subagents/prompt` queue/steer，Stop 走 `interruptByParent`（排队保留、后代继续），`dispose` 不冒充 UI 取消；fork seed 是例外必须显示；结束原因原样；子地址订阅按地址过滤；dock 按 `ADR-20261022-subagent-dock-lifecycle`。子代理产生的成本在 dock 上可见（用户 2026-10-28 变更），不新增第二个计费模型。

## 4. 跨份共同约束

- 文件隔离：本份不修改 `src/render`、`src/input`、`package.json`；键位只注册。
- 证据：每项真实官方服务验证，含负向安全用例；证据写 `docs/evidence/2026-10-28-nano-ts/beta/`。
- 跨根会话：transcript/草稿/队列/附件/审批/问卷/终端/Monitor/调度逐面隔离；双窗口同根拒绝、双 root 并发、调度表隔离。
- 性能/长会话：沿用 S01 指标；终端/Monitor 输出背压有界。

## 5. 验收

- 附件：图片 20MiB 边界、>20MiB 通用文件、多图一张超限、模型不支持图片、子代理通用文件、回执复用拒绝。
- 输入：多行/IME 组合态 Enter 不发送、`@` 语法、三类补全、命令同名优先、未知 `/name`、`history.jsonl`。
- 会话：列表/恢复/not-found/损坏/writer-held/新建 ID 不一致、压缩取消重读、上下文三投影分开；冷改名显示 writer-held 与单主会话。
- 权限：失败保留原值 + 警告 + 重开核对；`never` 后果可见。
- 终端：创建/附着/输入/缩放/关闭；序列缺口/`inputFull`/背压；输出不进 transcript；Agent 工具表无 terminal。
- 任务：游标不推进、停止分类、裁剪/缺口。
- Monitor：`quiet` 默认、`notify` 真实收件与计费提示、初始偏移、settled 补齐、预算耗尽、切根停止。
- 调度：per-root 表隔离、租约持有显示、无暂停、非严格一次、CAS 冲突。
- 子代理：one-shot/external/exact-parent-live/审批 never/interruptByParent/fork seed/内容隔离/dock ADR。
- `!`：工作区外写文件可用；Agent 同路径仍审批；输出不进 job 表、不构成授权；`!!` inject:false。
- 跨根：九个面逐面隔离；双窗口同根拒绝；双 root 并发。
- 切根：受控重启后 handoff 恢复草稿/锚点；旧进程退出、无并存；冷改名后留在该根。
- 会话控制器：`sessionController` 只暴露当前根；缺失时启动失败并点名。
- 键位：注册表汇总并可被 S03 生成 README/`--help`。

## 6. 本份机制与自定细节

- 机制：消费 S01 契约（D01：有序输入段、地址隔离、草稿/锚点、cell 网格、lifecycle hooks）；官方服务是唯一事实源；调度 per-root 后端/租约/sessionController 适配器；单进程切根 = 受控重启 + handoff；附件两条链；终端官方 controller；Monitor 预算/收件；子代理地址过滤。
- bridge 吸收范围见总纲 §8.2：controls/sessions/skills/attachments/jobs/monitor/schedule/subagents/shell/terminal 由本份吸收并验收，S03 只删除。
- 附件暂存/补全排序/Monitor 默认预算/调度租约阈值沿用 v1（30s、0600、`runtime/attachment-staging`、48 KiB chunk、官方目录顺序），不重新发明。
- 键位：S01 持有 `src/input/keymap.ts`；本份只注册功能键；S03 只生成文档。
- 不新增 Agent 工具、第二份任务表、第二份队列、自建 Cron。

## 7. 审核修订记录

- 2026-10-28 重审 8 份后按发现重写：调度隔离/启动顺序、D01 契约、`!` 安全、附件两条链、终端/任务/子代理语义、跨根隔离、验收负向；三处用户变更见总纲 §5.2；完整清单在 PR #84 评论。
- 2026-10-28 轻审修订：补 sessionController 适配器与 schedule 后端 provide/routes/lease、单进程切根改受控重启 + handoff、`!` 不唤醒、补全 Enter 语义、`/permission`、Monitor quiet 计费核实、子代理成本可见、bridge 吸收范围、32 KiB 上限。
