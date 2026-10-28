# [2026-10-28-nano-ts/总纲] TypeScript 单进程重写

- 组标识：`2026-10-28-nano-ts`；角色：总纲，迁移约束、共享约定、交付物地图与依赖台账的唯一入口。
- 结构：1 总纲 + 3 份执行 spec（S01 α / S02 β / S03 γ）；用户 2026-10-28 选择拆 3 份。
- 状态：草案（phase-0 spike 已通过；见 [spike-phase0.md](spike-phase0.md)）。
- 上游决定：[ADR-20261028-implementation-language-typescript](../../decisions/2026-10-28-implementation-language-typescript.md)。
- 行为权威：[`2026-10-20-nano-v1`](../2026-10-20-nano-v1/README.md) 的 S01–S13（§1–§12），叠加现行 ADR 的扩展/取代（input-history、subagent-dock、independent-tui-theme、spacing、process-display）；三处用户变更见 §5.2。
- 替代关系：只替代 v1 的实现语言与运行形态；业务行为除 §5.2 三处及现行 ADR 扩展外不变。旧 TS 方案（PR #83）已废弃。
- 适用环境：macOS arm64 + Ghostty，全屏优先。
- 官方基线：`0.2.1-rc.2`；能力快照为启动门槛。
- 合入前提：phase-0 已通过（自建根、87 服务、stdout 0 写入、storage 根隔离、会话创建/flush）。

## 1. 目标与非目标

**目标**：在官方 DSH 核心之上，用单一 TypeScript 代码库实现 nano 的终端界面；单 Node 进程、进程内事件、无自造协议；保留 v1 已验收的业务行为（除 §5.2）。

**非目标**：不重写 Agent/模型/工具/沙箱/会话/权限/持久化；不做多后端、插件市场、远程宿主、MCP 管理、检查点回滚；不引入第二套视觉体系；不做 Rust 与 TS 并存。

## 2. 已确认决定

| 决定 | 内容 | 影响 |
|---|---|---|
| 实现语言 | TypeScript；Rust 打 `rust-final` tag + `archive/rust-v1` 分支后退场 | 61,395 行 Rust、789 测试退出主线 |
| 运行形态 | 单一 Node 进程；无第二宿主、无 `nano.*` 协议、无 fd 3/4 | 桥接层与协议契约不再存在 |
| 组装方式 | 自建 Cordis 根：`loadProfileDirectory` + `readProfilePatches` + `createRuntimeResolution` + `boot()` + `PluginPackages` + `profileContext`/`appReady` | 不使用 `dsh --profile`；**不保留回退**（用户 2026-10-28 决定） |
| profile 归属 | 应用自持，放在数据根（如 `~/.dsh-tui-nano/profile`）；首次启动自动初始化，升级校验；不写 `$DSH_HOME/profiles` | 卸载默认保留数据根/profile，`--purge` 才删除 |
| 首帧 | pre-boot 最小首帧；核心就绪后接管 | 避免 0.5–0.8s 空白 |
| 渲染底座 | `react-reconciler` + Yoga；不用 Ink 渲染/输出/输入层 | 终端层自写，布局用 Yoga 子集 |
| 终端所有权 | nano 独占 fd 0/1、raw mode、resize；官方日志走文件或受控 stderr | 运行时也需守护，不只启动 |
| 行为权威 | v1 S01–S13 + 现行 ADR（input-history / subagent-dock / independent-tui-theme / spacing / process-display）；除 §5.2 三处与 ADR 扩展外语义不变 | 任何其他语义变化必须显式记录 |
| 结构 | 1 总纲 + 3 执行 spec + 3 张执行 issue + 1 张仅跟踪父单 | α → β → γ |

## 3. 运行结构与官方交互

```text
Ghostty
  └─ nano（本包 bin，唯一 Node 进程）
       ├─ 自建 Cordis 根
       │    ├─ 官方核心 profile（应用自持，dsh-base + 官方行）
       │    └─ nano 插件（UI / 输入 / 渲染，同一根）
       └─ 官方 DSH：Agent / 模型 / 工具 / 会话 / 权限 / 持久化
```

