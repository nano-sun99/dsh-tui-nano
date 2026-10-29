# ADR-20261029-single-process-fd-guard：fd 级 stdout/stderr 守护用启动器 re-exec 实现，运行态仍是单一宿主

- 状态：生效中
- 日期：2026-10-29
- 决策人：用户
- 适用范围：Nano 的进程模型、fd 1/2 重定向与终端写入者
- 取代：无
- 被取代：无
- 决策来源：2026-10-29 实施审核发现「re-exec 引入第二个 Node 进程，与总纲单一进程字面冲突」；用户当日选择「接受并补文档（改旧 spec）」

## 决定

- Nano 的 **runtime 只有一个 Node 宿主进程**：它拥有官方 Cordis 根、会话与全部业务状态，也是终端字节的唯一写入者。
- 为达到 fd 级 stdout/stderr 守护，CLI 入口在启动时 **re-exec 一次**：launcher 进程用 `stdio: ['inherit', logFd, logFd]` 拉起 runtime，把 fd 1/2 绑到 `<数据根>/logs/*.log`；runtime 通过独立的 `/dev/tty` 句柄渲染，不写 fd 1/2。
- launcher 不持有会话、不连官方服务、不写终端；它只负责拉起、转发信号与回收退出码。runtime 仍是唯一宿主、唯一协议边界。
- 信号去重：终端在 raw mode 下把 Ctrl+C 作为输入字节；外部信号可能同时到达 launcher 与 runtime，runtime 对 150ms 内重复投递的同一信号只处理一次，真正的第二次信号才强制恢复。
- 关停增加 3s 强制恢复定时器：无论 hook 是否挂起，3s 时恢复终端并非零退出。

## 依据

- Node 不暴露 `dup2`，无法在同一进程内把 fd 1/2 改指向；只包 `process.stdout.write` 抓不到原生模块直写（phase-0 已实测 0 次写入，但这是探针结果不是机制保证）。
- 两进程方案实测：启动期 stdout 写入 0、终端恢复逐项 stopped、同根第二窗口在备用屏前被拒。
- 用户 2026-10-29 明确接受「文档补齐后按此合并」，不接受退回只包 `process.stdout.write`。

## 否决了什么

- 只包 `process.stdout.write`：留不住原生模块与第三方库的直写。
- 放弃 fd 守护、依赖官方日志自律：与「终端单写入器」的验收目标冲突。
- 把 launcher 做成第二个宿主（持会话/连服务）：违反单宿主与无第二协议。

## 接受的代价

- 常驻两个 Node 进程（launcher + runtime）；launcher 的 RSS 与启动开销很小，但 `ps` 里会看到两个进程。
- 需要信号去重与 3s 强制恢复兜底。
- 证据与文档必须明确「单宿主」指 runtime，而不是操作系统进程数。

## 允许重开的条件

- Node 提供可用的 `dup2`/fd 重定向能力，可在单进程内完成同等守护。
- 官方 DSH 改为不写 fd 1/2，或提供受控 sink，使 fd 守护不再需要。
- 出现必须只有一个 OS 进程的部署约束（如受限容器）。

## 关联

- Spec：`docs/specs/2026-10-28-nano-ts/S01-runtime-render-conversation.md` §2.5、§1
- 证据：`docs/evidence/2026-10-28-nano-ts/alpha/README.md` §8/§9
- 实施：issue #86、PR #89
