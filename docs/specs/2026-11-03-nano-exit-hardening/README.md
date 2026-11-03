# [2026-11-03-nano-exit-hardening] 终端失联后的退出兜底：诊断写不抛、退出不留活口

- 组标识：`2026-11-03-nano-exit-hardening`
- 角色：单份 spec，总纲与执行规格合一
- 状态：**实施版**（对照与 DoR 已补，待过闸）
- Issue：[#164](https://github.com/nano-sun99/dsh-tui-nano/issues/164)
- 结构：**不拆**（单一成因、单一路径，1 份 spec + 1 张执行 issue）
- 机制范围：M1–M3（见 §5）
- 上游：
  - 实测事故与复现：issue #164（2026-11-03，83 分钟 100% CPU；4 秒复现；`uncaughtExceptionMonitor` 抓到 107,244 次未捕获异常）
  - Claude Code 2.1.88 源码（本机归档 `/Users/sunchongsheng/Downloads/归档/06-软件与安装包/ClaudeCode/src`）：
    `utils/gracefulShutdown.ts:193-232`（`forceExit`：`process.exit` 抛错则 `SIGKILL` 自己）、`:278-297`（孤儿巡检，Bun 语义：`stdout.writable`/`stdin.readable`）、`:301-310`（`uncaughtException` 只记日志）、`:417-426`（failsafe `max(5000, hookBudget+3500)` → `forceExit`）、`:132-135`（终端已消失时吞写错误）、`ink/ink.tsx:1691-1702`（revoked TTY 上 `setRawMode`/`read` 抛 EBADF/EIO）
  - Node 官方文档 [Process › Event `'uncaughtException'`](https://nodejs.org/api/process.html#event-uncaughtexception)：处理器内抛出的异常不再被捕获——该保证只覆盖同步重入，**异步写失败仍会重新触发**，正是本次自激入口
- ADR 检索：按「退出 / 退出码 / 信号 / SIGHUP / 孤儿 / orphan / stderr / 关停 / shutdown / fd」检索 `docs/decisions/`
  - 命中并沿用：[ADR-20261029-single-process-fd-guard](../../decisions/2026-10-29-single-process-fd-guard.md)（launcher/runtime 分工、诊断走重定向 stderr、3s 强制恢复；本单**不改架构**，只补退出保证）
  - 零命中：退出码约定、`SIGKILL` 兜底、孤儿巡检、诊断写失败熔断
- ADR：新增 [ADR-20261103-exit-failsafe](../../decisions/2026-11-03-exit-failsafe.md)，随本 spec 同一 PR
- 替代关系：不替代任何 spec。补充 ADR-20261029 第 17/18 条，**不修改**其决定。
- 下游：无硬依赖。`plain` 分支（`--help` / `--version` / `purge`）不受影响。
- 合入前提：`npm run typecheck` / `lint` / `build` / `npm test` 退出 0；§7 的 pty 回归脚本手动跑过一次并留证据。文档检查：本仓无 docs 检查脚本（无入口）。

## 1. 目标与边界

一句话：**终端失联之后，nano 必须在有限时间内、以可预期的方式消失，过程中不许留下烧 CPU 的活口。**

1. **诊断写永不抛**：写失败只吞掉并熔断，不进入 `uncaughtException`（R1）。
2. **退出不留活口**：`forceExit` 以「`process.exit` 失败就 `SIGKILL` 自己」收尾（R2）。
3. **关停到点就死**：`forceTimer` 从「只恢复终端」改为「恢复后强制退出」，预算 5s（R3）。
4. **孤儿能被发现**：30s 巡检 `ppid` 基线 + 终端 fd 空写探测（R4）。
5. **launcher 同一套底线**：`fd-guard` 与入口 `catch` 同样安全写，并自注册兜底（R5）。
6. **不引入新依赖**：不引入 native 模块，不动 `package.json` 依赖（R6）。
7. **可回归**：4 秒 pty 复现固化成用例（R7）。

### 非目标

- **不改 fd-guard 架构**：不合并 launcher/runtime，不动 `NANO_GUARDED` 契约。
- **不改渲染、终端恢复序列与信号去重**：`terminal.restore()` 的转义序列、150ms 去重窗口不动。
- **不改会话落盘顺序**：drain → flush → core 顺序保持。
- **不做内核级父进程监听**：macOS 无 `PR_SET_PDEATHSIG`，不为此引入 native 依赖。
- **不改非 TUI 命令与信号退出码**：信号仍退 0，不对齐 Claude Code 的 129/143（差异记入 ADR「接受的代价」）。

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

自激充要条件：**写失败会抛，而「写失败」的落点又是那行写本身**。

### 2.4 运行时行为实测（Node v24.18.0 / Darwin 27.0.0）

| 观测 | 结果 |
|---|---|
| pty 挂断后 `process.ppid` | 立即变 `1` |
| `fs.writeSync(2, …)` | 抛 `EIO` |
| `process.stdout.writable` / `stdin.readable` / `destroyed` | 恒 `true` / `true` / `false` |
| 同样挂断但 stderr 指向普通文件 | 关停完全正常（`开始关停` → 17ms 收尾） |

第 3 行是关键差异：Claude Code 的 30s 巡检依赖 stream 标志翻转（Bun 语义），**在 Node 上恒真，照抄等于没有巡检**。

## 3. 需求规格（实施粒度）

### R1 诊断写不抛

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
export function resetDiagnosticStateForTest(): void { stderrDead = false }
```

- 首次失败后熔断，本进程内不再 syscall（避免每轮一次 EIO 的开销与噪声）。
- 不用 `process.stderr.write`：实测其失败可逃出调用点，且 stream 语义允许异步 `error` 事件逃逸。
- 替换点：`src/main.ts:214`、`src/main.ts:218`（heap watch report）、`src/app/nano-app.ts:955` 等全部 `writeDiagnostic` 调用点（`onUncaught` / `onUnhandledRejection` / 渲染失败 / handoff）。

### R2 退出必须有终点

```ts
export function forceExit(code: number): void {
  try {
    process.exit(code)
  } catch (error) {
    try { process.kill(process.pid, 'SIGKILL') } catch { /* 已在退出 */ }
    if (process.env.NODE_ENV === 'test') throw error   // 测试里 exit 被 mock 时让断言看得见
  }
}
```

- `onUncaught` / `onUnhandledRejection`：先 `writeDiagnostic` 记一行 → 走既有 `shutdown` → 任一步失败即 `forceExit(1)`。
- 递归保险：模块级 `uncaughtCount`，`> 3` 时跳过关停直接 `forceExit(70)`。
- `shutdown` 的所有 `catch` 分支、`bin.ts` 顶层 `catch`、`fd-guard` 的失败分支统一以 `forceExit` 收尾。

### R3 关停到点必须退出

`src/app/nano-app.ts:1009-1014`：

```ts
const forceTimer = setTimeout(() => {
  terminal.restore()
  this.exitCode = this.exitCode || 1
  forceExit(this.exitCode)        // 新增：不再「只恢复终端、进程留着」
}, SHUTDOWN_BUDGET_MS)            // 3000 → 5000
```

- `SHUTDOWN_BUDGET_MS = 5000`，对齐 Claude Code 的 `max(5000, sessionEndBudget + 3500)`（nano 无 session-end hook，退化为 5000）。
- 正常路径仍在 `requestShutdown` 返回后 `clearTimeout`，不改变成功路径的时延。

### R4 孤儿巡检（30s）

- 启动时快照 `const startPpid = process.ppid`。
- `setInterval(30_000).unref()`，每轮判断两件事，任一命中即 `shutdown('orphan')`：
  1. `startPpid !== 1 && process.ppid === 1`（父进程已死）；
  2. 对**终端句柄**做一次空写探测：runtime 用 `Terminal.fd`（`/dev/tty`），launcher 用 fd 2；抛 `EIO`/`EBADF` 即终端已死。
- 仅 `process.stdin.isTTY === true` 时启动（管道/打印模式不装定时器）。
- **明确不用** `stdout.writable` / `stdin.readable`（§2.4 第 3 行）。
- 用 `startPpid` 快照而非「等于 1 即孤儿」，避免容器/CI 里本来以 PID 1 启动时误判。

### R5 launcher 同一套底线

- `src/runtime/fd-guard.ts:51`（子进程被信号终止时写 stderr）与 `src/bin.ts:69-74`（顶层 catch）改 `writeDiagnostic`。
- launcher 注册自己的 `uncaughtException` / `unhandledRejection` → `writeDiagnostic` + `forceExit`（当前一个处理器都没有）。
- launcher 同样装 R4 的巡检（父进程是 shell，shell 一死它就该走）。

### R6 不引入新依赖

全部用 `node:fs` / `node:process` 现有能力；不改 `package.json` 依赖与 `engines`。

### R7 可回归

- `tests/feature/exit-hardening.test.ts`：用 `script -q /dev/null` 拉起真 pty，挂断后断言 **8s 内进程消失**；无 `script` 或非 darwin 时 `skip`。
- `tests/unit/diagnostic.test.ts`：mock `node:fs` 的 `writeSync` 抛 `EIO`，断言连续 100 次调用只尝试 1 次且不抛；断言 `isStderrDead()` 为真。
- `tests/unit/nano-app-uncaught.test.ts`：连发 4 次 `uncaughtException`，断言 `forceExit` 被调用且次数 ≤ 3 次进入关停。

## 4. 对照表（无页面路径）

固定四列，覆盖全部流程节点：

| 流程节点 | 界面或样例 | 数据或接口 | 验收 |
|---|---|---|---|
| 正常 `Ctrl+C` 退出 | 无界面；终端恢复 + 退出码 `0`（现状不变） | `SIGINT` → `shutdown('signal SIGINT')` | `nano` 启动后按 Ctrl+C，`echo $?` 为 `0`，进程 1s 内消失 |
| 关窗口（`SIGHUP`） | 无界面；stderr 已死时无输出 | `SIGHUP` → `shutdown` → 诊断写失败 → 熔断 | §2.2 脚本：8s 内 `pgrep -f "bin/nano"` 为空 |
| 终端静默失联（无信号） | 无界面；日志出现 `reason=orphan`（仅 stderr 未死时） | `ppid` 变 1 或 `/dev/tty` 空写抛 EIO | `kill -9` 外层 shell（不触发 SIGHUP），30s + 8s 内进程消失 |
| 任何异常且 stderr 已死 | 无界面；无输出 | `writeSync(2)` 抛 EIO → 熔断 → 关停 → `forceExit` | 采样中 `TriggerUncaughtException` 命中 ≤ 1；CPU 不超过单核 5 秒 |
| 关停卡住（MCP/网络不返回） | 无界面；终端已恢复 | `forceTimer` 5000ms | 注入永不 resolve 的 dispose，5s 后进程消失 |

样例选择：本单属「后端/运行时」类，按 §三 用**时序 + 失败矩阵**（上表）+ 一条端到端薄切片（§2.2 脚本）。三个真实例子由「正常 / 挂断 / 静默失联」三行承担。

## 5. 机制清单

| ID | 机制 | 解决什么 | 没有会怎样 |
|---|---|---|---|
| M1 | `writeDiagnostic` + `stderrDead` 熔断 | 切断「错误处理器自己抛错」的自激环 | 一次终端失联就烧掉一条核 83 分钟（本次事故） |
| M2 | `forceExit`（`exit` 失败即 `SIGKILL`） | 保证任何收尾路径都有终点 | 关停卡住时进程挂死，只能人工 `kill -9` |
| M3 | 孤儿巡检（`ppid` 基线 + 终端 fd 探测，30s） | 覆盖「没收到 SIGHUP 也失联」 | 静默失联要等到下一次异常才可能退出 |

## 6. 改动面

| 文件 | 改什么 |
|---|---|
| `src/runtime/diagnostic.ts`（新建） | `writeDiagnostic`、`isStderrDead`、`forceExit`、`uncaughtCount` |
| `src/main.ts:214,218` | 两处裸写改走 `writeDiagnostic` |
| `src/app/nano-app.ts:271-287` | `onUncaught` / `onUnhandledRejection` 改安全写 + 计数保险 |
| `src/app/nano-app.ts:1009-1014` | `forceTimer` 预算 5000ms，到点 `forceExit` |
| `src/app/nano-app.ts:258-297` | 注册 R4 孤儿巡检（30s，`unref`，TTY 才装） |
| `src/runtime/fd-guard.ts:41-56` | 信号/退出分支安全写；launcher 自注册 `uncaughtException` → `forceExit` |
| `src/bin.ts:69-74` | 顶层 catch 改安全写 + `forceExit` |
| `tests/unit/diagnostic.test.ts`（新建） | 熔断单测 |
| `tests/unit/nano-app-uncaught.test.ts`（新建） | 计数保险单测 |
| `tests/feature/exit-hardening.test.ts`（新建） | pty 冒烟 |
| `docs/decisions/2026-11-03-exit-failsafe.md`（新建） | ADR |

## 7. 验收

1. §2.2 脚本跑完，进程 8s 内消失，`pgrep -f "bin/nano"` 为空。
2. 同场景 `sample` 采样，`TriggerUncaughtException` 连续命中 ≤ 1。
3. 把 `logs` 目录设为不可写、或 stderr 指向已挂断 pty，进程仍退出。
4. 正常路径不回归：Ctrl+C 退 0、`nano --help` / `--version` / `purge` 行为与退出码不变。
5. 注入永不 resolve 的 dispose，5s 后进程消失（R3）。
6. `npm run typecheck && npm run lint && npm run build && npm test` 全绿。
7. 单测：`writeSync` 抛 EIO 桩 → 100 次调用只尝试 1 次；4 次 uncaught → 最多 3 次进关停。

## 8. 迁移 / 回滚 / 兼容 / 观测

- **迁移 / 回填**：无。不涉及数据、配置或 schema。
- **回滚**：`git revert` 单个 PR 即可，无残留状态；新增文件全是新增，无隐藏耦合。
- **兼容**：CLI 参数、退出码（信号仍 0）、`NANO_GUARDED` 契约、日志格式（`reason` 新增取值 `orphan`）均向后兼容；`plain` 分支不加载巡检、不装定时器。
- **观测**：`reason` 字段新增 `orphan`；`stderrDead` 熔断时不写任何地方（终端本来就看不见），以「进程消失时间」为观测口径，由 §7 第 1/3 条断言。

## 9. DoR 自查

| # | 条目 | 结论 |
|---|---|---|
| 1 | 承重规则只有一个结论，无 TBD | ✅ §3 全部定值（5000ms / 30s / 3 次 / fd 2） |
| 2 | 每个流程节点有界面/样例或明确无界面 | ✅ §4 五节点全覆盖，均标「无界面 + 断言」 |
| 3 | 每条写路径单一入口；状态有字段有读侧 | ✅ 诊断写 = `writeDiagnostic`；退出 = `forceExit`；状态 `stderrDead` / `uncaughtCount`，读侧 `isStderrDead()` / 测试断言 |
| 4 | 每条验收可执行 | ✅ §7 全部为命令或断言 |
| 5 | 迁移 / 回填 / 回滚 / 兼容 | ✅ §8 |
| 6 | 外部合同影响与版本 | 不适用：本单不涉及报表 / 开放平台 / 消息通道等外部合同 |
| 7 | ADR supersede 链清楚、正文同步 | ✅ 新增 ADR-20261103-exit-failsafe；沿用 ADR-20261029 且不改其决定；无副本 |

## 10. 自定细节

- **关停预算 3s → 5s**：对齐 Claude Code `max(5000, …)`；代价是卡住时多等 2s。
- **熔断粒度 = 进程级**：`stderrDead` 一旦置位，本进程内不再尝试写 stderr（含启动期 heap watch）。
- **`ppid` 用启动快照**：避免容器/CI 里以 PID 1 启动时误判为孤儿。
- **探测目标**：runtime 探 `/dev/tty` 句柄，launcher 探 fd 2——两者的「终端」不是同一个 fd（runtime 的 fd 2 是日志）。
- **退出码不变**：信号仍退 0；`forceExit` 传当前 `exitCode`，仅在为 0 时兜底为 1。
- **命名**：`writeDiagnostic` / `forceExit` / `SHUTDOWN_BUDGET_MS` 为工作名，实施时可改，语义不变。
- **测试隔离**：`resetDiagnosticStateForTest()` 仅测试用，生产代码不调用。

## 11. 审核修订记录

（过闸后追加）
