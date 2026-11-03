# [2026-11-03-nano-exit-hardening] 终端失联后的退出兜底：诊断写不抛、退出不留活口

- 组标识：`2026-11-03-nano-exit-hardening`
- 角色：单份 spec，总纲与执行规格合一
- 状态：**实施版 · 修订 1**（13 条审核发现已改，待复核/过闸）
- Issue：[#164](https://github.com/nano-sun99/dsh-tui-nano/issues/164)
- 结构：**不拆**（单一成因、单一路径，1 份 spec + 1 张执行 issue）
- 机制范围：M1–M4（见 §5）
- 上游：
  - 实测事故与复现：issue #164（2026-11-03，83 分钟 100% CPU；4 秒复现；`uncaughtExceptionMonitor` 抓到 107,244 次未捕获异常）
  - Claude Code 2.1.88 源码（本机归档 `/Users/sunchongsheng/Downloads/归档/06-软件与安装包/ClaudeCode/src`）：
    `utils/gracefulShutdown.ts:193-232`（`forceExit`：`process.exit` 抛错则 `SIGKILL` 自己；**test 环境先 rethrow 再杀**）、`:278-297`（孤儿巡检，Bun 语义：`stdout.writable`/`stdin.readable`）、`:301-310`（`uncaughtException` 只记日志）、`:417-426`（failsafe `max(5000, hookBudget+3500)` → `forceExit`）、`:132-135`（终端已消失时吞写错误）、`ink/ink.tsx:1691-1702`（revoked TTY 上 `setRawMode`/`read` 抛 EBADF/EIO）
  - Node 官方文档 [Process › Event `'uncaughtException'`](https://nodejs.org/api/process.html#event-uncaughtexception)：处理器内抛出的异常不再被捕获——该保证只覆盖同步重入，**异步写失败仍会重新触发**，正是本次自激入口
- ADR 检索：按「退出 / 退出码 / 信号 / SIGHUP / 孤儿 / orphan / stderr / 关停 / shutdown / fd / 守卫」检索 `docs/decisions/`
  - 命中并沿用：[ADR-20261029-single-process-fd-guard](../../decisions/2026-10-29-single-process-fd-guard.md)（launcher/runtime 分工、诊断走重定向 stderr、`NANO_GUARDED` 契约）
  - **本次修订其中一条**：原文「关停增加 3s 强制恢复定时器：无论 hook 是否挂起，3s 时恢复终端并非零退出」→ 改为 5s 且**到点强制退出**（现行代码只恢复不退出，属代码回归该 ADR，R3 一半是修回归）
  - 零命中：退出码约定、`SIGKILL` 兜底、孤儿巡检、诊断写失败熔断、守卫标记的跨进程泄漏
- ADR：新增 [ADR-20261103-exit-failsafe](../../decisions/2026-11-03-exit-failsafe.md)（修订上述那一条），随本 spec 同一 PR
- 替代关系：不替代任何 spec；对 ADR-20261029 只改「3s 强制恢复」一条，launcher/runtime 分工、150ms 去重、`NANO_GUARDED` 契约一律不动（R8 只收紧其**校验方式**）
- 下游：无硬依赖。`plain` 分支（`--help` / `--version` / `purge`）不受影响。
- 合入前提：`npm run typecheck` / `lint` / `build` / `npm test` 退出 0；§7 的 pty 回归跑过一次并留证据。文档检查：本仓无 docs 检查入口（`scripts/` 下无 check-docs 脚本、AGENTS.md 未自报）。

## 1. 目标与边界

一句话：**终端失联之后，nano 必须在有限时间内、以可预期的方式消失，过程中不许留下烧 CPU 的活口。**

1. **诊断写永不抛**：进程内所有 stderr 写走同一封装，失败只熔断（R1）。
2. **退出不留活口**：`forceExit` 以「`process.exit` 失败就 `SIGKILL` 自己」收尾（R2）。
3. **关停到点就死**：`forceTimer` 从「只恢复终端」改为「恢复后强制退出」，预算 5s（R3）。
4. **孤儿能被发现**：30s 巡检 `ppid` 基线 + 终端 fd 空写探测（R4）。
5. **launcher 同一套底线**：`fd-guard` 与入口 `catch` 同样安全写，并自注册兜底（R5）。
6. **不引入新依赖**：不引入 native 模块，不动 `package.json` 依赖（R6）。
7. **可回归**：守卫路径与失联路径各一条用例（R7）。
8. **守卫标记不再泄漏**：`NANO_GUARDED` 带 launcher pid 并校验 `ppid`，用完即删（R8）。

### 非目标

- **不改 fd-guard 架构**：不合并 launcher/runtime，不改「fd 1/2 绑日志、渲染走 `/dev/tty`」的分工。
- **不改渲染、终端恢复序列与信号去重**：`terminal.restore()` 的转义序列、150ms 去重窗口不动。
- **不改会话落盘顺序**：drain → flush → core 顺序保持。
- **不做内核级父进程监听**：macOS 无 `PR_SET_PDEATHSIG`，不为此引入 native 依赖。
- **不改非 TUI 命令与信号退出码**：信号仍退 0，不对齐 Claude Code 的 129/143（差异记入 ADR「接受的代价」）。

## 2. 现状与证据

### 2.1 两条路径（关键：事故发生在**无守卫**那条）

| 路径 | 触发条件 | 终端挂断后 | 证据 |
|---|---|---|---|
| **守卫路径**（launcher 起 runtime，fd 1/2 = `logs/*.log`，渲染走 `/dev/tty`） | 正常启动 | SIGHUP → 诊断写进日志 → **19ms 干净退出** | 2026-11-03 实测：`nano: 开始关停（signal SIGHUP）` → `关停（…，19ms）`，进程消失 |
| **无守卫路径**（runtime 直接跑，fd 0/1/2 = 终端） | `NANO_GUARDED=1` 被继承 | 诊断写 → `EIO` → 自激 → 吃满一核到进程消失为止 | 4 秒复现；107,244 次未捕获异常；首条栈落在 `NanoApp.shutdown` |

事故进程 PID 25029 的 fd 0/1/2 **全部 revoked 且无任何日志文件**——正是无守卫路径的特征（守卫路径的 fd 2 会指向 `logs/nano-*.log`）。

### 2.2 泄漏成因

`src/runtime/fd-guard.ts:11` 用环境变量 `NANO_GUARDED` 标记「本次已被守卫」，但 runtime 启动后**不清理它**：

- 在 nano 会话里（Bash 工具、嵌套终端）再起一个 `nano`，后者继承 `NANO_GUARDED=1` → `src/bin.ts:63` 的 `isGuarded()` 为真 → **跳过守卫**，直接 `main()`；
- 实测确认：本机 nano 会话导出的环境里 `NANO_GUARDED=1`，在其中启动的 nano 一个日志都不建、fd 全指向终端；
- 于是「诊断写进日志」这条安全假设失效，终端一断就进入 §2.3 的自激。

### 2.3 自激链（首条栈已抓到）

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
| `fs.writeSync(2, …)`（含零长度写） | 抛 `EIO`；零长度不会短路 |
| `process.stdout.writable` / `stdin.readable` / `destroyed` | 恒 `true` / `true` / `false` |
| 守卫路径下同样挂断 | 19ms 干净退出（见 §2.1） |

第 3 行是关键差异：Claude Code 的 30s 巡检依赖 stream 标志翻转（Bun 语义），**在 Node 上恒真，照抄等于没有巡检**。

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

- **口径是全仓**：`src/` 下所有 `process.stderr.write` 一律替换（实测共 **23 处**，落在 5 个文件：`main.ts` 7、`controls/feature-host.ts` 11、`bin.ts` 2、`runtime/fd-guard.ts` 2、`render/renderer.ts` 1）。`process.stdout.write`（4 处，渲染/装配路径）不在本单范围。
- 「必须让人看见」的错误（`src/main.ts:361` 的 `writeToTty`）保留 `/dev/tty` 分支，只把其中的 `process.stderr.write` 换成 `writeDiagnostic`。
- 首次失败后熔断，本进程内不再 syscall；不用 `process.stderr.write`：其实测失败可逃出调用点，且 stream 语义允许异步 `error` 事件逃逸。

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
- 顺序与 CC 一致：`rethrow` 在 `SIGKILL` **之前**，否则单测会把 vitest worker 自己杀掉（SIGKILL 不可 catch）。

### R3 关停到点必须退出

`src/app/nano-app.ts:1010-1013`（`forceTimer` 本体；1009 是上一个注册、1014 是 `requestShutdown`）：

```ts
const forceTimer = setTimeout(() => {
  terminal.restore()
  this.exitCode = this.exitCode || 1
  forceExit(this.exitCode)        // 新增：不再「只恢复终端、进程留着」
}, SHUTDOWN_BUDGET_MS)            // 3000 → 5000
```

- `SHUTDOWN_BUDGET_MS = 5000`，定义在 `src/app/nano-app.ts` 顶部（模块常量，不跨文件），对齐 CC 的 `max(5000, sessionEndBudget + 3500)`（nano 无 session-end hook，退化为 5000）。
- 正常路径仍在 `requestShutdown` 返回后 `clearTimeout`，不改变成功路径时延。

### R4 孤儿巡检（30s）

- 启动时快照 `const startPpid = process.ppid`，`setInterval(30_000).unref()`，每轮两件事，任一命中即走失联处理：
  1. `startPpid !== 1 && process.ppid === 1`；
  2. 对**终端句柄**空写探测：runtime 用 `terminal.ttyFd`（`/dev/tty`），launcher 用 fd 2；抛 `EIO`/`EBADF` 即终端已死。
- **`Terminal` 需新增只读 getter**：`get ttyFd(): number | undefined`（当前 `private fd`，`src/runtime/terminal.ts:27`；`enter()` 后才有值，`restore()` 后置 `undefined`）。`undefined` 视为「无终端」→ **跳过写探测**，只用 `ppid` 判据。
- 仅 `process.stdin.isTTY === true` 时启动定时器（管道/打印模式不装）。
- 明确**不用** `stdout.writable` / `stdin.readable`（§2.4 第 3 行）。
- 用 `startPpid` 快照而非「等于 1 即孤儿」，避免容器/CI 里本来以 PID 1 启动时误判。

### R5 launcher 同一套底线

- `src/runtime/fd-guard.ts:45`（spawn 失败分支）与 `:51`（子进程被信号终止分支）、`src/bin.ts:51` 与 `:69-74` 的裸写改 `writeDiagnostic`。
- launcher 注册自己的 `uncaughtException` / `unhandledRejection` → `writeDiagnostic` + `forceExit`（当前一个处理器都没有）。
- launcher 的失联动作（**这里没有 `shutdown()`，必须写死**）：巡检命中 → `writeDiagnostic` 记一行 → `child.kill('SIGTERM')` → 最多等 1s → `forceExit(129)`。

### R6 不引入新依赖

全部用 `node:fs` / `node:process` 现有能力；不改 `package.json` 依赖与 `engines`。

### R7 可回归

- `tests/feature/exit-hardening.test.ts`：
  - 用例 A（守卫路径，防回归）：`env -u NANO_GUARDED` 起真 pty → 挂断 → 8s 内消失且日志里出现 `关停（…，NNms）`；
  - 用例 B（无守卫路径，复现本 bug）：`NANO_GUARDED=1` 起真 pty → 挂断 → 8s 内消失；
  - 无 `script` 命令或非 darwin 时 `skip`。
- `tests/unit/diagnostic.test.ts`：mock `node:fs` 的 `writeSync` 抛 `EIO` → 连续 100 次调用只尝试 1 次、不抛；`isStderrDead()` 为真。
- `tests/unit/nano-app-uncaught.test.ts`：连发 4 次 `uncaughtException` → 第 4 次直接 `forceExit(70)`，`getUncaughtCount()` 为 4；用 mock 的 `process.exit` 断言，不真杀。
- `tests/unit/nano-app-shutdown-timeout.test.ts`：注入一个永不 resolve 的 `features.dispose`（现有 `new NanoApp({ features })` 先例可直接 mock）→ 5s 后 `forceExit` 被调。

### R8 守卫标记不再泄漏

- `NANO_GUARDED` 的值改为 **launcher 的 pid**（`String(process.pid)`），runtime 校验两件事才算「已被守卫」：变量存在 **且** `String(process.ppid) === value`；不匹配则当作未守卫，正常 re-exec。
- `isGuarded()` 同步改成校验函数，返回布尔；调用点在 `src/bin.ts:63` 不变。
- runtime 进入 `main()` 前 `delete process.env.NANO_GUARDED`（`src/boot/env.ts`，`bin.ts` 第一个 import），防孙进程继承。
- 这样「在 nano 会话里再起 nano」会重新走守卫，§2.1 的无守卫路径不再自然出现。

## 4. 对照表（无页面路径）

固定四列：

| 流程节点 | 界面或样例 | 数据或接口 | 验收 |
|---|---|---|---|
| 正常 `Ctrl+C` 退出 | 无界面；终端恢复 + 退出码 `0`（不变） | `SIGINT` → `shutdown('signal SIGINT')` | 启动后 Ctrl+C，`echo $?` 为 `0`，1s 内消失 |
| 关窗口（守卫路径） | 无界面；日志出现 `关停（signal SIGHUP，NNms）` | `SIGHUP` → 诊断写日志（成功） | 用例 A：8s 内消失，日志含 `关停` |
| 关窗口（无守卫路径，本 bug） | 无界面；无输出 | `SIGHUP` → 诊断写 → EIO → 熔断 | 用例 B：8s 内消失；采样 `TriggerUncaughtException` 连续命中 ≤ 1 |
| 终端静默失联（无信号） | 无界面；日志 `reason=orphan`（stderr 未死时） | `ppid` 变 1 或 `/dev/tty` 空写抛 EIO | kill 外层 shell（不触发 SIGHUP）→ 30s + 8s 内消失 |
| 任何异常且 stderr 已死 | 无界面 | `writeSync(2)` 抛 EIO → 熔断 → 关停 → `forceExit` | 单测断言；CPU 不超过单核 5 秒 |
| 关停卡住（dispose 不返回） | 无界面；终端已恢复 | `forceTimer` 5000ms | 单测：5s 后 `forceExit` 被调 |
| 嵌套启动（`NANO_GUARDED` 继承） | 无界面 | 校验 `ppid` 不匹配 → 重新走守卫 | 用例：`NANO_GUARDED=1` 直接跑，日志里应出现守卫创建的 `logs/nano-*.log` |

样例选择：本条按「后端/运行时」路径，用**失败矩阵**（上表）+ 一条端到端薄切片（§2.2 复现脚本）。

## 5. 机制清单

| ID | 机制 | 解决什么 | 没有会怎样 |
|---|---|---|---|
| M1 | `writeDiagnostic` + `stderrDead` 熔断 | 切断「错误处理器自己抛错」的自激环 | 一次终端失联就烧掉一条核 83 分钟（本次事故） |
| M2 | `forceExit`（`exit` 失败即 `SIGKILL`）+ 关停 `forceTimer` 到点调用 | 保证任何收尾路径都有终点 | 关停卡住时进程挂死，只能人工 `kill -9` |
| M3 | 孤儿巡检（`ppid` 基线 + 终端 fd 探测，30s） | 覆盖「没收到 SIGHUP 也失联」 | 静默失联要等到下一次异常才可能退出 |
| M4 | `uncaughtCount > 3` 计数保险 | 防处理器自身重入（写已安全，但处理器仍可能抛别的） | 新的「处理器抛处理器」路径还能把进程钉住 |

## 6. 改动面

| 文件 | 改什么 |
|---|---|
| `src/runtime/diagnostic.ts`（新建） | `writeDiagnostic`、`isStderrDead`、`forceExit`、`uncaughtCount` / `getUncaughtCount`、`resetDiagnosticStateForTest` |
| `src/main.ts`（7 处 stderr 裸写，含 `:214,218,361`） | 全部改 `writeDiagnostic`；`writeToTty` 保留 `/dev/tty` 分支 |
| `src/controls/feature-host.ts`（11 处） | 同上 |
| `src/runtime/fd-guard.ts`（`:45`、`:51`） | 同上；launcher 自注册 `uncaughtException`/`unhandledRejection` → `forceExit`；R4 巡检 + R5 失联动作（kill child → `forceExit(129)`） |
| `src/bin.ts`（`:51`、`:69-74`） | 顶层错误改安全写 + `forceExit`；`isGuarded()` 改为校验函数（R8） |
| `src/boot/env.ts` | runtime 启动即 `delete process.env.NANO_GUARDED`（R8） |
| `src/runtime/terminal.ts:27` | 新增只读 `get ttyFd(): number \| undefined`（R4） |
| `src/render/renderer.ts`（1 处） | 裸写改 `writeDiagnostic` |
| `src/app/nano-app.ts:1010-1013` | `forceTimer` 预算 5000ms，到点 `forceExit`（R3） |
| `src/app/nano-app.ts:277-287` | `onUncaught`/`onUnhandledRejection` 计数 + 安全写 + 保险（R2） |
| `src/app/nano-app.ts:258-273` | `registerSignals` 内注册 R4 巡检（30s、`unref`、TTY 才装） |
| `tests/unit/diagnostic.test.ts`、`nano-app-uncaught.test.ts`、`nano-app-shutdown-timeout.test.ts`（新建） | 单测 |
| `tests/feature/exit-hardening.test.ts`（新建） | pty 冒烟 A/B 两例 |
| `docs/decisions/2026-11-03-exit-failsafe.md`（新建） | ADR |

## 7. 验收

1. 用例 A（守卫路径）与 B（无守卫路径）各 8s 内进程消失；B 的预算是 `5s 关停 + 3s 收尾`，即 issue 原「3s 内」按新预算换算为「8s 内」。
2. 用例 B 采样 `TriggerUncaughtException` 连续命中 ≤ 1。
3. `grep -rn "process\.stderr\.write" src | grep -v diagnostic.ts` 输出为空（全量口径可验证）。
4. 把 `logs` 目录设为不可写、或 stderr 指向已挂断 pty，进程仍退出。
5. 正常路径不回归：Ctrl+C 退 0、`--help` / `--version` / `purge` 行为与退出码不变。
6. 关停卡死单测：注入永不 resolve 的 `features.dispose` → 5s 后 `forceExit` 被调（不依赖手工 `sample`）。
7. `NANO_GUARDED=1` 直接启动时，仍会创建 `logs/nano-*.log`（R8 生效）。
8. `npm run typecheck && npm run lint && npm run build && npm test` 全绿。

## 8. 迁移 / 回滚 / 兼容 / 观测

- **迁移 / 回填**：无。不涉及数据、配置或 schema。
- **回滚**：`git revert` 单个 PR；新增文件全是新增，无隐藏耦合。
- **兼容**：
  - CLI 参数、`NANO_GUARDED` 的**存在性语义**保持（仍表示「已被守卫」），只是值从 `1` 变成 launcher pid；旧值 `1` 在 `ppid` 校验下会被判为未守卫（安全侧）。
  - 退出码：信号仍 0；**新增 `70`（未捕获异常连发 4 次）**，与既有 0/1 不冲突；脚本若依赖退出码需知悉。
  - 日志格式：`reason` 新增取值 `orphan`；`关停（…，NNms）` 不变。
  - `plain` 分支不装巡检、不装定时器。
- **观测**：`reason=orphan` + 退出码 70；`stderrDead` 熔断时不写任何地方（终端本来就看不见），以「进程消失时间」为观测口径，由 §7 第 1/3 条断言。

## 9. DoR 自查

| # | 条目 | 结论 |
|---|---|---|
| 1 | 承重规则只有一个结论，无 TBD | ✅ §3 全部定值（5000ms / 30s / 3 次 / 70 / launcher pid 校验） |
| 2 | 每个流程节点有界面/样例或明确无界面 | ✅ §4 七节点全覆盖，均标「无界面 + 断言」 |
| 3 | 每条写路径单一入口；状态有字段有读侧 | ✅ 诊断写 = `writeDiagnostic`（全仓 grep 归零，§7.3 可验证）；退出 = `forceExit`；状态 `stderrDead` / `uncaughtCount` 各有读侧 `isStderrDead()` / `getUncaughtCount()` |
| 4 | 每条验收可执行 | ✅ §7 全部为命令、断言或单测；不再依赖人工采样判读 |
| 5 | 迁移 / 回填 / 回滚 / 兼容 | ✅ §8（含新增退出码 70） |
| 6 | 外部合同影响与版本 | 不适用：不涉及报表 / 开放平台 / 消息通道等外部合同 |
| 7 | ADR supersede 链清楚、正文同步 | ✅ 新 ADR 明写「修订 ADR-20261029 中『关停增加 3s 强制恢复定时器』一条（3s→5s，且到点必须退出）」，其余决定不动；无副本 |

## 10. 自定细节

- **关停预算 3s → 5s**：对齐 CC `max(5000, …)`；代价是卡住时多等 2s，且大会话 flush 超过 5s 会被强杀（记入 ADR「接受的代价」）。
- **熔断粒度 = 进程级**：`stderrDead` 置位后本进程内不再尝试写 stderr（含启动期 heap watch）。
- **`uncaughtCount` 落点**：`src/runtime/diagnostic.ts` 模块级变量，读侧 `getUncaughtCount()`；`resetDiagnosticStateForTest()` 同时复位计数。
- **`SHUTDOWN_BUDGET_MS` 落点**：`src/app/nano-app.ts` 顶部模块常量。
- **`ppid` 用启动快照**：避免容器/CI 里以 PID 1 启动时误判。
- **探测目标**：runtime 探 `terminal.ttyFd`（`/dev/tty`），launcher 探 fd 2——两者的「终端」不是同一个 fd。`ttyFd === undefined` 时跳过写探测，只用 `ppid`。
- **launcher 失联动作**：`child.kill('SIGTERM')` → 1s 后 `forceExit(129)`（129 = 128+1，表示「因失联收尾」，与 CC 的 SIGHUP 退出码同值）。
- **退出码**：信号仍 0；`forceExit` 传当前 `exitCode`，为 0 时兜底为 1；计数保险固定 70。
- **命名**：`writeDiagnostic` / `forceExit` / `SHUTDOWN_BUDGET_MS` / `ttyFd` 为工作名，实施时可改，语义不变。

## 11. 审核修订记录

| # | 严重度 | 发现 | 处置 |
|---|---|---|---|
| 1 | 中 | §2.1/§2.3 对 §10 的 launcher/runtime 归属冲突 | 已改：§2.1 拆成守卫/无守卫两条路径，§2.3 标注为无守卫路径的 runtime 栈，事故归因改为「无守卫实例」 |
| 2 | 中 | 「单一入口」与 19+ 处裸写不符 | 已改：R1 改为全仓口径（实测 23 处 `process.stderr.write` / 5 文件），§6 逐文件列出，§7.3 加 grep 断言 |
| 3 | 中 | `Terminal.fd` 是 private，改动面缺 terminal.ts | 已改：R4/§6 新增 `get ttyFd()`；§10 写死 `undefined` 时跳过探测 |
| 4 | 中 | launcher 无 `shutdown()`，失联动作未定 | 已改：R5/§10 定为 `kill child` → 1s → `forceExit(129)` |
| 5 | 中 | `forceExit` 的 SIGKILL/rethrow 顺序与 CC 相反 | 已改：rethrow 前置，与 `gracefulShutdown.ts:214-222` 一致 |
| 6 | 中 | 把「3s 强制恢复」改 5s + 语义变更写成「不修改 ADR」 | 已改：ADR 增「修订」栏；§上游与 DoR#7 改为「修订其一条」；补「现行代码只恢复不退出 = 代码回归该 ADR」 |
| 7 | 低 | 拿行号当条款号 | 已改：改引原文首句 |
| 8 | 低 | 三处行号区间不准 | 已改：`1010-1013` / `277-287` / `258-273`；并补 `fd-guard.ts:45` |
| 9 | 低 | 机制清单漏「计数保险」 | 已改：新增 M4，M2 描述纳入 `forceTimer` |
| 10 | 低 | 新增退出码 70 未进兼容性 | 已改：§8/§10 补 70 |
| 11 | 低 | §7.5/§7.2 不可执行 | 已改：改为 mock 单测；采样降为辅助证据 |
| 12 | 低 | `uncaughtCount` / `SHUTDOWN_BUDGET_MS` / reset 落点缺失 | 已改：§10 补三条 |
| 13 | 低 | 3s→8s 未写换算、ADR 代价缺 flush 风险 | 已改：§7.1 补换算；ADR 代价补「flush > 5s 被强杀」 |
