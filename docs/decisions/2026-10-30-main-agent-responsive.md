# ADR-20261030-main-agent-responsive：运行中的用户消息走 steer，子代理不得挤占主对话

- 状态：生效中
- 日期：2026-10-30
- 决策人：用户
- 适用范围：根 agent 的提交语义、根 agent 系统提示中的委派纪律
- 取代：无
- 被取代：无
- 决策来源：2026-10-30 用户选择「先做 1+2」；对照 Claude Code 2.1.88 源码（`tools/AgentTool/prompt.ts:263`、`query.ts:1547`、`utils/messageQueueManager.ts:129`）与 2026-10-28 nano 会话证据（`session-f5682f02`）

## 决定

- 根 agent **运行中**，用户提交（文本 / 附件 / 未知 `/命令`）一律走 `agent.steer`（下一 step 注入）；**空闲**走 `agent.followup`（下一回合）。
- 根 agent 的系统提示注册固定段 `nano:delegation-responsiveness`：禁止 sleep / 轮询 / 偷看子代理；只剩等待时结束回合，完成通知会唤醒。
- 不实现「整回合后台化」；该能力由 [#106](https://github.com/nano-sun99/dsh-tui-nano/issues/106) 单独跟踪。
- `Ctrl+S` 保留显式 steer；不新增键位，也不新增「排队」键。

## 依据

- 2026-10-28 会话 `session-f5682f02`：主 agent 派 2 个子代理后轮询 `list_agents` 10 次 + `sleep 90`，回合持续 5 分 17 秒；期间子代理完成通知以 steer 进入当前回合，用户消息却走 followup 排到回合之后。
- Claude Code 2.1.88：用户消息优先级 `next`、任务通知 `later`（`utils/messageQueueManager.ts:129`），每个模型请求前把用户消息注入当前回合（`query.ts:1547`），并明令禁止 sleep / poll / 偷看（`tools/AgentTool/prompt.ts:263`）。
- dsh `steer` 在空闲时会 `wakeDriver` 开新回合并在 pre-step 取走消息（`dsh-agent-loop` `lib/index.js:800-865`），运行/空闲分流安全。

## 否决了什么

- **只加提示词、不改提交语义**：模型不遵守时没有硬保证。
- **只改 Enter、不动系统提示**：模型继续轮询会拖长回合，用户消息仍可能干等。
- **整回合后台化（Claude Code Ctrl+B 双击）**：dsh 单回合架构没有并发回合 API，需要另建会话或等官方支持；已开 #106 跟踪。

## 接受的代价

- 运行中提交会插入当前回合，可能改变模型正在进行的计划；用户仍可用 Ctrl+S 显式 steer，或停止当前回合。
- 提示词是软约束，不能保证模型永不轮询；硬保证只到「用户消息最多等一个 step」。
- 单步长调用（如 `sleep 90`）仍会延迟到该 step 结束；与 Claude Code 同类限制。
- `SubmitResult.queued` 改名会动到内部类型（仓内无外部消费者）。

## 允许重开的条件

- dsh 官方提供后台回合 / 并发回合能力。
- 官方 subagent 工具提供 wait / background 参数或消息优先级。
- `steer` 语义变化，或出现用户消息被通知饿死的实测。
- 用户明确要求把 Ctrl+S 改成「排队」。

## 关联

- spec：`docs/specs/2026-10-30-nano-main-agent-responsive/README.md`
- 跟踪：issue #106（整回合后台化，不在本次范围）
- 相关：`ADR-20261029-s02-s01-seams`、`ADR-20261022-input-history`
