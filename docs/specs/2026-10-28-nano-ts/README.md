# [2026-10-28-nano-ts/总纲] TypeScript 单进程重写

- 组标识：`2026-10-28-nano-ts`；角色：总纲，迁移约束、共享约定、交付物地图与依赖台账的唯一入口。
- 结构：1 总纲 + 3 份执行 spec（S01 α / S02 β / S03 γ）；用户 2026-10-28 选择拆 3 份。
- 状态：草案；三份子件均未实施。
- 上游决定：[ADR-20261028-implementation-language-typescript](../../decisions/2026-10-28-implementation-language-typescript.md)。
- 行为权威：[`2026-10-20-nano-v1`](../2026-10-20-nano-v1/README.md)（A–K 各节继续有效；仅 S01 的运行时与进程形态由本组取代）。
- 替代关系：只替代 v1 的实现语言与运行形态；不替代业务行为。旧 TS 方案（PR #83）已废弃。
- 适用环境：macOS arm64 + Ghostty，全屏优先。
- 官方基线：`0.2.1-rc.2`；能力快照为启动门槛，版本号只作辅助。
- 合入前提：S01 的 phase-0 通过（真实官方核心组装 + stdout 纯净 + 首帧 + 一轮真实对话）。

## 1. 目标与非目标

**目标**：在官方 DSH 核心之上，用单一 TypeScript 代码库实现 nano 的终端界面；单 Node 进程、进程内事件、无自造协议；保留 v1 已验收的业务行为。

**非目标**：

- 不重写 Agent、模型、工具、沙箱、会话、权限与持久化。
- 不做多后端（Claude / Codex）、插件市场、远程宿主、MCP 管理、检查点回滚。
- 不引入第二套视觉体系；沿用现行主题与间距 ADR。
- 不做 Rust 与 TypeScript 并存，不做「先并行再切」。

## 2. 已确认决定

| 决定 | 内容 | 影响 |
|---|---|---|
| 实现语言 | TypeScript；Rust 打 `rust-final` tag + `archive/rust-v1` 分支后退场 | 61,395 行 Rust、789 个测试退出主线 |
| 运行形态 | 单一 Node 进程；无第二进程、无 `nano.*` 协议、无 fd 3/4 | 桥接层与协议契约不再存在 |
| 组装方式 | 自己建 Cordis 根，用官方 `dsh-app-boot` 组装官方核心 profile；nano UI 挂同一根 | 不再以 `dsh --profile` 启动；phase-0 不成立时回退该入口 |
| 渲染底座 | `react-reconciler` + Yoga；不用 Ink 的渲染 / 输出 / 输入层 | 终端层自写，布局用 Yoga 子集 |
| 终端所有权 | nano 独占 fd 0/1、raw mode、resize；官方日志走 stderr 或文件 | stdout 污染即启动失败；需实测证据 |
| 行为权威 | v1 规格冻结；业务语义不变，实现重写 | 任何语义变化必须显式记录 |
| 结构 | 1 总纲 + 3 执行 spec + 3 张执行 issue + 1 张仅跟踪父单 | 按 α → β → γ 顺序推进 |

## 3. 运行结构与官方交互

```text
Ghostty
  └─ nano（本包 bin，唯一 Node 进程）
       ├─ 自建 Cordis 根
       │    ├─ 官方核心 profile（dsh-app-boot 组装）
       │    └─ nano 插件（UI / 输入 / 渲染，同一根）
       └─ 官方 DSH：Agent / 模型 / 工具 / 会话 / 权限 / 持久化
```