### 3.1 组装配方（核心已实测；β 行另测）

1. **确保应用 profile**：`initProfile(dir, ['@deepseek-ai/dsh-base'])` 写 manifest/patch/workspace，但它**不写 `cordis.yml`**，随后补 `[]`；三份文件逐项检查，缺失才补，禁止 0 字节；损坏先备份再报错，不覆盖 settings。`loadProfileDirectory` 不是纯只读（可能重写 manifest、`skippedBundles` 不抛错），启动后必须检查。
2. **解析根身份**：`--root` → `last-root` → 生成；同一 ID 用于 storage 根、schedule 根、认领、handoff、`sessions.create`；不一致硬失败。进备用屏前先取挂载认领。
3. 追加 patch 行：`tool-ask-user`（默认 blocking；timed 配置落 active preset config）、`file-reference-local { maxResults: 20 }`；β 再加 `@deepseek-ai/dsh-api-terminal-controller`。
4. 追加 storage patch：`session-persistence-jsonl.root = <数据根>/sessions`、`storage-json.root = <数据根>/runtime-data/<root>/storage`；`storage-domain` 沿用 base `{ backend: 'json' }`；关 HMR。
5. `createRuntimeResolution` → `boot()`，注入 `profileContext`、`cmdlineArgs`、`appExit`、`appReady`，挂 `PluginPackages`；`appReady.commit()`。不加载官方 `dsh-api-session-controller`（12 个注入服务 + `nativeOpen`，base 缺两项），也不 `provide('storageDomain')`。
6. 核心就绪后再做能力快照（boot 前无服务可查）；`boot` 期间 stdout 0 写入（实测）；`.anonymous-user-id` 仍写 `$DSH_HOME`，是 nano 唯一写入项。
7. β 的 schedule：boot 后注册命名后端 `nano-schedule-json` 并提供 `storageBackendServiceKey`，`storage-domain` 路由 `{ schedule, nano_probe }` 指向它；探针通过后再手动挂官方 `ScheduleService`。`sessionController` 适配器只提供 `resolveAgent`。

### 3.2 官方交互

- 直接调用 `ctx.agents`、`ctx.sessions`、`ctx.sessionQuery`、`ctx.userQuestions`、审批 waterfall、附件、终端、jobs、skills、commands、subagents；无协议/序列化。
- 直接订阅 `session/event`、`agent/assistant-stream`、`agent/status`、inbox、决策、jobs/monitor 事件。
- 官方记录是事实源；nano 只保留展示缓存、草稿、阅读锚点。
- 能力快照在 boot 之后执行；必须逐项断言必需服务与工具（含 `ask_user_question`），不能只依赖 `boot()` 的 required 列表。

### 3.3 生命周期

- 启动顺序：确保 profile → 解析根身份 → 获取挂载认领 → pre-boot 骨架（进备用屏、接管 fd 0/1、raw mode）→ fd 级 stdout/stderr 捕获 → boot 核心 → 能力快照 → 挂 UI → 正式首帧 → 接受输入。认领失败发生在进备用屏之前；画骨架必须先占终端。
- 启动失败两段：骨架前（profile/版本/认领）写 stderr 退出；骨架后（boot/快照）恢复终端、写 fd 2、非零退出。
- 根切换/冷改名：单进程不做在线 storage 路由替换；受控进程重启 = 冻结输入 → 原子写 handoff（tmp+fsync+rename、0600、版本、读后删）→ 停 schedule/Monitor/PTY、取消在飞 → flush → 杀死并核验 PTY 进程组 → 释放 claim → exec self `--root <id>`。新进程提交成功后才删 handoff；认领/boot/handoff/rename 任一失败都恢复终端、保留 handoff、不建替代会话。冷改名即切到该会话（保持单主会话），改名后留在该根。
- 关停阶段：冻结输入 → 排空生产者（S02 hooks）→ 排空持久化 → 释放 schedule 租约 → 释放挂载认领 → 恢复终端（finally，预留预算）→ 退出；每阶段独立截止，总优雅 10s；「3s 强制」= 恢复终端并非零退出；清理失败保留认领并报告。
- `uncaughtException`/`unhandledRejection` 走同一关停路径；SIGINT/SIGTERM/SIGHUP 有界关停并逐项报告；SIGKILL 后下次启动检测脏状态提示 `reset`。
- 官方 HMR 关闭（`hmr disabled`）；profile/settings 写入由应用自持 profile 承担。

