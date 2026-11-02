# [2026-11-02-nano-command-surface] 命令执行面

- 组标识：`2026-11-02-nano-command-surface`
- 角色：单份 spec，总纲与执行规格合一
- 状态：草案（待过闸）
- Issue：待开（spec 合并后开执行单）
- 结构：不拆——1 份 spec + 1 张执行 issue
- 机制范围：M1–M5（见 §6）
- 上游：
  - `docs/specs/2026-10-22-nano-visual-v1/README.md` §4.3（`README.md:72`「过程行整体 muted，只有失败/警告/错误用状态色」）与 §7（`README.md:147`「过程行/审批命令用 muted」）
  - `docs/specs/2026-10-28-nano-process-display/README.md` 与 [ADR-20261028-nano-process-display](../../decisions/2026-10-28-nano-process-display.md)（过程块默认一行、展开原位点击）
  - `docs/specs/2026-11-01-nano-approval-card-in-transcript/README.md` 与 [ADR-20261101-approval-card-in-transcript](../../decisions/2026-11-01-approval-card-in-transcript.md)（审批卡落点、4 选项、无「始终允许」）
  - 官方 `@deepseek-ai/dsh-permission-presets` / `@deepseek-ai/dsh-user-approval` / `@deepseek-ai/dsh-compaction-basic` 0.2.1-rc.2
  - Claude Code 2.1.88 源码（本机归档 `/Users/sunchongsheng/Downloads/归档/06-软件与安装包/ClaudeCode/src`）：`src/utils/sandbox/sandbox-adapter.ts:471`（`autoAllowBashIfSandboxed` 默认 true）、`src/tools/BashTool/readOnlyValidation.ts`（只读白名单）、`src/tools/BashTool/bashPermissions.ts`（AST 拆子命令）、`src/components/permissions/BashPermissionRequest/BashPermissionRequest.tsx:355`（don't ask again 写 `localSettings`）、`src/utils/permissions/bashClassifier.ts:1`（2.1.88 外部构建是 ANT-ONLY stub）
- ADR：新增 [ADR-20261102-nano-default-bypass-permissions](../../decisions/2026-11-02-nano-default-bypass-permissions.md)
- 替代关系：**不替代**审批卡 spec/ADR 的形态与 4 个结果；**执行** visual-v1 §4.3 / §7 的过程行整行 muted（当前实现偏离，本 spec 纠正）；**改变**新会话的默认权限姿态（从 dsh base 的 `workspace-write` 改为 `danger-full-access`）。
- 下游：无硬依赖；A 的会话生命周期与本文正交。
- 合入前提：单测 + 真实 PTY 证据；`nano --help` 同步；已有会话的已 pin preset 不被追溯改写。

## 1. 目标与边界

目标：让「命令跑起来」这一层同时满足三件事：

1. **默认不被打断**：新会话默认 `danger-full-access`（沙箱关闭 + 审批 `never`），对齐用户 Claude Code 的 bypass 启动方式；正常脚本不再逐次确认。
2. **过程行按设计稿变灰**：正文里的 `✓ Bash cd … · 点击展开` 这类过程行整行 `muted`；只有失败/警告/错误用状态色。
3. **压缩不再莫名失败**：`/compact` 在回合运行中排队到回合结束；空闲时失败给中文原因与下一步；压缩中显示进度。

### 非目标

- 不做持久 allowlist / `Bash(前缀)` 规则引擎；不复制 Claude Code 的 AST 规则匹配（复合命令绕过风险高）。
- 不挂 `@deepseek-ai/dsh-experimental-auto-review`，不做模型逐条分类。
- 不改审批卡的形态、4 个结果、fail-closed 语义与「不提供始终允许」。
- 不修 dsh 沙箱的 `/dev/ptmx` 限制；默认 bypass 下没有沙箱，PTY 问题只影响显式选择 `workspace-write` 的用户（见 §4）。
- 不实现本地压缩、自动压缩阈值或第二套上下文测量。
- 不改问题卡、计划审阅卡、活动栏鲸尾动画。

