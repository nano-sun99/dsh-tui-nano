> **HISTORICAL（2026-10-29 起）**：本目录记录的是已退场的 Rust 实现（v1）的发布验收，不作为 0.2.0 的依据。
> 代码在 tag `rust-final` 与分支 `archive/rust-v1`；当前发布验收见 [`../0.2.0/`](../0.2.0/README.md)。

# dsh-tui-nano 0.1.0 发布验收

- 规格：`docs/specs/2026-10-20-nano-v1/S13-release.md`；执行单：#16。
- 结论：**不发布**。存在 3 项 design-contract 阻断偏差，且人工输入法组合态未验证。详见 `release-conclusion.md`。
- 冻结产物：`packaging/dist/dsh-tui-nano-0.1.0-arm64.tar.gz`（SHA-256 见 `version-matrix.md`）。

## 目录

| 文件 | 内容 |
| --- | --- |
| `version-matrix.md` | 构建号、官方版本/源码基线、终端/系统/Node/CPU、产物哈希 |
| `known-limitations.md` | 未测项、已知边界和阻断项 |
| `release-conclusion.md` | 发布结论、阻断项、验收勾选 |
| `design-contract-compliance.md` | 对 design-contract 的逐项核对 |
| `evidence/` | 安装演练、跨功能 e2e、自动回归、Ghostty 截图与检查 |

## 复核方式

旧实现的构建/安装/测试脚本已随 2026-10-29 退场删除，主仓不再保留副本。需要复核时从归档恢复：

```sh
git fetch origin archive/rust-v1
git worktree add /tmp/nano-rust-v1 origin/archive/rust-v1
# 归档里的 packaging/ 与 tests/e2e/ 仍是 v1 原样，按当时的 README 执行
```

`rust-final` tag 记录了删除前的 `main` SHA（`f8a7971`）。

Ghostty 验收需要 macOS 辅助功能权限（System Events）与屏幕录制权限（仅窗口级截图）。所有截图来自合成 HOME/workdir；不采集用户真实桌面。
