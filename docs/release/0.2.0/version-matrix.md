# 版本矩阵（0.2.0）

- 记录日期：2026-10-29
- 包名 / 版本：`dsh-tui-nano` / `0.2.0`
- 源码：分支 `issue-88`（PR #99）；构建基线 `ac53a29`（含 2026-10-29 轻审修订）；归档基线 `f8a7971`
- 归档：tag `rust-final`（`f8a7971`）与分支 `archive/rust-v1`

## 产物

| 项 | 值 |
| --- | --- |
| 文件 | `packaging/dist/dsh-tui-nano-0.2.0.tgz` |
| 大小 | 173,992 字节（约 170 KiB） |
| 文件数 | 118 |
| SHA-256 | `4e4ca5b6e64de65a95b9ef41559ebac92d23b0f8e86596987639c1650060b2f7` |
| 期望 `dist.integrity` | `sha512-Xhqs/ukCLAtkRtfV//RTRkZzZ6ZIqZ5RrCltUv8evJaTy/FdMQ/ienLFk7sPen40FUbiq3BZw0fABfTv85yS9g==` |

期望 integrity 按 npm 的算法（tarball 的 SHA-512，base64）本地计算；只有发布到 registry 后才能用 `npm view dsh-tui-nano@0.2.0 dist.integrity` 核对。见 `release-conclusion.md` 的未验证项。

## 官方依赖

| 项 | 值 | 来源 |
| --- | --- | --- |
| 官方 harness | `@deepseek-ai/dsh` `0.2.1-rc.2`（精确） | `package.json` dependencies + `overrides`；`node_modules` 实测 |
| 子包解析 | 由整包自带的 `node_modules` 解析 | `src/boot/official.ts` 以整包锚点 `createRequire` |
| Cordis | `@deepseek-ai/cordis` 4.0.5 | `overrides`；`node_modules` 实测 |
| Cordis 插件 | group 1.0.5 / include 1.0.10 / loader 1.0.6 / timer 1.1.7 | `overrides`；`node_modules` 实测 |
| Node 下限来源 | `@earendil-works/pi-ai@1.4.0`、`undici@8.11.2` 的 engines | `node_modules` 实测 |

## 环境

| 项 | 值 |
| --- | --- |
| 系统 | macOS 27.0.1（build 26A434），arm64 |
| CPU | Apple M5 |
| 终端 | Ghostty 1.4.0 |
| Node（主） | v24.18.0，npm 11.16.0 |
| Node（下限） | v22.19.0（nvm），启动冒烟通过 |
| Node（拒绝） | v20.20.0，按预期拒绝启动 |
| 数据根 | 证据运行使用系统临时目录（macOS `/var/folders/...`）下的合成目录 |
| npm cache | 固定在系统临时目录，不写 `~/.npm` |

## 复现

```sh
npm ci
mkdir -p packaging/dist
npm pack --pack-destination packaging/dist
shasum -a 256 packaging/dist/dsh-tui-nano-0.2.0.tgz
npm run test:e2e
```
