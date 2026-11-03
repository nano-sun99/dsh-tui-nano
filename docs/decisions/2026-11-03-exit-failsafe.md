# ADR-20261103-exit-failsafe：诊断写不可抛，退出走「优雅关停 + 到点 SIGKILL」

- 状态：生效中（随 spec PR 2026-11-03 落地）
- 日期：2026-11-03
- 决策人：用户
- 适用范围：nano 的诊断输出路径、关停收尾、launcher 与 runtime 的退出保证、终端失联检测、守卫标记的传递
- 取代：无
- **修订**：[ADR-20261029-single-process-fd-guard](2026-10-29-single-process-fd-guard.md) 中「关停增加 3s 强制恢复定时器：无论 hook 是否挂起，3s 时恢复终端并非零退出」一条——预算改 5s，且**到点必须真的退出**（原文已要求「非零退出」，现行代码只恢复终端不退出，属代码回归该 ADR；本次一半是修回归）。该 ADR 其余决定（launcher/runtime 分工、fd 1/2 绑日志、渲染走 `/dev/tty`、150ms 信号去重）一律不动。
- 决策来源：2026-11-03 用户就 issue #164 的修复方案拍板——「跟 cc 保持一致」（兜底力度）、「30 秒（跟 CC 一致）」（孤儿巡检间隔）、「13 条全改」（审核发现处置）。事故与实测见 issue #164。

## 决定

1. **诊断写不可抛**：`src/` 下所有 `process.stderr.write` 收敛到 `writeDiagnostic`（`fs.writeSync(2, …)` + `try/catch`），首次失败即置 `stderrDead` 并在本进程内熔断。任何「报告错误」的代码都不允许自己抛出。
2. **退出必须有终点**：每条收尾路径以 `forceExit` 结束——`try { process.exit(code) } catch { 测试环境 rethrow；否则 process.kill(pid, 'SIGKILL') }`。顺序与 Claude Code 一致，rethrow 在杀之前。
3. **关停到点无条件退出**：`forceTimer` 预算 5000ms（对齐 `max(5000, sessionEndBudget+3500)`），到点 `terminal.restore()` 后 `forceExit`；废除「只恢复终端、进程留着」的中间态（这是对 ADR-20261029 那一条的修订）。
4. **失联检测用 `ppid` 基线 + 终端句柄探测**：30s 巡检 `ppid === 1` 或对 `/dev/tty` / fd 2 零长度写抛 `EIO`；**不采用** `stdout.writable` / `stdin.readable`。
5. **守卫标记不再跨进程泄漏**：`NANO_GUARDED` 的值改为 launcher pid，runtime 校验「存在且 `ppid` 匹配」才算已守卫；进入 `main()` 前删除该变量。这样「在 nano 会话里再起 nano」会重新走守卫，不会再出现「跳过守卫、诊断直写终端」的实例。
6. **不改架构与退出码基准**：launcher + runtime 分工不动；信号仍退 0，不对齐 Claude Code 的 129/143；新增退出码仅 70（未捕获异常连发）。

## 依据

- 2026-11-03 事故：一个**无守卫**实例（fd 0/1/2 全 revoked、无日志文件）孤儿化后 83 分 20 秒吃满一核；`sample` 显示 100% 时间在 V8 异常上报路径自激。
- 4 秒确定性复现 + `uncaughtExceptionMonitor`：**107,244 次未捕获异常**，首条栈为 `writeDiagnostic → process.stderr.write → Error: write EIO → onUncaught → writeDiagnostic`。
- **守卫路径实测是安全的**：同一台机器、同一版本，`env -u NANO_GUARDED` 正常起守卫时，挂断后 `nano: 开始关停（signal SIGHUP）` → `关停（…，19ms）`，进程干净消失。差异只在于 fd 2 是日志还是终端。
- 泄漏可复现：nano 会话导出的环境里 `NANO_GUARDED=1`，在其中启动的 nano 不建日志、fd 全指向终端；`src/runtime/fd-guard.ts:11` 只设不删。
- 运行时实测（Node v24.18.0 / Darwin 27.0.0）：pty 挂断后 `ppid` 立即变 1、`writeSync(2)`（含零长度）抛 EIO、而 `stdout.writable`/`stdin.readable` **恒为 true**——Claude Code 的孤儿判据在 Node 上不成立。
- Claude Code 2.1.88 `utils/gracefulShutdown.ts:193-232`：`process.exit()` 在终端已死时可能抛 EIO，兜底是 `process.kill(pid,'SIGKILL')`；test 环境先 rethrow 再杀，避免测试进程自杀。
- Node 官方文档〈Warning: Using 'uncaughtException' correctly〉：处理器内抛出的异常不再被捕获——该保证只覆盖**同步**重入，异步写失败仍会重新触发 `uncaughtException`，这正是自激入口。

## 否决了什么

- **只加 `try/catch`、不加 `forceExit`**：挡住本次这一条路径，但关停卡住（MCP/网络）时仍会挂死。
- **用 `stdout.writable` / `stdin.readable` 做孤儿检测**：照抄 Claude Code 会得到恒不触发的巡检（实测恒真）。
- **`uncaughtException` 直接 `SIGKILL`**：丢会话落盘机会，与 nano 既有「uncaught → 走关停」冲突；改为「记一行 + 关停 + 到点强杀」，再加连发计数保险。
- **只删除 `NANO_GUARDED`、不加 `ppid` 校验**：能防孙进程继承，但挡不住「从已泄漏的环境里启动」的第一跳；`ppid` 校验才是根因修法。
- **引入 native `PDEATHSIG` / kqueue**：跨平台与预编译成本远超收益，30s 轮询足够（最坏 30s 空转 vs 本次 83 分钟）。

## 接受的代价

- 关停卡住时多等 2 秒（预算 3s → 5s）；**大会话 flush 超过 5s 会被直接强杀**，未落盘内容可能丢——这是「一定能退」换来的。
- 静默失联最坏空转 30s 才被发现。
- 嵌套启动现在会真正起一个守卫进程（多一个 Node 进程、多一份启动开销），换来的是诊断不再污染外层终端。
- 退出码与 Claude Code 不一致（信号退 0 vs 129/143）；新增的 70 需脚本侧知悉。
- `stderrDead` 熔断后诊断只剩日志文件侧可见，终端上看不到任何提示。

## 允许重开的条件

- Node 提供可靠的终端失效事件（例如 pty 挂断时 `process.stdin` 必发 `close`/`end`），可用事件替换轮询。
- 上游 DSH 提供进程生命周期钩子，可省掉自建收尾。
- 决定把信号退出码对齐 Claude Code（129/143），届时修订第 6 条。

## 关联

- Spec：`docs/specs/2026-11-03-nano-exit-hardening/README.md`
- Issue：[#164](https://github.com/nano-sun99/dsh-tui-nano/issues/164)
- 修订：[ADR-20261029-single-process-fd-guard](2026-10-29-single-process-fd-guard.md) 的「关停增加 3s 强制恢复定时器」一条
