# 发布结论（0.2.0）

**结论：不发布。**

依据：`docs/specs/2026-10-28-nano-ts/S03-release.md` §3.2——「未验证不算通过；§3.3 的必测项任一未验证即阻断」。打包、安装链与 Rust/bridge 退场已经完成，但 §3.3 仍有必测项没有 0.2.0 的证据；按该口径不能宣告通过，也不能用「已知问题」降级。

- 产物与哈希、环境矩阵：见 [`version-matrix.md`](version-matrix.md)。
- 证据文件：见 [`evidence/`](evidence/)（`tests-unit-feature.txt`、`e2e-release.txt`）。
- 未验证项的产品边界：见 [`known-limitations.md`](known-limitations.md)。
- 状态词只用 §3.2 定义的三种：**通过 / 未验证 / 阻断**。

## 1. 阻断定义（B1–B8）

| # | 定义 | 状态 | 依据 |
| --- | --- | --- | --- |
| B1 | 数据丢失 / 损坏 | 通过 | 官方持久化独占会话；普通卸载保留数据根、`purge` 才删（e2e「普通卸载保留数据根」「purge --yes 删除数据根」每步 snapshot）；`--root purge` 误删回归已修并有用例 |
| B2 | 凭据 / 用户内容泄漏 | 通过 | nano 不复制、不显示凭据值；`$DSH_HOME` 只允许新增 `.anonymous-user-id`（e2e 启动冒烟逐文件哈希）；首启来源只显示路径（alpha §1#6） |
| B3 | 跨会话串内容 | 未验证 | 同根第二窗口拒绝与双 root 目录隔离有证据（alpha §1#4、beta §0），但九面（transcript/草稿/队列/附件/审批/问卷/终端/Monitor/调度）逐面隔离没有 0.2.0 证据（beta §3 自评「未覆盖」） |
| B4 | 无法启动 / 退出 | 通过 | e2e：全新安装 → 启动（真 PTY）→ Ctrl+C 退出 → purge → 卸载 → 重装 → 再启动，全部通过 |
| B5 | 权限 / 审批绕过 | 未验证 | 审批 waterfall、默认焦点、无答即拒有单测（`tests/unit/decisions.test.ts`、`tests/unit/seams.test.ts`）；`!` 权限提示与「terminal 不进 Agent 工具表」没有发布级证据 |
| B6 | 会话无法恢复 | 通过 | alpha §2：同根二次启动 resume 后历史回放可见 |
| B7 | 交付物缺失 / 契约冲突 | 通过 | 包入口、keymap 文档、prepack 检查、发布文档齐全；键位单一源生成 README 与 `--help`（e2e「keymap 文档与源码一致」「--help 含用法与键位段」）。视觉未验证不影响「交付物存在」的判定，但会作为独立行阻断 |
| B8 | 首启来源缺失 | 通过 | alpha §1#6：首帧 notice 显示 profile / settings / 生效层 / 凭据 / 全局指令来源 |

## 2. §3.3 矩阵

