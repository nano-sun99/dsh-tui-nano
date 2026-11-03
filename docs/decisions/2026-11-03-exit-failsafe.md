# ADR-20261103-exit-failsafe：诊断写不可抛，退出走「优雅关停 + 到点 SIGKILL」

- 状态：生效中（随 spec PR 2026-11-03 落地）
- 日期：2026-11-03
- 决策人：用户
- 适用范围：nano 的诊断输出路径、关停收尾、launcher 与 runtime 的退出保证、终端失联检测
- 取代：无
- 被取代：无
- 决策来源：2026-11-03 用户就 issue #164 的修复方案拍板——「跟 cc 保持一致」（兜底力度）、「30 秒（跟 CC 一致）」（孤儿巡检间隔）。事故与实测见 issue #164。

## 决定

1. **诊断写不可抛**：所有诊断输出走同一个 safe 写（`fs.writeSync(2, …)` + `try/catch`），首次失败即置 `stderrDead` 并在本进程内熔断，之后不再尝试。任何「报告错误」的代码都不允许自己抛出。
2. **退出必须有终点**：进程的每条收尾路径都以 `forceExit` 结束——`try { process.exit(code) } catch { process.kill(process.pid, 'SIGKILL') }`。这是唯一能保证「一定消失」的手段。
3. **关停到点无条件退出**：关停预算 5s（对齐 Claude Code 的 `max(5000, sessionEndBudget+3500)`，nano 无 session-end hook 故退化为 5000），到点强制退出；废除「只恢复终端、进程留着」的中间态。
4. **失联检测用 `ppid` 基线 + 写探测**：启动时快照 `ppid`，30s 巡检 `ppid === 1` 或 `writeSync(2,'')` 抛 `EIO`/`EBADF`；**不采用** `stdout.writable` / `stdin.readable` 判据。
5. **不改架构与退出码**：launcher + runtime 的分工（ADR-20261029）不动；信号仍退 0，不对齐 Claude Code 的 129/143。

## 依据

- 2026-11-03 事故：launcher 孤儿化后 83 分 20 秒吃满一核；`sample` 显示 100% 时间在 V8 异常上报路径自激。
- 4 秒确定性复现 + `uncaughtExceptionMonitor`：**107,244 次未捕获异常**，首条栈为 `writeDiagnostic → process.stderr.write → Error: write EIO → onUncaught → writeDiagnostic`。
- 同场景下把 stderr 换成普通文件，关停完全正常（17ms 收尾）——证明缺的不是关停逻辑，而是**「写失败不能抛」这一条底线**。
- 运行时实测（Node v24.18.0 / Darwin 27.0.0）：pty 挂断后 `ppid` 立即变 1、`writeSync(2)` 抛 EIO、而 `stdout.writable`/`stdin.readable` **恒为 true**——Claude Code 的孤儿判据在 Node 上不成立。
- Claude Code 2.1.88 `utils/gracefulShutdown.ts:193-232`：`process.exit()` 在终端已死时可能抛 EIO，其兜底是 `process.kill(pid,'SIGKILL')`。
- Node 官方文档〈Warning: Using 'uncaughtException' correctly〉：处理器内抛出的异常不再被捕获——但该保证只覆盖**同步**重入，异步写失败仍会重新触发 `uncaughtException`，这正是本次自激的入口。

## 否决了什么

- **只加 `try/catch`、不加 `forceExit`**：挡住本次这一条路径，但关停卡住（MCP/网络）时仍会挂死，只能人工 `kill -9`。
- **用 `stdout.writable` / `stdin.readable` 做孤儿检测**：照抄 Claude Code 会得到一个恒不触发的巡检（实测恒真）。
- **`uncaughtException` 直接 `SIGKILL`**：丢会话落盘机会，且与 nano 既有「uncaught → 走关停」的行为冲突；改为「记一行 + 关停 + 到点强杀」。
- **引入 native `PDEATHSIG` / kqueue**：跨平台与预编译成本远超收益，30s 轮询已足够（最坏 30s 空转 vs 本次 83 分钟）。

## 接受的代价

- 关停卡住时多等 2 秒（预算 3s → 5s）。
- 静默失联最坏空转 30s 才被发现。
- 退出码与 Claude Code 不一致（信号退 0 vs 129/143），跨工具脚本若依赖退出码需自行适配。
- `stderrDead` 熔断后诊断只剩日志文件侧可见，终端上看不到任何提示（终端本来也看不见）。

## 允许重开的条件

- Node 提供可靠的终端失效事件（例如 pty 挂断时 `process.stdin` 必发 `close`/`end`），可用事件替换轮询。
- 上游 DSH 提供进程生命周期钩子，可省掉自建收尾。
- 决定把信号退出码对齐 Claude Code（129/143），届时修订第 5 条。

## 关联

- Spec：`docs/specs/2026-11-03-nano-exit-hardening/README.md`
- Issue：[#164](https://github.com/nano-sun99/dsh-tui-nano/issues/164)
- 沿用：[ADR-20261029-single-process-fd-guard](2026-10-29-single-process-fd-guard.md)（launcher/runtime 分工、诊断走重定向 stderr、3s 强制恢复；本 ADR 只补「到点必须真退出」）
