# 证据 · 子代理运行期间主 agent 保持可对话

- 日期：2026-10-30
- 环境：macOS arm64（Darwin 27.0.0）、Node `v24.18.0`、官方 harness `0.2.1-rc.2`
- 对应 spec：`docs/specs/2026-10-30-nano-main-agent-responsive/README.md` §5 / §6
- 复现前提：`npm ci && npm run build`（PTY 证据跑 `dist/bin.js`）

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
✓ tests/unit/conversation-delivery.test.ts (6 tests)
  - 空闲提交走 followup
  - 运行中提交走 steer
  - 运行中带附件提交也走 steer，且回显与历史各一次
  - 三条提交路径共用同一 notice：运行中插话、空闲清空
  - 运行中状态行提示插话
  - 在根 agent 作用域注册委派纪律段

Test Files  14 passed (14)
     Tests  121 passed (121)   # tests/unit
Test Files   8 passed (8)
     Tests  25 passed (25)    # tests/feature

npm run typecheck：通过
npm run lint：exit 0（7 条既有 warning，均在本次未触碰的旧行；无 error）
```

覆盖映射：

| 验收 | 证据 |
|---|---|
| A1 | `运行中提交走 steer` / `空闲提交走 followup`：fake agent 记录 `steer`/`followup` 调用 |
| A2 | `运行中带附件提交也走 steer`：image content 经 `submitContent` 走 `steer`，回显与历史各一次；附件准入由 `tests/feature/attachments.test.ts` 既有用例覆盖，投递方式不改变准入 |
| A3 | `SubmitResult.delivery` 断言；仓内无 `SubmitResult.queued` 字段/类型引用（`grep -rn '\.queued' src tests` 为空；`queued work` 注释保留） |
| A4 | `在根 agent 作用域注册委派纪律段`：`name/order/text/interpolate` 全等断言；段只在 `ConversationController.start()` 的 `setup(agentCtx)` 注册，子代理各自是独立 scope，不继承根段 |
| A7 | `npm test` / `typecheck` / `lint` 全绿（lint warning 为既有项） |

## 2. PTY 证据（A5、A6）

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

覆盖映射：

| 验收 | 证据 |
|---|---|
| A5 | 输入区 notice「已插入（下一 step 或新回合生效）」；三条提交路径共用 `deliveryNotice()` |
| A6 | 状态行「Enter 插话 · Ctrl+C 停止」 |

## 3. 已知限制

- 本次未起真实子代理：投递分支由 `statusValue` 决定，与子代理类型无关；PTY 用慢速 mock 保持 running 即可复现同一路径。真实子代理场景由 #106 的后续跟踪覆盖。
- `steer` 是 best-effort：abort 窗口（Ctrl+C 后回合尚未 unwound）官方会改投 next-turn，notice 不承诺当前回合；见 spec §4.1。
- A4 的「子代理组装不含」由 agent 作用域注册保证，未另造子代理组装快照。