## 2. 现状与证据

调查基线：`origin/main` @ `17cc80b`；官方 `@deepseek-ai/dsh` 0.2.1-rc.2。

| 事实 | 证据 |
|---|---|
| dsh base 的权限预设表是 `read-only` / `workspace-write` / `danger-full-access`；`danger-full-access` = 沙箱 `danger-full-access` + 审批 `never` | `node_modules/@deepseek-ai/dsh-base/cordis.patch.yml:243-276` |
| 默认沙箱模式与审批策略读 `DSH_PERMISSION_MODE ?? 'workspace-write'`；不是 `danger-full-access` 时审批策略为 `ask` | `node_modules/@deepseek-ai/dsh-base/cordis.patch.yml:243-263` |
| `permission-presets` 支持 `defaultPreset` 配置；未配置时从沙箱/审批默认值推断 | `node_modules/@deepseek-ai/dsh-permission-presets/lib/index.js:158-185`（推断在 `:178-179`）、`:274-275`（getter） |
| nano 当前不设置默认 preset；新会话按 base 默认走 `workspace-write` | `src/boot/assemble.ts:88-104`（含 tool-ask-user / file-reference-local / session-persistence / storage-json / hmr / extraPatches）；`src/boot/env.ts`（只设 `NODE_ENV`） |
| 已有会话会把生效 preset pin 在会话日志里；改默认不追溯 | `@deepseek-ai/dsh-permission-presets` README「Session defaults / Session pinning」 |
| 过程行当前用 `tool`（正文白）：读类组标签 `src/transcript/model.ts:399`；单条工具标题 `:435`；`✓` 用 `success` 绿 `:431-434` | `src/transcript/model.ts:392-440` |
| 设计稿要求「过程行整体 muted，只有失败/警告/错误用状态色」「过程行/审批命令用 muted」 | `docs/specs/2026-10-22-nano-visual-v1/README.md:72`、`:147` |
| `/compact` 当前直接转发官方 commands，没有运行中预检、排队或中文原因 | `src/controls/feature-host.ts:314-364` |
| 官方 `/compact` 只在 agent 空闲、没有排队唤醒、没有进行中压缩时可用；否则返回 `busy` | `@deepseek-ai/dsh-compaction-basic` README；`node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js:1009` |
| 用户现场会话日志（preview-main，截至 2026-11-02 14:31 CST 快照）19 次 `approval/asked`：15 次 PTY e2e、2 次 `~/Downloads`、2 次全局安装；18 次 `approval/decided` 中 2 次 `cancelled`、16 次 `allowed-once`，最后一条尚待结算 | 2026-11-02 用户会话日志；`approval/asked` / `approval/decided` 的 `reason` / `outcome` 字段 |
| Claude Code 的免问路径不止一条：bypass、沙箱内自动放行、只读白名单、allow 规则 + don't ask again、`acceptEdits`；2.1.88 外部构建的 `auto` 分类器是 stub | 上表 Claude Code 源码行；`src/components/messages/AssistantToolUseMessage.tsx:240`（Waiting for permission…） |
| 用户 Claude Code 的启动方式实际是 bypass；nano 默认 `workspace-write + ask` 与它不可直接对比 | 用户 2026-11-02 明确「那我们也默认让我们的 nano 开启 bypass 模式」 |

## 3. 行为规格

### 3.1 默认权限姿态

- **新会话**默认 preset = `danger-full-access`：沙箱关闭、审批策略 `never`。正常 bash 命令不再触发审批；PTY、全局安装、跨目录写也不会因为沙箱升级而弹卡。
- **优先级**（从高到低）：
  1. CLI `--permission-mode <preset>` 或 `--dangerously-skip-permissions`。
  2. 进程环境 `DSH_PERMISSION_MODE`（兼容官方 base 的既有开关）。
  3. nano 默认 `danger-full-access`。
