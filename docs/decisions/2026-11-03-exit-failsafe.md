# ADR-20261103-exit-failsafe：诊断写不可抛，退出走「优雅关停 + 硬上限 SIGKILL」

- 状态：生效中（随 spec PR 2026-11-03 落地）
- 日期：2026-11-03
- 决策人：用户
- 适用范围：nano 的诊断输出路径、关停收尾与硬上限、launcher 与 runtime 的退出保证、终端失联检测、守卫标记的传递
- 取代：无
- 修订：无。**不修改 [ADR-20261029-single-process-fd-guard](2026-10-29-single-process-fd-guard.md)**——其中的「关停增加 3s 强制恢复定时器（3s 时恢复终端并设非零退出码）」原样保留；本 ADR 新增的是与它**正交**的 13.5s 硬退出上限。旧 ADR 只在「关联」节加一行交叉引用，正文不动。
- 决策来源：2026-11-03 用户就 issue #164 的修复方案拍板——「跟 cc 保持一致」（兜底力度）、「30 秒（跟 CC 一致）」（孤儿巡检间隔）、「13 条全改」（第一轮审核发现）、「max(5000, 10s+3.5s) ≈ 13.5s」（关停预算）。事故与实测见 issue #164。

## 决定

1. **诊断写不可抛**：`src/` 下所有 `process.stderr.write`（23 处 / 5 文件）收敛到 `writeDiagnostic`（`fs.writeSync(2, …)` + `try/catch`），首次失败即置 `stderrDead` 并在本进程内熔断。任何「报告错误」的代码都不允许自己抛出。
2. **退出必须有终点**：每条失败/收尾路径以 `forceExit` 结束——`try { process.exit(code) } catch { 测试环境 rethrow；否则 process.kill(pid, 'SIGKILL') }`。顺序与 Claude Code 一致，rethrow 在杀之前。
3. **关停两个定时器，互不替代**：3s 复位（`terminal.restore()` + 设非零退出码，ADR-20261029 原语义）+ **13.5s 硬退出**（`Math.max(5000, TOTAL_BUDGET_MS + 3500)`，`TOTAL_BUDGET_MS = 10_000` 由 `src/runtime/lifecycle.ts:49` 导出，值不变）。两者都在 `requestShutdown` 返回后 `clearTimeout`，`exitTimer` 另加 `unref()`。**13.5s 防的是「`requestShutdown` 永不 settle」**（lifecycle 已给每个 hook 设 deadline 并由 10s 总预算夹逼，正常路径到不了这一层）；它不负责腰斩 5–10s 的正常关停。
4. **失联检测用 `ppid` 基线 + 终端句柄探测**：30s 巡检 `ppid === 1`（启动快照比对）或对 `/dev/tty`（runtime）/ fd 2（launcher）零长度写抛 `EIO`；**不采用** `stdout.writable` / `stdin.readable`。巡检 interval 在 `shutdown()` **一开始**就清（不是 `removeProcessListeners()`，那在 `await` 之后）。launcher 命中后 `SIGTERM` 子进程并等 `SHUTDOWN_BUDGET_MS + 1500`（≈15s）再 `forceExit(129)`；runtime 进入 `stopping` 后对 `SIGTERM`/`SIGHUP` 不再升级 force（force 只留给 SIGINT 第二击），否则 launcher 这一记会砍断 flush。
5. **守卫标记不再跨进程泄漏**：`NANO_GUARDED` 的值改为 launcher pid，runtime 校验「存在且 `ppid` 匹配」才算已守卫；进入 `main()` 前删除该变量（位置在守卫分支之后，不能放 `boot/env.ts`）。
6. **退出码**：信号仍退 0（不对齐 Claude Code 的 129/143）；新增 **70**（未捕获异常连发 4 次）与 **129**（launcher 失联收尾，语义是「被挂断收尾」）。

## 依据

