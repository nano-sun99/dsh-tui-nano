# 打包与安装

仓库内**只保留 npm 一条安装路径**。旧版的 `install.sh` / `build-release.sh` / `uninstall.sh` / `verify-install.sh` / `manifest.json` 已随 Rust 实现退场删除（2026-10-29，S03）。历史产物与记录在 tag `rust-final` 与分支 `archive/rust-v1`。

## 产物

`npm pack` 产出 `dsh-tui-nano-0.2.0.tgz`，包内只有：

```text
package/
  package.json
  README.md / README.en.md / LICENSE
  dist/                 tsc 编译结果（入口 dist/bin.js，带 shebang）
```

`files` 只声明 `dist`；npm 会自动带上 `package.json`、README 与 LICENSE。源码、测试、`node_modules`、`tsconfig.json`、`biome.json` 不进包（`scripts/prepack-check.mjs` 断言）。

## 构建

```sh
npm ci
npm pack            # 自动跑 prepack：build + keymap-docs --check + prepack-check
```

输出 tarball 路径与 SHA-256 写入 `docs/release/0.2.0/version-matrix.md`。

## 安装 / 升级 / 卸载

```sh
npm install -g ./dsh-tui-nano-0.2.0.tgz   # 或发布后 npm install -g dsh-tui-nano
nano --version

nano purge          # 删数据根（交互确认）
npm uninstall -g dsh-tui-nano
```

发布流程：首次发布用 `npm publish --tag next`；`docs/release/0.2.0/release-conclusion.md` 通过后再 `npm dist-tag add dsh-tui-nano@0.2.0 latest`。

## 发布前检查

| 检查 | 命令 | 时点 |
| --- | --- | --- |
| 键位区块与源码一致 | `node scripts/keymap-docs.mjs --check` | `prepack` 与发布验收 |
| tarball 内容、入口 shebang | `node scripts/prepack-check.mjs` | `prepack` 与发布验收 |
| 安装/升级/purge/卸载/重装 | `npm run test:e2e` | 发布验收 |

`tests/e2e` 全部使用合成的 `HOME` / `DSH_HOME` / 安装前缀，不读写用户的真实数据根。