## 4. 技术栈与依赖

| 层 | 选型 |
|---|---|
| 语言/运行时 | TypeScript + Node ≥22.19（当前官方依赖树最严 `engines`；实施时冻结） |
| 官方集成 | `@deepseek-ai/dsh-base`、`dsh-app-boot`、`dsh-api-terminal-controller`、`dsh-schedule`、`dsh-tool-ask-user`、`dsh-file-reference-local`；harness 包精确 0.2.1-rc.2，其余 `@deepseek-ai/*` 用 `overrides` 锁官方树版本；不加载官方 session-controller，nano 自提供最小 `resolveAgent` 适配器；Cordis/React 单实例校验，未知 harness 版本拒绝 |
| UI | `react` + `react-reconciler`（React 19） |
| 布局 | `yoga-layout`（WASM，无平台二进制）；只用 S01 §3.2 子集 |
| 文本 | `string-width` 或等价显示宽度；CJK/emoji/ZWJ/组合字符自测 |
| 内容 | markdown 子集（`micromark` 或 `marked`）；代码高亮（`shiki`/`prismjs`，实施时定） |
| 测试/构建 | `vitest`/`node:test`；`tsc`/`tsup`；`biome` |
| 原生 | nano 自身不新增原生 addon；官方依赖树自带 node-pty/koffi/sharp/node-addon-require-builtin/node-addon-system 等预编译包 |
| 明确不用 | Ink、自建 PTY/Cron/任务表、`nano.*` 协议 |

## 5. 跨份共同规则

### 5.1 共同约束

- 只有一份实现：Rust 归档后 `crates/`、`Cargo.*`、`bridge/`、`protocol/` 不再并存；删除由 S03 执行，bridge 业务逻辑按 §8.2 吸收。
- 官方记录是事实源；nano 不写第二份会话历史、不改官方存储、不复制凭据。
- 终端单写入器；S02/S03 不得绕过 S01 直接写 fd 1。
- 能力快照失败即启动失败并点名；缺失必需能力不降级。
- 观察式收尾不纳入本单；完成 = 约定功能 + 测试 + 真实证据 + 无未处理阻断。

### 5.2 用户 2026-10-28 明确保留的三处语义变更

| 行为 | v1 | v2（用户拍板保留） | 代价/缓解 |
|---|---|---|---|
| Monitor 默认 | `notify` | 默认 `quiet`；切 `notify` 需明确开关与告知 | `quiet` = 官方 inject：不唤醒、不新建 turn，内容进入下一个被接受的步骤，随下一次请求计费；必须显示「notify 会计费」 |
| 冷会话改名 | 一律拒绝，先打开 | 允许先取写权限再改名 | 走受控重启；任一时刻只有一个 live 根；UI 显示 writer-held 与单主会话状态 |
| 权限切换失败 | 重读官方投影，显示实际值（可能 custom/半切换） | 保留原值并显示失败原因 | 可能显示与官方实际权限不一致；必须提示「可能已部分生效，请重开 /permission 核对」 |

这三处是用户本轮明确变更；现行 ADR（input-history / subagent-dock / independent-tui-theme / spacing / process-display）的扩展/取代同样生效。除此之外不允许偏离 v1 + 现行 ADR；任何进一步变化必须显式记录。

