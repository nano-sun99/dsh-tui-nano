# [2026-10-28-nano-ts/S03] γ：打包、发布与 Rust 退场

- 组标识：`2026-10-28-nano-ts`；角色与编号：子件 S03；目标是交付一个可安装、可升级、可卸载、可验收、可发布的 npm 形态产品，并完成 Rust/bridge 退场。
- 总纲：[共享约定与依据](README.md)。上游依赖：S01（包入口/运行时）、S02（功能面/键位注册）。下游影响：无。
- 合入前提：S01 包入口与 npm manifest 清单可备数据；S02 功能面与键位注册冻结；本份是收尾份，负责发布。

## 1. 边界与文件 owner

拥有：`packaging/`、`tests/e2e/`、`scripts/`（含新 `keymap-docs.mjs`/`prepack-check.mjs` 与 Rust 期脚本清理）、`docs/release/`、`README.md`、`README.en.md`、键位文档与最终证据归档。

仅删除：`crates/`、`Cargo.toml`、`Cargo.lock`、`rust-toolchain.toml`、`protocol/`、`bridge/`。这些路径不承接功能，只按总纲 §8.2 处置表在退场时删除。

不碰：业务功能实现；发现功能缺失时报告并退回对应子件。`package.json` 由 S01 独占，本份提供 npm manifest 内容由 S01 合入。

## 2. 包结构与安装

### 2.1 npm manifest（S01 合入）

```json
{
  "name": "dsh-tui-nano",
  "version": "0.2.0",
  "private": false,
  "type": "module",
  "license": "MIT",
  "bin": { "nano": "dist/cli.js" },
  "files": ["dist"],
  "engines": { "node": ">=22.19.0" },
  "publishConfig": { "access": "public" },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "test": "vitest run",
    "lint": "biome check .",
    "keymap:docs": "node scripts/keymap-docs.mjs",
    "prepack": "npm run build && node scripts/prepack-check.mjs"
  },
  "dependencies": {
    "@deepseek-ai/dsh-app-boot": "0.2.1-rc.2",
    "@deepseek-ai/dsh-base": "0.2.1-rc.2",
    "@deepseek-ai/dsh-api-terminal-controller": "0.2.1-rc.2",
    "@deepseek-ai/dsh-file-reference-local": "0.2.1-rc.2",
    "@deepseek-ai/dsh-schedule": "0.2.1-rc.2",
    "@deepseek-ai/dsh-storage": "0.2.1-rc.2",
    "@deepseek-ai/dsh-storage-json": "0.2.1-rc.2",
    "@deepseek-ai/dsh-tool-ask-user": "0.2.1-rc.2",
    "react": "^19",
    "react-reconciler": "^0.31",
    "yoga-layout": "^3",
    "string-width": "^7"
  },
  "devDependencies": {
    "typescript": "^5",
    "vitest": "^3",
    "@biomejs/biome": "^2"
  },
  "overrides": {
    "@deepseek-ai/cordis": "4.0.5",
    "@deepseek-ai/cordis-plugin-group": "1.0.5",
    "@deepseek-ai/cordis-plugin-include": "1.0.10",
    "@deepseek-ai/cordis-plugin-loader": "1.0.6",
    "@deepseek-ai/cordis-plugin-timer": "1.1.7"
  }
}
```

- 包名 `dsh-tui-nano`、bin `nano`、版本 `0.2.0`；`docs/release/0.2.0/` 为发布目录，`docs/release/0.1.0/` 标 HISTORICAL，不作为 v2 依据。
- `files` 只含 `dist`；构建用 `tsc`，依赖全部 external；`dist/cli.js` 必须带 shebang 且可执行。若改用 tsup 打包依赖，必须把 Yoga WASM 等资产显式列入 `files`，并重写本节。
- `prepack-check` 用 `npm-packlist` 断言 `dist/cli.js` 存在、带 shebang；不做递归 `npm pack --dry-run`。
- 版本口径：harness 包精确 `0.2.1-rc.2`；其依赖的 `@deepseek-ai/*` 用 `overrides` 按已装官方树锁精确版本（cordis 4.0.5、cordis-plugin-* 见 manifest），不随 registry 漂移；启动前按明确包名+版本清单校验，未知 harness 版本拒绝启动；Cordis/React 单实例用 `createRequire(...).resolve` 断言解析到同一路径/版本。
- 首次发布用 dist-tag `next`，发布结论通过后再提升 `latest`。
- Node 下限 22.19（官方树 `@earendil-works/pi-ai@1.3.0`、`undici@8.11.2` 的 engines）；`engines` 只警告，bin 入口必须运行时检查 `process.versions.node`，低于下限给可操作错误并退出。
- 官方依赖树自带 native 预编译包（node-pty/koffi/sharp/node-addon-require-builtin/node-addon-system 等）；nano 自身不新增原生 addon，不承诺整条依赖树无 native。