- **可选值**：`read-only`、`workspace-write`、`danger-full-access`（base 表）。未知值 → 启动失败并列出可选值。
- `--dangerously-skip-permissions` 等价于 `--permission-mode danger-full-access`。
- **已有会话不追溯**：resume 时保留会话日志里 pin 的 preset。用户要切换时在会话内执行 `/permission danger-full-access`；nano 不静默改写历史会话的权限姿态。
- **审批卡保留**：只有在显式选择 `read-only` / `workspace-write` 且官方请求权限时才出现；形态、4 个结果、fail-closed、无「始终允许」都不变。
- **不新增规则引擎**：不做持久 allowlist、不做 `Bash(前缀)` 匹配、不挂 Auto review。
- **多窗口**：preset 是每会话的；默认 bypass 不改变挂载锁、会话隔离与多窗口行为。两个窗口都能写任意路径；文件级隔离仍靠 worktree（§4）。

### 3.2 过程行整行 muted

适用范围：`toolUnit` 产生的**折叠态过程行**（读类组行、单条 Bash / 通用工具行）。不改思考行（已是 muted）、不改 diff、不改审批卡命令块（已是 muted）。

| 元素 | 当前 | 改为 |
|---|---|---|
| 读类组标签（`读取 …`） | `tool`（正文白） | `muted` |
| 单条工具标题（`Bash cd …`） | `tool`（正文白） | `muted` |
| `✓`（成功） | `success`（绿） | `muted` |
| `…`（运行中） | `muted` | `muted`（不变） |
| `✗`（失败） | `danger` | `danger`（不变） |
| 失败摘要（`· N 失败`） | `danger` | `danger`（不变） |
| `· 点击展开 / · 点击收起` | `faint` | `faint`（不变；主题里与 muted 同值） |

- **只改折叠态行**；展开后的命令/结果正文维持现状（命令 `code`、结果 `muted`、错误 `danger`），不借这次改动重做展开体。
- 设计依据是 visual-v1 §4.3 / §7 的「过程行整体 muted」；当前 `tool`/`success` 是实现偏离，不是设计选择。
- 成功不再使用绿色；绿色只保留给 diff 统计等设计稿明确指定的位置。

### 3.3 `/compact` 预检与排队

状态机：

| 触发时状态 | 行为 |
|---|---|
| 空闲 + `/compact` | 显示「正在压缩…」→ 调官方 `/compact` → 成功显示官方结果（条数 / 估算 token）；`No compactable history yet.` 也走成功路径，显示「还没有可压缩的历史」；失败按 3.4 映射 |
| 回合运行中 + `/compact` | 记录一个 pending；显示「回合结束后压缩（已排队）」；输入被 take；回合结束（agent 变 idle）后自动执行一次 |
| 已有 pending + 再次 `/compact` | 显示「已排队，回合结束后自动压缩」；不重复入队 |
| 回合被 Ctrl+C 停止 | agent 变 idle 后仍执行 pending（用户已经表达压缩意图）；若用户已退出/切换会话则取消 |
| 会话切换 / 受控重启 / 退出 | 取消 pending，不执行 |
| 压缩进行中 + `/compact` | 显示「压缩进行中，完成后会显示结果」；不重复入队 |
| 空闲 + 官方返回 `busy` | 显示 3.4 的中文原因；不自动重试 |

- **只有一个 pending**；不实现队列数组。
- 排队期间用户继续提问：按官方队列语义处理，nano 不重排、不丢失。
- 压缩期间提交的 prompt 由官方排队，压缩结束后按序开始；nano 不自行调度。
- **不实现本地压缩 / 自动压缩阈值**；自动压缩仍由官方决定，nano 只展示结果。

### 3.4 官方结果映射（成功 / 失败）

`commands.execute` 返回 `result.kind === 'error'`，或成功但文案是 `No compactable history yet.` 时，按官方稳定文案映射为中文「原因 + 下一步」；原文保留在诊断日志，不弹给用户：

