# [2026-10-28-nano-ts/S03] γ：打包、发布与 Rust 退场

- 组标识：`2026-10-28-nano-ts`；角色与编号：子件 S03；目标是交付一个可安装、可升级、可卸载、可验收、可发布的 npm 形态产品，并完成 Rust/bridge 退场。
- 总纲：[共享约定与依据](README.md)。上游依赖：S01（包入口/运行时）、S02（功能面/键位注册）。下游影响：无。
- 合入前提：S01 包入口与 npm manifest 清单可备数据；S02 功能面与键位注册冻结；本份是收尾份，负责发布。

## 1. 边界与文件 owner

拥有：`packaging/`、`tests/e2e/`、`scripts/`（含新 `keymap-docs.mjs`/`prepack-check.mjs` 与 Rust 期脚本清理）、`docs/release/`、`README.md`、`README.en.md`、键位文档与最终证据归档。

仅删除：`crates/`、`Cargo.toml`、`Cargo.lock`、`rust-toolchain.toml`、`protocol/`、`bridge/`。这些路径不承接功能，只按总纲 §8.2 处置表在退场时删除。

不碰：业务功能实现；发现功能缺失时报告并退回对应子件。`package.json` 在 α/β 期由 S01 独占；γ 发布期 S01 已交付，manifest 由本份落盘，内容以 §2.1 为准。

入口级例外（2026-10-29 用户拍板，改旧 spec）：S03 可改 `src/bin.ts`、`src/main.ts`、`src/input/keymap.ts` 与 `src/controls/feature-host.ts` 的入口/文档接缝——Node 下限检查、`nano purge` 交互确认与 `--yes`、`--help` 的键位段生成、功能键改为从静态清单注册；除本句记录的 `!` 提示外，不改 α/β 的业务行为，回归由 S01 单测、S02 功能测试与 S03 e2e 覆盖。新增 `src/input/keymap-docs.ts`（键位文档渲染）与 `src/controls/feature-keys.ts`（S02 功能键静态清单，运行时与文档共用）归本份。用户 2026-10-29 指示补 `!` 首次使用权限提示（S08 §2.2）；实现落在 `feature-host.ts`，属于本次授权的 S02 行为补缺。用户同日对照设计稿发现 v2 色板偏离冻结色表，指示按主题 spec §3.2 修正 `src/theme/theme.ts` 并去掉覆盖层实色背景。用户随后指出 `/model` 与输入框上下文线缺失，指示一并补：`/model` 走官方模型目录与 selection ref，输入块补上下边框与占比线。发布期 manifest 落盘会改 `package.json` / `package-lock.json`；`biome.json` 的检查范围扩到 `tests/**`、`scripts/**`，并做一次只含格式与 import 排序的扫尾（无行为变化）。

## 2. 包结构与安装

### 2.1 npm manifest（S01 合入）

```json
{
  "name": "dsh-tui-nano",
  "version": "0.2.0",
  "private": false,
  "type": "module",
  "license": "MIT",
  "bin": { "nano": "dist/bin.js" },
  "files": ["dist"],
  "engines": { "node": ">=22.19.0" },
  "publishConfig": { "access": "public" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run && vitest run --config tests/feature/vitest.config.ts",
    "test:watch": "vitest",
    "test:e2e": "node --test --test-concurrency=1 tests/e2e/*.test.mjs",
    "lint": "biome check src tests",
    "start": "node dist/bin.js",
    "keymap:docs": "node scripts/keymap-docs.mjs",
    "prepack": "npm run build && node scripts/keymap-docs.mjs --check && node scripts/prepack-check.mjs"
  },
  "dependencies": {
    "@deepseek-ai/dsh": "0.2.1-rc.2",
    "marked": "^15.0.12",
    "prismjs": "^1.30.0",
    "react": "^19.1.1",
    "react-reconciler": "^0.33.0",
    "string-width": "^7.2.0",
    "yaml": "^2.9.1",
    "yoga-layout": "^3.2.1"
  },
  "devDependencies": {
    "@biomejs/biome": "^2.2.4",
    "@types/node": "^24.3.0",
    "@types/prismjs": "^1.26.5",
    "@types/react": "^19.1.12",
    "@types/react-reconciler": "^0.32.1",
    "npm-packlist": "^11.3.0",
    "typescript": "^5.9.2",
    "vitest": "^3.2.4"
  },
  "overrides": {
    "@deepseek-ai/dsh": "0.2.1-rc.2",
    "@deepseek-ai/cordis": "4.0.5",
    "@deepseek-ai/cordis-plugin-group": "1.0.5",
    "@deepseek-ai/cordis-plugin-include": "1.0.10",
    "@deepseek-ai/cordis-plugin-loader": "1.0.6",
    "@deepseek-ai/cordis-plugin-timer": "1.1.7"
  }
}
```