### 2.2 安装、升级、卸载

- 安装/升级走 npm；数据根默认保留。
- **普通卸载**：`npm uninstall -g dsh-tui-nano`，删包/bin，**保留数据根与应用 profile**；`$DSH_HOME` 除官方标识外不变。
- **`--purge`**：先执行 `nano purge`（bin 仍在时；交互确认，`--yes` 跳过），删除数据根（profile/sessions/runtime-data/history 全部），再执行 `npm uninstall -g dsh-tui-nano`。不依赖 npm 生命周期脚本（npm v7 起不保证 uninstall 脚本运行）。
- 安装/卸载前后对 `$DSH_HOME` 做哈希比对，只允许 `.anonymous-user-id` 出现或不变。
- 旧 Rust `packaging/install.sh|build-release.sh|uninstall.sh|verify-install.sh`、`packaging/manifest.json`、`packaging/README.md`、Rust 期证据脚本、`tests/e2e` 的 cargo 命令必须删除或重写；仓库内只保留 npm 一条安装路径。

## 3. 发布闸门

### 3.1 阻断定义（逐条照 v1 S13，不降级）

- **B1 数据丢失/损坏**：权威会话、工具结果、调度任务、持久化事件丢失或损坏。可丢弃草稿/缓存不算，但必须在界面标为未保存/可丢弃。
- **B2 凭据/用户内容泄漏**：密钥、凭据、PII、用户正文进入另一会话、日志、诊断、截图/录屏或发布包。检查面包含 UI、持久化、日志和证据。
- **B3 跨会话串内容**：任一地址的 transcript、草稿、队列、附件、审批、问卷、终端、Monitor、调度出现在另一地址。例外只有官方 fork seed 和父对话 settlement notice。
- **B4 无法启动/退出**：profile 初始化、宿主启动、会话创建/恢复、正常退出或清理失败到不可用。
- **B5 权限/审批绕过**：UI、工具、终端、`!`、Monitor 或子代理在没有官方审批时扩大授权或改变策略。
- **B6 会话无法恢复**：崩溃/重开后本可恢复的会话无法 resume/读取；上游明确限制不算，但必须在支持矩阵里写明。
- **B7 交付物缺失/契约冲突**：某个子件的必需产物或契约不存在；键位、布局、主题 token 互相冲突且未按 design-contract 统一。

- **B8 首启来源缺失**：首启不显示配置/凭据/全局指令来源（v1 S03 要求）。

任一存在即阻断发布；披露成「已知问题」再降级不算解除。

### 3.2 发布结论

`docs/release/0.2.0/release-conclusion.md` 逐项给「通过 / 未验证 / 阻断」+ 证据链接；未验证不算通过；**§3.3 的必测项任一未验证即阻断**；非必测补充项需用户裁决。
- 审计档位：由用户在闸口选择并记录，不在 spec 里预设人数；涉及安全/权限/跨会话的项未重审则必须留人工实测记录。
- 旧 `docs/release/0.1.0/` 加 HISTORICAL 标记，复核路径移除 cargo 命令。

### 3.3 矩阵

| 维度 | 必测 |
|---|---|
| 版本 | `npm pack --json` 产物与 SHA-256、`npm view dsh-tui-nano@0.2.0 dist.integrity`、官方精确版本/来源、Node 22.19 与 24.x、Ghostty、macOS、CPU、日期 |
| 启动 | pre-boot 首帧、二次启动、恢复会话；核心加载失败有可见错误；未知 harness 版本拒绝启动；首启显示配置/凭据/全局指令来源（B8） |
| 主链路 | 对话 → 工具 → 差异 → 审批 → 完成 |
| 功能面 | 附件/图片/技能/模型/权限/压缩/终端/任务/Monitor/调度/子代理 |
| 视觉 | 主题/间距 ADR、process-display ADR、深/浅、60/100 列、diff 8 行、CJK/窄屏 |
| 长会话 | 1000 行滚动/流式/resize 的 p95 阈值（33/50/80ms）、5000 行内存曲线 |
| 异常 | 断网、官方异常、SIGTERM、SIGKILL 后重启、终端残留、`reset` 提示 |
| 安全 | 审批无答即拒、Monitor `notify` 默认关闭且计费提示、`!` 权限提示、terminal 不进 Agent 工具表 |
| 跨会话 | transcript/草稿/队列/附件/审批/问卷/终端/Monitor/调度九面隔离；双窗口同根拒绝、双 root 并发 |
| 安装 | 全新安装 → 启动 → 升级 → `nano purge` → 卸载 → 重装；每步前后文件清单/哈希 |
| 架构 | 单进程、无 `nano.*` 协议、无第二宿主；运行时 stdout/stderr fd 级守护 |
| 证据 | 合成 HOME/DSH_HOME/数据根；真实路径/用户名/主机名/密钥/用户正文脱敏；证据绑定发布产物 |

