# 版本矩阵（0.2.0）

- 记录日期：2026-11-02（发布改判后重建；历史记录日期 2026-10-30）
- 包名 / 版本：`dsh-tui-nano` / `0.2.0`
- 源码：`main` @ `0e43397`（PR #136 合并后，2026-11-02）；历史构建基线 `d38fbed`（2026-10-30）；归档基线 `f8a7971`
- 归档：tag `rust-final`（`f8a7971`）与分支 `archive/rust-v1`

## 产物

| 项 | 值 |
| --- | --- |
| 文件 | `packaging/dist/dsh-tui-nano-0.2.0.tgz` |
| 大小 | 561,309 字节（约 548 KiB） |
| 文件数 | 137 |
| SHA-256 | `ea64a53ee12dcf9a2eec8803d3a28fdc5518a6c1ea4411abbe877d860cbca0bf` |
| 期望 `dist.integrity` | `sha512-oWC/IW0CHruMiy4t46K3Wwr+tS+w9exC2UwxznDKcndfki86NaJoOnKpDfHB/GHHbFB3Mc2ztuKNctlMPqBb+w==` |
| 发布渠道 | GitHub Release `v0.2.0`（tarball 附件）；npm registry 未发布 |

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
| Node（下限） | v22.19.0（nvm），e2e 设置 `NANO_NODE_22` 后启动冒烟通过 |
| Node（拒绝） | v20.20.0（nvm），e2e 设置 `NANO_NODE_20`，按预期拒绝启动 |
| 数据根 | 证据运行使用系统临时目录（macOS `/var/folders/...`）下的合成目录 |
| npm cache | 固定在系统临时目录，不写 `~/.npm` |

## 复现

```sh
npm ci
npm run build
NANO_NODE_22="$HOME/.nvm/versions/node/v22.19.0/bin/node" \
  NANO_NODE_20="$HOME/.nvm/versions/node/v20.20.0/bin/node" \
  npm run test:e2e
mkdir -p packaging/dist
npm pack --pack-destination packaging/dist
shasum -a 256 packaging/dist/dsh-tui-nano-0.2.0.tgz
```