| 维度 | 必测项 | 状态 | 证据 / 缺口 |
| --- | --- | --- | --- |
| 版本 | `npm pack` 产物与 SHA-256 | 通过 | e2e 连打两次比 SHA-256 一致，并断言 `version-matrix.md` 记录了该值 |
| 版本 | `npm view dsh-tui-nano@0.2.0 dist.integrity` | 未验证 | 尚未发布到 registry；本地期望值已算（见 version-matrix），发布后回填 `npm view` |
| 版本 | 官方精确版本 / 来源 | 通过 | `package.json` 精确 `0.2.1-rc.2` + `overrides`；e2e「未知 harness 版本拒绝启动」 |
| 版本 | Node 22.19 与 24.x | 通过 | e2e：先断言 `NANO_NODE_22` 真是 22.19.0、PATH 解析一致，再跑启动冒烟；24.18 跑全流程；20.20 按预期拒绝 |
| 版本 | Ghostty / macOS / CPU / 日期 | 通过 | `version-matrix.md`（环境记录，不代表视觉验收） |
| 启动 | pre-boot 首帧 | 通过 | e2e PTY 输出匹配「正在启动官方核心」；alpha §5 约 0.5s 后正式 UI |
| 启动 | 二次启动、恢复会话 | 通过 | alpha §2 |
| 启动 | 核心加载失败有可见错误 | 未验证 | alpha §7：未构造真实 boot 失败 |
| 启动 | 未知 harness 版本拒绝启动 | 通过 | e2e「未知 harness 版本拒绝启动」 |
| 启动 | 首启显示配置 / 凭据 / 全局指令来源（B8） | 通过 | alpha §1#6 |
| 主链路 | 对话 → 工具 → 差异 → 审批 → 完成 | 未验证 | alpha §2/§3/§5 分段覆盖对话、问卷、审批 seam；差异仅单测，未串成一条真实链路 |
| 功能面 | 附件/图片/技能/模型/权限/压缩/终端/任务/Monitor/调度/子代理 | 未验证 | beta §3 对照表多项为「部分」，跨根九面「未覆盖」 |
| 视觉 | 主题/间距 ADR、process-display ADR、深/浅、60/100 列、diff 8 行、CJK/窄屏 | 未验证 | 实现与单测在；0.2.0 没有 Ghostty 真机截图，0.1.0 截图属已退场的 Rust 实现 |
| 长会话 | 1000 行 p95、5000 行内存 | 通过 | alpha §6：滚动 2.80ms / 流式 1.61ms / resize 6.99ms；5000 行与 1000 行堆增长同量级 |
| 异常 | 断网、官方异常、SIGTERM、SIGKILL、终端残留、reset 提示 | 未验证 | SIGTERM/SIGHUP/3s 强制恢复通过（alpha #12）；陈旧锁提示 `reset` 通过（e2e「强杀残留」）；断网与官方异常未取证 |
| 安全 | 审批无答即拒、Monitor `notify` 默认关闭且计费提示、`!` 权限提示、terminal 不进 Agent 工具表 | 未验证 | 审批与 Monitor 有单测；`!` 权限提示与工具表未取证 |
| 跨会话 | 九面隔离；双窗口同根拒绝、双 root 并发 | 未验证 | 同根拒绝（alpha #4）与双 root 目录隔离（beta §0）通过；九面隔离未覆盖 |
| 安装 | 全新安装 → 启动 → 升级 → `nano purge` → 卸载 → 重装；每步前后文件清单/哈希 | 通过 | e2e 15 个用例；每步 `snapshot` 记录数据根 / `$DSH_HOME` / 安装目录的文件数与摘要哈希；卸载后重装再跑一次真 PTY 启动 |
| 架构 | 单一运行时宿主（ADR-20261029-single-process-fd-guard）、无 `nano.*` 协议、无第二宿主；fd 级守护 | 通过 | ADR + `src/bin.ts` / `src/runtime/fd-guard.ts`；alpha §5 启动期 stdout 写入 0；e2e「架构门禁」为空（门禁只覆盖旧工具链/路径字符串，不替代结构审查） |
| 证据 | 合成 HOME/DSH_HOME/数据根；脱敏；绑定发布产物 | 通过 | 全部 e2e 用合成 HOME / DSH_HOME / 数据根 / 安装前缀；npm cache 固定在本机临时目录，不写 `~/.npm`；证据文件已脱敏；tarball SHA-256 与 `version-matrix.md` 双向绑定 |

## 3. 阻断项汇总

按 §3.2 口径，下列必测项不是「通过」即构成阻断：

1. **B3 跨会话九面隔离**（未验证，最高优先级）。
2. **主链路**：差异与审批未在同一条真实链路中串完。
3. **功能面**：beta 自评多项「部分」。
4. **视觉**：0.2.0 无 Ghostty 真机截图。
5. **异常**：断网、官方异常未取证。
6. **安全**：`!` 权限提示、terminal 工具表未取证。
7. **启动**：核心加载失败未构造真实失败。
8. **版本**：`dist.integrity` 需发布后 `npm view` 核对。

解除条件：逐项补齐可核证据（命令输出、截图或录屏），或由子件退回补实现/取证后重新出结论。必测项不接受「已知问题」降级。

## 4. 审核记录