- **启动**：解析已安装的官方包与 `$DSH_HOME`，建立 Cordis 根，用 `dsh-app-boot` 的 `composeEntries` / `loadProfile` 组装核心；随后挂载 nano 插件并接管终端。**不启动第二个进程**。
- **直接调用**：`ctx.agents`、`ctx.sessions`、`ctx.sessionQuery`、`ctx.userQuestions`、审批 waterfall、附件、`ctx.controls`、调度、终端、任务、子代理等公开导出；没有协议与序列化。
- **直接订阅**：`session/event`、`agent/assistant-stream`、`agent/status`、inbox、决策、jobs / monitor 事件；类型来自官方 `.d.ts`。
- **事实源**：会话、工具结果、队列、权限、持久化以官方记录为准；nano 只保留展示缓存、草稿、阅读锚点，不写第二份历史。
- **能力快照**：启动时核对必需能力（会话 / 审批 / 问卷 / 附件 / 调度 / 终端 / 任务 / 子代理 / 模型 / 权限）；缺失即明确失败并给修复路径，不降级猜。
- **回退**：phase-0 若证明 `dsh-app-boot` 组装不可行，回退到官方 `dsh --profile dsh-tui-nano` 入口；其余决定（TS、渲染、终端、功能）不变，并在 ADR 记录。

## 4. 技术栈与依赖

| 层 | 选型 |
|---|---|
| 语言 / 运行时 | TypeScript + Node（下限跟随官方 `engines`） |
| 官方集成 | `@deepseek-ai/*` 核心包（版本区间实施时冻结）、`cordis`、`dsh-app-boot` |
| UI | `react` + `react-reconciler` |
| 布局 | `yoga-layout`（优先 WASM 构建；实施时确认无平台二进制）；只用 S01 §3.2 写死的子集 |
| 文本 | `string-width` 或等价的显示宽度计算；CJK / emoji / ZWJ / 组合字符自测 |
| 内容 | markdown 子集（`micromark` 或 `marked`）；代码高亮（`shiki` 或轻量 `prismjs`，实施时定） |
| 测试 / 构建 | `vitest` 或 `node:test`；`tsc` 或 `tsup`；`biome` |
| 明确不用 | Ink、`node-pty`、自建 PTY / Cron / 任务表、native 二进制、`nano.*` 协议 |

依赖版本不在 spec 写死；实施时选定并写入 README，锁定后随官方升级窗口更新。

## 5. 跨份共同规则

- 只有一份实现：Rust 归档后主线的 `crates/` / `Cargo.*` / `bridge/` / `protocol/` 不再并存；删除由 S03 执行。
- 官方记录是事实源；nano 不写第二份会话历史、不改官方存储、不复制凭据。
- 终端所有权与 stdout 纯净由 S01 负责，S02 / S03 不得绕过单写入器直接写 fd 1。
- 能力快照与失败分类沿用 v1：不可继续 / 可降级 / 内部错误；缺失必需能力不降级启动。
- 任一语义变化必须在对应子 spec 与 PR 显式记录；不得用「换语言」静默丢功能。
- 观察式收尾不纳入本单；完成 = 约定功能 + 测试 + 真实证据 + 无未处理阻断。

## 6. 交付物地图

| 子 spec | 产出 | 消费 | 文件 owner | 不碰 | 开始 / 合入 / 发布 | 波次 |
|---|---|---|---|---|---|---|
| [S01 α：运行时、渲染与对话](S01-runtime-render-conversation.md) | 自建根与官方核心组装、终端独占、渲染/输入内核、真实对话与阅读决策 | 官方公开导出 | `package.json`、`src/boot`、`src/runtime`、`src/render`、`src/input`、`src/theme`、`src/conversation`、`src/transcript`、`src/decisions` | S02/S03 的文件、官方存储 | spec 合并后开始 / phase-0 + α 验收后合入 / 由 S03 发布 | A |
| [S02 β：输入、会话与功能面](S02-input-sessions-terminal.md) | 输入与会话控制、附件/技能、终端/任务/Monitor/调度/子代理 | S01 的 render/input/transcript 契约 | `src/attachments`、`src/sessions`、`src/controls`、`src/skills`、`src/terminal`、`src/jobs`、`src/monitor`、`src/schedule`、`src/subagents` | `src/render`、`package.json`、S01/S03 的文件 | S01 契约冻结后开始 / β 验收后合入 / 由 S03 发布 | B |
| [S03 γ：打包与发布](S03-release.md) | npm 包与安装器、发布验收、证据归档、Rust 资产退场 | 全部成果 | `packaging/`、`tests/e2e/`、`docs/release/`、`README.md`、`README.en.md`、键位与证据目录 | 代其他子件补写功能 | S01 包入口可备数据 / γ 验收后合入 / 本份负责发布 | C |

