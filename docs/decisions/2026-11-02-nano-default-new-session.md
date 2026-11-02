# ADR-20261102-nano-default-new-session：默认新会话，续接必须显式

- 状态：生效中（随 spec `2026-11-02-nano-session-lifecycle` 合并进入仓库基线）
- 日期：2026-11-02
- 决策人：用户
- 适用范围：nano 启动时的会话身份解析、`-c` / `-r` / `--root` 语义、多窗口与会话所有权
- 取代：取代 `docs/specs/2026-10-28-nano-ts/README.md` §3.1「`--root` → `last-root` → 生成」的默认根解析口径；**局部取代** [ADR-20261029-root-session-resume-first](2026-10-29-root-session-resume-first.md) 的「否决每次启动生成新 session id」一条；其 resume-first 决定继续有效
- 被取代：无
- 决策来源：用户 2026-11-02 原话「默认打开 nano 应该是新的上下文」「我们多开窗口是刚需」；同日确认「ABC 一起写」并选择机制卡「全要」

## 决定

1. `nano` 不带参数时**生成新会话 id**，不再读取 `<数据根>/last-root`；每次启动都是一个新上下文。
2. `-c` / `--continue`：只续**当前 cwd 最近使用的顶层会话**；没有候选直接报错，不创建。
3. `-r` / `--resume`：无 id 打开会话选择器；`-r <id>` 精确恢复；两者都是 resume-only，NotFound 不创建。
4. `--root <id>`：保留为精确会话 id 的低级逃生口；先 resume，NotFound 才 create（沿用 2026-10-29 的 resume-first）。
5. **一窗一会话**：每个窗口认领一个会话 id；不同会话可并存；同一会话只允许一个 writer，第二窗口在挂载认领处被拒绝。
6. 用 nano 自有的 `<数据根>/last-session.json`（按 cwd 记录最近使用）作为 `-c` 的排序提示；它不是官方历史副本，损坏可回退到官方 `createdAt`。
7. `last-root` 停止读写，不迁移、不删除；`nano purge` 仍会删除整个数据根。

## 依据

- 现状 `resolveRootId` 的 `last-root` 是全局的（`src/boot/root.ts:38-55`），第二个窗口必然撞同一个会话；用户现场得到「根 `preview-main` 已被进程 36737 占用」。
- 会话 id 就是根 id（`src/conversation/controller.ts:123-151`）；S07 本来就规定「同仓库不同会话可以各开一个窗口；同一根会话不能被两个窗口同时驱动」。缺的不是多窗口能力，而是「默认怎么拿到一个新会话」。
- Claude Code 2.1.88：默认新会话；`-c` 只看当前目录，无会话直接报 `No conversation found to continue`；`-r` 是选择器/ID（`src/main.tsx:988`、`:3102-3115`、`src/utils/listSessionsImpl.ts:227-291`）。
- 用户 2026-11-02 明确把「开多个 nano 窗口，每个窗口负责不同的事」作为目标。
- ADR-20261029 的「否决每次启动生成新 session id」是在「保持根连续性、支持同根重启」的单一工作流下做的；多窗口成为刚需后，默认每次新 id 是唯一能让两个窗口不撞根的做法。resume-first 仍用于 `-c` / `-r` / `--root` 的既有目标。

## 否决了什么

- **继续沿用 `last-root` 作为默认**：会让每个新窗口撞同一会话，直接违背多窗口刚需。
- **占用时自动换一个新根**：看似聪明，但用户无法预期「这次启动到底续了谁」；默认必须确定。
- **同一会话多窗口可写**：官方写锁与 S07 的单 writer 不变量会被破坏；同一会话的并发写会交错。
- **`-c` / `-r` 找不到时静默新建**：用户会以为历史回来了；S07 已明确禁止静默新建。
- **用官方 `.jsonl` 的 mtime 排序**：Claude Code 的 mtime 会被元数据写入污染；nano 用自有 last-session 提示 + 官方 `createdAt` 回退。

## 接受的代价

- 默认不再自动续接；想继续上一次工作必须显式 `-c` / `-r`。
- 已有会话（如 `preview-main`）不再被默认打开；需要 `-r preview-main` 或 `--root preview-main`。
- 新增一个 nano 自有的 `last-session.json`；它是导航提示，不是官方历史，损坏时只能回退排序。
- `-r` 选择器是启动前的一次性数字列表，不是 Claude Code 那种全屏选择器；首版先保证不创建临时会话。
- 同一会话仍然只能一个窗口驱动；想看同一会话的两个视图需要另立 spec。

## 允许重开的条件

- 官方提供原子 `create-or-resume` 或跨进程 writer 协调，使同一会话多窗口成为安全能力。
- 用户明确要求同一会话的多窗口只读查看，且有独立 spec。
- 真实使用表明 `-c` 的「当前目录最近使用」不足以覆盖日常工作流（例如需要跨目录或按分支续接）。

## 关联

- Spec：`docs/specs/2026-11-02-nano-session-lifecycle/README.md`
- 上游：`docs/specs/2026-10-20-nano-v1/S07-sessions-context.md`；`docs/decisions/2026-10-29-root-session-resume-first.md`
- 对照：Claude Code 2.1.88 `src/main.tsx:988`、`:3102-3115`、`src/utils/listSessionsImpl.ts:227-291`、`src/utils/concurrentSessions.ts`