| 官方稳定消息（前缀） | 用户看到 |
|---|---|
| `Compaction is unavailable because this process has an active compaction, or the agent is not idle.` | `压缩暂不可用：会话可能还在运行，或上一次压缩还没结束。等回合结束后再试。` |
| `Compaction cancelled.` | `压缩已取消。` |
| `The history selected for compaction changed before it could be replaced.` | `压缩期间会话历史变了，本次未替换；请重试。` |
| `Compaction could not produce a useful summary.` | `没有生成可用的摘要；本次未替换。` |
| `Compaction did not finish cleanly; some session history may have changed.` | `压缩未干净结束；请先检查会话状态再重试。` |
| `Compaction finished, but the session could not be saved.` | `压缩已完成，但会话保存失败。` |
| `No compactable history yet.` | `还没有可压缩的历史。` |
| `Usage: /compact (no arguments)` | `用法：/compact（不接受参数）。` |

- 未知错误：显示「压缩失败：<原文>」，不自动重试。
- `No compactable history yet.` 在官方是 `kind: "success"`，不是 error；不能只按 error 分支处理。
- 映射只影响展示；命令生命周期、官方日志与历史替换仍由官方拥有。

### 3.5 启动开关

- `nano --permission-mode <preset>`：设置本次进程的默认 preset。
- `nano --dangerously-skip-permissions`：等价 `--permission-mode danger-full-access`；这是对用户 Claude Code 习惯的直接对齐。
- **解析**：`bin.ts` 的 `commandArgs` 与 `main.ts` 的 `parseArgs` 都必须像 `--root` 一样跳过 `--permission-mode` 的值；`--permission-mode purge --yes` 不得被当成 `purge` 子命令。两个开关同时出现 → 启动错误。未知 preset → 启动错误并列出 3 个可选值；`purge` 与 `--permission-mode` 同时出现 → 启动错误（purge 不是 TUI 会话）。
- 帮助文案必须列出这两个开关与默认值；README 同步。
- 实现落点：`main.ts` 在 `parseArgs` 之后、`prepareCore` 读取 profile patch **之前**设置 `process.env.DSH_PERMISSION_MODE`：CLI 给了 preset 就写 CLI 值；否则 env 未设时写 `danger-full-access`。`src/boot/env.ts` 不参与权限默认，只设 `NODE_ENV`。若改用 `permission` patch 的 `defaultPreset`，必须验证 `presets` 表未被覆盖。
- 不新增 `NANO_PERMISSION_MODE`；沿用 `DSH_PERMISSION_MODE`，避免第二套环境变量。

### 3.6 明确不变的部分

- 审批卡落点、命令行区块、4 个选项、键位、活动行「等待你的授权」、输入占位「等待你处理上面的确认…」全部不变。
- 问题卡、计划审阅卡、子代理 dock、忙碌/等待文案不变。
- `!` 人工命令的 danger-full-access 单次执行语义不变；它本来就不走审批。
- 官方 session 写锁、挂载认领、受控重启不变。

## 4. 失败与不变量

1. **默认 bypass 是每会话的**：不写全局配置、不改已有会话的 pin；resume 不追溯。
2. **不做 allowlist / Auto review**：本轮不引入新的权限判定层；审批仍只有官方 `ask` / `never` 与 nano 的 4 结果卡。
3. **不伪造成本**：`danger-full-access` 意味着没有沙箱；两个窗口可以写同一文件。worktree 是文件级隔离手段，nano 不承诺会话锁能防文件冲突。
4. **过程行只改颜色**：失败仍是 `danger`，成功不再用 `success` 绿；不得因为变灰而隐藏失败或把错误改成 muted。
5. **压缩只在空闲执行**：pending 不得在 agent 运行中执行；不得重复入队；切换/退出必须取消。
6. **不自动重试**：官方失败后由用户再次触发；nano 不循环重试、不本地截断。
7. **PTY 限制如实标注**：显式选择 `workspace-write` 的用户仍可能被 `/dev/ptmx` 拒绝并弹审批卡；本轮不修沙箱，不把它说成已解决。
8. **帮助与文档一致**：`nano --help`、README、本文的默认值与开关一致。

