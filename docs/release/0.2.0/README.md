# dsh-tui-nano 0.2.0 发布验收

- 规格：`docs/specs/2026-10-28-nano-ts/S03-release.md`；执行单：#88。
- **结论：不发布。** 打包、安装链与 Rust/bridge 退场已完成；§3.3 的必测项除用户 2026-10-30 认可按边界结案的项外均已取证。本版由用户拍板不发布，`dist.integrity` 留作发布后外部核对。详见 [`release-conclusion.md`](release-conclusion.md)。
- 产物：`packaging/dist/dsh-tui-nano-0.2.0.tgz`，SHA-256 `384215a2…`（完整值见 [`version-matrix.md`](version-matrix.md)）。

## 目录

| 文件 | 内容 |
| --- | --- |
| `release-conclusion.md` | 发布结论、B1–B8、§3.3 矩阵、阻断项与已完成清单 |
| `version-matrix.md` | 产物哈希、官方依赖、Node/Ghostty/macOS/CPU、复现命令 |
| `known-limitations.md` | 必须披露的限制与证据未覆盖项 |
| `feature-matrix.md` | 功能面 16 组逐项证据、部分 / 边界与剩余缺口 |
| `evidence/tests-unit-feature.txt` | `npm run build && npm test`（单元 112 + 功能 25） |
| `evidence/ghostty/` | 真 Ghostty 截图（深/浅、60/100 列、CJK、diff、透明度）与 `summary.json` |
| `evidence/e2e-release.txt` | 发布级 e2e 42 个用例全过（安装 16 + 视觉 3 + 能力 1 + 交互 6 + 输入 2 + 跨会话 10 + 主链路 2 + Monitor 1 + 调度 1） |

## 复核方式

```sh
npm ci
npm run build
npm test
NANO_NODE_22=<node-22.19> NANO_NODE_20=<node-20> npm run test:e2e
mkdir -p packaging/dist
npm pack --pack-destination packaging/dist
shasum -a 256 packaging/dist/dsh-tui-nano-0.2.0.tgz
```

前置：macOS arm64 + Ghostty；Node 22.19 与 24.x 各一份（证据运行用 nvm 的 v22.19.0 与 v24.18.0，另用 v20.20.0 验证拒绝启动）。所有测试使用合成 `HOME` / `DSH_HOME` / 数据根 / 安装前缀；npm cache 固定在系统临时目录，不写 `~/.npm`。

当前无本版阻断项；功能面部分 / 边界、物理断网模拟按用户 2026-10-30 拍板结案，`dist.integrity` 属发布后外部核对项（见 `release-conclusion.md` §3）。

## 历史

旧实现（v1）的发布验收在 [`../0.1.0/`](../0.1.0/README.md)，已标 HISTORICAL；代码在 tag `rust-final` 与分支 `archive/rust-v1`。
