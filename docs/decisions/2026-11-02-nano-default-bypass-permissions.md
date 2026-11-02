# ADR-20261102-nano-default-bypass-permissions：新会话默认 danger-full-access

- 状态：生效中（随 spec `2026-11-02-nano-command-surface` 合并进入仓库基线）
- 日期：2026-11-02
- 决策人：用户
- 适用范围：nano 新会话的默认权限 preset、启动开关、审批卡出现条件、allowlist 边界
- 取代：无旧 ADR；改变 nano 从 dsh base 继承的 `workspace-write + ask` 默认，不改官方 preset 表与审批 seam
- 被取代：无
- 决策来源：用户 2026-11-02 原话「那我们也默认让我们的 nano 开启 bypass 模式」；同日说明其 Claude Code 启动方式带 `--dangerously-skip-permissions`

## 决定

1. nano 的**新会话**默认 preset = `danger-full-access`：沙箱关闭、审批策略 `never`。普通 bash、PTY e2e、跨目录写不再触发沙箱升级审批。
2. 启动优先级：CLI `--permission-mode <preset>` / `--dangerously-skip-permissions` > `DSH_PERMISSION_MODE` > nano 默认 `danger-full-access`。
3. **已有会话不追溯**：resume 保留会话日志里 pin 的 preset；用户要切换时在会话内执行 `/permission danger-full-access`。
4. **审批卡保留**：显式选择 `read-only` / `workspace-write` 时，官方请求权限仍弹现有 4 选项卡片；形态、fail-closed、无「始终允许」都不变。
5. **不做持久 allowlist、不做 `Bash(前缀)` 规则引擎、不挂 Auto review**；Claude Code 的规则能力只作为调研背景。
6. 默认 bypass 不改变会话锁、多窗口隔离、`!` 人工命令的 danger-full-access 单次执行语义。

## 依据

- 用户 2026-11-02 的 `preview-main` 会话日志（截至 14:31 CST 快照）里 19 次 `approval/asked`：15 次 PTY e2e、2 次 `~/Downloads`、2 次全局安装；18 次 `approval/decided` 中 2 次 `cancelled`、16 次 `allowed-once`，最后一条尚待结算。PTY 是沙箱拦截 `/dev/ptmx` 导致的升级，不是用户想逐条确认的操作。
- 用户 Claude Code 的启动方式实际是 `--dangerously-skip-permissions`；nano 的 `workspace-write + ask` 与它不可直接对比。用户明确要求把 nano 默认对齐到这条工作流。
- dsh base 的 `danger-full-access` 就是「沙箱 danger-full-access + 审批 never」（`node_modules/@deepseek-ai/dsh-base/cordis.patch.yml:243-275`）；没有沙箱升级，就不会有审批请求。
- 官方 `permission-presets` 支持 `defaultPreset` 与会话 pinning；已有会话切 preset 走 `/permission`，不需要 nano 自造状态。

## 否决了什么

- **继续默认 `workspace-write`**：用户每次跑 PTY/跨目录写都要逐条确认，已被现场日志证伪。
- **默认 `workspace-write` + 只修 PTY**：能减少 8/13 的弹卡，但全局安装、`~/Downloads` 仍会弹；用户已明确要 bypass。
- **持久 allowlist / `Bash(前缀)` 规则**：Claude Code 用 shell AST 拆子命令并限制建议条数（`src/tools/BashTool/bashPermissions.ts`），nano 没有对应引擎；硬做前缀匹配会引入 `;` / `&&` / `sh -c` 绕过风险。
- **挂 Auto review**：2.1.88 外部构建的 classifier 是 ANT-ONLY stub；官方 experimental auto-review 每条多一次模型调用，且对 PTY/设备访问未必放行，不能替代默认 bypass。
- **把 `danger-full-access` 做成全局设置**：nano 只改每会话默认，不写用户全局配置，不追溯已有会话。

## 接受的代价

- **默认没有沙箱**：任何窗口都能写任意路径；两个窗口共用 worktree 时会互相踩文件。文件级隔离仍靠 worktree。
- 已有会话仍按旧 preset 运行；用户需要手动 `/permission danger-full-access` 才能切。
- 显式选择 `workspace-write` 的用户仍会遇到 `/dev/ptmx` 被拒与审批卡；本 ADR 不修沙箱。
- 默认 bypass 让「误执行」的后果更大；这是用户明确选择的安全姿态，不在 nano 侧再加一层隐形保护。

## 允许重开的条件

- 用户要求恢复沙箱默认，或发生一次可归因于「默认无沙箱」的安全事故。
- 官方沙箱允许 PTY 设备节点（`/dev/ptmx` / `/dev/ttys*`），且 job 场景不再需要全局 bypass。
- 官方提供可审计、可回退的持久 allowlist 或 Auto review，且用户明确选择用它替代 bypass。
- 官方 `danger-full-access` 的语义或 preset 表发生变化。

## 关联

- Spec：`docs/specs/2026-11-02-nano-command-surface/README.md`
- 审批卡：[ADR-20261101-approval-card-in-transcript](2026-11-01-approval-card-in-transcript.md)
- 过程行：`docs/specs/2026-10-22-nano-visual-v1/README.md:72`、`:147`
- 官方：`node_modules/@deepseek-ai/dsh-base/cordis.patch.yml:243-275`；`@deepseek-ai/dsh-permission-presets` README
- 对照：Claude Code 2.1.88 `src/utils/sandbox/sandbox-adapter.ts:471`、`src/tools/BashTool/readOnlyValidation.ts`、`src/tools/BashTool/bashPermissions.ts`、`src/components/permissions/BashPermissionRequest/BashPermissionRequest.tsx:355`