- 档位：**重审**（用户 2026-10-29 在闸卡上当场选择）。
- 执行：2 个只读 agent（规格符合性、对抗找 bug），共 31 条发现；两路原文已贴 PR #95 评论。
- 说明：两个 agent 由实施方派出，**不是独立第三方**；本次结论不把它当外部裁决。
- 处置：用户选择「改」。本轮已修——
  - 数据丢失：`--root purge` 不再被当成子命令（含 `--root=purge` 回归用例）；
  - 交互：purge 确认提示写 `/dev/tty` + stderr，stdout 重定向时仍可见；补 `-y` 到 `--help`；
  - 假绿：`keymap-docs.mjs` 改为直接 import 源码；标记重复直接报错；表格单元格转义；
  - 证据：e2e 二次打包比哈希、断言与 `version-matrix.md` 一致、每步 snapshot、合成 HOME 与固定 npm cache、Node 22.19 真值校验、启动冒烟匹配骨架文案、卸载重装后真启动；
  - 健壮性：`pty-start.py` 的 `waitpid` 带超时并 `killpg`；`prepack-check` 捕获 dist 缺失并扩大禁入清单；预发布版 Node 按 semver 拒绝；
  - 文档：入口级例外补 `feature-host.ts` / `package.json` / `package-lock.json` / `biome.json`；旧口径（`dist/cli.js`、逐包依赖、门禁正则、overrides 描述）同步；移除 README 中未实现的 `Ctrl+P`；Ghostty 口径改为「手工交互验证、视觉未取证」；`docs/release/0.1.0` 全部文件补 HISTORICAL 头。

## 5. 本次已完成

| 项 | 结果 | 证据 |
| --- | --- | --- |
| npm 包结构与 manifest | `private:false`、`files:["dist"]`、`bin: nano → dist/bin.js`、`publishConfig`、精确官方依赖与 overrides | `package.json`；`scripts/prepack-check.mjs` |
| 打包检查 | `npm pack` 自动跑 build + keymap `--check` + packlist 断言 | `prepack`；tarball 116 个文件、入口带 shebang |
| 安装链 | 全新安装 → 启动 → 升级 → purge → 卸载 → 重装 → 再启动 | `docs/release/0.2.0/evidence/e2e-release.txt` |
| Node 下限 | 22.19 启动通过；20.20 入口拒绝并给可操作错误 | 同上 |
| 键位文档 | README 中英区块与 `--help` 都从源码单一源生成，`--check` 挂 `prepack` | `scripts/keymap-docs.mjs`；e2e |
| Rust / bridge 退场 | 删除 `crates/`、`Cargo.*`、`rust-toolchain.toml`、`protocol/`、`bridge/`；tag `rust-final` + 分支 `archive/rust-v1`；grep 门禁为空 | `version-matrix.md`；e2e「架构门禁」 |
| 用户数据边界 | 普通卸载保留数据根；`purge` 交互确认、`--yes`/`-y` 跳过；`$DSH_HOME` 只写 `.anonymous-user-id` | e2e |
| 文档 | README / README.en / LICENSE（MIT）/ `docs/release/0.1.0` 全部标 HISTORICAL | 本目录与仓库根 |

## 6. bridge 处置（未列模块）

总纲 §8.2 未单列的 bridge 文件按「不承接」处理，原因逐条如下：

| 模块 | 处置 |
| --- | --- |
| `bridge/runtime/capabilities.mjs` | 不承接：跨进程能力快照随协议退场；改为 boot 后运行时断言（`src/boot/official.ts` 与能力快照） |
| `bridge/runtime/errors.mjs` | 不承接：协议错误码随协议退场；启动错误改可读 `Error` + 可见报文 |
| `bridge/runtime/transport.mjs` | 不承接：无跨进程传输 |
| `bridge/runtime/index.mjs` | 不承接：桥接入口随 `bridge/` 退场 |
| `bridge/runtime/methods.mjs` | 不承接：方法表是协议契约，v2 直接调用官方公开导出 |
| `bridge/runtime/ledger.mjs` | 不承接：挂载账本由 `src/boot/root.ts` 的 pid 锁承接 |
| `bridge/README.md`、`bridge/package*.json` | 不承接：桥接包自身文档与依赖清单随目录删除 |

## 7. spec 偏差（2026-10-29，用户选择「改旧 spec」）

- bin 实际是 S01 交付的 `dist/bin.js`；spec 原写 `dist/cli.js`，已改。
- 依赖实际是 `@deepseek-ai/dsh` 整包 + cordis 五件 overrides，子包由整包锚点解析；spec 原按逐包列出，已改。
- grep 门禁的裸词 `rust` 会误伤 `src/transcript/markdown.ts` 的语法高亮语言名，`bridge` 过宽；已改为旧工具链 / 路径 / 协议标识。
- 为落实 §2.1/§2.2/§5，S03 改了 `src/bin.ts`、`src/main.ts`、`src/input/keymap.ts`、`src/controls/feature-host.ts` 的入口接缝，并新增 `src/input/keymap-docs.ts`、`src/controls/feature-keys.ts`；`package.json` / `package-lock.json` / `biome.json` 的发布期改动与一次纯格式化扫尾也已写入 S03 §1 例外，并同步 S01 §1/§6 与总纲 §6 owner 地图。