## 5. 验收

- [ ] 新开 `nano`（先 `unset DSH_PERMISSION_MODE`）：会话日志的 `permission/preset` 是 `danger-full-access`；普通 bash、PTY e2e、跨目录写都不弹审批卡。
- [ ] `nano --permission-mode workspace-write`：会话 preset 是 `workspace-write`；沙箱升级仍弹审批卡，卡片形态与 4 个结果不变；`/dev/ptmx` 仍被拒且文档保留该限制。
- [ ] `nano --dangerously-skip-permissions` 与 `--permission-mode danger-full-access` 等价。
- [ ] `nano --permission-mode purge --yes`：不得进入 purge 分支、不得删除数据根；`purge` 与 `--permission-mode` 同时出现报错；未知 preset 报错并列出 3 个可选值。
- [ ] 恢复一个已 pin `workspace-write` 的旧会话：仍是 `workspace-write`；执行 `/permission danger-full-access` 后切换。
- [ ] 过程行 100/60 列、深/浅主题：`Bash` / 命令 / `✓` / 读类组标签都是 `muted`；失败是 `danger`；成功不再出现绿色。
- [ ] 展开后的命令/结果正文不变：命令 `code`、结果 `muted`、错误 `danger`。
- [ ] 回合运行中 `/compact`：显示「回合结束后压缩（已排队）」；回合结束后自动执行；不再出现英文 `busy` 报错。
- [ ] 空闲 `/compact` 成功：先显示「正在压缩…」，再显示条数 / 估算 token；`No compactable history yet.` 显示中文「还没有可压缩的历史」；失败按 §3.4 显示中文原因；不自动重试。
- [ ] Ctrl+C 停止回合后：pending 仍执行一次；切换会话/退出时 pending 被取消。
- [ ] 压缩进行中再次 `/compact`：显示「压缩进行中…」且不重复入队。
- [ ] 连续两次 `/compact` 只入队一次。
- [ ] 两个窗口默认 bypass（先 `unset DSH_PERMISSION_MODE`）：各自独立；挂载锁与多窗口行为不受影响。
- [ ] `nano --help` 与 README 列出默认值与两个开关。

## 6. 机制清单

| 机制 | 解决什么 / 没有会怎样 | 确认与代价 |
| --- | --- | --- |
| M1 默认 `danger-full-access` | 对齐用户的 Claude Code bypass，正常脚本不再逐次确认；没有则 PTY/跨目录写反复弹卡 | 用户 2026-11-02 明确要求；代价是默认无沙箱 |
| M2 `--permission-mode` / `--dangerously-skip-permissions` | 想临时开沙箱时不用改配置；没有则只能进 TUI 后 `/permission` | 复用 base 的 3 个 preset；不新增 preset |
| M3 过程行整行 muted | 正文里的 Bash 折叠行按设计稿变灰；没有则设计稿与实现长期不一致 | 只改颜色，不改结构；成功不再用绿色 |
| M4 `/compact` 预检 + 排队 | 消除运行中必失败与英文 busy 报错；没有则长会话压缩不可用 | 只排队一次；含进度态「正在压缩…」与「压缩进行中」提示；不实现本地压缩 |
| M5 官方失败消息映射 | 用户看到原因和下一步；没有则只能读英文原文 | 映射只影响展示，不改官方语义 |

## 7. 自定细节

