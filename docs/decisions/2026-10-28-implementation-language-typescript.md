# ADR-20261028-implementation-language-typescript：实现语言改为 TypeScript，运行形态改为单 Node 进程

- 状态：生效中
- 日期：2026-10-28
- 决策人：用户
- 适用范围：nano 的全部实现代码、构建、分发与运行时形态
- 取代：无
- 被取代：无
- 决策来源：2026-10-28 用户拍板（本会话选型：纯 TypeScript、单进程、自己组装官方核心、reconciler + Yoga、Rust 归档）；规格 `2026-10-28-nano-ts`

## 决定

1. 实现语言改为 TypeScript，运行形态改为单一 Node 进程；不再有 Rust 窗口进程、`nano.*` 跨进程协议与 fd 3/4 帧传输。
2. 自己建立 Cordis 根，用官方 `dsh-app-boot` 的 `boot()` + `PluginPackages` + `profileContext` + `appReady` 组装 DSH 核心；profile 应用自持（数据根），nano UI 作为同根插件。不以 `dsh --profile` 启动，**不保留回退**（用户 2026-10-28 决定）。
3. 渲染底座为 `react-reconciler` + Yoga；不使用 Ink 的渲染 / 输出 / 输入层。
4. 官方 DSH 独占 Agent、模型、工具、会话、权限与持久化；nano 只消费公开导出。
5. 终端所有权归 nano：独占 fd 0/1 与 raw mode；官方日志走 stderr 或文件。
6. Rust 资产打 `rust-final` tag + `archive/rust-v1` 分支后退场，不并存第二套实现。
7. 保留三处与 v1 不同的行为（用户 2026-10-28 拍板）：Monitor 默认 `quiet`；冷会话改名允许先取写权限；权限切换失败保留原值并显示原因。代价与缓解见规格 §5.2。

## 依据

- 单进程与单语言消除 1 套 70 方法、78 形状、74 错误码的自造跨进程契约，以及围绕它的帧编解码、有界写与双保险版本校验。
- 官方公开导出为 MIT，随包 `.d.ts` 可直接复用；本决定只消费公开导出，不复刻内核。
- phase-0 spike（2026-10-28）实测：`boot()` + `PluginPackages` + `profileContext` + `appReady` 起 dsh-base，505–826ms、87 个服务、启动 stdout 0 写入、storage 根写入数据根；`composeEntries`/`loadProfile` 单独调用不能启动核心。
- 用户明确要求“尽可能性能好且不要东一块西一块”，并接受用自写终端层换取全屏、鼠标、cell diff 与虚拟化的控制力。

## 否决了什么

1. **Ink 作为最终渲染器**：全屏、鼠标、hit-testing、虚拟化、cell 级 diff、kitty keyboard 不在 Ink 核心；要做到需 fork 移植，自由度不足。否决的是“最终渲染器”，不否决借鉴其 reconciler/Yoga 经验。
2. **napi-rs 混合（Node 宿主 + Rust 渲染 addon）**：仍是双语言，增加原生打包、崩溃域合并与事件循环边界；用户判定长期成本高于收益。技术可行，若将来重新追求渲染极致可重开。
3. **Rust UI + 自组装 Node 核心 + IPC**：去掉了官方 CLI/profile 壳，但桥接与双进程仍在，不满足“少零散”。
4. **`dsh --profile` 回退**：需要另一套 profile bundle、安装器、bin 转发与终端语义；phase-0 已通过，用户 2026-10-28 决定去掉回退。
5. **Rust 重写内核**：Agent / LLM / 工具 / 会话均为 TS/Cordis，重写等于重造 DSH，不现实。
6. **保留 Rust 双实现**：两套实现会立即漂移；改为 tag + 归档分支。

## 接受的代价

- 丢弃 61,395 行 Rust 与 789 个测试；边界知识需在 v2 重新发现，靠 v1 规格冻结为行为权威缓解。
- 自建 Cordis 根意味着自己承担模块解析、React/Cordis 单实例、官方包版本对齐与 profile 组装升级；官方依赖树含 native 预编译包，nano 自身不新增原生 addon。
- 三处行为变更的代价：Monitor 默认不唤醒；冷改名会 resume 冷会话并拿写锁；权限失败时界面可能与官方实际值不一致（须提示重开核对）。
- JS 的 GC 停顿与共享事件循环重新成为性能风险面；无崩溃隔离。
- 迁移期无可用产品；Rust 侧验收成果不构成 v2 发布依据。
- 产品差异化收窄：与同生态 TS 产品进入同一技术赛道。
- Node 下限按官方依赖树最严 `engines` 定为 ≥22.19（当前），官方包本身未声明 `engines`。

## 允许重开的条件

1. 真实长会话与真实流式下，滚动或输入延迟出现用户可感知的持续卡顿，且实测归因于 JS 运行时。
2. 渲染优化（虚拟化、增量 diff、离屏预算）用尽仍达不到 v1 已验收的观感基线。
3. 官方核心改为提供语言无关的稳定进程外接口，且覆盖 v1 已交付能力的多数。

不以“理论上 Rust 更快”作为重开依据；须附当次实测数据。

## 关联

- 规格：[`2026-10-28-nano-ts`](../specs/2026-10-28-nano-ts/README.md)
- 冻结的行为权威：[`2026-10-20-nano-v1`](../specs/2026-10-20-nano-v1/README.md)
- 现行相关 ADR：[`2026-10-26-spacing-token-architecture`](2026-10-26-spacing-token-architecture.md)、[`2026-10-28-nano-process-display`](2026-10-28-nano-process-display.md)