## 6. 交付物地图

| 子 spec | 产出 | 消费 | 文件 owner | 不碰 | 开始 / 合入 / 发布 | 波次 |
|---|---|---|---|---|---|---|
| [S01 α](S01-runtime-render-conversation.md) | 自建根/核心组装、pre-boot 首帧、终端独占、渲染/输入、真实对话与阅读决策 | 官方公开导出 | `package.json`、`src/boot`、`src/runtime`、`src/render`、`src/input`、`src/theme`、`src/conversation`、`src/transcript`、`src/decisions`、`tests/unit`、`docs/evidence/2026-10-28-nano-ts/alpha` | S02/S03 文件、官方存储 | spec 合并后 / phase-0+α / 由 S03 发布 | A |
| [S02 β](S02-input-sessions-terminal.md) | 输入/会话/控制/附件/技能、终端/任务/Monitor/调度/子代理 | S01 render/input/transcript/keymap/scene 契约 | `src/attachments`、`src/sessions`、`src/controls`、`src/skills`、`src/terminal`、`src/jobs`、`src/monitor`、`src/schedule`、`src/subagents`、`tests/feature`、`docs/evidence/2026-10-28-nano-ts/beta` | `src/render`、`package.json`、S01/S03 文件 | S01 契约冻结后 / β / 由 S03 发布 | B |
| [S03 γ](S03-release.md) | npm 包、发布验收、证据、Rust 与 bridge 退场 | 全部成果 | `packaging/`、`tests/e2e/`、`scripts/`（Rust 期证据脚本）、`docs/release/`、`README.md`、`README.en.md`、键位文档；仅删除 `crates/`、`Cargo.*`、`rust-toolchain.toml`、`protocol/`、`bridge/` | 代其他子件补写功能 | S01 包入口 + S02 键位冻结 / γ / 本份发布 | C |

- `package.json` 由 S01 独占；S03 提供 npm manifest 清单（`private` 处置、`version`、`dependencies`、`scripts`、`bin`、`files`、`engines`、`publishConfig`、`prepack`），由 S01 合入。S02/S03 的依赖变更同样经 S01。
- 键位单一源：S01 拥有 `src/input/keymap.ts`；S02 只注册功能键；S03 从该源生成 README/`--help` 并加 diff 检查。
- README 由 S03 拥有；S01/S02 提供章节内容，不直接写 README。备用屏由 S01 决定，S03 写入 README。
- 证据：S01/S02 各写自己的证据目录；S03 只做发布级 e2e 与最终归档。

## 7. 依赖台账

| ID | 提供方 → 消费方 | 类型 / 产物 | 就绪条件、证据、owner、波次 |
|---|---|---|---|
| D01 | S01 → S02 | 契约：render/input API、可交互 transcript（含子地址）、场景/焦点、keymap 注册 API、有序输入段与附件段、草稿/光标/锚点保存恢复、审批/问卷地址隔离、终端 cell 网格/VT、根会话身份、mount claim/release、lifecycle hooks（阶段/截止/隔离）、补全 provider、补全打开输入模式、历史读写（项目过滤/100 条/子代理投影）、合成 transcript 条目、boot 后服务/挂载扩展点、handoff 读写 | S01 夹具稳定帧 + 组件/API 冻结 + 单测 + 接口文件；owner S01；B |
| D02 | S01 → S03 | 运行时/发布：包入口、pre-boot 首帧、关停、证据 harness | phase-0+α 通过；owner S01；C |
| D03 | S02 → S03 | 验收：功能面证据、键位注册、真实服务结果 | β 通过；owner S02；C |
| D04 | S01+S02 → S03 | 发布：同批验收、发布矩阵、release conclusion | α/β 齐备；owner S03；C |
| D05 | S01+S02 → S03 | 迁移：bridge 逐模块处置表；S01/S02 吸收业务，S03 承接安装/卸载、e2e 重写与删除 | 处置表逐项勾 + 吸收验收；owner S01/S02（吸收）、S03（安装/卸载、e2e、删除）；C |

