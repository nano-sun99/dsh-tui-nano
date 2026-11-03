# [2026-11-03-nano-exit-hardening] 退出与终端生命周期：四条不变量

- 组标识：`2026-11-03-nano-exit-hardening`
- 角色：单份 spec；**本版推翻前三版的「症状 → 对策」写法**，改为按不变量与状态机组织
- 状态：**实施版（重构 · 第 4 版）**，待复核/过闸
- Issue：[#164](https://github.com/nano-sun99/dsh-tui-nano/issues/164)
- 结构：**不拆**；本版取代同目录下前三版的全部条款（均未合并）
- 上游：
  - 事故与实测：issue #164（83 分钟 100% CPU；4 秒复现；107,244 次未捕获异常）
  - 三轮审核共 37 条发现 → 归因见 §2：**四项结构性缺陷在持续生产新缺陷**，不是条款写得不够细
  - Claude Code 2.1.88（本机归档 `…/ClaudeCode/src`）：单进程、单一 `forceExit`、诊断写文件（`utils/diagLogs.ts:44-56`）、交互模式 patch 掉 `stderr.write`（`ink/ink.tsx:1604-1637`）、终端归还排在关停第一件事（`utils/gracefulShutdown.ts:436`）
  - 同类症状的公开案例：终端关闭后 Node 进程 100% CPU（[cocalc#6963](https://github.com/sagemathinc/cocalc/issues/6963)、[vscode#44408](https://github.com/microsoft/vscode/issues/44408)）——是「tty 消失 + 持续写」这一类的通病，不是本仓偶发
- ADR 检索：按「退出 / 退出码 / 信号 / SIGHUP / 孤儿 / orphan / stderr / 关停 / shutdown / fd / 守卫 / 进程模型」检索 `docs/decisions/`
  - 命中并**取代**：[ADR-20261029-single-process-fd-guard](../../decisions/2026-10-29-single-process-fd-guard.md)（launcher re-exec 那套；取代关系见 §7）
  - 零命中：退出漏斗、诊断 sink、终端状态机
- ADR：新增 [ADR-20261103-single-process-exit](../../decisions/2026-11-03-single-process-exit.md)
- 合入前提：`npm run typecheck` / `lint` / `build` / `npm test` 退出 0；§6 的 pty 回归跑过并留证据。文档检查：本仓无 docs 检查入口。

## 1. 四条不变量（本 spec 的全部条文由它们推出）

> 判据：任何实现细节违反下面任一条就是 bug，不需要再讨论「要不要加个定时器」。

| # | 不变量 | 反例（本仓真实发生过） |
|---|---|---|
| **I1** | 诊断输出只依赖 **sink**，不依赖终端存活 | 同一个 `process.stderr`：守卫时是日志、未守卫时是终端；终端一断写失败抛错，又落回同一行写 → 自激 107,244 次 |
| **I2** | 终端归还先于一切异步收尾；终端可用性是**一等状态**，只有一个探测者 | `restore` 排在 lifecycle 最后一相；3s / 13.5s / 10s 三个预算互相打架 |
| **I3** | 进程只有**一个**退出漏斗，任何路径都经过它，漏斗自身不会被异常穿透 | `bin.ts:65/68/71`、`main.ts:152`、nano-app finish、forceTimer 五条路径各写各的 |
| **I4** | 「守卫」是进程拓扑属性，由**不可继承**的通道传递 | `NANO_GUARDED` 环境变量被孙进程继承 → 嵌套启动跳过守卫 → 回到 I1 的反例 |

## 2. 为什么推翻重写（37 条发现的归因）

| 结构缺陷 | 吃掉的审核发现 | 代表条目 |
|---|---|---|
| 诊断通道身份随启动方式变（违 I1） | 8 条 | 23 处裸写、「单一入口」不成立、熔断粒度、`writeToTty` |
| 双进程切碎终端归属（违 I4） | 9 条 | `NANO_GUARDED` 泄漏、无限 re-exec、「哪个 fd 才是终端」、launcher 无 `shutdown`、129 退出码、用例 B 构造 |
| 退出无单一漏斗（违 I3） | 7 条 | `forceExit` 顺序、`bin.ts:65/68`、`main.ts:152`、DoR#3 |
| 终端归还排最后（违 I2） | 6 条 | 3s vs 13.5s vs lifecycle 10s、`clearInterval` 位置、巡检打断 flush |
| 其余（行号、措辞、计数） | 7 条 | — |

**判据**：四轮打补丁仍在新位置冒同类问题 → 缺口在结构，不在条款。前三版条款作废。

## 3. 目标架构

```
bin/nano  (POSIX sh)                         ← 唯一的「守卫」实现，一个 exec
   └─ exec node dist/bin.js "$@"  >>"$LOG" 2>&1
        │  fd1/2 从出生就是日志；stdin 仍是终端；pid 不变、信号语义不变
        │
        ├─ 渲染  → /dev/tty（terminal.ts 已如此，唯一写入者）
        ├─ 诊断  → sink（fd2=日志），写失败只熔断，不抛
        └─ 退出  → exit(code)：restore → flush(预算) → exit → catch → SIGKILL
```

由此直接消失三样东西：**第二个 Node 进程**、**`NANO_GUARDED` 标记**、**「哪个 fd 是终端」的歧义**。

### 3.1 为什么 shell 能替代 re-exec

- 项目 **0 处 `win32` 代码**，本来就只跑 macOS / Linux；
- TUI 渲染早已走 `/dev/tty`（`src/runtime/terminal.ts:129`），不依赖 fd1；
- `exec` 后 pid 不变 → 信号、父子关系、`ppid` 判据与单进程一致；
- 重定向由内核完成，**没有 JS 抓不到的缝隙**——这正是 ADR-20261029 当初要的保证。

代价（如实）：`node dist/bin.js` 直跑时没有这层保护（开发态可接受，且 §6 用例 B 会验证它**仍然不会挂死**）；日志目录解析在 shim 里重复两行，用 parity 测试锁住。

## 4. 需求规格

### R1 诊断 sink（I1）

`src/runtime/diagnostic.ts`：

```ts
let dead = false
/** 诊断唯一写入点：任何情况下不抛。 */
export function writeDiagnostic(line: string): void {
  if (dead) return
  try { writeSync(2, line.endsWith('\n') ? line : `${line}\n`) }
  catch { dead = true }            // EIO / EBADF / EPIPE 一律熔断
}
export function isSinkDead(): boolean { return dead }
```

- **可机检**：`grep -rn "process\.stderr\.write" src` 必须**零命中**（当前 23 处 / 5 文件全部改走它）。
- 「必须让人看见」的错误走 `writeVisible(text)`：只写 `/dev/tty`（`try/catch`），不写 fd2；`src/main.ts:361` 的 `writeToTty` 改为调用它。
- 不再存在「未守卫 → 诊断写终端」这条路径。

### R2 守卫改由 shim 承担（I4）

- 新增 `bin/nano`（`#!/bin/sh`，`chmod +x`），`package.json` 的 `bin.nano` 指向它：

```sh
#!/bin/sh
root=${NANO_DATA_ROOT:-$HOME/.dsh-tui-nano}
for a in "$@"; do
  case "$a" in --help|-h|--version|-v|purge|--purge) exec node "$(dirname "$0")/../dist/bin.js" "$@" ;; esac
done
mkdir -p "$root/logs"
NANO_LOG_FILE="$root/logs/nano-$(date +%Y%m%dT%H%M%S)-$$.log"
export NANO_LOG_FILE
exec node "$(dirname "$0")/../dist/bin.js" "$@" >>"$NANO_LOG_FILE" 2>&1
```

- **非 TUI 命令原样透传**：`--help` / `--version` 的输出去 stdout；`purge` 不会把日志目录删掉后还往里写。
- **parity 测试**：`tests/unit/bin-shim.test.ts` 读 shim 与 `src/boot/cli.ts`，断言两份「plain 命令」清单一致（防 drift）。
- 删除 `src/runtime/fd-guard.ts` 全文、`src/bin.ts` 的 re-exec 分支、`GUARD_ENV` / `isGuarded()` / `NANO_GUARDED` 的一切引用（含 `docs/evidence/.../drive.mjs` 的相关判断）。

### R3 单一退出漏斗（I3）

`src/runtime/exit.ts`：

```ts
export function exit(code: number, reason: string): void {
  try {
    restoreTerminalOnce()          // 幂等；I2
    writeDiagnostic(`nano: 退出（${reason}，code=${code}）`)
    process.exit(code)
  } catch (error) {
    if (process.env.NODE_ENV === 'test') throw error
    try { process.kill(process.pid, 'SIGKILL') } catch { /* 已退出 */ }
  }
}
```

- **所有**退出点改调它：`src/bin.ts`（正常 / catch）、`src/main.ts:152`（启动期信号）、`nano-app` 的 finish、信号处理、硬超时。
- **可机检**：`grep -rn "process\.exit(" src` 只允许命中 `src/runtime/exit.ts`。
- `uncaughtException` / `unhandledRejection`：`writeDiagnostic` 记一行 → 走既有 `shutdown` → `exit(1)`；同进程内连发 4 次直接 `exit(70)`。

### R4 终端状态机 + 归还优先（I2）

- `TtyState: 'ok' | 'lost'`，**唯一探测者**是 30s 巡检（`ppid === 1` 或 `/dev/tty` 零写抛 EIO，两者均实测有效）；关停一开始就 `clearInterval`，此后不再探测。
- **`shutdown()` 第一件事是 `terminal.restore()`**（当前排在 lifecycle 最后一相），随后才跑 drain/flush/release；lifecycle 的 `restore` 相保留为幂等兜底。
- 预算收敛成两个，含义清楚：
  - `RESTORE_BUDGET_MS = 3000`：3s 还没归还就再 `restore()` 一次并记一行。
  - `SHUTDOWN_BUDGET_MS = max(5000, TOTAL_BUDGET_MS + 3500) = 13_500`：`requestShutdown` **永不 settle** 时的最后保险，`unref()`。
  - 两个定时器都要 `clearTimeout`；`TOTAL_BUDGET_MS` 由 `src/runtime/lifecycle.ts:49` 改 `export const`（**值不变**）。
- `stopping` 之后 `SIGTERM`/`SIGHUP` 只记一行、不升级 force（force 只留给 SIGINT 第二击）。

### R5 不引入新依赖 / 不扩平台

只用 `node:fs` / `node:process` 与 POSIX sh；不改依赖。`package.json` 建议补 `"os": ["darwin","linux"]`，让 Windows 安装时**显式失败**而不是装上一个跑不起来的 shim（§8 记为兼容性变更）。

### R6 可回归（两个方向都测）

- `tests/feature/exit-hardening.test.ts`（真 pty；无 `script` 或非 darwin 时 skip）：
  - **A（shim 路径）**：`script -q /dev/null ./bin/nano --root repro` → 挂断 → 8s 内消失，`logs/` 里出现 `关停` 记录。
  - **B（直跑，无保护）**：`script -q /dev/null node dist/bin.js --root repro` → 挂断 → 8s 内同样消失（sink 熔断 + 漏斗生效；这条正是事故形态）。
- `tests/unit/diagnostic.test.ts`：`writeSync` 抛 EIO 桩 → 100 次调用只试 1 次、不抛。
- `tests/unit/exit-funnel.test.ts`：`restore` 抛错时仍走到 `process.exit`；`process.exit` 抛错时降级 `SIGKILL`（mock，不真杀）。
- `tests/unit/bin-shim.test.ts`：shim 与 `cli.ts` 的 plain 清单 parity。
- `tests/unit/nano-app-shutdown.test.ts`：stub `requestShutdown` 永不 settle → 3s 断言 `restore()` 已调用、13.5s 断言 `exit()` 被调用；正向用例断言两个定时器被 clear。

## 5. 状态机（实现照这张表写，不照条款猜）

| 状态 | 谁进入 | 允许做什么 | 必须停止做什么 |
|---|---|---|---|
| `TtyState = ok` | 启动、`enter()` 成功 | 渲染、探测 | — |
| `TtyState = lost` | 巡检命中 | 只写 sink | 渲染、再探测 |
| `Shutdown = idle` | 运行中 | 一切 | — |
| `Shutdown = stopping` | 任一信号 / 异常 / 孤儿 | drain → flush → release（带预算） | 新渲染、新探测、接受第二次 force（除 SIGINT） |
| `Shutdown = done` | 漏斗执行 | — | 一切 |

## 6. 验收（全部可执行）

1. 用例 A、B 各 8s 内进程消失。
2. `grep -rn "process\.stderr\.write" src` 零命中；`grep -rn "process\.exit(" src` 只命中 `src/runtime/exit.ts`。
3. 用例 B 用 `--import` 预加载 `uncaughtExceptionMonitor`：整个生命周期未捕获异常 ≤ 1。
4. 正常路径不回归：Ctrl+C 退 0；`nano --version` 打到 stdout；`nano purge` 能删掉数据根（不被自己的日志 fd 占住）。
5. 关停卡死单测（stub `requestShutdown`）→ 3s restore、13.5s exit。
6. shim parity 测试通过。
7. `npm run typecheck && npm run lint && npm run build && npm test` 全绿。

## 7. 对 ADR 的影响

| 现行 ADR | 处置 |
|---|---|
| [ADR-20261029-single-process-fd-guard](../../decisions/2026-10-29-single-process-fd-guard.md) | **被取代**：launcher re-exec / `NANO_GUARDED` / 3s 强制恢复三条由 shim + 漏斗 + 两预算替代；「终端单写入者」「150ms 信号去重」保留 |
| ADR-20261103-exit-failsafe（前一版新增，未合并） | 删除，内容并入 ADR-20261103-single-process-exit |

## 8. 迁移 / 回滚 / 兼容 / 风险

- **迁移**：无数据变更。历史 `logs/` 不受影响；`NANO_GUARDED` 彻底消失，仓内唯一消费方 `drive.mjs` 同步删除该判断。
- **回滚**：`git revert` 单个 PR。shim 是新增文件，`bin` 一行即可改回 `dist/bin.js`。
- **兼容**：
  - `--version` / `--help` / `purge` 行为不变（shim 透传）。
  - 退出码：信号仍 0；新增 70（连发 4 次未捕获）；**不再有 129**（launcher 已消失）。
  - 日志命名 `nano-<ts>-<pid>.log` 保留，`NANO_LOG_FILE` 仍由启动方提供。
- **风险（如实）**：
  1. shim 与 `cli.ts` 的 plain 清单会 drift → parity 测试锁。
  2. 直跑 `node dist/bin.js` 失去 fd 守护 → 开发态可接受；用例 B 保证仍不会挂死。
  3. shim 复制了两行日志目录解析 → parity 测试 + 只依赖 `NANO_DATA_ROOT` / `$HOME`。

## 9. 自定细节

- shim 用 `date +%Y%m%dT%H%M%S` + `$$` 生成日志名，与现有 `nano-<ISO>-<pid>.log` 的差异记在 §8（保留可读性，不追求逐字一致）。
- `writeVisible` 只写 `/dev/tty`，打不开时静默。
- 漏斗的 `restoreTerminalOnce()` 复用 `terminal.restore()` 的幂等性，不新造状态。
- `TOTAL_BUDGET_MS` 只改导出、不改值；分段预算一律不动。
- 顺带清理：`src/bin.ts` 顶部解释 re-exec 的注释随代码删除。

## 10. 审核修订记录

本版是对前三版的**重写**。前三版的具体发现（第 1 轮 13 条、第 2 轮 12 条、第 3 轮 12 条）不再逐条回填——共同根因已归到 §2 的四类，由 I1–I4 与 R1–R6 整体覆盖；完整清单保留在 PR #165 的评论里供对照。
