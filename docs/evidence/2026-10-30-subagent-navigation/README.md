# 证据：子代理三层导航与消失（2026-10-30）

- Spec：[2026-10-30-nano-subagent-navigation](../../specs/2026-10-30-nano-subagent-navigation/README.md)
- Issue：[#119](https://github.com/nano-sun99/dsh-tui-nano/issues/119)
- 环境：macOS，真 PTY（100×30），本地 mock 模型（`tests/e2e/mock-model.mjs`，`MOCK_SCRIPT=subagent`），不访问真实模型。

## 文件

| 文件 | 内容 |
|---|---|
| `unit-feature-output.txt` | `npm test`：单元 277 + feature 25 全绿 |
| `checks-output.txt` | `npm run typecheck` / `npm run lint`（0 error，5 条仓内既有 warning）/ `npm run build` |
| `e2e-output.txt` | 4 条真 PTY e2e 全绿（含 30 秒消失） |
| `e2e-full-summary.txt` | 全量 `npm run test:e2e` 摘要（43 pass / 1 release 冻结矩阵 fail / 2 skip） |
| `pty-dock.txt` | dock 入列、名字/状态词、输入框上方位置 |
| `pty-list.txt` | `全部子代理 · 1`、行、关闭按钮、输入框保留 |
| `pty-detail.txt` | `‹ 返回 子代理 · 名字 · 状态词`、child 正文、`给 … 发送消息…` 占位 |
| `pty-grace.txt` | 终态 30 秒后 dock 行消失，settlement notice 仍在 |

## 验收对照

| 验收 | 证据 |
|---|---|
| A1 冷启动 0 行 / 空 dock Alt+L | `tests/unit/sv-dock.test.ts`、`tests/unit/sv-navigation.test.ts`（Alt+L 从空 dock 打开） |
| A2 终态 30 秒消失且不复活 | `tests/unit/sv-dock.test.ts`（连续 3 次 refresh 断言）；`pty-grace.txt`（真实事件 30 秒） |
| A3 `x` 仅终态行 / 同 id 重新 start | `tests/unit/sv-dock.test.ts`（含行仍存在时再次 start）、`tests/unit/sv-navigation.test.ts` |
| A4 ≤4 行 + 溢出 / dismissed 不截断 | `tests/unit/sv-dock.test.ts`（6 行窗口、300 次出列） |
| A5 三种来源返回 | `tests/unit/sv-navigation.test.ts`（dock / 列表（含滚动位置）/ 结果卡）；`tests/unit/sv-result.test.ts`（官方回执文本识别） |
| A6 Esc / ← / 按钮；问卷审批优先 | `tests/unit/sv-navigation.test.ts`（Esc / 空输入 ← / 顶部按钮）；问卷/审批在 `NanoApp` 中先于 features 处理；IME 见已知限制 |
| A7 草稿隔离、`x` 不吞 | `tests/unit/sv-navigation.test.ts`（含 `x` 返回 false 交给输入框、主草稿非空时返回） |
| A8 五种 stopReason + unknown | `tests/unit/sv-dock.test.ts`、`tests/unit/sv-render.test.ts` |
| A9 external 不进 dock / 列表叶子 | `tests/unit/sv-dock.test.ts`（external start 过滤）、`tests/unit/sv-list.test.ts` |
| A10 一次性可读性条件验收 | `tests/unit/sv-navigation.test.ts`（可读 / 不可读 / 二次 Enter / 瞬时失败重试 / 未知模式原因） |
| A11 列表计数、滚动、诊断、读取中 | `tests/unit/sv-list.test.ts`、`tests/unit/sv-render.test.ts`（`诊断 · corrupt`）、`tests/unit/sv-navigation.test.ts` |
| A12 dock 消失后回执仍在 | `pty-grace.txt` 的 settlement notice |
| A13 test / typecheck / lint | `unit-feature-output.txt`、`checks-output.txt` |

## 已知限制

- IME 组合态由终端/输入法在按键到达应用前处理；TUI 层没有组合态状态，无法在应用内再判一次。问卷/审批焦点由 `NanoApp` 在 features 之前拦截。
- 当前部署的 provider 集未产出 one-shot / external 记录；一次性会话与 external 的读取路径来自官方类型与单测夹具，未在真实 provider 下复现。spec §1 已把这条列为条件验收的已知限制。
- `dismissed` 按 id 在会话内保存（规模与目录同阶），这是 spec 的选择；单测用 300 次出列验证不因容量边界复活。
- 全量 e2e 的 release 冻结矩阵用例失败与本次改动无关：`version-matrix.md` 绑定 0.2.0 发布 tarball，任何源码变更都会改变摘要；本次不是发布 PR，未改冻结矩阵。
- 主对话暂无卡片键盘焦点；结果卡入口只做鼠标点击，`Enter` 进卡片不在本次范围（spec §4.2）。
- 子详情内的 activation 卡在 maxDepth>1 时导航与展开都不生效；当前默认配置 maxDepth=1，不可达。

## 2026-10-31 重审修订

用户点「重审」，2 个只读 agent（规格符合性 + 对抗找 bug）。原始结论见 [PR #120 评论](https://github.com/nano-sun99/dsh-tui-nano/pull/120#issuecomment-6539631906)。

- 2 阻断：结果卡 `resultMeta` 真实不可达（改为识别官方回执文本）；续聊再次 start 未清 `terminalAt`（已修）。
- 12 条建议（两路去重）：external / 后代入 dock、详情 ↑ 串主历史、列表返回滚回顶部、一次性行二次 Enter 可进、草稿非空时 `x` 误删、残留焦点、诊断原因、unknown mode 原因、只读 paste / 换行、Home/End、溢出行焦点、探测失败锁死（均已修并补测试）。
- 事实澄清：§2 措辞、§9 机制清单、`scrollAnchor`、证据映射、占位符空格、IME / one-shot 真实验证限制（已回写 spec / 证据）。
- 代码验证：`npm test` 277 单元 + 25 feature 全绿；`npm run typecheck` / `npm run build` 绿；`npm run lint` 0 error（5 条仓内既有 warning）；全量 e2e 43 pass / 1 known fail / 2 skip。

修订后轻审（用户点「轻审」，1 个只读 agent）：

- 3 建议：可编辑详情 `Ctrl+End` 漏给主对话、unknown 详情滚动上限少 1 行、新用例卸载时 Yoga 越界（均已修并补测试）。
- 1 事实澄清：external activation 卡导航被拒后不展开（主视图已修：回落到工具卡展开；子详情内同类卡在 maxDepth>1 时仍不展开，见已知限制）。
- 范围外对账：本次 delta 的代码改动全部落在 spec §6 表内。
