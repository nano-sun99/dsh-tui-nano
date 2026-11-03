# [2026-11-03-nano-exit-hardening] 终端失联后的退出兜底：诊断写不抛、退出不留活口

- 组标识：`2026-11-03-nano-exit-hardening`
- 角色：单份 spec，总纲与执行规格合一
- 状态：**实施版 · 修订 3**（三轮审核共 37 条发现已处置，待复核/过闸）
- Issue：[#164](https://github.com/nano-sun99/dsh-tui-nano/issues/164)
- 结构：**不拆**（单一成因、单一路径，1 份 spec + 1 张执行 issue）
- 机制范围：M1–M4（见 §5）
- 上游：
  - 实测事故与复现：issue #164（2026-11-03，83 分钟 100% CPU；4 秒复现；107,244 次未捕获异常）
  - Claude Code 2.1.88 源码（本机归档 `/Users/sunchongsheng/Downloads/归档/06-软件与安装包/ClaudeCode/src`）：
    `utils/gracefulShutdown.ts:193-232`（`forceExit`：`process.exit` 抛错则 `SIGKILL`；test 先 rethrow）、`:272-276`（SIGHUP → 129）、`:278-296`（30s 孤儿巡检，Bun 语义）、`:301-310`（`uncaughtException` 只记日志）、`:417-426`（failsafe `max(5000, hookBudget+3500)`）、`:436-437`（先复位终端再异步收尾）、`:132-135`（终端已消失时吞写错误）、`ink/ink.tsx:1691-1702`（revoked TTY 上 EBADF/EIO）
  - 覆盖度调研结论（同一归档，逐场景）：SIGHUP 覆盖；无信号失联仅 30s 流状态巡检（判据在 Node 不成立）；**真孤儿未覆盖**（全仓无 `ppid` 存活判定）；嵌套守卫泄漏不适用（它无 launcher re-exec）；关停卡死有 failsafe 但装在 `await import` 之后；`uncaughtException` 只记日志、不退出，且 `error.message.slice` 对非 Error 会抛
  - Node 官方文档 [Process › Event `'uncaughtException'`](https://nodejs.org/api/process.html#event-uncaughtexception)：处理器内抛出的异常不再被捕获——只覆盖同步重入，异步写失败仍会重新触发
- ADR 检索：按「退出 / 退出码 / 信号 / SIGHUP / 孤儿 / orphan / stderr / 关停 / shutdown / fd / 守卫」检索 `docs/decisions/`
  - 命中并沿用：[ADR-20261029-single-process-fd-guard](../../decisions/2026-10-29-single-process-fd-guard.md)（launcher/runtime 分工、诊断走重定向 stderr、3s 强制恢复定时器、`NANO_GUARDED` 契约）
  - **本次不修订该 ADR**：3s 恢复定时器保持原状（它做的是「复位终端 + 设非零退出码」）；本单新增的是**正交的 13.5s 硬退出上限**。旧 ADR 只在「关联」节加一行交叉引用，正文不动
  - 零命中：退出码约定、`SIGKILL` 兜底、孤儿巡检、诊断写失败熔断、守卫标记的跨进程泄漏
- ADR：新增 [ADR-20261103-exit-failsafe](../../decisions/2026-11-03-exit-failsafe.md)，随本 spec 同一 PR
- 替代关系：不替代任何 spec；不改 ADR-20261029 的任何决定
- 下游：无硬依赖。`plain` 分支（`--help` / `--version` / `purge`）不受影响。
- 合入前提：`npm run typecheck` / `lint` / `build` / `npm test` 退出 0；§7 的 pty 回归跑过一次并留证据。文档检查：本仓无 docs 检查入口（`scripts/` 下无 check-docs 脚本、AGENTS.md 未自报）。

## 1. 目标与边界

一句话：**终端失联之后，nano 必须在有限时间内、以可预期的方式消失，过程中不许留下烧 CPU 的活口。**

1. **诊断写永不抛**：进程内所有 stderr 写走同一封装，失败只熔断（R1）。
2. **退出不留活口**：`forceExit` 以「`process.exit` 失败就 `SIGKILL` 自己」收尾（R2）。
3. **关停有硬上限**：保留 3s 复位定时器，**另加** 13.5s 硬退出定时器（R3）。
4. **孤儿能被发现**：30s 巡检 `ppid` 基线 + 终端句柄空写探测（R4）。
5. **launcher 同一套底线**：`fd-guard` 与入口 `catch` 同样安全写，并自注册兜底（R5）。
6. **不引入新依赖**：不引入 native 模块，不动 `package.json` 依赖（R6）。
7. **可回归**：守卫路径与失联路径各一条用例（R7）。
8. **守卫标记不再泄漏**：`NANO_GUARDED` 带 launcher pid 并校验 `ppid`，runtime 进 `main()` 前删除（R8）。

### 非目标

- **不改 fd-guard 架构**：不合并 launcher/runtime，不改「fd 1/2 绑日志、渲染走 `/dev/tty`」的分工。
- **不改渲染、终端恢复序列与信号去重**：`terminal.restore()` 的转义序列、150ms 去重窗口不动。
- **不改 lifecycle 分段预算**：freeze 500 / drain 3000 / flush 3000 / release 2000 / restore 1500 与 `TOTAL_BUDGET_MS = 10_000` 的**值**一律不动；只把常量改为 `export` 以便引用（见 §6）。
- **不改会话落盘顺序**：drain → flush → core 顺序保持。
- **不缩 launcher 职责**：R5 给它加了巡检与兜底退出（旧 ADR 原文只说「拉起 / 转发信号 / 回收退出码」），属**职责扩展而非变更**——不持有会话、不连官方服务这两条不变。
- **不做内核级父进程监听**：macOS 无 `PR_SET_PDEATHSIG`，不为此引入 native 依赖。
- **不改非 TUI 命令与信号退出码**：信号仍退 0，不对齐 Claude Code 的 129/143。

## 2. 现状与证据

### 2.1 两条路径（事故发生在**无守卫**那条）

| 路径 | 触发条件 | 终端挂断后 | 证据 |
|---|---|---|---|
| **守卫路径**（launcher 起 runtime，fd 1/2 = `logs/*.log`，渲染走 `/dev/tty`） | 正常启动 | SIGHUP → 诊断写进日志 → **19ms 干净退出** | 2026-11-03 实测：`nano: 开始关停（signal SIGHUP）` → `关停（…，19ms）`，进程消失 |
| **无守卫路径**（runtime 直接跑，fd 0/1/2 = 终端） | `NANO_GUARDED` 被继承 | 诊断写 → `EIO` → 自激 → 吃满一核 | 4 秒复现；107,244 次未捕获异常；首条栈落在 `NanoApp.shutdown` |

事故进程 PID 25029 的 fd 0/1/2 **全部 revoked 且无任何日志文件**——正是无守卫路径的特征（守卫路径的 fd 2 会指向 `logs/nano-*.log`）。

### 2.2 泄漏成因

`src/runtime/fd-guard.ts:11` 用环境变量 `NANO_GUARDED` 标记「本次已被守卫」，runtime 启动后**不清理它**：

- 在 nano 会话里（Bash 工具、嵌套终端）再起 `nano`，后者继承该值 → `src/bin.ts:59` 的 `isGuarded()` 为真 → **跳过守卫**，直接 `main()`；
- 实测：nano 会话导出的环境里 `NANO_GUARDED=1`，在其中启动的 nano 一个日志都不建、fd 全指向终端；
- 于是「诊断写进日志」这条安全假设失效，终端一断就进入 §2.3 的自激。

### 2.3 自激链（无守卫路径的 runtime 栈；守卫路径 fd 2 是日志，走不到这里）

```
终端挂断 → SIGHUP → onSignal → shutdown()
  → writeDiagnostic('nano: 开始关停…')        src/app/nano-app.ts:955
  → process.stderr.write()                    src/main.ts:214（裸写）
  → Error: write EIO
→ uncaughtException → onUncaught()            src/app/nano-app.ts:277-287
  → writeDiagnostic('nano: 未捕获异常：…')    同一行裸写 → 又 EIO
→ 回到上一步
```

自激充要条件：**写失败会抛，而「写失败」的落点又是那行写本身**。

### 2.4 运行时行为实测（Node v24.18.0 / Darwin 27.0.0）

| 观测 | 结果 |
|---|---|
| pty 挂断后 `process.ppid` | 立即变 `1` |
| `fs.writeSync(2, …)`（含零长度写） | 抛 `EIO` |
| `openSync('/dev/tty','r+')` 句柄在挂断后 `writeSync(fd,'')` | 抛 `EIO`（2026-11-03 补测 → R4 探测判据成立） |
| `process.stdout.writable` / `stdin.readable` / `destroyed` | 恒 `true` / `true` / `false` |
| 守卫路径下同样挂断 | 19ms 干净退出 |

第 4 行是关键差异：Claude Code 的 30s 巡检依赖 stream 标志翻转（Bun 语义），**在 Node 上恒真，照抄等于没有巡检**。

## 3. 需求规格（实施粒度）

### R1 诊断写永不抛（全量口径）

新建 `src/runtime/diagnostic.ts`：

```ts
let stderrDead = false

/** 诊断唯一入口：任何情况下不抛。 */
export function writeDiagnostic(line: string): void {
  if (stderrDead) return
  try {
    writeSync(2, line.endsWith('\n') ? line : `${line}\n`)
  } catch {
    stderrDead = true          // EIO / EBADF / EPIPE 一律视为「诊断通道已死」
  }
}

export function isStderrDead(): boolean { return stderrDead }
export function resetDiagnosticStateForTest(): void { stderrDead = false; uncaughtCount = 0 }
```

- **口径是全仓**：`src/` 下所有 `process.stderr.write`（实测 **23 处**，5 个文件：`main.ts` 7、`controls/feature-host.ts` 11、`bin.ts` 2、`runtime/fd-guard.ts` 2、`render/renderer.ts` 1）一律替换。`process.stdout.write`（4 处，渲染/装配路径）不在本单范围。
- 「必须让人看见」的错误（`src/main.ts:361` 的 `writeToTty`）保留 `/dev/tty` 分支（已有 try/catch），只把其中的 stderr 写换成 `writeDiagnostic`。
- 首次失败后熔断，本进程内不再 syscall。

### R2 退出必须有终点

```ts
let uncaughtCount = 0
export function getUncaughtCount(): number { return uncaughtCount }

export function forceExit(code: number): void {
  try {
    process.exit(code)
  } catch (error) {
    // 与 Claude Code 一致：测试环境先 rethrow，让断言看得见；生产环境才自杀。
    if (process.env.NODE_ENV === 'test') throw error
    try { process.kill(process.pid, 'SIGKILL') } catch { /* 已在退出 */ }
  }
}
```

- `onUncaught` / `onUnhandledRejection`：`uncaughtCount++` → `writeDiagnostic` 记一行 → 走既有 `shutdown`；任一步失败即 `forceExit(1)`。
- **计数保险**：`uncaughtCount > 3` 时跳过关停直接 `forceExit(70)`。
- `src/bin.ts:65` 与 `:68` 的正常退出也改走 `forceExit`（终端已死时裸 `process.exit` 抛错会把退出码从 0 变成 1）。

### R3 关停有硬上限（两个定时器，互不替代）

`src/app/nano-app.ts:1010-1015` 现状是**一个** 3s 定时器（复位终端 + 设非零 exitCode），并在 `requestShutdown` 返回后 `clearTimeout`。改为两个：

```ts
// 保留：3s 复位终端（ADR-20261029 那条决定的原语义，不动）
const restoreTimer = setTimeout(() => {
  terminal.restore()
  this.exitCode = this.exitCode || 1
}, RESTORE_BUDGET_MS)            // 3000，不变

// 新增：最后保险——只在 requestShutdown 永不 settle 时兜底
const exitTimer = setTimeout(() => {
  terminal.restore()             // 幂等
  forceExit(this.exitCode || 1)
}, SHUTDOWN_BUDGET_MS)
exitTimer.unref()
```

- `RESTORE_BUDGET_MS = 3000`（不变）；`SHUTDOWN_BUDGET_MS = Math.max(5000, TOTAL_BUDGET_MS + 3500) = 13_500`。
- **两个定时器都要 clear**：`requestShutdown` 返回后同时 `clearTimeout(restoreTimer)` 与 `clearTimeout(exitTimer)`。
- **诚实说明触发面**：lifecycle 给每个 hook 都设了 deadline，并由 `TOTAL_BUDGET_MS` 夹逼，所以 `requestShutdown` 必定在 ≤10s 内 resolve —— 13.5s 这个定时器**正常路径下永远到不了**（实测：永不 resolve 的 `features.dispose` 在 3002ms 就以 `drain/features:unknown` 收尾）。它防的是更外一层：`requestShutdown` 本身永不 resolve（lifecycle 内部实现回归、Promise 死锁、hook 卡在不可中断的同步调用里）。**它不承诺「5–10s 的正常关停被腰斩」——那件事由 lifecycle 的 deadline 负责，本单不动。**
- 为什么不做「3s 直接杀」：会砍在 flush/落盘中间，`process.exit` 不 flush 异步 I/O。

### R4 孤儿巡检（30s）

- 启动时快照 `const startPpid = process.ppid`，`setInterval(30_000).unref()`，每轮两件事，任一命中即走失联处理：
  1. `startPpid !== 1 && process.ppid === 1`；
  2. 对**终端句柄**空写探测：runtime 用 `terminal.ttyFd`（`/dev/tty`），launcher 用 fd 2；抛 `EIO`/`EBADF` 即终端已死（两处均实测抛 EIO，§2.4）。
- **`Terminal` 需新增只读 getter**：`get ttyFd(): number | undefined`（当前 `private fd`，`src/runtime/terminal.ts:27`；`enter()` 后才有值，`restore()` 后置 `undefined`）。`undefined` 视为「无终端」→ **跳过写探测**，只用 `ppid` 判据。
- 仅 `process.stdin.isTTY === true` 时启动定时器（管道/打印模式不装）。
- **关停一开始就 `clearInterval`**：放在 `shutdown()` 开头（`this.stopping = true` 之后，`src/app/nano-app.ts:942-952` 区间），不是 `removeProcessListeners()`——后者在 `await requestShutdown` **之后**才跑（`:1016`），10–13.5s 的窗口里 30s 巡检约 1/3 概率会命中，把正在跑的 flush force 掉。`removeProcessListeners()` 里再兜一次 `clearInterval`（幂等）。
- 明确**不用** `stdout.writable` / `stdin.readable`（§2.4 第 4 行）。

### R5 launcher 同一套底线

- `src/runtime/fd-guard.ts:45`（spawn 失败）、`:51`（子进程被信号终止）、`src/bin.ts:51` 与 `:69-74` 的裸写改 `writeDiagnostic`。
- launcher 注册自己的 `uncaughtException` / `unhandledRejection` → `writeDiagnostic` + `forceExit`（当前一个处理器都没有）。
- launcher 的失联动作（**这里没有 `shutdown()`，写死**）：巡检命中 → `writeDiagnostic` 记一行 → `child.kill('SIGTERM')` → 等 `SHUTDOWN_BUDGET_MS + 1500`（约 15s，让 runtime 自己的预算先走完）→ `forceExit(129)`。**不能 1s 就杀**：那会把 runtime 的 flush 砍掉，与 R3 的保证冲突。
- 配套：runtime 进入 `stopping` 后，`SIGTERM` / `SIGHUP` 只记一行、**不再升级为 force**（force 只留给 SIGINT 第二击）——否则 launcher 的这记 SIGTERM 会经 `nano-app.ts:947` 的 `>150ms` 判据变成 `forceRestore`。

### R6 不引入新依赖

全部用 `node:fs` / `node:process` 现有能力；不改 `package.json` 依赖与 `engines`。

### R7 可回归

- `tests/feature/exit-hardening.test.ts`：
  - 用例 A（守卫路径，防回归）：`env -u NANO_GUARDED` 起真 pty → 挂断 → 8s 内消失且日志出现 `关停（…，NNms）`；
  - 用例 B（无守卫路径，复现本 bug）：**用预加载注入标记，别用 `$$`**——`script -q /dev/null node --import ./tests/fixtures/pretend-guarded.mjs dist/bin.js --root repro`，fixture 内容就一行 `process.env.NANO_GUARDED = String(process.ppid)`（`--import` 早于 `bin.ts` 的 `isGuarded()`，`ppid` 校验通过 → 跳过 launcher → 正是无守卫路径）。
    - ⚠️ 不要写 `sh -c 'NANO_GUARDED=$$ node …'`：单条简单命令 bash 会 exec 顶替，node 的 pid 就是 `$$`、`ppid` 反而是外层（实测 ppid≠env），判否后退回守卫路径，用例静默退化成 A；`execFile` 里 `$$` 更是字面量。
    - 断言里加一条「本轮**没有**新建 `logs/nano-*.log`」防再退化。
  - 无 `script` 命令或非 darwin 时 `skip`。
- `tests/unit/diagnostic.test.ts`：mock `node:fs` 的 `writeSync` 抛 `EIO` → 连续 100 次调用只尝试 1 次、不抛；`isStderrDead()` 为真。
- `tests/unit/nano-app-uncaught.test.ts`：连发 4 次 `uncaughtException` → 第 4 次 `forceExit(70)`，`getUncaughtCount()` 为 4（mock `process.exit`，不真杀）。
- `tests/unit/nano-app-shutdown-timeout.test.ts`：stub `requestShutdown` 为永不 settle（**不是** stub `features.dispose`——lifecycle 会在 3002ms 用 `unknown` 收尾，13.5s 的定时器根本到不了）→ 3s 断言 `restore()`、13.5s 断言 `forceExit`；再加正向用例断言两个定时器被 clear。

### R8 守卫标记不再泄漏

- **写入端**：`src/runtime/fd-guard.ts:32` 的 `env: { …process.env, [GUARD_ENV]: '1' }` 改为 `[GUARD_ENV]: String(process.pid)`。
- **校验端**：`src/runtime/fd-guard.ts:13-15` 的 `isGuarded()` 改为「变量存在 **且** `String(process.ppid) === value`」；不匹配视为未守卫。全仓只有 `src/bin.ts:59` 一个调用点、无测试引用，改签名不破。
- **删除位置必须在守卫判定之后**（不能放 `boot/env.ts`：它是 `bin.ts` 的第一个 import，ESM 先求值完 import 再跑 body，在那里删会让 runtime 也判未守卫 → 无限 re-exec）：

```ts
// src/bin.ts
if (!isGuarded() && !plain) {
  const code = await launchGuarded({ /* … */ })
  process.exit(code)                     // launcher 到此为止
}
delete process.env[GUARD_ENV]            // 只有 runtime 走得到这一行
const code = await main(argv)
```

- **连带**：`docs/evidence/2026-11-01-nano-question-card-parity/drive.mjs:11` 的 `=== '1'` 改真值判断（仓内唯一消费方；两个 README 无该变量）。

## 4. 对照表（无页面路径）

| 流程节点 | 界面或样例 | 数据或接口 | 验收 |
|---|---|---|---|
| 正常 `Ctrl+C` 退出 | 无界面；终端恢复 + 退出码 `0`（不变） | `SIGINT` → `shutdown` | 启动后 Ctrl+C，`echo $?` 为 `0`，1s 内消失 |
| 关窗口（守卫路径） | 无界面；日志 `关停（signal SIGHUP，NNms）` | `SIGHUP` → 诊断写日志（成功） | 用例 A：8s 内消失 |
| 关窗口（无守卫路径，本 bug） | 无界面；无输出 | `SIGHUP` → 诊断写 → EIO → 熔断 | 用例 B：8s 内消失；采样 `TriggerUncaughtException` 连续命中 ≤ 1 |
| 终端静默失联（无信号） | 无界面；日志 `reason=orphan` | `ppid` 变 1，或 `/dev/tty` 空写抛 EIO | kill 外层 shell → 30s + 13.5s 内消失 |
| 任何异常且 stderr 已死 | 无界面 | `writeSync(2)` 抛 EIO → 熔断 → 关停 | 单测断言 |
| 关停卡死（dispose 不返回） | 无界面；3s 时终端已复位 | `restoreTimer` 3s / `exitTimer` 13.5s | 单测：3s 复位、13.5s `forceExit` |
| 嵌套启动（标记泄漏） | 无界面 | `ppid` 校验不匹配 → 重新走守卫 | `NANO_GUARDED=1` 启动仍创建 `logs/nano-*.log` |

样例选择：本条按「后端/运行时」路径，用**失败矩阵**（上表）+ 端到端薄切片（§2.2 复现脚本）。

## 5. 机制清单

| ID | 机制 | 解决什么 | 没有会怎样 |
|---|---|---|---|
| M1 | `writeDiagnostic` + `stderrDead` 熔断 | 切断「错误处理器自己抛错」的自激环 | 一次终端失联就烧掉一条核 83 分钟（本次事故） |
| M2 | `forceExit` + 13.5s 硬退出定时器 | 保证任何收尾路径都有终点 | 关停卡住时进程挂死，只能人工 `kill -9` |
| M3 | 孤儿巡检（`ppid` 基线 + 终端 fd 探测，30s） | 覆盖「没收到 SIGHUP 也失联」——Claude Code 连这条都没做 | 静默失联要等到下一次异常才可能退出 |
| M4 | `uncaughtCount > 3` 计数保险 | 防处理器自身重入（写已安全，但处理器仍可能抛别的） | 新的「处理器抛处理器」路径还能把进程钉住 |

## 6. 改动面

| 文件 | 改什么 |
|---|---|
| `src/runtime/diagnostic.ts`（新建） | `writeDiagnostic`、`isStderrDead`、`forceExit`、`uncaughtCount` / `getUncaughtCount`、`resetDiagnosticStateForTest` |
| `src/main.ts`（7 处 stderr 裸写：`:106,143,164,198,214,218,362`） | 改 `writeDiagnostic`；`:152` 的 early signal handler 里裸 `process.exit(1)` 改 `forceExit` |
| `src/controls/feature-host.ts`（11 处） | 同上 |
| `src/render/renderer.ts`（1 处） | 同上 |
| `src/runtime/fd-guard.ts:32` | `[GUARD_ENV]` 值改 `String(process.pid)`（R8 写入端） |
| `src/runtime/fd-guard.ts:13-15` | `isGuarded()` 加 `ppid` 校验（R8 校验端） |
| `src/runtime/fd-guard.ts:45,51` | 裸写改 `writeDiagnostic`；launcher 注册 `uncaughtException`/`unhandledRejection` → `forceExit`；R4 巡检 + R5 失联动作 |
| `src/bin.ts:51,59,65,68,69-74` | 错误写改安全版 + `forceExit`；:65/:68 正常退出改 `forceExit`；守卫判定后 `delete process.env[GUARD_ENV]` |
| `src/runtime/terminal.ts:27` | 新增只读 `get ttyFd(): number \| undefined` |
| `src/runtime/lifecycle.ts:49` | `const TOTAL_BUDGET_MS` 改 `export const`（**值不变**） |
| `src/app/nano-app.ts:1010-1015` | 拆成 `restoreTimer`(3s) + `exitTimer`(13.5s，`unref`)；`:1015` 起两个都 `clearTimeout`（R3） |
| `src/app/nano-app.ts:277-287` | `onUncaught`/`onUnhandledRejection` 计数 + 安全写 + 保险（R2） |
| `src/app/nano-app.ts:258-273`、`:942-952`、`:1028` | 注册 R4 巡检；`shutdown()` 开头 `clearInterval`，`removeProcessListeners()` 再兜一次 |
| `docs/evidence/2026-11-01-nano-question-card-parity/drive.mjs` | **已完成**（`5509c92` 改真值判断），后续无需再动 |
| `tests/unit/diagnostic.test.ts`、`nano-app-uncaught.test.ts`、`nano-app-shutdown-timeout.test.ts`（新建） | 单测 |
| `tests/feature/exit-hardening.test.ts`（新建） | pty 冒烟 A/B |
| `tests/fixtures/pretend-guarded.mjs`（新建） | 一行 `process.env.NANO_GUARDED = String(process.ppid)`，供用例 B 构造无守卫路径 |
| `docs/decisions/2026-11-03-exit-failsafe.md`（新建） | ADR |
| `docs/decisions/2026-10-29-single-process-fd-guard.md` | 只在「关联」节加一行交叉引用，正文不动 |

## 7. 验收

1. 用例 A、B 各 8s 内进程消失（正常关停是毫秒级，8s 是余量而非预算）。
2. 用例 B 用 `--import` 预加载的 `uncaughtExceptionMonitor` 计数：整个进程生命周期内 ≤ 1 次（不依赖手工 `sample`）。
3. `grep -rn "process\.stderr\.write" src` **零命中**（diagnostic.ts 用的是 `writeSync(2, …)`）。
4. 把 `logs` 目录设为不可写、或 stderr 指向已挂断 pty，进程仍退出。
5. 正常路径不回归：Ctrl+C 退 0、`--help` / `--version` / `purge` 行为与退出码不变。
6. 关停卡死单测：stub `lifecycle.requestShutdown` 返回**永不 settle** 的 Promise → fake timers 推进到 3s 断言 `terminal.restore()` 已跑、13.5s 断言 `forceExit` 被调；另加一条「正常关停（10s 内 resolve）时两个定时器都被 clear」的正向用例。
7. `NANO_GUARDED=1` 直接启动仍会创建 `logs/nano-*.log`（R8 生效）。
8. `npm run typecheck && npm run lint && npm run build && npm test` 全绿。

## 8. 迁移 / 回滚 / 兼容 / 观测

- **迁移 / 回填**：无。不涉及数据、配置或 schema。
- **回滚**：`git revert` 单个 PR；新增文件全是新增，无隐藏耦合。
- **兼容**：
  - CLI 参数不变；`NANO_GUARDED` 的**存在性语义**保持（仍表示「已被守卫」），值从 `1` 变为 launcher pid；旧值 `1` 在 `ppid` 校验下判为未守卫（安全侧）。仓内唯一消费方 `drive.mjs` 同步改真值判断。
  - 退出码：信号仍 0；**新增 70（未捕获异常连发 4 次）与 129（launcher 失联收尾，语义是「被挂断收尾」而非 CC 的「SIGHUP 导致」）**；不动既有 0/1。
  - 日志格式：`reason` 新增取值 `orphan`；`关停（…，NNms）` 不变。
  - `plain` 分支不装巡检、不装定时器。
- **观测**：`reason=orphan` + 退出码 70/129；`stderrDead` 熔断时不写任何地方，以「进程消失时间」为观测口径（§7 第 1/3 条）。

## 9. DoR 自查

| # | 条目 | 结论 |
|---|---|---|
| 1 | 承重规则只有一个结论，无 TBD | ✅ §3 全部定值（3s / 13.5s / 30s / 3 次 / 70 / 129 / launcher pid 校验） |
| 2 | 每个流程节点有界面/样例或明确无界面 | ✅ §4 七节点全覆盖 |
| 3 | 每条写路径单一入口；状态有字段有读侧 | ✅ 诊断写 = `writeDiagnostic`（§7.3 grep 零命中可验证）；退出 = `forceExit`（含 `main.ts:152` 与 `bin.ts:65/68` 的收编）；状态 `stderrDead` / `uncaughtCount` 有读侧 |
| 4 | 每条验收可执行 | ✅ §7 全为命令、断言或单测 |
| 5 | 迁移 / 回填 / 回滚 / 兼容 | ✅ §8（含新增 70 / 129） |
| 6 | 外部合同影响与版本 | 不适用：不涉及报表 / 开放平台 / 消息通道 |
| 7 | ADR supersede 链清楚、正文同步 | ✅ 新 ADR「取代：无 / 修订：无」——3s 定时器保持原状，新增的是正交硬上限；旧 ADR「关联」加一行交叉引用 |

## 10. 自定细节

- **两个定时器而非一个**：3s 复位的语义按 ADR-20261029 原样保留；13.5s 是「`requestShutdown` 永不 settle」的最后保险（正常路径到不了，见 R3）。`SHUTDOWN_BUDGET_MS = Math.max(5000, TOTAL_BUDGET_MS + 3500)`，`unref()`。
- **熔断粒度 = 进程级**：`stderrDead` 置位后本进程内不再尝试写 stderr（含启动期 heap watch）。
- **`uncaughtCount` 落点**：`src/runtime/diagnostic.ts` 模块级；`resetDiagnosticStateForTest()` 同时复位它。
- **`RESTORE_BUDGET_MS` / `SHUTDOWN_BUDGET_MS` 落点**：`src/app/nano-app.ts` 顶部模块常量；`TOTAL_BUDGET_MS` 由 `lifecycle.ts:49` 改为 `export`（值不变）后引用。
- **`ppid` 用启动快照**：避免容器/CI 里以 PID 1 启动时误判。
- **探测目标**：runtime 探 `terminal.ttyFd`（`/dev/tty`），launcher 探 fd 2；`ttyFd === undefined` 时跳过写探测，只用 `ppid`。
- **launcher 失联动作**：`child.kill('SIGTERM')` → 等 `SHUTDOWN_BUDGET_MS + 1500`（≈15s）→ `forceExit(129)`；runtime 在 `stopping` 后不再因 SIGTERM/SIGHUP 升级 force。
- **`NANO_GUARDED` 删除位置**：`bin.ts` 守卫分支之后（不能放 `boot/env.ts`，见 R8）。
- **命名**：`writeDiagnostic` / `forceExit` / `RESTORE_BUDGET_MS` / `SHUTDOWN_BUDGET_MS` / `ttyFd` 为工作名，实施时可改，语义不变。

## 11. 审核修订记录

### 第 1 轮（轻审）

| # | 严重度 | 发现 | 处置 |
|---|---|---|---|
| 1 | 中 | §2.1/§2.3 的 launcher/runtime 归属冲突 | 已改：§2.1 拆两条路径，§2.3 标注为无守卫路径的 runtime 栈 |
| 2 | 中 | 「单一入口」与 19+ 处裸写不符 | 已改：R1 全仓口径（23 处 / 5 文件），§7.3 加 grep 断言 |
| 3 | 中 | `Terminal.fd` 是 private | 已改：R4/§6 新增 `get ttyFd()` |
| 4 | 中 | launcher 无 `shutdown()` | 已改：R5/§10 定 `kill child` → 1s → `forceExit(129)` |
| 5 | 中 | `forceExit` 的 SIGKILL/rethrow 顺序 | 已改：rethrow 前置 |
| 6 | 中 | 把 3s 改 5s 写成「不修改 ADR」 | 已改：第 2 轮进一步拆成两个定时器，**3s 原样保留**，不再修订该 ADR |
| 7 | 低 | 拿行号当条款号 | 已改：引原文首句 |
| 8 | 低 | 三处行号区间不准 | 已改：`1010-1013` / `277-287` / `258-273`；补 `fd-guard.ts:45` |
| 9 | 低 | 机制清单漏「计数保险」 | 已改：新增 M4 |
| 10 | 低 | 退出码 70 未进兼容性 | 已改：§8/§10 补 70 |
| 11 | 低 | §7 第 5/2 条不可执行 | 已改：改 mock 单测 |
| 12 | 低 | `uncaughtCount` 等三处落点缺失 | 已改：§10 补齐 |
| 13 | 低 | 3s→8s 未写换算、ADR 代价缺 flush 风险 | 已改：第 2 轮撤销该改动（不再用 5s） |

### 第 2 轮（复审）

| # | 严重度 | 发现 | 处置 |
|---|---|---|---|
| 1 | 高 | R8 的 `delete` 放 `boot/env.ts` 会导致无限 re-exec | 已改：移到 `bin.ts` 守卫分支之后（R8 代码块），§6 同步 |
| 2 | 高 | 5s 预算会砍断 5–10s 的正常关停（漏看 lifecycle `TOTAL_BUDGET_MS=10_000`） | 已改：拆成 3s 复位 + 13.5s 硬退出；§7 验收、§10、ADR 同步 |
| 3 | 中 | 旧 ADR 未双向同步 | 已改：不再修订该 ADR（3s 保持原状），只加「关联」交叉引用；DoR#7 重写 |
| 4 | 中 | `forceExit(129)` 与 ADR「仅新增 70」冲突 | 已改：ADR 决定 6 与 §8 同时列 70 / 129 |
| 5 | 中 | 用例 B 在 R8 后与 A 同路径，失去回归意义 | 已改：B 改为 `NANO_GUARDED=$$ node dist/bin.js` |
| 6 | 中 | §6 漏 `fd-guard.ts:32` 写入端 | 已改：§6 补写入端与校验端两行 |
| 7 | 低 | `bin.ts:63` 应为 `:59` | 已改：§2.2 与 R8 两处都改 |
| 8 | 低 | §2.3 缺「无守卫路径栈」标注 | 已改：标题行内补注 |
| 9 | 低 | `/dev/tty` 句柄零写未实测 | 已实测：挂断后抛 EIO，写入 §2.4 第 3 行 |
| 10 | 低 | `drive.mjs` 的 `=== '1'` 会失效 | 已改：§6 列入改动面（真值判断） |
| 11 | 低 | `bin.ts:65/:68` 正常退出仍是裸 `process.exit` | 已改：R2 与 §6 一并改 `forceExit` |
| 12 | 低 | 巡检 interval 关停时不清 | 已改：§6 `:1028` 加 `clearInterval` |

### 第 3 轮（复审）

| # | 严重度 | 发现 | 处置 |
|---|---|---|---|
| 1 | 高 | 用例 B 的 `NANO_GUARDED=$$` 不成立（bash exec 顶替使 `$$` 变成 node 自己 pid；`execFile` 里是字面量） | 已改：改用 `--import tests/fixtures/pretend-guarded.mjs` 注入 `String(process.ppid)`；并加「本轮未新建 logs」断言 |
| 2 | 中 | 13.5s exitTimer 在 lifecycle 10s 夹逼下不可达，配套单测会假失败 | 已改：R3 明写「防的是 `requestShutdown` 永不 settle」，单测改为 stub `requestShutdown`；`unref()` |
| 3 | 中 | §6 漏 `:1015` 的第二个 `clearTimeout` | 已改：§6 行号 `1010-1015`，代码块写明两个都 clear |
| 4 | 中 | `TOTAL_BUDGET_MS` 未导出、§6 未列、非目标却说「一律不动」 | 已改：§6 补 `lifecycle.ts:49` 改 `export const`（值不变）；非目标措辞改为「值不动，只导出」 |
| 5 | 中 | `clearInterval` 放 `removeProcessListeners()` 太晚（它在 await 之后） | 已改：移到 `shutdown()` 开头（`:942-952`），`removeProcessListeners()` 再兜一次 |
| 6 | 中 | launcher 1s 后 SIGTERM 强杀会砍断 flush；与 R3 冲突 | 已改：等 `SHUTDOWN_BUDGET_MS + 1500`（≈15s）；并规定 runtime `stopping` 后 SIGTERM/SIGHUP 不再升级 force |
| 7 | 低 | `grep` 断言应零命中，非「只命中 diagnostic.ts」 | 已改 |
| 8 | 低 | §4 仍写「30s + 8s」 | 已改「30s + 13.5s」 |
| 9 | 低 | `drive.mjs` 已在 `5509c92` 改完，§6 仍当待办；`main.ts` 裸写在 `:362` | 已改：标「已完成」；裸写列 `:106,143,164,198,214,218,362` |
| 10 | 低 | `main.ts:152` 早退信号里仍裸 `process.exit(1)` | 已改：§6 列入，改 `forceExit`；DoR#3 同步 |
| 11 | 低 | §7#2 的采样没给手段 | 已改：改用 `--import` 预加载 `uncaughtExceptionMonitor` 计数 |
| 12 | 低 | 旧 ADR 的 launcher 职责被 R5 扩写，spec 说「不改任何决定」 | 已改：§1 非目标写明「职责扩展而非变更」；旧 ADR「关联」节同步一句 |
