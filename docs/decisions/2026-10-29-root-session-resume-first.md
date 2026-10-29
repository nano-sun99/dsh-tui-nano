# ADR-20261029-root-session-resume-first：根会话启动 resume 优先，仅在 NotFound 时 create

- 状态：生效中
- 日期：2026-10-29
- 决策人：用户
- 适用范围：Nano 启动时根会话的创建/恢复、根身份一致性校验与历史回放
- 取代：无
- 被取代：无
- 决策来源：2026-10-29 实施审核发现「开启 resume 优先与 S01 §2.2 字面 create 冲突」；用户当日选择「接受并补文档（改旧 spec）」

## 决定

- 启动时先 `ctx.agents.resume({ resumeSessionId: <根身份> })`。
- 仅当 persistence 报 NotFound（错误名 `SessionPersistenceNotFoundError`，或消息匹配 `not found`）时，才 `ctx.agents.create({ sessionId: <根身份> })` 新建；其它错误原样上抛。
- 两条路径返回的 `session.id` 必须等于预生成根身份；不一致立即硬失败，不创建替代会话。
- 恢复成功后从 `session.deriveMessages()` 回放阅读面；官方记录仍是唯一事实源，nano 不写第二份历史。
- 恢复回放暂不携带 `tool/result` 的 `meta`（差异卡会退化为纯文本）；这是已记录的低优先级缺口，不改变本决定。

## 依据

- 官方 `session-persistence-jsonl` 在发现已有日志时拒绝 `create`（`SessionAlreadyExistsError`），强行 create 会让「同一根二次启动」必然失败；实施复现（SIGKILL 后同根重启报 `session "x" already exists`）见 PR #89 讨论，官方契约见 `@deepseek-ai/dsh-session-persistence` README。
- 官方 `ResumeAgentOptions` 是恢复既有会话的唯一公开路径；error name 可稳定区分 NotFound。
- 根身份仍是 session id，认领/存储/调度/handoff 的「同一 ID」不变。

## 否决了什么

- 忽略已有日志强行 create：与持久化契约冲突，且会制造替代会话。
- 每次启动生成新 session id：破坏根连续性、历史回放与 per-root 隔离。
- 只 create 不 resume：同根重启不可用，强杀恢复不成立。

## 接受的代价

- 启动路径多一次 resume 尝试（新根会有一次 NotFound 开销）。
- 恢复回放的差异元数据暂缺（见决定最后一条）。
- 文档必须把「sessions.create」表述改为「创建/恢复」。

## 允许重开的条件

- 官方提供「create-or-resume」原子入口。
- 持久化改为允许覆盖/轮转同 id 日志。
- 恢复回放需要完整 `meta` 且官方 projection 提供该字段。

## 关联

- Spec：`docs/specs/2026-10-28-nano-ts/S01-runtime-render-conversation.md` §2.2
- 证据：PR #89（合并后 `docs/evidence/2026-10-28-nano-ts/alpha/README.md` §8/§9）
- 实施：issue #86、PR #89
