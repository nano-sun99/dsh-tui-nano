# 真终端证据：审批卡进正文流 + 决策留痕

- 环境：macOS 27.0.1（arm64），Node v24.18.0，PTY（`tests/e2e/pty-start.py`，100/60 列 × 30 行），采集日期 2026-11-02。
- 方法：本地 mock 模型（`tests/e2e/mock-model.mjs`，`MOCK_SCRIPT=approval`）触发 bash 提权审批，真实 `dist/bin.js` 在 PTY 中运行；无真实凭据、无模型调用、不打开窗口。
- 文件：`100-dark.txt` / `100-light.txt` / `60-dark.txt` / `60-light.txt`，原始终端字节（含 ANSI）；去转义后可直接检索 `是否运行这条检查命令`。
- 复跑：`bash docs/evidence/2026-11-01-nano-approval-card-in-transcript/terminal/capture.sh`（先 `npm run build`）。

## 核对项

| 项 | 结果 |
|---|---|
| 卡片位于正文末尾（Bash 工具行之后），不在输入区、不是浮层 | 四份证据均可见横线 + 标题接在 `… Bash touch approval-ok.txt` 之后 |
| 输入块保留在底部，占位「等待你处理上面的确认…」 | 四份证据最后一行可见 |
| 完整命令以 muted 渲染 | `touch approval-ok.txt` |
| 4 个选项，默认焦点「拒绝」 | `> 2. 拒绝`；前两项带描述 |
| 活动行为静态「等待你的授权」（鲸尾动画未启动） | 四份证据均只有一行文本，无图像序列 |
| 60 列换行正常、无横向溢出 | `60-*.txt` |

## 边界

- 本组是 **PTY 文本证据**，不是窗口截图；与 e2e（`tests/e2e/main-chain.test.mjs`、`cross-surface.test.mjs`）断言同一场景。
- 未覆盖真实 Ghostty 的像素级观感；视觉终验可在真实窗口按 spec §6 复核。
- 决策留痕的四种文案由单测覆盖（`tests/unit/approval-card.test.ts`），真终端结算后的行需要按键后才出现，未在本组截取。