- 2026-11-03 事故：一个**无守卫**实例（fd 0/1/2 全 revoked、无日志文件）孤儿化后 83 分 20 秒吃满一核；`sample` 显示 100% 时间在 V8 异常上报路径自激。
- 4 秒确定性复现 + `uncaughtExceptionMonitor`：**107,244 次未捕获异常**，首条栈为 `writeDiagnostic → process.stderr.write → Error: write EIO → onUncaught → writeDiagnostic`。
- **守卫路径实测安全**：同一台机器同一版本，`env -u NANO_GUARDED` 正常起守卫时，挂断后 `开始关停（signal SIGHUP）` → `关停（…，19ms）`，进程干净消失。差异只在 fd 2 是日志还是终端。
- 泄漏可复现：nano 会话导出的环境里 `NANO_GUARDED=1`，在其中启动的 nano 不建日志、fd 全指向终端；`src/runtime/fd-guard.ts:11` 只设不删。
- 运行时实测（Node v24.18.0 / Darwin 27.0.0）：pty 挂断后 `ppid` 立即变 1；`writeSync(2)` 与 `writeSync('/dev/tty' 句柄)`（含零长度）均抛 EIO；`stdout.writable`/`stdin.readable` 恒 true。
- nano 自带关停预算：`src/runtime/lifecycle.ts:41-49` 分段 freeze 500 / drain 3000 / flush 3000 / release 2000 / restore 1500，`TOTAL_BUDGET_MS = 10_000`——这是 13.5s 而不是 5s 的原因：5s 会把 5–10s 的正常关停砍在 flush/落盘中间。
- Claude Code 2.1.88 `utils/gracefulShutdown.ts:417-426`：failsafe 取 `Math.max(5000, sessionEndTimeoutMs + 3500)`，会跟着 hook 预算缩放；`:193-232` 的 `forceExit` 在 `process.exit` 抛 EIO 时降级 `SIGKILL`，测试环境先 rethrow。
- 覆盖度调研（同一归档）：Claude Code 对 SIGHUP 覆盖、对「父进程先死、终端还在」的真孤儿**完全未覆盖**（全仓无 `ppid` 存活判定），对无信号失联只靠 30s 流状态巡检（Node 语义下判据不成立）；它无 launcher re-exec 结构，故本 ADR 第 5 条对它不适用。
- Node 官方文档〈Warning: Using 'uncaughtException' correctly〉：处理器内抛出的异常不再被捕获——只覆盖**同步**重入，异步写失败仍会重新触发 `uncaughtException`，这正是自激入口。

## 否决了什么

- **只加 `try/catch`、不加 `forceExit`**：挡住本次这一条路径，但关停卡住（MCP/网络）时仍会挂死。
- **`forceTimer` 直接改 5s 并强杀**：会把 5–10s 的正常关停砍在落盘中间；改为「3s 复位 + 13.5s 硬退出」两条独立预算。
- **用 `stdout.writable` / `stdin.readable` 做孤儿检测**：照抄 Claude Code 会得到恒不触发的巡检（实测恒真），且它没有父进程存活判定。
- **`uncaughtException` 只记日志、不退出**（Claude Code 的做法）：进程会带病继续跑、终端不复位；本 ADR 选择「记一行 + 关停 + 到点强杀」再加连发计数保险。
- **只删除 `NANO_GUARDED`、不加 `ppid` 校验**：挡不住「从已泄漏的环境里启动」的第一跳；且删除点放 `boot/env.ts` 会因 import 求值顺序把 runtime 也判成未守卫，导致无限 re-exec。
- **引入 native `PDEATHSIG` / kqueue**：跨平台与预编译成本远超收益，30s 轮询已足够（最坏 30s 空转 vs 本次 83 分钟）。

## 接受的代价

- 关停卡死时最坏 13.5s 才消失（3s 时终端已复位，用户感知只是「进程多留了 10s」）；该上限正常路径到不了，只在 `requestShutdown` 永不 settle 时生效。
- launcher 失联收尾要等 ≈15s 才强杀子进程（先让 runtime 自己走完预算），这段时间 launcher 仍在。
- 静默失联最坏空转 30s 才被发现。
- 嵌套启动现在会真正起一个守卫进程（多一个 Node 进程与启动开销），换来诊断不再污染外层终端。
- 退出码与 Claude Code 不一致（信号退 0 vs 129/143）；新增的 70 需脚本侧知悉。
- `stderrDead` 熔断后诊断只剩日志文件侧可见，终端上看不到任何提示。

## 允许重开的条件

- Node 提供可靠的终端失效事件（例如 pty 挂断时 `process.stdin` 必发 `close`/`end`），可用事件替换轮询。
- 上游 DSH 提供进程生命周期钩子，可省掉自建收尾。
- 决定把信号退出码对齐 Claude Code（129/143），届时修订第 6 条。

## 关联

- Spec：`docs/specs/2026-11-03-nano-exit-hardening/README.md`
- Issue：[#164](https://github.com/nano-sun99/dsh-tui-nano/issues/164)
- 并行生效：[ADR-20261029-single-process-fd-guard](2026-10-29-single-process-fd-guard.md)（其 3s 强制恢复定时器原样保留，与本 ADR 的 13.5s 硬上限互补）
- 职责扩展说明：ADR-20261029 描述 launcher「只负责拉起、转发信号与回收退出码」；本 ADR 给它加了失联巡检与兜底退出。这是**扩展**不是变更——launcher 仍不持有会话、不连官方服务。