## 8. 迁移与资产

### 8.1 Rust 资产

- 合并本组 spec 前：`main` 打 tag `rust-final`（记录 SHA）并推分支 `archive/rust-v1`；`git ls-remote` 验证。
- S03 删除 `crates/`、`Cargo.toml`、`Cargo.lock`、`rust-toolchain.toml`、`protocol/`、`bridge/`；删除后仓库可构建/测试/打包。

### 8.2 bridge 处置

| bridge 模块 | v2 owner | 落点 / 验收 |
|---|---|---|
| profile/install | S01/S03 | S01 只承接应用 profile 初始化/升级；`dsh plugin --profile` 路径不承接；S03 安装/卸载 |
| runtime/host、frames、writer、events | S01 | boot/关停/事件接线；协议帧与 fd 传输不承接 |
| conversation、decisions | S01 | `src/conversation`、`src/decisions` |
| controls、sessions、skills、attachments、jobs、monitor、schedule、subagents、shell、terminal | S02 | 对应 `src/*` 与 v1 验收 |
| cordis.patch.yml | S01 | 行集（终端/问卷/文件引用/HMR）重写为应用自持 profile 的 patch，不照搬 `dsh plugin` 路径 |
| protocol/、node_modules/、test/ | S03 | 删除 / 重写 e2e |
| 未列模块 | — | 必须标注「不承接」及原因，不得静默丢弃 |

- 删除后检查：`git ls-files -z -- src package.json packaging tests scripts README.md README.en.md AGENTS.md .github .gitignore | xargs -0 grep -nE 'cargo|Cargo|nano-protocol|@dsh-tui-nano/bridge|--bridge-package|target/release|nano-bridge'` 为空；`docs/specs/` 历史规格与 `docs/release/0.1.0/`（标 HISTORICAL）豁免。
- 根 `package.json` 的 cargo/bridge scripts 与 `packaging/` 旧脚本由 S01/S03 重写或删除。

### 8.3 数据

- 数据根 `~/.dsh-tui-nano`；应用自持 profile 放数据根，首次启动自动创建；普通卸载保留数据根/profile，`--purge` 才删除；官方 `$DSH_HOME` 中 nano 只写 `.anonymous-user-id`，其他不改不删。
- 会话/存储根按 §3.1 patch；挂载账本 pid 改为本进程 pid；调度租约沿用 v1 S11。

## 9. 机制清单

| 机制 | 解决什么 / 没有会怎样 | 确认与代价 |
|---|---|---|
| 自建根 + boot/PluginPackages/profileContext/appReady | 自有入口、首帧与终端所有权；没有则回到官方 CLI 客人形态 | 用户 2026-10-28 选择；phase-0 实测 505–826ms、87 服务 |
| 应用自持 profile + 首次初始化/升级 | 干净机器首启可用、不写 `$DSH_HOME/profiles`；卸载默认保留、purge 删除 | 用户 2026-10-28 选择；profile/settings 自管 |
| 最小 sessionController 适配器 | 官方 session-controller 要 12 个服务 + `nativeOpen`，base 缺两项；schedule 只需 `resolveAgent` | 本次新增；S02 经 D01 的 boot 后扩展提供，capability 快照断言 |
| schedule 命名后端 + 探针后挂载 | 保证 per-root 隔离且探针不过不打开表 | 本次新增；S02 验收 |
| 单进程切根 = 受控重启 + handoff | 不替换 storage 路由、不产生第二个 live root | 本次新增；代价是切根会重启进程 |
| lifecycle hooks | S01 关停能清理 S02 资源且不越界 | 本次新增；D01 契约 |
| bridge 处置表 | 不并存第二套实现、不静默丢逻辑 | 本次新增；S01/S02 吸收、S03 删除 |
| pre-boot 最小首帧 | 避免核心加载空白 | 用户 2026-10-28 选择；代价是两套渲染状态 |
| `react-reconciler` + Yoga 子集 | React 树 + 成熟 flexbox；没有则自造协调器/布局 | 用户已批准；代价是版本耦合 |
| cell 双缓冲 + diff + 单写入器 | 全屏、长会话、无撕裂 | 本次新增；终端层自写 |
| 终端独占 + fd 级 stdout/stderr 守护 | 官方日志污染会毁屏；只包 `process.stdout.write` 抓不到原生直写 | phase-0 启动实测 0；运行时仍须守护 |
| storage 根 patch + 根身份认领 | 多窗口/多根隔离；默认会写 `$DSH_HOME` | 本次新增；spike 实测写入数据根；认领先于备用屏 |
| 三处行为变更 | 用户明确保留 | §5.2；代价见该表 |
| Rust 归档 + bridge 处置表 | 不并存第二套实现 | 用户 2026-10-28 拍板 |