## 7. 依赖台账

| ID 与提供方 → 消费方 | 类型 / 产物 | 就绪条件、证据、owner 与波次 |
|---|---|---|
| D01 S01 → S02 | 契约：render / input API、transcript 只读接口、场景注册 | S01 用夹具渲染稳定帧并冻结组件 API；owner S01；波次 B |
| D02 S01 → S03 | 运行时：包入口、启动/退出、终端恢复、证据 harness | S01 phase-0 与 α 验收通过；owner S01；波次 C |
| D03 S02 → S03 | 验收：功能面证据、键位表、真实服务结果 | S02 β 验收通过；owner S02；波次 C |
| D04 S01 + S02 → S03 | 发布：同批验收与发布矩阵 | α/β 成果齐备，S03 为收尾份；owner S03；波次 C |

## 8. 迁移与资产

- 合并本组 spec 前：在 `main` 打 tag `rust-final` + 分支 `archive/rust-v1`。
- S03 实施时删除 `crates/`、`Cargo.toml`、`Cargo.lock`、`rust-toolchain.toml`、`protocol/`，并从 `bridge/` 吸收仍需保留的业务逻辑到 `src/`。
- 数据根 `~/.dsh-tui-nano` 沿用；官方 `$DSH_HOME` 与会话存储不动；挂载账本 pid 改为本进程 pid。
- 不并存第二套实现；历史留在 git。

## 9. 机制清单

| 机制 | 解决什么 / 没有会怎样 | 确认与代价 |
|---|---|---|
| 自建 Cordis 根 + 官方核心组装 | 自有入口、首帧与终端所有权；没有则回到 `dsh --profile` 客人形态 | 用户 2026-10-28 选择；phase-0 验证；代价是自己管组装与版本 |
| `react-reconciler` 自写 host config | 用 React 的树与生命周期，自己定终端 cell 语义；没有则要自造协调器 | 用户已批准；代价是调度与虚拟化自担 |
| Yoga 布局子集 | 复用成熟 flexbox，避免自写布局引擎 | 用户 2026-10-28 选择；代价是依赖与语义边界 |
| cell 双缓冲 + 最小 diff + 单写入器 | 全屏、长会话与无撕裂；没有则全量重绘 / 半帧 | 本次新增；代价是终端层自写 |
| 终端独占 + stdout 证据 | 官方日志污染会毁屏；没有则花屏不可复现 | 本次新增；最高优先，phase-0 实测 |
| Rust 资产归档 | 不并存第二套实现，保留历史 | 用户 2026-10-28 拍板；代价是丢弃 Rust 资产 |
| 能力快照 | 官方 rc 期能力变动；没有则升级即死 | 沿用 v1 思路；不宣称能发现语义漂移 |
| 行为承接对账 | 防止「换语言」变成「丢功能」 | 本次新增；代价是人工逐项核对 |

## 10. 自定细节

- 包名与 bin 名沿用 `dsh-tui-nano` / `nano`；数据根 `~/.dsh-tui-nano`；官方 `$DSH_HOME` 不动。
- 目录结构按 §6 的 owner 划分；新增目录先改总纲地图。
- `react` / `react-reconciler` / Yoga / 官方包版本在实施时选定并锁定，不在 spec 写死。
- 备用屏幕是否启用由 S01 与 S03 共同决定。
- 图片协议（Kitty / Sixel）不在本次范围；需要时另立需求。

## 11. 审核修订记录

（待审核后填写）
