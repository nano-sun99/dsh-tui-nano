# [2026-11-03-nano-exit-hardening] 终端失联后的退出兜底：诊断写不抛、退出不留活口

- 组标识：`2026-11-03-nano-exit-hardening`
- 角色：单份 spec，总纲与执行规格合一
- 状态：骨架版（待对照与 DoR）
- Issue：[#164](https://github.com/nano-sun99/dsh-tui-nano/issues/164)
- 结构：**不拆**（单一成因、单一路径，1 份 spec + 1 张执行 issue）
- 机制范围：M1–M3（见 §4）
- 上游：
  - 实测事故与复现：issue #164（2026-11-03，83 分钟 100% CPU；4 秒复现；`uncaughtExceptionMonitor` 抓到 107,244 次未捕获异常）
  - Claude Code 2.1.88 源码（本机归档 `/Users/sunchongsheng/Downloads/归档/06-软件与安装包/ClaudeCode/src`）：
    `utils/gracefulShutdown.ts:193-232`（`forceExit`：`process.exit` 抛错则自杀式 `SIGKILL`）、`:278-297`（孤儿巡检，Bun 语义：`stdout.writable`/`stdin.readable`）、`:301-310`（`uncaughtException` 只记日志不退出）、`:417-426`（failsafe 定时器 `max(5000, hookBudget+3500)` → `forceExit`）、`:132-135`（终端已消失时吞掉写错误）、`ink/ink.tsx:1691-1702`（revoked TTY 上 `setRawMode`/`read` 抛 EBADF/EIO 的恢复路径）
  - Node 官方文档 [Process › Event `'uncaughtException'`](https://nodejs.org/api/process.html#event-uncaughtexception)：处理器内抛出的异常不再被捕获，「以避免无限递归」——本单要补的正是这条保证在**异步写失败**路径上的缺口
- ADR 检索：按「退出 / 退出码 / 信号 / SIGHUP / 孤儿 / orphan / stderr / 关停 / shutdown / fd」检索 `docs/decisions/`
  - 命中并沿用：[ADR-20261029-single-process-fd-guard](../../decisions/2026-10-29-single-process-fd-guard.md)（launcher/runtime 分工、诊断走已重定向的 stderr、3s 强制恢复兜底；本单**不改架构**，只在同一分工上补退出保证）
  - 零命中：退出码约定、`SIGKILL` 兜底、孤儿巡检、诊断写失败熔断——均无现行 ADR
- ADR：新增 1 条，随本 spec 同一文档 PR：
  - [ADR-20261103-exit-failsafe](../../decisions/2026-11-03-exit-failsafe.md)
- 替代关系：不替代任何 spec。补充 ADR-20261029 第 17/18 条（信号去重、3s 强制恢复）——**不修改**其决定，只补「到点之后必须真的退出」。
- 下游：无硬依赖。`purge`、`--help`、`--version` 等非 TUI 命令走 `plain` 分支不受影响。
- 合入前提：单测 + feature 全绿；`npm run typecheck` / `lint` / `build` / `npm test` 退出 0；§6 的 4 秒 pty 回归脚本手动跑过一次并记录证据（本仓无测试环境，README 写明「文档检查：无入口」）。

## 1. 目标与边界

一句话：**终端失联之后，nano 必须在有限时间内、以可预期的方式消失，并且过程中不许留下烧 CPU 的活口。**

七个目标：

1. **诊断写永不抛**：`writeDiagnostic` 写失败只吞掉并熔断，不进入 `uncaughtException`（R1）。
2. **退出不留活口**：`forceExit` 以「`process.exit` 失败就 `SIGKILL` 自己」收尾（R2）。
3. **关停超时到点就死**：现有 3s forceTimer 只恢复终端，改为恢复后 `forceExit`；预算对齐 Claude Code（R3）。
4. **孤儿能被发现**：30s 巡检 `ppid` 基线与一次写探测，发现失联即走关停（R4）。
5. **launcher 同一套底线**：`fd-guard` 的 stderr 写同样包起来，子进程异常退出不再把 launcher 带进循环（R5）。
6. **不引入新架构**：仍是 launcher + runtime，仍不用 native 模块（R6）。
7. **可回归**：把 4 秒 pty 复现脚本固化成仓库里的冒烟用例（R7）。

### 非目标

- **不改 fd-guard 架构**：不合并 launcher/runtime，不换成单进程，不动 `NANO_GUARDED` 的契约。
- **不改渲染、终端恢复序列与信号去重**：`terminal.restore()` 的转义序列、150ms 去重窗口一律不动。
- **不改会话落盘顺序**：`shutdown` 里 drain → flush → core 的顺序保持；本单只改「写诊断」和「到点退出」。
- **不做父进程死亡的内核级监听**：macOS 无 `PR_SET_PDEATHSIG`，不为此引入 native 依赖；用轮询近似。
- **不改非 TUI 命令的退出码**：`--help` / `--version` / `purge` 的码值不变。
- **不改信号对应退出码**：现在任何信号都退 0；本单不改成 Claude Code 的 129/143，避免与既有脚本约定冲突（记在 §7，留待后续单独立项）。

## 2. 现状与证据

### 2.1 事故（2026-11-03，实测）

| 项 | 实测 |
|---|---|
| 进程 | launcher `node ~/.nvm/.../bin/nano --root readme`（PID 25029） |
| 存活 | 16:38 起，83 分 20 秒 CPU 时间，99–115% CPU |
| fd | 0/1/2 全 `(revoked)` |
| 处置 | 18:01 `kill -9`，系统 idle 64% → 83.6% |

### 2.2 复现（4 秒，确定性）

```sh
mkdir -p /private/tmp/nano-repro && printf '# demo\n' > /private/tmp/nano-repro/note.txt
cd /private/tmp/nano-repro
NANO_DATA_ROOT=/private/tmp/nano-repro-data \
  script -q /dev/null node "$(which nano)" --root repro >/dev/null 2>&1 &
sleep 4 && kill -9 $(pgrep -n -f 'script -q /dev/null node')
# → 进程变孤儿（PPID 1），96–100% CPU，永不退出
```

挂 `uncaughtExceptionMonitor` 后：**4 秒 107,244 次未捕获异常**（约 2.7 万次/秒）。

### 2.3 根因链（首条栈已抓到）

```
pty 挂断 → SIGHUP → onSignal → shutdown()
  → writeDiagnostic('nano: 开始关停…')        src/app/nano-app.ts:955
  → process.stderr.write()                    src/main.ts:214（裸写）
  → Error: write EIO
→ uncaughtException → onUncaught()            src/app/nano-app.ts:271/279
  → writeDiagnostic('nano: 未捕获异常：…')    同一行裸写 → 又 EIO
→ 回到上一步
```

自激的充要条件：**写失败会抛，而「写失败」的落点又是那行写本身**。每轮重新排一次写，事件循环永不空 → 不退、吃满一核。

### 2.4 运行时行为实测（Node v24.18.0 / Darwin 27.0.0）

| 观测 | 结果 |
|---|---|
| pty 挂断后 `process.ppid` | 立即变 `1` |
| `fs.writeSync(2, …)` | 抛 `EIO` |
| `process.stdout.writable` / `stdin.readable` / `destroyed` | 恒 `true` / `true` / `false` |
| 同样挂断但 stderr 指向普通文件 | 关停完全正常（`开始关停` → 17ms 收尾） |

第 3 行是本单最关键的差异：**Claude Code 的 30s 巡检依赖 stream 标志翻转，那是 Bun 的行为；在 Node 上恒真，直接照抄等于没有巡检。**

## 3. 需求规格

### R1 诊断写不抛

- 所有诊断输出统一走一个新函数（暂名 `writeDiagnosticSafe`，落点 `src/runtime/` 下），实现为 `fs.writeSync(2, line + '\n')` + `try/catch`。
- 首次写失败即置 `stderrDead = true`，之后直接 return，不再 syscall（避免每轮 EIO 的开销与噪声）。
- `src/main.ts:214` 与 `src/main.ts:218`（`startHeapWatch` 的 report）都改走它。
- 不用 `process.stderr.write`：实测其失败表现为抛错并可逃出调用点，stream 语义还允许异步 error 事件逃逸。

### R2 forceExit

- 新增 `forceExit(code)`：`try { process.exit(code) } catch { process.kill(process.pid, 'SIGKILL') }`。
- `uncaughtException` / `unhandledRejection` 处理器里：先 `writeDiagnosticSafe` 记一行，再走既有 `shutdown`；`shutdown` 内部任何 `catch` 分支的收尾也一律改 `forceExit`。
- 递归保险：进程内 `uncaught` 计数超过 3 次，跳过关停直接 `forceExit`。

### R3 关停到点必须退出

- `src/app/nano-app.ts:1010` 的 `forceTimer`：现在只 `terminal.restore()` + 设 exitCode，改为 `terminal.restore()` 后调 `forceExit(exitCode)`。
- 预算对齐 Claude Code：`max(5000, sessionEndBudget + 3500)`；nano 没有 session-end hook，退化为 **5000ms**，与现行 3000ms 的差异写进 §7。

### R4 孤儿巡检（30s）

- 启动时快照 `startPpid = process.ppid`；`setInterval(30_000).unref()` 里判断：
  - `process.ppid === 1 && startPpid !== 1` → 失联；
  - 或 `writeSync(2, '')` 抛 `EIO`/`EBADF` → 终端已死。
- 命中即 `shutdown('orphan')`（走既有路径，到点由 R3 兜底）。
- 明确**不用** `stdout.writable` / `stdin.readable`（§2.4 第 3 行）。

### R5 launcher 同一套底线

- `src/runtime/fd-guard.ts:51`（子进程被信号终止时写 stderr）与 `src/bin.ts:69-74`（顶层 catch）都改 `writeDiagnosticSafe`。
- launcher 自身也注册 `uncaughtException` → `forceExit`（现在它一个处理器都没有）。
- launcher 侧同样开孤儿巡检（它的父进程是 shell，shell 一死它就该走）。

### R6 不引入新依赖

- 全部用 `node:fs` / `node:process` 现有能力，不新增 native 模块，不改 `package.json` 依赖。

### R7 可回归

- 把 §2.2 的脚本固化为 `tests/feature/exit-hardening.test.ts`（真 pty，用 `script` 拉起，CI 无 pty 时 `skip`），断言：挂断后 8s 内进程消失。
- 单测：注入「`writeSync` 抛 EIO」的桩，断言 `uncaught` 不再循环（次数 ≤ 3）且 `forceExit` 被调用。

## 4. 机制清单

| ID | 机制 | 解决什么 | 没有会怎样 |
|---|---|---|---|
| M1 | `writeDiagnosticSafe` + `stderrDead` 熔断 | 切断「错误处理器自己抛错」的自激环 | 一次终端失联就换一条核 83 分钟（本次事故） |
| M2 | `forceExit`（exit 失败即 SIGKILL） | 保证任何收尾路径都有终点 | 关停卡住时进程挂死，只能人工 `kill -9` |
| M3 | 孤儿巡检（ppid 基线 + 写探测，30s） | 覆盖「没收到 SIGHUP 也失联」的情形 | 静默失联的实例要等到下一次异常才可能退出 |

## 5. 改动面

| 文件 | 改什么 |
|---|---|
| `src/runtime/diagnostic.ts`（新建） | `writeDiagnosticSafe`、`stderrDead` 熔断、`forceExit` |
| `src/main.ts:214,218` | 两处裸写改走新函数 |
| `src/app/nano-app.ts:271-287` | `onUncaught`/`onUnhandledRejection` 改安全写 + 计数保险 |
| `src/app/nano-app.ts:1009-1014` | `forceTimer` 到点改 `forceExit` |
| `src/app/nano-app.ts:258-297` | 注册孤儿巡检（30s，`unref`） |
| `src/runtime/fd-guard.ts:41-56` | 信号/退出分支的安全写；launcher 侧 `uncaughtException` → `forceExit` |
| `src/bin.ts:69-74` | 顶层 catch 改安全写 |
| `tests/feature/exit-hardening.test.ts`（新建） | pty 冒烟 + 熔断单测 |
| `docs/decisions/2026-11-03-exit-failsafe.md`（新建） | ADR |

## 6. 验收

1. §2.2 的 4 秒复现脚本跑完，进程在 **8 秒内**消失，`pgrep -f "bin/nano"` 为空。
2. 同样场景下采样，栈里不再出现 `TriggerUncaughtException` 连续命中（命中 ≤ 1）。
3. 把 `~/.dsh-tui-nano/logs` 设为不可写、或 stderr 指向已挂断 pty 时，进程仍能退出。
4. 正常路径不回归：Ctrl+C 退出、`nano --help`、`nano --version`、`purge` 的退出码与行为不变。
5. `npm run typecheck && npm run lint && npm run build && npm test` 全绿。
6. 单测覆盖：`writeSync` 抛 EIO 桩 → `uncaught` 次数 ≤ 3 → `forceExit` 被调用。

## 7. 自定细节

- **关停预算从 3s 改 5s**：对齐 Claude Code 的 `max(5000, …)`。代价是卡住时多等 2 秒；收益是与上游行为一致、给 analytics/落盘留余量。
- **熔断阈值**：`stderrDead` 置位后本进程内不再尝试写 stderr；诊断只剩日志文件侧（已由 fd 重定向保证）。
- **`ppid` 基线**：用启动时快照而不是「等于 1 即孤儿」，避免容器/CI 里本来就以 PID 1 启动时误判。
- **退出码不变**：信号仍退 0（现状），不改 129/143。与 Claude Code 的差异记在 ADR「接受的代价」里。
- **巡检只在 TTY 模式启用**：`process.stdin.isTTY !== true`（管道/打印模式）不启动定时器。
- **命名**：`writeDiagnosticSafe` / `forceExit` 均为工作名，实施时可改；语义不变。

## 8. 审核修订记录

（待填）
