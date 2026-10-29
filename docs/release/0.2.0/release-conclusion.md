# 发布结论（0.2.0）

**结论：不发布。**

依据：`docs/specs/2026-10-28-nano-ts/S03-release.md` §3.2——「未验证不算通过；§3.3 的必测项任一未验证即阻断」。打包、安装链与 Rust/bridge 退场已经完成，但 §3.3 仍有必测项没有 0.2.0 的证据；按该口径不能宣告通过，也不能用「已知问题」降级。

- 产物与哈希、环境矩阵：见 [`version-matrix.md`](version-matrix.md)。
- 证据文件：见 [`evidence/`](evidence/)（`tests-unit-feature.txt`、`e2e-release.txt`）。
- 未验证项的产品边界：见 [`known-limitations.md`](known-limitations.md)。
- 审核档位：本结论尚未过闸，档位由用户在闸口当场选择。

## 1. 阻断定义（B1–B8）

| # | 定义 | 状态 | 依据 |
| --- | --- | --- | --- |
| B1 | 数据丢失 / 损坏 | 通过 | 官方持久化独占会话；普通卸载保留数据根、`purge` 才删（e2e「普通卸载保留数据根」「purge --yes 删除数据根」）；nano 不写第二份会话历史 |
| B2 | 凭据 / 用户内容泄漏 | 通过 | nano 不复制、不显示凭据值；`$DSH_HOME` 只允许新增 `.anonymous-user-id`（e2e 启动冒烟逐文件哈希）；首启来源只显示路径（alpha §1#6） |
| B3 | 跨会话串内容 | **未验证** | 同根第二窗口拒绝与双 root 目录隔离有证据（alpha §1#4、beta §0），但九面（transcript/草稿/队列/附件/审批/问卷/终端/Monitor/调度）逐面隔离没有 0.2.0 证据（beta §3 自评「未覆盖」） |
| B4 | 无法启动 / 退出 | 通过 | e2e：全新安装 → 启动（真 PTY）→ Ctrl+C 退出 → purge → 卸载 → 重装，14/14 通过 |
| B5 | 权限 / 审批绕过 | **部分** | 审批 waterfall、默认焦点、无答即拒有单测（`tests/unit/decisions.test.ts`、`tests/unit/seams.test.ts`）；`!` 权限提示与「terminal 不进 Agent 工具表」没有发布级证据 |
| B6 | 会话无法恢复 | 通过 | alpha §2：同根二次启动 resume 后历史回放可见 |
| B7 | 交付物缺失 / 契约冲突 | 通过 | 包入口、keymap 文档、prepack 检查、发布文档齐全；键位单一源生成 README 与 `--help`（e2e「keymap 文档与源码一致」「--help 含用法与键位段」） |
| B8 | 首启来源缺失 | 通过 | alpha §1#6：首帧 notice 显示 profile / settings / 生效层 / 凭据 / 全局指令来源 |

## 2. §3.3 矩阵

| 维度 | 必测项 | 状态 | 证据 / 缺口 |
| --- | --- | --- | --- |
| 版本 | `npm pack` 产物与 SHA-256 | 通过 | `version-matrix.md`；e2e「pack 产物与哈希可复现」 |
| 版本 | `npm view dsh-tui-nano@0.2.0 dist.integrity` | **未验证** | 尚未发布到 registry；本地期望值已算，发布后回填 |
| 版本 | 官方精确版本 / 来源 | 通过 | `package.json` 精确 `0.2.1-rc.2` + `overrides`；e2e「未知 harness 版本拒绝启动」 |
| 版本 | Node 22.19 与 24.x | 通过 | e2e：22.19 启动冒烟、24.18 全流程、20.20 按预期拒绝 |
| 版本 | Ghostty / macOS / CPU / 日期 | 通过 | `version-matrix.md` |
| 启动 | pre-boot 首帧 | 通过 | alpha §5：PTY 先出「正在启动官方核心…」，约 0.5s 后正式 UI |
| 启动 | 二次启动、恢复会话 | 通过 | alpha §2 |
| 启动 | 核心加载失败有可见错误 | **未验证** | alpha §7：未构造真实 boot 失败 |
| 启动 | 未知 harness 版本拒绝启动 | 通过 | e2e「未知 harness 版本拒绝启动」 |
| 启动 | 首启显示配置 / 凭据 / 全局指令来源（B8） | 通过 | alpha §1#6 |
| 主链路 | 对话 → 工具 → 差异 → 审批 → 完成 | **部分** | alpha §2/§3/§5 覆盖对话、问卷、审批 seam；差异仅单测，未串成一条真实链路 |
| 功能面 | 附件/图片/技能/模型/权限/压缩/终端/任务/Monitor/调度/子代理 | **部分** | beta §3 对照表：多数为「部分」，跨根九面「未覆盖」 |
| 视觉 | 主题/间距 ADR、process-display ADR、深/浅、60/100 列、diff 8 行、CJK/窄屏 | **未验证** | 实现与单测在；0.2.0 没有 Ghostty 真机截图，0.1.0 截图属 Rust 实现 |
| 长会话 | 1000 行 p95、5000 行内存 | 通过 | alpha §6：滚动 2.80ms / 流式 1.61ms / resize 6.99ms；5000 行与 1000 行堆增长同量级 |
| 异常 | 断网、官方异常、SIGTERM、SIGKILL、终端残留、reset 提示 | **部分** | SIGTERM/SIGHUP/3s 强制恢复通过（alpha #12）；陈旧锁提示 `reset` 通过（e2e「强杀残留」）；断网与官方异常未取证 |
| 安全 | 审批无答即拒、Monitor `notify` 默认关闭且计费提示、`!` 权限提示、terminal 不进 Agent 工具表 | **部分** | 审批与 Monitor 有单测；`!` 权限提示与工具表未取证 |
| 跨会话 | 九面隔离；双窗口同根拒绝、双 root 并发 | **部分** | 同根拒绝（alpha #4）与双 root 目录隔离（beta §0）通过；九面隔离未覆盖 |
| 安装 | 全新安装 → 启动 → 升级 → `nano purge` → 卸载 → 重装；每步前后文件清单/哈希 | 通过 | e2e 14/14；`$DSH_HOME` 哈希比对 |
| 架构 | 单一运行时宿主（ADR-20261029-single-process-fd-guard）、无 `nano.*` 协议、无第二宿主；fd 级守护 | 通过 | ADR + `src/bin.ts` / `src/runtime/fd-guard.ts`；e2e「架构门禁」为空 |
| 证据 | 合成 HOME/DSH_HOME/数据根；脱敏；绑定发布产物 | 通过 | 所有 e2e 使用 `/tmp` 合成目录；`version-matrix.md` 绑定 tarball SHA-256 |