- 默认 preset 的落点：`main.ts` 在 `parseArgs` 之后、`prepareCore` 之前：CLI 给了 preset 就写 `process.env.DSH_PERMISSION_MODE`；否则 env 未设时写 `danger-full-access`。`src/boot/env.ts` 不参与权限默认，只设 `NODE_ENV`。若实现改用 `permission` patch，必须保留完整 `presets` 表。
- 优先级：CLI > `DSH_PERMISSION_MODE` > `danger-full-access`。显式 env 不被 CLI 之外的东西覆盖。
- `--permission-mode` 只接受 base 的 3 个名字；未知值报错并列出，不回退到默认。
- 已有会话的 pin 不追溯；`/permission` 是唯一的切换入口。
- 过程行改动只覆盖 `toolUnit` 的折叠态；读类组行的展开体已经 muted，不动；单条工具的展开体不动。
- `✓` / `…` / 读类组标签统一 `muted`；`✗` 与失败摘要保持 `danger`；`warning` 只在已有警告语义处使用。
- `/compact` pending 的触发点是 agent 状态变 idle（`conversation.onChange` 或 `agent/status`），不是定时器；只有一个 pending。
- 压缩期间显示「正在压缩…」；成功/失败后清除；不新增进度条或动画。
- 错误映射按官方稳定消息前缀匹配；未知错误显示原文；原文写诊断日志。
- 不新增 allowlist、`--allowedTools`、Auto review；Claude Code 的规则能力只作为调研背景，不在本轮实现。
- `workspace-write` 下的 `/dev/ptmx` 拒绝保持现状；本文只记录为已知限制，不承诺修复。
- 多窗口下每个窗口的默认 preset 独立；nano 不提供「全局权限」设置。

## 8. 审核修订记录

| # | 严重度 | 发现 | 处置 |
|---|---|---|---|
| 1 | 重要 | 审批计数过期、outcome 标签不符（实际 18→19 次 asked，全局安装是 cancelled 不是 rejected） | 已改：spec 与 ADR 统一为 14:31 CST 快照：19 asked / 18 decided；2 cancelled / 16 allowed-once；最后一条待结算 |
| 2 | 重要 | `No compactable history yet.` 是 success，不是 error；§3.4 只映射 error | 已改：§3.3 / §3.4 明确成功路径；验收补空历史成功态 |
| 3 | 重要 | `--permission-mode` 解析未定义，`--permission-mode purge --yes` 会误进 purge | 已改：§3.5 补解析规则、互斥与未知值报错；§5 补验收 |
| 4 | 轻微 | `cordis.patch.yml:243-275` 截掉 `approval: never` | 已改：243-276 |
| 5 | 轻微 | `permission-presets` 推断行号不准 | 已改：`:178-179` 推断、`:274-275` getter |
| 6 | 轻微 | `assemble.ts:96-107` 漏 tool-ask-user / file-reference | 已改：88-104 |
| 7 | 轻微 | `bashToolUseOptions.tsx:78` 不是写入点 | 已改：`BashPermissionRequest.tsx:355` |
| 8 | 轻微 | §5 未验收 workspace-write 下 PTY 仍被拒 | 已改：§5 项 2 补 PTY 限制 |
| 9 | 轻微 | 压缩验收缺进度态、Ctrl+C、压缩中再次 `/compact` | 已改：§5 已补三项 |
| 10 | 轻微 | 默认值验收未 unset `DSH_PERMISSION_MODE` | 已改：§5 项 1 / 两项补 `unset` |
| 11 | 轻微 | §3.5 / §7 对 `env.ts` / `main.ts` 落点表述不一致 | 已改：统一为 `main.ts` 写 env，`env.ts` 只设 `NODE_ENV` |
| 12 | 轻微 | §6 M4 未覆盖进度态与压缩中提示 | 已改：M4 补进度态与压缩中提示 |
| 13 | 重要 | 实施轻审：排队压缩在下一回合已开始时执行并丢失 pending | 已改：`setImmediate` 内重新确认 idle，运行中则放回 pending |
| 14 | 轻微 | 实施轻审：dispose 异步窗口内可能仍执行已排程压缩 | 已改：dispose 开头清 context，排程回调据此取消 |
| 15 | 轻微 | 实施轻审：`tests/e2e/README.md` 格式重排噪声 | 已改：恢复原格式，只保留内容变更 |
