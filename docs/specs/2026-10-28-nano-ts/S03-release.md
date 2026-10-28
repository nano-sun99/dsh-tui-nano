# [2026-10-28-nano-ts/S03] γ：打包、发布与 Rust 退场

- 组标识：`2026-10-28-nano-ts`；角色与编号：子件 S03；目标是交付一个可安装、可升级、可卸载、可验收、可发布的 npm 形态产品，并完成 Rust/bridge 退场。
- 总纲：[共享约定与依据](README.md)。上游依赖：S01（包入口/运行时）、S02（功能面/键位注册）。下游影响：无。
- 合入前提：S01 包入口与 npm manifest 清单可备数据；S02 功能面与键位注册冻结；本份是收尾份，负责发布。

## 1. 边界与文件 owner

拥有：`packaging/`、`tests/e2e/`、`docs/release/`、`README.md`、`README.en.md`、键位文档与最终证据归档。

不碰：业务功能实现；发现功能缺失时报告并退回对应子件。`package.json` 由 S01 独占，本份提供 npm manifest 清单由 S01 合入：
`private: false`、`version`、`dependencies`（官方包）、`scripts`（`build`/`test`/`prepack`/`lint`，删除 cargo/bridge 脚本）、`bin`（`nano` → 编译后入口）、`files`（编译后 JS + bin + 必要元数据）、`engines`（`node >= 22.19`）、`publishConfig`（`access: public`）、`prepack`（构建 + 校验产物）。

## 2. 包结构与安装

- 单一 npm 包，`bin` 暴露 `nano`；Node ≥22.19（当前依赖树最严 `engines`）。
- 版本口径：harness 包（`dsh-base`/`dsh-app-boot`/`dsh-session-controller`/`dsh-schedule` 等直接挂载项）**精确** `0.2.1-rc.2`；其依赖的 `@deepseek-ai/*`（cordis 4.0.5、cordis-plugin-* 1.x 等）跟随官方树锁定，不自选版本；未知 harness 版本拒绝启动。
- 官方依赖树自带 native 预编译包（node-pty/koffi/sharp/node-addon-require-builtin）；**nano 自身不新增原生 addon**，不承诺整条依赖树无 native。
- 应用自持 profile 放数据根；不写 `$DSH_HOME/profiles`；`$DSH_HOME` 只保留 `.anonymous-user-id` 等官方标识；不保留 `dsh --profile` 回退（用户 2026-10-28 决定）。
- 安装/升级/卸载走 npm；数据根默认保留，`--purge` 才删除。
  - **普通卸载**：删包/bin，**保留数据根与应用 profile**（重装可续）；`$DSH_HOME` 除官方标识外不变。
  - **`--purge` 卸载**：再删数据根（含 profile、sessions、runtime-data、history）。
  - 安装/卸载前后对 `$DSH_HOME` 做哈希比对，只允许 `.anonymous-user-id` 出现或不变。
- `npm pack` 内容白名单：只含编译后 JS、bin、必要元数据；不含 `crates/`、`bridge/`、`tests/`、`docs/`、证据与开发脚本；安装后 `nano` 可执行。
- 旧 Rust 资产必须删除或重写：`packaging/install.sh|build-release.sh|uninstall.sh|verify-install.sh`、`packaging/manifest.json`、`packaging/README.md`、Rust 期证据脚本、`tests/e2e` 的 cargo 命令；仓库内只保留 npm 一条安装路径。

## 3. 发布闸门

### 3.1 阻断定义（沿用 v1 S13）

| 编号 | 阻断条件 |
|---|---|
| B1 | 数据丢失（会话/草稿/附件/调度表） |
| B2 | 凭据/PII 泄漏，含证据未脱敏 |
| B3 | 跨会话/跨根串内容 |
| B4 | 无法启动、无法退出、终端无法恢复 |
| B5 | 权限绕过；首启不显示配置/凭据/全局指令来源 |
| B6 | 会话无法恢复；交付物与契约冲突 |

任一未关闭不得发布。

### 3.2 发布结论

`docs/release/<version>/release-conclusion.md` 逐项给「通过 / 未验证 / 阻断」+ 证据链接；未验证不算通过；全部标未验证不得发布。
- 审计档位：发布前至少「轻审」（4 份独立视角）；涉及安全/权限/跨会话的项必须「重审」或人工实测并留记录；发布结论写明本次用了哪档。

