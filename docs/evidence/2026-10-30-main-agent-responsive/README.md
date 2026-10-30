# 证据 · 子代理运行期间主 agent 保持可对话

- 日期：2026-10-30
- 环境：macOS arm64（Darwin 27.0.0）、Node `v24.18.0`、官方 harness `0.2.1-rc.2`
- 对应 spec：`docs/specs/2026-10-30-nano-main-agent-responsive/README.md` §5 / §6
- 基线：`origin/main` @ `eaa4b44`（分支已对齐）
- 复现前提：`npm ci && npm run build`（PTY / 组装证据跑 `dist/`）

## 1. 自动化测试（A1–A4、A7）

命令：

```text
npx vitest run tests/unit/conversation-delivery.test.ts
npm test
npm run typecheck
npm run lint
```

实测结果（2026-10-30）：

```text
✓ tests/unit/conversation-delivery.test.ts (11 tests)
  - 空闲提交走 followup
  - 运行中提交走 steer
  - 运行中带附件提交也走 steer，且回显与历史各一次
  - 运行中连续两次提交都走 steer，顺序保留
  - 附件经 assemblePrompt 后仍以 steer 投递
  - 通用文件一次性回执经 assemblePrompt 后也以 steer 投递
  - 投递失败时透传原错误并写 danger notice
  - 组装 user message 失败时也写 danger notice
  - 三条提交路径共用同一 notice：运行中插话、空闲清空
  - 运行中状态行提示插话
  - 在根 agent 作用域注册委派纪律段

Test Files  14 passed (14)
     Tests  126 passed (126)   # tests/unit
Test Files   8 passed (8)
     Tests   25 passed (25)    # tests/feature

npm run typecheck：通过
npm run lint：exit 0（7 条既有 warning，均在本次未触碰的旧行；无 error）
```

失败路径用例是先写后修的：实现未修时 `投递失败时透传原错误并写 danger notice` 实际抛出 `message is not a function`，修掉局部变量遮蔽后才转绿。

覆盖映射：

| 验收 | 证据 |
|---|---|
| A1 | `运行中提交走 steer` / `空闲提交走 followup`：fake agent 记录 `steer`/`followup` 调用 |
| A2 | 运行中图片与通用文件各经 `assemblePrompt` 后走 `steer`；回显与历史各一次；官方准入由 `tests/feature/attachments.test.ts` 既有用例覆盖；32 KiB 是 UI 层既有检查，本次未改（spec §3.1 要求不变） |
| A3 | `SubmitResult.delivery` 断言；仓内无 `SubmitResult.queued` 字段/类型引用（`grep -rn '\.queued' src tests` 为空；`queued work` 注释保留） |
| A4 | 单测断言 `name/order/text/interpolate`；另有真组装证据，见 §3 |
| A5 | 三条路径共用 `deliveryNotice()`（单测 + 代码核对）；PTY 只覆盖 Enter 路径，见 §4 已知限制 |
| A6 | `RUNNING_HINT` 常量断言 + PTY 状态行，见 §2 |
| A7 | `npm test` / `typecheck` / `lint` 全绿（lint warning 为既有项） |

## 2. PTY 证据（A5 Enter 路径、A6）

脚本：`docs/evidence/2026-10-30-main-agent-responsive/pty-evidence.mjs`

```sh
node docs/evidence/2026-10-30-main-agent-responsive/pty-evidence.mjs
```

做法：用 `MOCK_SCRIPT=slow` 的本地 mock 模型把回合保持在 running；PTY 里先发「第一条」，0.8s 后发「第二条」；在模型返回前抓取屏幕。

实测输出（2026-10-30）：

```text
  ────────────────────────────────────────────────────────────────────────────────────────────────
  ›  输入消息…  已插入（下一 step 或新回合生效）
  ────────────────────────────────────────────────────────────────────────────────────────────────
  …/worktrees/issue-108                                                   Enter 插话 · Ctrl+C 停止
PTY 证据通过：运行中提交已插入当前回合，notice 与状态行正确
```

同屏另见 `nano  deepseek-official/deepseek-flash · 运行中`，transcript 中同时出现「第一条」「第二条」。

## 3. 根 agent 组装证据（A4）

脚本：`docs/evidence/2026-10-30-main-agent-responsive/prompt-evidence.mjs`

```sh
node docs/evidence/2026-10-30-main-agent-responsive/prompt-evidence.mjs
```

做法：真 boot 官方核心 + 真 `ConversationController.start()`；对根 agent 与另一个未走该 `setup` 的 agent 各组装一次系统提示。

实测输出（2026-10-30）：

```text
根 agent sections: mcp-resource-servers | nano:delegation-responsiveness | deployment:persona-suffix
根 agent 组装结果包含纪律正文：true
未注册该段的 agent 组装结果包含纪律正文：false
A4 组装证据通过
```

说明：第二个 agent 用于证明注册是 agent 作用域的（子代理走同一套独立 scope，不继承根段）；它不是通过 subagent 工具起的真实子代理，真实子代理链路不在本单。

## 4. 已知限制

- A5 的 PTY 证据只覆盖 Enter 文本路径；附件与未知 `/命令` 路径调用同一个 `deliveryNotice()`，已做代码核对，没有单独 PTY 证据。
- 32 KiB 上限是 `nano-app` / `feature-host` 的既有检查，本次没有改动，也没有新增测试。
- 附件的一次性回执对象已经过 `steer` 投递验证；官方 `saveFileStream` 的 commit/release 时序由官方持有，本次投递方式不改变它。
- `steer` 是 best-effort：abort 窗口（Ctrl+C 后回合尚未 unwound）官方会改投 next-turn，notice 不承诺当前回合；见 spec §4.1。
- 模型轮询只能软约束；单步长调用仍会延迟到该 step 结束。#106 只跟踪「整回合后台化」，不覆盖本单未验的真实子代理链路。
- 用户文档 `README.md` / `docs/release/design-contract.md` 仍写旧的「排队」入口，超出本 spec 范围，另开文档单。