## 3. 阻断项汇总

按 §3.2 口径，下列必测项未达到「通过」即构成阻断：

1. **B3 跨会话九面隔离**（未验证，最高优先级）。
2. **视觉**：0.2.0 无 Ghostty 真机截图（未验证）。
3. **主链路**：差异与审批未在同一条真实链路中串完（部分）。
4. **功能面**：beta 自评多项「部分」（部分）。
5. **异常**：断网、官方异常未取证（部分）。
6. **安全**：`!` 权限提示、terminal 工具表未取证（部分）。
7. **启动**：核心加载失败未构造真实失败（未验证）。
8. **版本**：`dist.integrity` 需发布后 `npm view` 核对（未验证）。

解除条件：逐项补齐可核证据（命令输出、截图或录屏），或由子件退回补实现/取证后重新出结论。必测项不接受「已知问题」降级。

## 4. 本次已完成

| 项 | 结果 | 证据 |
| --- | --- | --- |
| npm 包结构与 manifest | `private:false`、`files:["dist"]`、`bin: nano → dist/bin.js`、`publishConfig`、精确官方依赖与 overrides | `package.json`；`scripts/prepack-check.mjs` |
| 打包检查 | `npm pack` 自动跑 build + keymap `--check` + packlist 断言 | `prepack`；tarball 116 个文件、入口带 shebang |
| 安装链 | 全新安装 → 启动 → 升级 → purge → 卸载 → 重装 | `docs/release/0.2.0/evidence/e2e-release.txt` |
| Node 下限 | 22.19 启动通过；20.20 入口拒绝并给可操作错误 | 同上 |
| 键位文档 | README 中英区块与 `--help` 都从单一源生成，`--check` 挂 `prepack` | `scripts/keymap-docs.mjs`；e2e |
| Rust / bridge 退场 | 删除 `crates/`、`Cargo.*`、`rust-toolchain.toml`、`protocol/`、`bridge/`；tag `rust-final` + 分支 `archive/rust-v1`；grep 门禁为空 | `version-matrix.md`；e2e「架构门禁」 |
| 用户数据边界 | 普通卸载保留数据根；`purge` 交互确认、`--yes` 跳过；`$DSH_HOME` 只写 `.anonymous-user-id` | e2e |
| 文档 | README / README.en / LICENSE（MIT）/ `docs/release/0.1.0` 标 HISTORICAL | 本目录与仓库根 |

## 5. spec 偏差（2026-10-29，用户选择「改旧 spec」）

- bin 实际是 S01 交付的 `dist/bin.js`；spec 原写 `dist/cli.js`，已改。
- 依赖实际是 `@deepseek-ai/dsh` 整包 + cordis 五件 overrides，子包由整包锚点解析；spec 原按逐包列出，已改。
- grep 门禁的裸词 `rust` 会误伤 `src/transcript/markdown.ts` 的语法高亮语言名，`bridge` 过宽；已改为旧工具链 / 路径 / 协议标识。
- 为落实 §2.1/§2.2/§5，S03 改了 `src/bin.ts`、`src/main.ts`、`src/input/keymap.ts` 的入口接缝，并新增 `src/input/keymap-docs.ts`、`src/controls/feature-keys.ts`；已同步 S01 §1/§6 与总纲 §6 owner 地图。