### 3.3 矩阵

| 维度 | 必测 |
|---|---|
| 版本 | `npm pack` SHA-256、官方精确版本/来源、Node、Ghostty、macOS、CPU、日期 |
| 启动 | pre-boot 首帧、二次启动、恢复会话；核心加载失败有可见错误 |
| 主链路 | 对话 → 工具 → 差异 → 审批 → 完成 |
| 功能面 | 附件/图片/技能/模型/权限/压缩/终端/任务/Monitor/调度/子代理 |
| 视觉 | 主题/间距 ADR、深/浅、60/100 列、diff 8 行、CJK/窄屏 |
| 长会话 | 1000 行滚动/流式/resize p50/p95、5000 行内存曲线 |
| 异常 | 断网、官方异常、SIGTERM、SIGKILL 后重启、终端残留、`reset` 提示 |
| 安全 | 审批无答即拒、Monitor `notify` 默认关闭且计费提示、`!` 权限提示、terminal 不进 Agent 工具表 |
| 跨会话 | transcript/草稿/队列/附件/审批/问卷/终端/Monitor/调度九面隔离；双窗口同根拒绝、双 root 并发 |
| 架构 | 单进程、无 `nano.*` 协议、无第二宿主；运行时 stdout/stderr 守护 |
| 证据 | 合成 HOME/DSH_HOME/数据根；真实路径/用户名/主机名/密钥/用户正文脱敏；证据绑定发布产物 |

## 4. Rust 与 bridge 退场

- 合并本组 spec 前：`main` 打 tag `rust-final`（记录 SHA）并推 `archive/rust-v1`；`git rev-parse`/`git ls-remote` 验证。
- 删除 `crates/`、`Cargo.toml`、`Cargo.lock`、`rust-toolchain.toml`、`protocol/`、`bridge/`；按 S01/S02 的 bridge 处置表吸收业务逻辑，未列模块必须标注「不承接」及原因。
- 删除后检查限定源码：`git grep 'cargo\|Cargo\|@dsh-tui-nano/bridge\|nano-protocol' -- src package.json packaging tests scripts` 为空（docs 中历史规格不算）；仓库可构建、测试、打包；旧 Rust 发布证据标为历史，不作为 v2 发布依据。
- `main` 上并发开发可能产生冲突：删除以合并后的 `main` 为准，先 rebase 再删，不force 覆盖他人改动。

## 5. 键位与文档

- 键位单一源 `src/input/keymap.ts`（S01）；S02 只注册功能键；本份从源生成 README/`--help` 并加 diff 检查；中英文 README 同步。
- README 保留主题与透明、架构、许可证/致谢等章节；已知限制必须含：无崩溃隔离、共享事件循环上限、强杀后终端可能残留、调度无暂停、投递非严格一次、Monitor `notify` 计费、三处用户变更（总纲 §5.2）。
- 首启显示配置/凭据/全局指令实际来源（B5）；不复制凭据值。

## 6. 验收

- 全新安装 → 启动 → 升级 → 卸载 → 重装；每步有前后文件清单/哈希；普通卸载保留数据根/profile、`--purge` 删除；`$DSH_HOME` 除官方标识外不变。
- e2e 覆盖主链路、功能面、异常、跨会话、多窗口、单进程/无协议、运行时 stdout；证据按 §3.3 脱敏并绑定 `npm pack` 哈希。
- Rust/bridge 删除后主仓可构建、测试、打包；tag/归档可查。
- 发布结论逐项有证据；阻断项为零；未验证项显式列出，不冒充完成。

## 7. 审核修订记录

- 2026-10-28 重审 8 份后按发现重写：native 口径、精确版本、应用自持 profile、卸载残留定义、npm manifest owner、bridge 退场、发布闸门/阻断/脱敏、键位单一源、旧安装器处置；完整清单在 PR #84 评论。
- 2026-10-28 轻审修订：npm manifest 完整清单、harness 精确/其余跟随口径、普通卸载保留 profile 与 `--purge` 区分、B1–B6 阻断表、发布审计档位、Rust 退场 grep 限定范围与旧 packaging 文件清单。
