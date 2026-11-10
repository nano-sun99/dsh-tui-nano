# 版本矩阵（0.2.5）

- 验证日期：2026-11-10
- 结论口径：只列实际执行过的组合；未测组合不宣称可用。

## 1. 产物

| 字段 | 值 |
| --- | --- |
| 版本 | `0.2.5` |
| 构建平台 | macOS 27.2，Apple Silicon，arm64 |
| Node | `v24.18.0`（构建）；e2e 矩阵另测 `v24.9.0` / `v20.20.0` |
| 官方 dsh | `0.2.2-rc.1` |
| 终端 | Ghostty（本轮未重跑真机视觉；沿用 0.2.4 环境） |

## 2. 支持矩阵

| 维度 | 本版承诺 | 不承诺 |
| --- | --- | --- |
| 平台 | macOS arm64 + Ghostty | 其他终端、Windows、Linux |
| 官方 Harness | 精确 `0.2.2-rc.1` | 其他版本、未知版本 |
| Node | `>=24.9.0`；24.9.0 与 20.20.0 实测 | 其他下限以下版本 |
| 宽度 | 60 与 100 列实测 | 其他宽度的任意列数 |

## 3. 构建与产物哈希

| 文件 | 值 |
| --- | --- |
| `dsh-tui-nano-0.2.5.tgz` | 599,780 字节 / 157 文件 |
| SHA-256 | `af145f45aa389ee7c06843e4ce27054e75db87e491db0f173ebb3ca0ccdf4401` |
| npm integrity | `sha512-T1j6gVyYtiJIUqGquKFu8yQfHrr9zyzppg55EWptYOYB8j4DZC/sCpDDmx2d+kW4Q6ZaxwdnK0vQSNTXq2ehLA==` |

哈希来自 `npm pack`，并用第二次打包复核一致；源码或构建输入变化后必须重新打包并更新本表。

## 4. 验证覆盖

| 项目 | 方式 | 结果 |
| --- | --- | --- |
| 类型检查 | `npm run typecheck` | 通过 |
| 单元 + feature | `npm test` | unit 547 / 547；feature 56 / 56 |
| 发布级 e2e | `npm run test:e2e`（含 Node 矩阵） | 62 通过 / 0 失败 / 1 跳过 |
| 哈希复核 | 在发布提交上用 `NANO_RELEASE_VERIFY=1` 跑 `release.test.mjs` | 通过 |
| 隔离安装 | `npm install -g --prefix <tmp> <tarball>` | `nano 0.2.5 (harness 0.2.2-rc.1)` |
| lint | `npm run lint` | 0 error / 5 存量 warning |