## 10. 自定细节

- 包名/bin 名沿用 `dsh-tui-nano` / `nano`；v2 版本 `0.2.0`，发布目录 `docs/release/0.2.0/`，首次发布 dist-tag `next`；数据根 `~/.dsh-tui-nano`；应用 profile 放数据根（`profile/`），首次启动自动创建。
- 目录结构按 §6 owner；新增目录先改总纲地图。
- 版本：harness 包精确 0.2.1-rc.2；其余 `@deepseek-ai/*` 用 `overrides` 锁官方树版本，Cordis/React 单实例校验；未知 harness 版本拒绝启动。
- 首帧骨架的最小内容由 S01 定；备用屏由 S01 决定，S03 写入 README。根切换 handoff 文件位置由 S01 定，S02 负责写入/读取。
- 图片协议（Kitty/Sixel）不在本次范围；图片消息仍走官方附件协议。

## 11. v1 行为承接表

| v1 | v2 owner | 承接方式 |
|---|---|---|
| S01 宿主与通信 | S01 | 重写：自建根 + boot；协议/进程管理消失 |
| S02 对话与输入 | S01（输入基础设施与对话）、S02（输入增强） | 沿用：requestId、回显、attempt、queue/steer/stop/clear、草稿按地址、单次 32 KiB 上限 |
| S03 阅读与决策 | S01 | 沿用：锚点、滚轮、diff 坐标/预算、审批默认拒绝焦点、问卷契约、计划审阅 |
| S04 模型与权限 | S02 | 沿用 + §5.2 权限失败变更 |
| S05 技能与规矩 | S02 | 沿用：命令优先、complete=false、加载顺序/预算 |
| S06 引用与图片 | S02 | 沿用：图片 base64 链、通用文件回执、`@` 语法、`file-reference-local.maxResults: 20` |
| S07 会话与上下文 | S02 | 沿用 + §5.2 冷改名变更；切根走受控进程重启（§3.3） |
| S08 Shell 与任务 | S02 | 沿用：`!` 单次 danger-full-access、不进 job 表、`!!` inject:false |
| S09 交互终端 | S02 | 沿用：retain/attach/sequence/inputFull/背压/权限边界 |
| S10 Monitor | S02 | §5.2 默认 quiet（官方 inject：不唤醒、不新建 turn、随下一次请求计费）；其余沿用（初始偏移、settled readAt、预算耗尽、真实收件） |
| S11 调度 | S02 | 沿用：per-root 后端、租约、无暂停、非严格一次 |
| S12 子代理 | S02 | 沿用 v1 + `ADR-20261022-subagent-dock-lifecycle`（取代 v1 dock 条款）：one-shot/external、exact-parent-live、审批 never、interruptByParent、fork seed |
| S13 发布验收 | S03 | 沿用：阻断定义、版本矩阵、证据脱敏、首启来源；按新架构重写步骤 |

## 12. 审核修订记录

