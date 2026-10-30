# 0.2.0 功能面证据矩阵（beta §5）

- 日期：2026-10-30
- 口径：覆盖 = 该组每个必测子项都有真机或功能/单元测试证据；部分 = 主路径有证据、仍有子项未取证；边界 = 本版无对应 UI 或不可自动模拟，需 owner 认可后按边界处理；未覆盖 = 尚未取证。
- 本文件不替代 spec；只把 `release-conclusion.md` 的「功能面」阻断拆到可验收的粒度。

| §5 验收组 | 状态 | 证据 | 剩余 |
|---|---|---|---|
| 输入：多行 / IME、`@`、三类补全、补全 Enter、未知 `/`、32 KiB | 部分 | `tests/unit/input.test.ts`、`tests/e2e/input-screen.test.mjs`、`tests/e2e/interaction-pty.test.mjs`、`tests/feature/attachments.test.ts` | IME 真输入法组合不可自动模拟（边界）；补全 Enter 的负向边界未取证 |
| 附件：图片准入、超限 / 不支持、通用文件、回执拒绝 | 部分 | `tests/feature/attachments.test.ts`（6 例：准入失败、每次新回执等）、`tests/e2e/cross-surface.test.mjs`（`@` 引用隔离） | S02 §86 的「回执复用拒绝」未单独取证 |
| 会话：列表 / 恢复 / not-found / 损坏、冷改名 | 部分 | `tests/feature/handoff.test.ts`、`tests/e2e/cross-session.test.mjs`；冷改名受控重启真机验证 | 冷改名四种失败路径未逐条取证；会话列表 PTY 交互未取证 |
| 权限：`/permission <preset>`、失败保留 / 警告、`never`、changed-by-user | 部分 | beta 真机 `/permission read-only`；B5 审批 waterfall / 默认拒绝 | 失败回滚 / 警告与 changed-by-user 未取证 |
| 模型 / 强度：身份、官方 efforts、官方回执 | 部分 | `/model` 面板 24 项单测 + PR #99/#102 e2e；换模型不重置档位、档位不重置模型 | 跨进程记忆只做过手工 PTY，仓库内无对应用例 |
| 技能 / 规矩：命令优先、`complete=false`、发现失败保留、预览只读 | 部分 | 信息面板与补全实现；技能目录缓存 | `complete=false`、发现失败保留未取证 |
| 终端：创建 / 附着 / 输入 / 缩放 / 关闭、缺口 / 背压、不进 transcript | 部分 | `tests/e2e/cross-surface.test.mjs`（终端内容隔离）、beta `terminal-attach-probe.mjs`、`tests/e2e/vision-pty.test.mjs` | 缺口 / `inputFull` / 背压未取证（边界或补探针） |
| 任务：游标不推进、停止分类、裁剪 / 缺口 | 部分 | `tests/feature/jobs.test.ts`（2 例：`statusWord` / `classifyStop`）、`tests/e2e/monitor-policy.test.mjs` | 游标不推进、裁剪 / 缺口未取证 |
| `!`：工作区外可写、不进 job 表、不构成授权、`!!` inject:false | 部分 | `tests/e2e/interaction-pty.test.mjs`、`tests/feature/bash-mode.test.ts` | inject 的 step boundary 时序未取证（边界） |
| Monitor：quiet/notify、初始偏移、settled、预算、切根停止 | 部分 | `tests/feature/monitor.test.ts`、`tests/e2e/cross-surface.test.mjs`（监听器隔离 + B 面板正控） | 切根停止未单独取证（边界或补 feature 用例） |
| 调度：后端 / 服务键 / 探针 / 挂载、per-root 隔离、CAS、无暂停、非严格一次 | 部分 | `tests/e2e/schedule-surface.test.mjs`（A/B 各自正控、门面投影、按根隔离） | CAS 冲突、无暂停、非严格一次属官方语义 / 边界 |
| 子代理：one-shot / external / exact-parent-live / 审批 never / fork seed / 内容隔离 / dock | 部分 | `tests/feature/subagents.test.ts`、`tests/feature/handoff.test.ts` | 审批 / 续聊路径未取证（边界或补用例） |
| 会话控制器：只暴露 `resolveAgent`、两种形状、能力快照 | 部分 | `tests/e2e/capability.test.mjs`（服务键存在、工具表）、`tests/feature/cross-root.test.ts` | `resolveAgent` 两种返回形状未逐条取证 |
| 跨根九面：transcript / 草稿 / 队列 / 附件 / 审批 / 问卷 / 终端 / Monitor / 调度 | 覆盖 | `tests/e2e/cross-surface.test.mjs`（8 项，Monitor 含 B 面板正控）+ `tests/e2e/schedule-surface.test.mjs`（A/B 正控 + 门面投影） | 无（调度无 UI，按服务 / 存储隔离取证） |
| 键位：D01 注册表汇总并生成文档 | 覆盖 | `tests/e2e/release.test.mjs`「keymap 文档与源码一致」 | 无 |
| 压缩：官方 `/compact` 转发 | 边界 | `src/controls/feature-host.ts` 检索官方命令并原样转发（含 `/compact`） | nano 无独立压缩 UI / 证据；压缩行为由官方核心负责 |

## 边界（2026-10-30 owner 已认可）

1. IME 真输入法组合：终端 / 输入法负责预编辑，自动化只覆盖 parser 的 UTF-8 / grapheme。
2. 真实物理断网：只能模拟连接不可达（`127.0.0.1:9` 连接被拒）；不切系统网络。仓库没有 DNS 用例，不宣称验证过 DNS。
3. 冷改名四种失败路径、终端缺口 / 背压、`!` inject step boundary、Monitor 切根停止、子代理审批 / 续聊、调度 CAS / 无暂停 / 非严格一次：本版无对应 UI 或属官方语义；按边界或后续单处理。
4. 压缩：nano 不实现独立压缩界面，`/compact` 原样转发官方命令；压缩行为与证据由官方核心负责。该行归类随 2026-10-30 PR #103 修订（用户选「改」）一并获批。
5. `dist.integrity`：必须发布 registry 后 `npm view`；本版不发布，保留本地期望值，发布后外部核对。

## 结论

- 功能面 16 组中 2 组「覆盖」、13 组「部分」、1 组「边界」（压缩）；另有 5 条边界说明（含物理断网、`dist.integrity`）由 owner 2026-10-30 认可。
- 断网 PTY 模拟已补，但只有「连接被拒」一条路径；真实物理断网按边界认可。
- B3 九面已覆盖：`cross-surface.test.mjs` 8 项 + `schedule-surface.test.mjs` 1 项（含 A/B 正控与门面投影）。
- 本版不发布；`dist.integrity` 留作发布后外部核对。
