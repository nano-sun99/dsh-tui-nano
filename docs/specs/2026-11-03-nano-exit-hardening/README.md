# [2026-11-03-nano-exit-hardening] 退出与终端生命周期：四条不变量（v5 · 进程内 sink）

- 组标识：`2026-11-03-nano-exit-hardening`
- 角色：单份 spec
- 状态：**实施版 v5**，待复核/过闸
- Issue：[#164](https://github.com/nano-sun99/dsh-tui-nano/issues/164)
- 版本沿革：v1–v3「症状 → 对策」→ v4 四条不变量 + sh shim → **v5 去掉 shim，守卫搬进进程内**（依据：第四轮重审的两条高，见 §8）
- 上游：
  - 事故与实测：issue #164（83 分钟 100% CPU；4 秒复现；107,244 次未捕获异常）
  - Claude Code 2.1.88（本机归档 `…/ClaudeCode/src`）——**本版的主参照**，逐条见 §9
- ADR 检索：「退出 / 退出码 / 信号 / SIGHUP / 孤儿 / stderr / 关停 / fd / 守卫 / 进程模型」
  - 取代 [ADR-20261029-single-process-fd-guard](../../decisions/2026-10-29-single-process-fd-guard.md) 的两条：launcher re-exec、3s 强制恢复定时器；保留「终端单写入者」「150ms 信号去重」
- ADR：[ADR-20261103-single-process-exit](../../decisions/2026-11-03-single-process-exit.md)（v5 同步改写）
- 合入前提：`typecheck` / `lint` / `build` / `npm test` 全绿；§7 的 pty 回归跑过。文档检查：本仓无入口。

## 1. 四条不变量

| # | 不变量 | 反例（本仓真实发生过） |
|---|---|---|
| **I1** | 诊断只写**进程内打开的日志文件**，永不依赖终端或 fd 1/2 的存活 | 同一条 `process.stderr`：守卫时是日志、未守卫时是终端；终端一断写失败抛错，又落回同一行写 → 自激 107,244 次 |
| **I2** | 终端归还先于一切异步收尾；终端可用性是一等状态，只有一个探测者 | `restore` 排在 lifecycle 最后一相；3s 与 13.5s 两个预算互相打架 |
| **I3** | 进程只有一个退出漏斗，任何路径都经过它，漏斗自己不会被异常穿透 | `bin.ts:55/65/68/72`、`main.ts:152`、nano-app finish、硬超时五条路径各写各的 |
| **I4** | 能写到屏幕的只有 `Terminal.write`（走 `/dev/tty`）；其余 JS 写一律改道 | 库直写 stdout / stderr 落进 alt-screen，或干脆落进终端 |

## 2. 事故与关键实测（不重复推导）

| 事实 | 值 |
|---|---|
| 事故进程 | 无守卫实例，fd 0/1/2 全 revoked，83 分 20 秒吃满一核 |
| 复现 | 4 秒；`uncaughtExceptionMonitor` 抓到 **107,244 次**未捕获异常 |
| 首条栈 | `writeDiagnostic → stderr.write → EIO → onUncaught → writeDiagnostic` |
| pty 挂断后 | `ppid` 立即变 1；`writeSync(2)` 与 `/dev/tty` 零写均抛 EIO；`stdout.writable`/`stdin.readable` 恒 true |
| 守卫路径（旧双进程） | 挂断后 19ms 干净退出 —— 说明关停逻辑本身没问题 |

## 3. 目标架构（单进程）

```
node dist/bin.js                      ← bin 就是它，没有 shim、没有 re-exec
  ├─ 启动   openSink()  → ~/.dsh-tui-nano/logs/nano-<ts>-<pid>.log（0600）
  ├─ 改道   installWriteRedirect()：process.stdout/stderr.write + console.* → sink
  ├─ 渲染   Terminal.write → /dev/tty        （唯一能到屏幕的路径）
  └─ 退出   exit(code, reason, hooks)        （唯一出口）
```

`fd-guard.ts`、`GUARD_ENV`、`isGuarded()`、re-exec 分支、`bin/nano` shim **全部删除**；`package.json` 的 `bin` 保持 `dist/bin.js`（`scripts/prepack-check.mjs` 的断言因此无需改动）。

## 4. 需求规格

### R1 进程内 sink（I1）

`src/runtime/sink.ts`：

```ts
let fd: number | null = null
let dead = false
let redirectOff: (() => void) | null = null

export function openSink(path: string): void {
  try { fd = openSync(path, 'a', 0o600) } catch { fd = null }   // 打不开就静默降级
}
export function writeDiagnostic(line: string): void {
  if (dead || fd === null) return
  try { writeSync(fd, line.endsWith('\n') ? line : `${line}\n`) } catch { dead = true }
}
export function isSinkDead(): boolean { return dead }

/** 唯一允许上屏的写：stderr 改道后的兜底 + /dev/tty；两路都不抛。 */
export function writeVisible(text: string): void {
  writeDiagnostic(text)                       // 无控制终端时至少日志里有
  try { const t = openSync('/dev/tty', 'w'); try { writeSync(t, text) } finally { closeSync(t) } }
  catch { /* 没有 ctty：静默 */ }
}
```

- **改道**：`installWriteRedirect()` 把 `process.stdout.write`、`process.stderr.write`、`console.log/info/debug/…`、`console.error/warn/trace` 指到 `writeDiagnostic`，并把原文前缀成 `[stdout]` / `[stderr]` / `[console]`。带**重入保护**（sink 内部写不再走 patch）；返回 `redirectOff()` 供测试还原。
- **只在 TUI 路径安装**：`--version` / `--help` / `purge` 不装改道，输出照旧走真 stdout —— 这一层判定留在 JS（`src/bin.ts:20-22` 的 `plain`），**不复制进任何脚本**。
- 可机检：`grep -rn "process\.stdout\.write\|process\.stderr\.write" src` 只允许命中 `src/runtime/sink.ts`（保存原函数那一处）。

### R2 单一退出漏斗（I3）

`src/runtime/exit.ts`：

```ts
export interface ExitHooks { restore?: () => void; release?: () => void }

export function exit(code: number, reason: string, hooks: ExitHooks = {}): void {
  try { hooks.restore?.() } catch { /* 终端没了 */ }
  try { hooks.release?.() } catch { /* 认领释放失败不拦退出 */ }
  writeDiagnostic(`nano: 退出（${reason}，code=${code}）`)
  try { process.exit(code) } catch (error) {
    if (process.env.NODE_ENV === 'test') throw error
    try { process.kill(process.pid, 'SIGKILL') } catch { /* 已退出 */ }
  }
}
```

- **收敛全部站点**：`src/bin.ts:55`（Node 版本过低）、`:65`（正常）、`:68`（`main` 返回）、`:72`（顶层 catch）、`src/main.ts:152`（启动期信号）、`nano-app` 的 finish、信号处理、硬超时。
- `restore` / `release` 由调用方以 hook 传入（`exit.ts` 不认识 `NanoApp`），所以「漏斗拿不到 terminal」这个坑不存在。
- 可机检：`grep -rn "process\.exit(" src` 只命中 `src/runtime/exit.ts`。
- `uncaughtException` / `unhandledRejection`：`writeDiagnostic` 记一行 → 走既有 `shutdown` → `exit(1)`；同进程连发 4 次直接 `exit(70)`。

### R3 终端归还优先 + 两个预算收敛成一个（I2）

- `shutdown()` **第一件事**就是 `terminal.restore()`（当前排在 lifecycle 最末相），随后才 drain/flush/release；lifecycle 的 `restore` 相保留为幂等兜底（`terminal.ts:81` 的 `if (!this.active) return` 保证两次 restore 安全）。
- **只保留一个预算**：`SHUTDOWN_BUDGET_MS = max(5000, TOTAL_BUDGET_MS + 3500) = 13_500`，`unref()`；到点调 `exit(exitCode || 1, 'fuse', { restore, release })`。
  - v4 里那个 `RESTORE_BUDGET_MS = 3000` **删掉**：第一次 restore 是同步的，定时器永远触发不了（第四轮审核 #10）。
  - `TOTAL_BUDGET_MS` 由 `src/runtime/lifecycle.ts:49` 改 `export const`（**值不变**）。
- **保险丝路径也要 release**：通过 `hooks.release` 传进去，避免锁留盘导致下次启动报「上次异常退出」（审核 #11）。
- `stopping` 之后 `SIGTERM`/`SIGHUP` 只记一行、不升级 force；force 只留给 SIGINT 第二击。

### R4 孤儿巡检（CC 没覆盖，我们自研）

- 启动时快照 `startPpid`；`setInterval(30_000).unref()` 里判断 `startPpid !== 1 && process.ppid === 1`。
- 另加一次 `/dev/tty` 零写探测（实测抛 EIO）；`terminal.ttyFd === undefined` 时跳过探测，只用 `ppid`。
- 命中 → `writeDiagnostic('nano: 终端失联')` → 走既有 `shutdown`（不另起捷径）。
- 关停一开始就 `clearInterval`（放在 `shutdown()` 开头），`removeProcessListeners()` 再兜一次。
- `Terminal` 新增只读 `get ttyFd(): number | undefined`（`src/runtime/terminal.ts:27` 的 `private fd`；`:54` 才赋值）。

### R5 不引入新依赖

只用 `node:fs` / `node:process`；不改 `package.json` 依赖与 `bin`；`engines` 不动；`os` 字段**不加**（CC 也没加；它不解决任何问题，见审核 #14）。

### R6 可回归

- `tests/feature/exit-hardening.test.ts`（真 pty；无 `script` 或非 darwin 时 `skip`，**但 skip 必须打印原因，且 CI 里 skip 不算通过**）：
  - **A（TUI 正常路径）**：`script -q /dev/null node dist/bin.js --root repro`，`NANO_DATA_ROOT=<tmp>`；等 3s 后 `kill -9` 掉 `script` 进程（这就是「挂断」的**定义**：pty 主端消失，内核向会话首领发 SIGHUP）；断言 ≤8s 消失、`<tmp>/logs/*.log` 里有 `关停`。
  - **B（保险丝路径）**：`NANO_TEST_STALL_SHUTDOWN=1` 时 `requestShutdown` 返回永不 settle 的 Promise；断言 ≤14s 消失且日志有 `fuse`。
- `tests/unit/sink.test.ts`：`writeSync` 抛 EIO 桩 → 100 次只试 1 次、不抛；`writeVisible` 在无 ctty 时不抛。
- `tests/unit/exit-funnel.test.ts`：`restore` / `release` 抛错时仍走到 `process.exit`；`process.exit` 抛错时降级 `SIGKILL`（mock，不真杀）。
- `tests/unit/redirect.test.ts`：装改道后 `console.log` 不落到 fd1（用临时 fd 替身），`redirectOff()` 能还原；重入不递归。
- `tests/unit/nano-app-shutdown.test.ts`：3s 时 `restore()` 已被调用（同步，无需定时器）；13.5s 时 `exit()` 被调且带 `release`。

## 5. 机制清单

| ID | 机制 | 解决什么 | 没有会怎样 |
|---|---|---|---|
| M1 | 进程内 sink（`openSink` + `writeDiagnostic` 熔断） | 诊断不再依赖终端/fd 存活 | 终端一断就自激，一条核烧 83 分钟（本次事故） |
| M2 | 写改道（stdout/stderr/console → sink，带重入保护） | 第三方库写不进 alt-screen | 屏幕上出现杂散文本、逐帧污染 |
| M3 | 单一退出漏斗（`exit` + restore/release hooks + SIGKILL 兜底） | 五条退出路径合成一条，收尾不会被异常穿透 | 有的路径不还原终端、有的不释放认领、有的挂死 |
| M4 | 关停硬上限（13.5s `exit('fuse')`） | `requestShutdown` 永不 settle 时仍有终点 | 关停卡住只能人工 `kill -9` |
| M5 | 孤儿巡检（`ppid` 快照 + `/dev/tty` 零写，30s） | 覆盖「没有 SIGHUP 也失联」「父进程先死」 | 静默失联要等到下一次异常才可能退出（CC 至今没覆盖这条） |
| M6 | 未捕获异常计数保险（>3 → `exit(70)`） | 防处理器自身重入 | 即使写不抛，处理器也可能互相触发 |

## 6. 状态与字段（每条都有写者与读侧）

| 字段 | 类型 | 写者 | 读侧 |
|---|---|---|---|
| `sinkFd` | `number \| null` | `openSink` | `writeDiagnostic` |
| `sinkDead` | `boolean` | `writeDiagnostic` 的 catch | `isSinkDead()`（诊断 + 测试） |
| `redirectOff` | `(() => void) \| null` | `installWriteRedirect` | 关停时调用、测试还原 |
| `stopping` | `boolean` | `shutdown()` | `handleInput`、信号处理、巡检（早退） |
| `uncaughtCount` | `number` | `onUncaught` | `exit(70)` 判定、`getUncaughtCount()` |
| `startPpid` | `number` | 启动时快照 | 巡检 |

## 7. 验收

1. `grep -rn "process\.stdout\.write\|process\.stderr\.write" src` 只命中 `src/runtime/sink.ts`。
2. `grep -rn "process\.exit(" src` 只命中 `src/runtime/exit.ts`。
3. 用例 A ≤8s 消失、日志有 `关停`；用例 B ≤14s 消失、日志有 `fuse`。
4. `nano --version` 打到 stdout（不装改道）；`nano purge` 正常（不装改道，无日志 fd 指向被删目录的问题）。
5. TUI 里 `console.log('x')` 不上屏，日志出现 `[stdout] x`。
6. sink 打不开（`NANO_DATA_ROOT` 指向不可写目录）时进程照常启动、不抛。
7. 关停卡死单测：13.5s `exit()` 被调且带 `release`；正常路径定时器被 clear。
8. `npm run typecheck && npm run lint && npm run build && npm test` 全绿。

## 8. 为什么 v4 的 shim 被推翻

| 发现（第四轮重审） | 后果 |
|---|---|
| npm 把 `bin` 装成**符号链接**，`dirname "$0"` 指到安装前缀 | `npm i -g` 后敲 `nano`：空白 + 退出 1 |
| `prepack-check.mjs:59` 硬断言 `bin === 'dist/bin.js'` | `npm publish` 直接失败 |
| shim 的 `for a in "$@"` 不剥带值参数 | `nano --root purge`（会话 id）被判成 plain → 跳过守卫 |
| `exec node` 走 PATH；`mkdir`/`>>` 不带 mode；启动错误全被 `2>&1` 吞 | 127 无提示、日志权限 0644、Node 版本提示消失 |

四类问题的共同点是**把判定搬到了 sh 里**；v5 把判定收回 JS，`bin` 不动，四个问题一起不存在。

## 9. 照抄 CC 的 / 我们自研的（本 spec 的取舍表）

### 9.1 直接抄（CC 已验证）

| # | CC 的做法 | 出处 | 我们怎么用 |
|---|---|---|---|
| C1 | 诊断写文件，双层 try/catch，失败静默 | `utils/diagLogs.ts:44-60` | M1 |
| C2 | patch `process.stderr.write`，文本转日志并吞掉写，带重入保护 | `ink/ink.tsx:1605-1642` | M2（**并额外 patch stdout**，因为 nano 渲染走 `/dev/tty` 不走 stdout） |
| C3 | patch `console.*` → 调试日志 | `ink/ink.tsx:1570-1590` | M2 |
| C4 | `process.exit` 抛 EIO 时降级 `SIGKILL`；test 环境先 rethrow | `utils/gracefulShutdown.ts:193-232` | M3 |
| C5 | 终端归还排在关停第一件事 | `:436` | R3 |
| C6 | failsafe 预算跟着内部预算缩放（`max(5000, …+3500)`） | `:417-426` | M4 |

### 9.2 CC 没解决，我们的方案

| # | 场景 | CC 的状态 | 我们的方案 | 代价 |
|---|---|---|---|---|
| O1 | **真孤儿**：父进程/shell 先死、终端还在 | **完全未覆盖**（全仓无 `ppid` 存活判定；`isProcessRunning(pid≤1)` 这个现成判据只用来挑 IDE） | 30s 巡检 `ppid` 快照比对（M5） | 最坏 30s 空转；容器里 PID 1 启动需靠快照基线排除 |
| O2 | **终端失联但无 SIGHUP** | 只靠 30s 轮询 `stdout.writable`/`stdin.readable`（Node 语义下恒真，实测） | 换判据：`ppid` + `/dev/tty` 零写探测（实测抛 EIO） | 需要 `ttyFd` getter |
| O3 | **未捕获异常处理器自身抛错** | 部分：`error.message.slice` 对非 Error 会抛；handler 只记日志**不退出**，进程带病继续跑 | sink 不抛 + 计数保险（M6）+ 处理器内也走关停 | 多一个计数器 |
| O4 | **事件循环被同步阻塞**（native 卡死、同步 fs 打满） | **未覆盖**：failsafe 与 SIGKILL 都在同一循环里 | **本版不解决**，只留痕：sink 记「关停开始」与最后一条进度；如需硬保证，后续单独开单用 `worker_threads` 看门狗（心跳 5s 未更新 → `process.kill(pid,'SIGKILL')`） | 现在承认这个洞，不做假承诺 |
| O5 | **关停期间重复信号会砍断 flush** | CC 的 `shutdownInProgress` 直接吞掉后续信号 | SIGINT 第二击才 force；SIGTERM/SIGHUP 只记一行（**有意与 CC 不同**） | 与 CC 行为有差异，需在 ADR 记 |

## 10. 迁移 / 回滚 / 兼容 / 风险

- **迁移**：无数据变更。`NANO_GUARDED` 彻底消失（仓内两个消费方：`docs/evidence/.../drive.mjs` 的判断删除；`src/main.ts:250-255 relaunchInto` 不再需要特殊处理——受控重启只是一个普通 spawn，子进程自己 `openSink`）。`NANO_LOG_FILE` 无消费方，从契约里删掉。
- **回滚**：`git revert` 单个 PR；`bin` 前缀未动，无安装侧影响。
- **兼容**：`--version` / `--help` / `purge` 行为与退出码不变；信号仍退 0；新增 70（连发 4 次）；日志文件名沿用 `nano-<ts>-<pid>.log`。
- **风险**：① 改道只覆盖 JS 层，native 直写 fd1 拦不住（CC 同样放弃；phase-0 实测 0 次）。② 同步阻塞卡死仍是洞（O4，已明说）。③ 巡检 30s 粒度（O1）。

## 11. 自定细节

- sink 文件权限 `0600`、目录 `0700`（与仓内其它落盘点一致）。
- 改道只在 TUI 路径安装；`plain` 判定沿用 `src/bin.ts:20-22`，不新增副本。
- `writeVisible` 双写（sink + `/dev/tty`），无 ctty 时只剩 sink —— 不再出现「消息全丢」。
- 漏斗的 `restore` 复用 `terminal.restore()` 的幂等性；`release` 复用现有 `releaseMountClaim`。
- 删掉 `RESTORE_BUDGET_MS`（同步 restore 使其永远不触发）。
- 验收 4 里不再保留「purge 不被自己的日志 fd 占住」的说法（macOS 上 open 的文件本就能删，那是 Windows 才有的问题）。

## 12. 审核修订记录

本轮（第四轮重审）共 2 份结论：规格符合性 21 条（含硬性缺项「机制清单」）、对抗 14 条（含 2 高：npm 符号链接、prepack 断言）。

处置：**结构性改法（v5）覆盖了绝大多数**——机制清单已补（§5）、shim 相关的 5 条（符号链接 / prepack / PATH / umask / argv 误判）随 shim 一起消失、NANO_LOG_FILE 与 relaunchInto 的连带问题一并消解；逐条落在 R1–R6 与 §10：漏斗 hook 化、`bin.ts:55/65/68/72` 站点补齐、`writeVisible` 保留 stderr 一路、`RESTORE_BUDGET_MS` 删除、保险丝带 release、8s / 14s 分开断言、`os` 字段不加、`terminal.ts` 行号改 `:54`/`:124`、purge 括号删除。