| # | 严重度 | 发现 | 处置 |
|---|---|---|---|
| 1 | 高 | `composeEntries`/`loadProfile` 不能启动核心 | 已改：§3.1 改为 boot + PluginPackages + profileContext + appReady；phase-0 实测 |
| 2 | 高 | storage/session/schedule 根未定义 | 已改：§3.1/§8.3 显式 patch；S02 补 per-root 调度 |
| 3 | 高 | v1 承接表缺失；三处语义反转 | 已改：§5.2（用户保留）+ §11 承接表 |
| 4 | 高 | owner 冲突（package.json/README/bridge/keymap/证据） | 已改：§6/§7/§8.2 单 owner 与 D02/D05 |
| 5 | 高 | 回退是第二套架构且无交付物 | 已改：去掉回退（用户 2026-10-28 决定） |
| 6 | 高 | 「无 native」与官方依赖树矛盾 | 已改：§4 区分 nano 自身与官方预编译包 |
| 7 | 高 | 发布闸门可空转、证据无脱敏/版本矩阵 | 已改：S03 补阻断定义、release conclusion、版本矩阵与脱敏 |
| 8 | 高 | phase-0 时点/回退逻辑 | 已改：phase-0 = 组装 spike（已通过）；真实对话在 α；去掉回退 |
| 9 | 中/低 | 其余 8 份评审条目 | 分配至 S01/S02/S03 的验收与自定细节；完整清单见 PR #84 四份评论 |
| 10 | 高 | 应用 profile 首次初始化未定义 | 已改：§3.1 第 1 步自动创建/升级；卸载默认保留、`--purge` 删除 |
| 11 | 高 | bridge 处置表缺失/owner 对不上 | 已改：§8.2 逐模块表；D05 owner 改为 S01/S02 吸收、S03 删除 |
| 12 | 高 | 现行 ADR（dock/theme）扩展/取代 v1；§5.2「唯一」不成立 | 已改：头部/§5.2/§11 纳入现行 ADR；S01 去掉已取代的 theme-scope |
| 13 | 高 | 单进程切根/冷改名无生命周期 | 已改：§3.3 受控进程重启 + handoff；冷改名即切换并保留单主会话 |
| 14 | 高 | S02 缺 session-controller/schedule 行与适配器 | 已由第 18 条取代：官方 row 不加载，改最小 `resolveAgent` 适配器 |
| 15 | 高 | S01 关停含 S02 资源的反向依赖 | 已改：§3.3 lifecycle hooks（D01） |
| 16 | 高 | D01 契约不足 | 已改：D01 补有序输入/子地址/草稿锚点/审批问卷地址/终端网格/lifecycle |
| 17 | 高 | 卸载定义、Rust 退场 grep、npm manifest | 已改：§8.2/§8.3 与 S03 修订 |
| 18 | 高 | 官方 session-controller 直接挂载会冲突；storageDomain 重复 provide | 已改：§3.1 不加载官方 row、不 provide storageDomain；S02 改为最小 `resolveAgent` 适配器 + 官方 storage-domain 路由 |
| 19 | 高 | 根身份/认领晚于 boot，第二窗口拦不住；profile 空 YAML 必失败 | 已改：§3.1/§3.3 根身份 + 认领先于备用屏；`initProfile` 后补 `cordis.yml=[]`、逐文件修复 |
| 20 | 高 | handoff 草稿与 input-history ADR 冲突；exec/PTY/claim 失败未定义 | 已改：§3.3 原子写/读后删/失败矩阵，标为受控切根显式例外 |
| 21 | 高 | 首启来源无人负责；`--purge` 无入口；manifest 落不了盘 | 已改：首启来源（B8）归 S01 验收；`nano purge` 先于 npm 卸载；S03 给完整 manifest |
| 22 | 高 | 子代理成本是未登记的第四处变更；20 MiB 无依据；`!`/quiet 语义漂移 | 已改：删除成本字段与 20 MiB；`!` 回 step boundary、quiet 回官方 inject |