- 包名 `dsh-tui-nano`、bin `nano`、版本 `0.2.0`；`docs/release/0.2.0/` 为发布目录，`docs/release/0.1.0/` 标 HISTORICAL，不作为 v2 依据。
- `files` 只含 `dist`；构建用 `tsc`，依赖全部 external；`dist/bin.js` 必须带 shebang（可执行位由 npm 安装 bin 时设置，2026-10-29 重审对齐；S01 交付的入口是 `src/bin.ts`）。若改用 tsup 打包依赖，必须把 Yoga WASM 等资产显式列入 `files`，并重写本节。
- `prepack-check` 用 `npm-packlist` 断言 `dist/bin.js` 存在、带 shebang；不做递归 `npm pack --dry-run`。
- 版本口径：依赖只声明 `@deepseek-ai/dsh` 整包（精确 `0.2.1-rc.2`），子包由该整包自带、启动时按整包锚点解析（`src/boot/official.ts`）；`overrides` 把该整包与 cordis 五件锁到已装官方树版本（cordis 4.0.5、cordis-plugin-* 见 manifest），不随 registry 漂移。启动前校验整包版本，未知 harness 版本拒绝启动；Cordis/React 单实例由启动期断言解析到同一路径与版本（`src/boot/official.ts`）。
- `test` 同时跑 `tests/unit`（S01）与 `tests/feature`（S02）；e2e 单独用 `test:e2e`，避免把需要合成 HOME/DSH_HOME 的安装演练塞进默认回归。
- 首次发布用 dist-tag `next`，发布结论通过后再提升 `latest`。
- Node 下限 22.19（官方树 `@earendil-works/pi-ai@1.4.0`、`undici@8.11.2` 的 engines）；`engines` 只警告，bin 入口必须运行时检查 `process.versions.node`，低于下限给可操作错误并退出。
- 官方依赖树自带 native 预编译包（node-pty/koffi/sharp/node-addon-require-builtin/node-addon-system 等）；nano 自身不新增原生 addon，不承诺整条依赖树无 native。

### 2.2 安装、升级、卸载

- 安装/升级走 npm；数据根默认保留。
- **普通卸载**：`npm uninstall -g dsh-tui-nano`，删包/bin，**保留数据根与应用 profile**；`$DSH_HOME` 除官方标识外不变。
- **`--purge`**：先执行 `nano purge`（bin 仍在时；交互确认，`--yes` / `-y` 跳过；stdin 不是 TTY 时必须显式跳过，否则拒绝执行），删除数据根（profile/sessions/runtime-data/history 全部），再执行 `npm uninstall -g dsh-tui-nano`。确认提示必须写到 `/dev/tty` 与 stderr，stdout 被重定向时用户仍要能看见。不依赖 npm 生命周期脚本（npm v7 起不保证 uninstall 脚本运行）。
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
| 架构 | 单一运行时宿主（runtime 单进程 + 启动器 fd 包装，ADR-20261029-single-process-fd-guard）、无 `nano.*` 协议、无第二宿主；运行时 stdout/stderr fd 级守护 |
| 证据 | 合成 HOME/DSH_HOME/数据根；真实路径/用户名/主机名/密钥/用户正文脱敏；证据绑定发布产物 |

## 4. Rust 与 bridge 退场

- 删除前：在 `main` 打 tag `rust-final`（记录 SHA）并推 `archive/rust-v1`；`git rev-parse`/`git ls-remote` 验证。spec 合并时未打（2026-10-29 补齐），tag 取删除前 `main` 的 SHA；tag 与分支只做归档，不回改历史。
- 删除 `crates/`、`Cargo.toml`、`Cargo.lock`、`rust-toolchain.toml`、`protocol/`、`bridge/`；按总纲 §8.2 的 bridge 处置表吸收业务逻辑，未列模块必须标注「不承接」及原因。
- 删除后检查（只用已跟踪文件，目录不存在不 fatal）：

