# [2026-10-30-nano-main-agent-responsive] 子代理运行期间主 agent 保持可对话

- 组标识：`2026-10-30-nano-main-agent-responsive`
- 角色：单份 spec，总纲与执行规格合一
- 状态：方案中（草案，待审核）
- 结构：不拆——1 份 spec + 1 张执行 issue
- 机制范围：**无新增机制**——① 复用官方 `steer`/`followup`，② 复用官方 `systemPrompt.section`
- 上游：`2026-10-28-nano-ts` S01/S02、[ADR-20261029-s02-s01-seams](../../decisions/2026-10-29-s02-s01-seams.md)、[ADR-20261022-input-history](../../decisions/2026-10-22-input-history.md)
- 替代关系：本 spec 与 S01 §4「queue/steer/stop/clear」、S02 §2「Enter 提交」的冲突处以本 spec 为准；其余条款沿用，不回写旧 spec
- ADR：本次新增 [ADR-20261030-main-agent-responsive](../../decisions/2026-10-30-main-agent-responsive.md)（同一文档 PR）
- 下游：spec 合并后开执行 issue；[#106](https://github.com/nano-sun99/dsh-tui-nano/issues/106) 只跟踪「整回合后台化」，不在本次范围
- 合入前提：本 spec 合并后开执行 issue；实施需单测/feature 测试全绿，并按 §6 留证据

## 1. 目标

主 agent 在子代理运行期间仍能回应用户：

1. **运行中提交**（文本、附件、未知 `/命令`）不再排到整个回合之后，而是在下一个 step 进入当前回合（官方 `steer`）。
2. **空闲提交**保持原语义（官方 `followup`，立即开始新回合）。
3. 根 agent 的系统提示明确禁止 sleep / 轮询 / 偷看子代理；派完只剩等待时结束回合，完成通知会唤醒。

不承诺：模型 100% 不轮询（提示词是软约束）；「整回合后台化」（[#106](https://github.com/nano-sun99/dsh-tui-nano/issues/106)）。

## 2. 当前事实与根因

调查基线：`origin/main` @ `5bf9b4f`；官方 `@deepseek-ai/dsh` 0.2.1-rc.2。

| 事实 | 证据 |
|---|---|
| 主 agent 派完子代理后仍占用回合轮询、等待 | 2026-10-28 会话 `session-f5682f02`：218.0s 回合开始，派出 2 个子代理后轮询 `list_agents` 10 次、执行 `sleep 90`；551.3s 回合才结束（5 分 17 秒） |
| 用户消息固定排到下一回合 | `src/conversation/controller.ts:317-352`：`submit`/`submitContent` 调 `agent.followup`（next-turn）；只有 Ctrl+S 的 `steer` 走 next-step |
| 子代理完成通知反而能插入当前回合 | `node_modules/@deepseek-ai/dsh-subagent/lib/index.js:2058`：父级 busy 时通知走 `steer` |
| 官方没有「禁止 sleep/轮询」的指令 | `dsh-tool-subagent` 的工具描述只说「立即返回 id，完成时运行时会通知」；全包检索无 sleep/poll 约束 |
| `steer` 对空闲 agent 也安全 | `dsh-agent-loop` `lib/index.js:800-865`：`steer` 入 next-step 后 `wakeDriver` 会开新回合并在 pre-step 取走 |

结论：当前优先级是反的——子代理通知能插队，用户消息排在整回合之后。①把用户消息改成下一 step 注入；②补上官方缺失的委派纪律。

## 3. 范围与边界

### 3.1 本次做

- `src/conversation/controller.ts`
  - `submitContent` 改为单一投递入口：`statusValue === 'running'` → `agent.steer(...)`；否则 → `agent.followup(...)`。本地回显、历史记录、附件 content、失败回滚不变。
  - `SubmitResult.queued: boolean` 改为 `delivery: 'steer' | 'followup'`（无外部消费者，改名以免语义撒谎）。
  - `start()` 的 `setup(agentCtx)` 里注册根 agent 的委派纪律段：`agentCtx.systemPrompt.section({ name: 'nano:delegation-responsiveness', order: 10150, interpolate: false, text: DELEGATION_GUIDANCE })`；disposer 收进 `this.disposers`。
  - 文本固定为（English，模型面向）：
    > Delegated subagents run in the background. The runtime notifies you when one finishes; do not sleep, poll `list_agents`, or read a subagent's output file to check its progress. If you have no useful work left while they run, end your turn — the user can keep talking to you, and the completion notice will wake you in a later turn.
- `src/app/nano-app.ts`：`conversation.submit` 成功后按 `delivery` 设 notice——`steer` 显示「已插入当前回合（下一 step 生效）」，`followup` 清空 notice；32 KiB 上限与草稿保留不变。
- `src/controls/feature-host.ts`：附件提交继续调 `submitContent`（现在自动按状态分流），并按返回值设同样的 notice；未知 `/命令` 走 `submit`，自动获得同一语义。
- `src/app/App.tsx`：运行中状态行提示改为「Enter 插话 · Ctrl+S 引导 · Ctrl+C 停止」；空闲提示不变。
- 测试：新增 `tests/unit/conversation-delivery.test.ts`（或并入现有 conversation 测试）——running → steer、idle → followup、附件 content 同规则、回显/历史各一次、`delivery` 返回值；提示段注册、order 与文本断言。
- 证据：`docs/evidence/2026-10-30-main-agent-responsive/README.md`（测试输出 + PTY 截图/脚本）。

### 3.2 本次不做

- 不改 `Ctrl+S` 语义（仍是显式 steer）；它与运行中 Enter 等价，保留兼容。
- 不改官方 `followup`/`steer`、`stop`/`clear` 语义（停止保留队列、清空是复合动作）。
- 不改子代理工具、完成通知投递、容量/深度。
- 不实现「整回合后台化」；[#106](https://github.com/nano-sun99/dsh-tui-nano/issues/106) 跟踪。
- 不新增自动中断、自动取消回合、自动排队的机制。
- 不改附件准入、历史文件格式、键位表；不新增依赖。

## 4. 行为规则

1. 提交时按 `statusValue`（TUI 已订阅 `agent/status`，不直读 `agent.status`）分流；状态在检查后翻转的边界：running→idle 时 steer 会唤醒新回合；idle→running 时 followup 会排到下一回合（最坏等一个回合）。
2. 运行中文本/附件/未知命令走同一入口，不出现「文本插话、附件排队」的分裂。
3. 本地回显、历史、32 KiB 上限、提交失败回滚保持 S01/S02 既有验收。
4. 提示段只注册在根 agent 作用域，子代理不继承；段名唯一，`order = 10150`（第一方 web 段 10100 之后、persona 后缀 10200 之前），`interpolate: false`。
5. 提示段是软约束；硬保证来自第 1 条——即使模型继续轮询，用户消息最多等一个 step。
6. 单步长调用（如 `sleep 90`）仍会延迟到该 step 结束；这是官方回合链的边界，与 Claude Code 同类，不在本次解决。

## 5. 验收

- **A1** running 提交调用 `steer` 且不调用 `followup`；idle 提交调用 `followup` 且不调用 `steer`。
- **A2** 附件 content 在 running 下走 `steer`、idle 下走 `followup`；回显与历史各一次；32 KiB 超限仍拒绝并保留草稿（UI 层回归）。
- **A3** `SubmitResult.delivery` 与实际调用一致；仓内无 `queued` 残留引用。
- **A4** `start()` 在根 agent 的 `systemPrompt` 上注册 `nano:delegation-responsiveness`，`order = 10150`，文本与 §3.1 完全一致；组装结果包含该段。
- **A5** 运行中提交成功后 notice 为「已插入当前回合（下一 step 生效）」；空闲提交清空 notice。
- **A6** 状态行运行中提示为「Enter 插话 · Ctrl+S 引导 · Ctrl+C 停止」。
- **A7** `npm test`、`npm run typecheck`、`npm run lint` 全绿；既有测试无回归。

## 6. 证据

- 单测/feature 测试输出覆盖 A1–A6，放 `docs/evidence/2026-10-30-main-agent-responsive/README.md`。
- PTY/真实终端：运行中提交后消息出现在 transcript、本回合继续、输入区 notice 与状态行正确；保留脚本与截图。若当日无法稳定复现真实子代理，用可控 fake agent 的 feature 测试作为 A1/A2 证据，PTY 只证明 UI 文案与 notice。
- 提示段证据：打印/断言根 agent 组装后的 system prompt 文本，确认段在 10100 与 10200 之间。

## 7. 自定细节

- 沿用 `submit`/`submitContent` 方法名，不新增 `deliver` 入口，避免多一条提交路径。
- `SubmitResult.queued` 改名 `delivery`；无外部消费者，属内部类型调整。
- notice 文案与触发条件按 §3.1；`feature-host` 附件路径复用同一文案。
- 提示段名称 `nano:delegation-responsiveness`、`order 10150`、英文原文、`interpolate: false`。
- `Ctrl+S` 保留显式 steer；运行中与 Enter 等价，不另改键位，也不新增「排队」键。
- 状态判断用 `statusValue`，不用 `agent.status` 直读。

## 8. 机制清单

**无新增机制。** ① 复用官方 `steer`/`followup`；② 复用官方 `systemPrompt.section`。不新增命令、开关、配置项、持久化格式或第二套提交路径。

## 9. 完成标准

- §3.1 的文件改完，§5 全部通过，§6 证据入仓。
- 无 §3.2 范围外变更；无新增依赖。
- `ADR-20261030-main-agent-responsive` 与本 spec 同 PR 合并。
- 执行 issue 按 spec 开；回填时核对 [#106](https://github.com/nano-sun99/dsh-tui-nano/issues/106) 仍只跟踪「整回合后台化」，不被本次关掉。

## 10. 审核修订记录

- 待审。