## 4. Rust 与 bridge 退场

- 合并本组 spec 前：`main` 打 tag `rust-final`（记录 SHA）并推 `archive/rust-v1`；`git rev-parse`/`git ls-remote` 验证。
- 删除 `crates/`、`Cargo.toml`、`Cargo.lock`、`rust-toolchain.toml`、`protocol/`、`bridge/`；按总纲 §8.2 的 bridge 处置表吸收业务逻辑，未列模块必须标注「不承接」及原因。
- 删除后检查（只用已跟踪文件，目录不存在不 fatal）：

```sh
git ls-files -z -- src package.json packaging tests scripts README.md README.en.md AGENTS.md .github .gitignore \
  | xargs -0 grep -nE 'cargo|Cargo|rust|bridge|nano-protocol|--bridge-package|target/release|nano-bridge'
```

  结果为空；`docs/specs/` 历史规格与 `docs/release/0.1.0/`（已标 HISTORICAL）豁免。bridge/ 下的 `cordis.patch.yml` 行集（终端/问卷/文件引用/HMR）由 S01 重写为应用自持 profile 的行集，不照搬 `dsh plugin` 安装路径。
- 仓库可构建、测试、打包；旧 Rust 发布证据标为历史，不作为 v2 发布依据。
- 删除以合并后的 `main` 为准，先 rebase 再删，不 force 覆盖他人改动。

## 5. 键位与文档

- 键位单一源 `src/input/keymap.ts`（S01）；S02 只注册功能键；本份用 `scripts/keymap-docs.mjs --check` 从源生成 README/`--help` 并加 diff 检查，挂到 `prepack` 或 §6 验收，写明执行者与时点；中英文 README 同步。
- README 保留主题与透明、架构、许可证/致谢等章节；补 `LICENSE` 文件（MIT，沿用 Cargo.toml 声明）；已知限制必须含：无崩溃隔离、共享事件循环上限、强杀后终端可能残留、调度无暂停、投递非严格一次、Monitor `notify` 计费、三处用户变更（总纲 §5.2）。
- 首启显示配置/凭据/全局指令实际来源（B8）由 S01 实现，本份只验证；不复制凭据值。

## 6. 验收

- 全新安装 → 启动 → 升级 → `nano purge` → 卸载 → 重装；每步有前后文件清单/哈希；普通卸载保留数据根/profile、purge 删除；`$DSH_HOME` 除官方标识外不变。
- e2e 覆盖 §3.3 全部必测行（安装、主链路、功能面、视觉、长会话、异常、安全、跨会话、架构、证据），证据按 §3.3 脱敏并绑定 `npm pack` 哈希。
- Rust/bridge 删除后主仓可构建、测试、打包；tag/归档可查；grep 门禁按 §4 命令为空。
- 发布结论逐项有证据；阻断项为零；§3.3 必测项无「未验证」；环境矩阵（Node/Ghostty/macOS/CPU/日期）写入结论。
- `nano` 在 Node 22.19 与 24.x 均可启动；低于 22.19 给出可操作错误；`npm pack` 产物可全局安装并运行 `nano --version`。

## 7. 审核修订记录

- 2026-10-28 重审 8 份后按发现重写：native 口径、精确版本、应用自持 profile、卸载残留定义、npm manifest owner、bridge 退场、发布闸门/阻断/脱敏、键位单一源、旧安装器处置；完整清单在 PR #84 评论。
- 2026-10-28 轻审修订：npm manifest 完整清单、harness 精确/其余跟随口径、普通卸载保留 profile 与 `--purge` 区分、B1–B8 阻断表、发布审计档位、Rust 退场 grep 限定范围与旧 packaging 文件清单。
- 2026-10-28 二次轻审修订：manifest 可直接落盘（全名/版本/devDeps/type/license/bin/files/overrides）、`nano purge` 作为可执行入口且不依赖 npm 生命周期、版本 `0.2.0` 与 `docs/release/0.2.0`、B1–B8 逐条覆盖 v1 S13 并补首启来源、B8 改由 S01 实现、grep 用 `git ls-files` 避免假绿与 fatal、p50 删除、Node 22.19 运行时检查、`npm pack` 命令与 integrity、发布档位由用户当场选择。