```sh
git ls-files -z -- src package.json packaging tests scripts README.md README.en.md AGENTS.md .github .gitignore \
  | xargs -0 grep -nE 'cargo|Cargo|rust-toolchain|nano-protocol|--bridge-package|target/release|nano-bridge|@dsh-tui-nano/bridge|bridge/'
```

  结果为空；`docs/specs/` 历史规格与 `docs/release/0.1.0/`（已标 HISTORICAL）豁免。裸词 `rust`/`bridge` 不再进正则：`rust` 会误伤语法高亮的语言名（`src/transcript/markdown.ts` 的 `prism-rust` 与 `rs: 'rust'`），`bridge` 过宽；门禁只匹配旧工具链、旧路径与旧协议标识（2026-10-29 改旧 spec）。bridge/ 下的 `cordis.patch.yml` 行集（终端/问卷/文件引用/HMR）由 S01 重写为应用自持 profile 的行集，不照搬 `dsh plugin` 安装路径。
- 仓库可构建、测试、打包；旧 Rust 发布证据标为历史，不作为 v2 发布依据。
- 删除以合并后的 `main` 为准，先 rebase 再删，不 force 覆盖他人改动。

## 5. 键位与文档

- 键位单一源 `src/input/keymap.ts`（S01）；S02 只注册功能键，功能键的静态清单位于 `src/controls/feature-keys.ts`（运行时注册与文档共用同一份）。本份用 `scripts/keymap-docs.mjs` 直接 import `src/**/*.ts`（Node ≥22.19 的类型剥离）渲染键位表，避免读到过期 `dist/`：`--write` 写 README.md / README.en.md 的标记区块，`--check` 只比对并返回非零；`--check` 挂在 `prepack`（`npm pack` 前自动跑），§6 验收也跑一次。`--help` 的键位段由 `src/input/keymap-docs.ts` 在运行时从同一清单渲染；中英文 README 同步。
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
- 2026-10-29 实施发现修订（用户选择「改旧 spec」）：bin 对齐 S01 已交付的 `dist/bin.js`（新增 `src/bin.ts` 入口级例外）；依赖对齐已实现的 `@deepseek-ai/dsh` 整包并保留 cordis 五件 overrides；`test` 覆盖 `tests/feature`、新增 `test:e2e`；grep 门禁去掉会误伤语法高亮的裸词 `rust`/`bridge`，改为旧工具链/路径/协议标识；`rust-final` tag 在删除前补打；§5 写明 `keymap:docs` 的 `--write`/`--check` 与 `--help` 渲染来源。
- 2026-10-29 用户指示补 `/model` 与输入框上下文线：控制器保留可变 selection ref；`/model` 列官方目录、校验后切换；输入块补上下 `rule` 边框，左段按 `contextPressure` 占比着色。
- 2026-10-29 用户指示按设计稿修正 v2 色板：`src/theme/theme.ts` 改用主题 spec §3.2 的全套 RGB；覆盖层去掉 `overlayBg` 实色底；视觉 e2e 断言同步。
- 2026-10-29 用户指示补主链路 e2e：本地 Anthropic Messages SSE mock，覆盖 read→edit（差异）→完成与 bash 提权→审批（默认拒绝→允许一次）→完成；不触真实网络/凭据。
- 2026-10-29 用户指示补 `!` 首次使用权限提示（S08 §2.2）：`feature-host.ts` 首条人工命令前显示「以用户权限运行，不是 Agent 授权」，e2e 断言。
- 2026-10-29 补证据两轮（用户选「轻审」并选「改」）：新增视觉/能力/交互/跨会话 e2e；修掉真实 `~/.dsh` 读写、凭据环境变量继承、跨会话无正控与同根竞态。
- 2026-10-29 实施期重审修订（用户选「重审」并选「改」）：入口级例外补 `feature-host.ts` / `package.json` / `package-lock.json` / `biome.json` 与格式化扫尾；`dist/bin.js` 只断言 shebang（可执行位由 npm 设置）；`test:watch` / `start` 进 manifest；purge 补 `-y` 别名、非 TTY 必须显式跳过、提示写 `/dev/tty`；`keymap-docs` 改为直接 import 源码；pi-ai 版本更正为 1.4.0。
