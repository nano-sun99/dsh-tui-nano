# 证据：子代理 dock 位置与完成态对齐（2026-10-31）

- Spec：[2026-10-31-nano-subagent-dock-alignment](../../specs/2026-10-31-nano-subagent-dock-alignment/README.md)
- Issue：[#122](https://github.com/nano-sun99/dsh-tui-nano/issues/122)
- 环境：macOS，真 PTY（100×30 / 60×30），本地 mock 模型（`tests/e2e/mock-model.mjs`，`MOCK_SCRIPT=subagent`），不访问真实模型。

## 文件

| 文件 | 内容 |
|---|---|
| `unit-feature-output.txt` | `npm test`：单元 288 + feature 25 全绿 |
| `checks-output.txt` | `npm run typecheck` / `npm run lint`（0 error，5 条仓内既有 warning）/ `npm run build` / keymap 文档检查 |
| `e2e-output.txt` | 5 条子代理 PTY e2e 全绿（含 60 列） |
| `e2e-full-summary.txt` | 全量 `npm run test:e2e`：44 pass / 1 known fail / 2 skip |
| `pty-dock.txt` | 100 列：输入 → 状态栏 → dock（完成态） |
| `pty-dock-60.txt` | 60 列：dock 仍在状态栏之后，不压输入 |
| `pty-list.txt` | Alt+L 全部列表与计数 |
| `pty-detail.txt` | `← 子代理 名字` + 右侧状态词 |
| `pty-grace.txt` | 终态 30 秒后 dock 行消失，settlement notice 仍在 |

## 验收对照

| 验收 | 证据 |
|---|---|
| A1 dock 在状态栏之后、终端最底部 | `pty-dock.txt` / `pty-dock-60.txt`；`tests/unit/sv-app.test.ts` |
| A2 左右 2ch、顶边框、4 行 + 溢出 | 2ch / 顶边框：`pty-dock.txt`、`pty-dock-60.txt`；4 行 + 溢出：`tests/unit/sv-render.test.ts`、`tests/unit/sv-navigation.test.ts` |
| A3 100/60 列不压输入与状态栏 | `pty-dock.txt`、`pty-dock-60.txt`；`tests/unit/sv-app.test.ts` 的 `transcriptBodyHeight` 用例 |
| A4 可续聊 / one-shot `turn/end completed` 立即完成 | 主证据：`tests/unit/sv-dock.test.ts`（turn 级状态、one-shot 同路径、activation 顺序）；`pty-dock.txt` 的「完成」只证明视觉结果（同一场景 activation end 也可能给出完成，不能单独区分 turn 路径） |
| A5 `turn/start` 复位并清 `dismissed` / `terminal` | `tests/unit/sv-dock.test.ts` |
| A6 reason 映射（含 blocked / interrupted / forked / 未知） | `tests/unit/sv-dock.test.ts` |
| A7 activation end 兜底不覆盖 turn 终态 | `tests/unit/sv-dock.test.ts`（turn 先到、activation 先到两种顺序） |
| A8 详情头部 + dock 在详情隐藏 | `pty-detail.txt`；`tests/unit/sv-navigation.test.ts` |
| A9 焦点 / `x` / Alt+L / 返回 / 草稿无回归 | `tests/unit/sv-navigation.test.ts`、既有 e2e |
| A10 test / typecheck / lint / build / 文档检查 / PTY e2e | `unit-feature-output.txt`、`checks-output.txt`、`e2e-output.txt`、`e2e-full-summary.txt` |
| A11 冷启动 0 行 | `tests/unit/sv-dock.test.ts` |
| A12 `/model` 面板打开时 dock 隐藏 | `tests/unit/sv-app.test.ts` |

## 已知限制

- mock 子代理是 continuable；one-shot / external 的真实 provider 路径仍用官方类型 + 夹具验证，未在真实 provider 下复现。
- `turn/start` / `turn/end` 订阅跟随 child agent live 生命周期；真实 provider 的同一事件序列已在 mock 的官方 subagent 路径验证，但未在用户真实会话里重放。
- 全量 e2e 的 release 冻结矩阵用例仍会因源码变更失败；本 PR 不是发布 PR，未改冻结矩阵。
- dock 出现/消失会改变正文区高度；非贴底阅读时可视内容整体位移 `dockRows` 行，规格 §4.2 未要求锚定保持，本次不补偿。
- `/model` 面板与 dock 的互斥由 `dockBody()` / `dockRows()` 各自判断，当前同步；若未来面板 `open` 与 `rows()` 瞬时不一致，两处分支可能短暂错开。
