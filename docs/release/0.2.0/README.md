# dsh-tui-nano 0.2.0 发布验收

- 规格：`docs/specs/2026-10-28-nano-ts/S03-release.md`；执行单：#88。
- **结论：不发布。** 打包、安装链与 Rust/bridge 退场已完成，但 §3.3 仍有必测项没有 0.2.0 证据；按 §3.2 口径构成阻断。详见 [`release-conclusion.md`](release-conclusion.md)。
- 产物：`packaging/dist/dsh-tui-nano-0.2.0.tgz`，SHA-256 `4e4ca5b6…`（完整值见 [`version-matrix.md`](version-matrix.md)）。

## 目录

| 文件 | 内容 |
| --- | --- |
| `release-conclusion.md` | 发布结论、B1–B8、§3.3 矩阵、阻断项与已完成清单 |
| `version-matrix.md` | 产物哈希、官方依赖、Node/Ghostty/macOS/CPU、复现命令 |
| `known-limitations.md` | 必须披露的限制与证据未覆盖项 |
| `evidence/tests-unit-feature.txt` | `npm run build && npm test`（单元 101 + 功能 25） |
| `evidence/ghostty/` | 真 Ghostty 截图（深/浅、60/100 列、CJK、diff、透明度）与 `summary.json` |
| `evidence/e2e-release.txt` | 发布级 e2e 32 个用例（安装 16 + 视觉 3 + 能力 1 + 交互 5 + 输入 2 + 跨会话 2 + 主链路 2 + Monitor 1） |

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

前置：macOS arm64 + Ghostty；Node 22.19 与 24.x 各一份（证据运行用 nvm 的 v22.19.0 与 v24.18.0）。所有测试使用合成 `HOME` / `DSH_HOME` / 数据根 / 安装前缀；npm cache 固定在系统临时目录，不写 `~/.npm`。

视觉与跨会话九面隔离的证据缺口见 `known-limitations.md`「证据未覆盖」；这些缺口正是当前阻断项。

## 历史

旧实现（v1）的发布验收在 [`../0.1.0/`](../0.1.0/README.md)，已标 HISTORICAL；代码在 tag `rust-final` 与分支 `archive/rust-v1`。
