# [2026-11-03-nano-exit-hardening] 退出与终端生命周期：五条不变量（v7 · 进程内 sink）

- 组标识：`2026-11-03-nano-exit-hardening`
- 角色：单份 spec
- 状态：**实施版 v7**，待复核/过闸
- Issue：[#164](https://github.com/nano-sun99/dsh-tui-nano/issues/164)
- 版本沿革：v1–v3「症状 → 对策」→ v4 四条不变量 + sh shim → v5 去掉 shim、守卫搬进进程内（依据：第四轮重审的两条高，见 §8）→ v6 加入 I5：终端写不可阻塞（依据：pty 缓冲实测，见 §2 末行）→ **v7 按第五轮轻审修订：区分可丢与必达的写、删掉第二条上屏通道、补齐 errno 与状态机**
- 上游：
  - 事故与实测：issue #164（83 分钟 100% CPU；4 秒复现；107,244 次未捕获异常）
  - Claude Code 2.1.88（本机归档 `…/ClaudeCode/src`）——**本版的主参照**，逐条见 §9
- ADR 检索：「退出 / 退出码 / 信号 / SIGHUP / 孤儿 / stderr / 关停 / fd / 守卫 / 进程模型」
  - 取代 [ADR-20261029-single-process-fd-guard](../../decisions/2026-10-29-single-process-fd-guard.md) 的两条：launcher re-exec、3s 强制恢复定时器；保留「终端单写入者」「150ms 信号去重」
- ADR：[ADR-20261103-single-process-exit](../../decisions/2026-11-03-single-process-exit.md)（v5 同步改写）
- 合入前提：`typecheck` / `lint` / `build` / `npm test` 全绿；§7 的 pty 回归跑过。文档检查：本仓无入口。

## 1. 五条不变量

| # | 不变量 | 反例（本仓真实发生过） |
|---|---|---|
| **I1** | 诊断只写**进程内打开的日志文件**，永不依赖终端或 fd 1/2 的存活 | 同一条 `process.stderr`：守卫时是日志、未守卫时是终端；终端一断写失败抛错，又落回同一行写 → 自激 107,244 次 |
| **I2** | 终端归还先于一切异步收尾；终端可用性是一等状态，只有一个探测者 | `restore` 排在 lifecycle 最后一相；3s 与 13.5s 两个预算互相打架 |
| **I3** | 进程只有一个退出漏斗，任何路径都经过它，漏斗自己不会被异常穿透 | `bin.ts:55/65/68/72`、`main.ts:152`、nano-app finish、硬超时五条路径各写各的 |
| **I4** | 能写到屏幕的只有 `Terminal.write`（走 `/dev/tty`）；其余 JS 写一律改道 | 库直写 stdout / stderr 落进 alt-screen，或干脆落进终端 |
| **I5** | 任何**终端写**都不许阻塞事件循环 | `/dev/tty` 阻塞写把整个进程按死（0% CPU），此时**所有**进程内定时器都失效，13.5s 保险丝也救不了（`execFileSync('stty'/'pbcopy')` 是同类残余，记在 §9.2 O4，本版不改） |

## 2. 事故与关键实测（不重复推导）

| 事实 | 值 |
|---|---|
| 事故进程 | 无守卫实例，fd 0/1/2 全 revoked，83 分 20 秒吃满一核 |
| 复现 | 4 秒；`uncaughtExceptionMonitor` 抓到 **107,244 次**未捕获异常 |
| 首条栈 | `writeDiagnostic → stderr.write → EIO → onUncaught → writeDiagnostic` |
| pty 挂断后 | `ppid` 立即变 1；`writeSync(2)` 与 `/dev/tty` 零写均抛 EIO；`stdout.writable`/`stdin.readable` 恒 true |
| 守卫路径（旧双进程） | 挂断后 19ms 干净退出 —— 说明关停逻辑本身没问题 |
| **pty 缓冲（2026-11-03 实测）** | macOS pty 缓冲只有 **1024 字节**：阻塞模式下 64KB 的第一笔写**永不返回**（1.5s 后仍 0% CPU 卡死）；`O_NONBLOCK` 下第一次写 1024 字节（部分写）、第二次抛 `EAGAIN` 立即返回 |

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

/** 需要让人看见的文本：先进 sink，再由 Terminal 送出（**不另开 /dev/tty**）。 */
export function writeVisible(text: string): void {
  writeDiagnostic(text)                       // 无终端时至少日志里有
  terminal?.write(text, 'lifecycle')          // 复用唯一上屏通道；未 enter 时 terminal 为 undefined
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

### R3b 终端写不可阻塞，且**可丢的与必达的分开**（I5）

`Terminal.enter()` 用 `openSync('/dev/tty', constants.O_RDWR | constants.O_NONBLOCK)` 打开渲染句柄（现在是无 flag 的 `'r+'`，`src/runtime/terminal.ts:54`）。

**写分两类**，`write(bytes, kind: 'frame' | 'lifecycle')`：

| kind | 内容 | `EAGAIN` 时 |
|---|---|---|
| `frame` | 渲染帧 | **丢弃本帧剩余**，置 `frameDropped`/`streamTruncated`，下一帧全量重绘 |
| `lifecycle` | 归还序列、探测序列、`writeVisible` 文本 | **逐条独立重试**（见下），一条丢也只丢一条 |

**必达清单（`restore()` 的 7 条，必须逐条写、各自重发）**：`deleteActivityImage`(APC) / `disableKittyKeyboard` / `disableFocusReporting` / `disableBracketedPaste` / `disableMouse`×3 / `showCursor` / `leaveAltScreen`。理由：现在这 7 条是**一次** `write()` 送出去的（`terminal.ts:89-97`），部分写丢的是**尾巴**，最先丢的正是 `showCursor` + `leaveAltScreen`；而且 `restore()` 先把 `active=false`（`:83`）再写，嵌套 `restore()` 直接 no-op，第二次机会也没有。

**有界重试（不阻塞、不引 native）**：每条 lifecycle 序列独立状态机——`EAGAIN` → `setImmediate` 下一轮重试，总预算 300ms（远小于 13.5s）。**不采用「临时清掉 `O_NONBLOCK` 改成阻塞写」**：Node 没有 `fcntl`，清标志只能加 native 依赖，违反 R5。
**排空优先**：第一次 `EAGAIN` 出现即置 `rendererSuspended = true`，暂停一切 `frame` 写，把缓冲让给 `lifecycle`。
**幂等判据**：`restore()` 的幂等性从「被调用过」改成「**序列已送达**」——`restoreDelivered` 为真才算归还完成，lifecycle 的 `restore` 兜底相因此才有意义。
**兜不住怎么办**：300ms 内仍送不出去，落 `ttyRestoreFailed`；下次启动复用现有那句「检测到上次异常退出…请运行 reset」（`main.ts:174`），不新增用户可见文案。

**errno 分类（写死，不要临场判断）**：

| 类别 | 错误码 | 动作 |
|---|---|---|
| 可重试 | `EAGAIN` / `EWOULDBLOCK` / `EINTR` | `frame` 丢帧；`lifecycle` 有界重试 |
| 判失联 | `EIO` / `ENXIO` / `ENODEV` / `EBADF` / `EPIPE` | `ttyState = lost`，走 R4 关停 |
| 其它（含 `ENOTTY`、未知 errno） | — | 丢帧 + 首次记一行诊断，不改状态 |

三态：**`alive` / `degraded`（在丢帧）/ `lost`**。**`EAGAIN` 永不导致 `lost`** —— Ctrl+S（XOFF）会让健康终端持续 `EAGAIN`，按丢帧判失联会误关停。

**两条硬约束**：① 循环里 `const n = writeSync(...)`，**`n <= 0` 一律按 `EAGAIN` 处理**（否则 `offset` 不前进 = 死循环 100% CPU，正是本事故的另一半形态）；② `probeGraphics()` 的探测序列属于 `lifecycle`，失败置 `probePending`、在下一次成功写之后重发（探测幂等，400ms 判据不变）——否则能力被误判为「不支持」，活动图静默消失。

**流恢复**：部分写会留下**半截转义序列**，下一帧仍会从半截处被解释（`osc52` 以 BEL 结尾，截断后终端会吞字节到下一个 BEL）。所以 `streamTruncated` 为真时，下一帧开头先发 `ESC\` + `ESC[0m`，再走 `renderer.invalidate()`（`renderer.ts:193`）做全量重绘。

**`enter()` 的顺序**（`terminal.ts:67` vs `:76`）：第一笔写发生在 `active=true` 之前，若命中 `EIO` 就地关停，`restore()` 会因为 `active===false` 直接返回（fd 不关、raw mode 不回滚），而 `enter()` 还会继续跑完。约定：**写失败只标记状态，关停由调用栈返回后统一执行**。

**为什么不是加看门狗**：阻塞入口是我们自己的同步写，去掉它比在另一个线程里补救便宜；看门狗对 D 状态（NFS hard mount）也无效。
**已知边界**：`writeDiagnostic` 仍用 `writeSync`（本地盘无碍，NFS 可能卡死）；`execFileSync('stty')`（每个 SIGWINCH）与 `pbcopy`（timeout 1000）也是同步阻塞，本版不改，记在 §9.2 O4。

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
| M7 | `/dev/tty` 非阻塞打开 + `EAGAIN` 丢帧 | 终端不消费时不再阻塞事件循环 | 一次写就能把进程按死到 0% CPU，保险丝全程无法触发 |

## 6. 状态与字段（每条都有写者与读侧）

| 字段 | 类型 | 写者 | 读侧 |
|---|---|---|---|
| `sinkFd` | `number \| null` | `openSink` | `writeDiagnostic` |
| `sinkDead` | `boolean` | `writeDiagnostic` 的 catch | `isSinkDead()`（诊断 + 测试） |
| `redirectOff` | `(() => void) \| null` | `installWriteRedirect` | 关停时调用、测试还原 |
| `stopping` | `boolean` | `shutdown()` | `handleInput`、信号处理、巡检（早退） |
| `uncaughtCount` | `number` | `onUncaught` | `exit(70)` 判定、`getUncaughtCount()` |
| `startPpid` | `number` | 启动时快照 | 巡检 |
| `ttyState` | `'alive' \| 'degraded' \| 'lost'` | `write` 的 errno 分类、巡检 | `write`（早退）、`shutdown`、诊断 |
| `ttyFd` | `number \| undefined` | `enter()` / `restore()` | `write`、巡检零写探测（**就是现有 `fd` 字段，不新造第二个名字**） |
| `frameDropped` | `boolean` | `write`（`EAGAIN`） | 渲染器：为真时下一帧走全量重绘，然后由 `renderer.invalidate()` 的调用方清零 |
| `streamTruncated` | `boolean` | `write`（部分写） | 渲染器：下一帧开头先补 `ESC\\` + `ESC[0m` |
| `rendererSuspended` | `boolean` | `write`（首次 `EAGAIN`） | 渲染器：为真时不再提交 `frame` 写 |
| `restoreDelivered` | `boolean` | `restore()` 的逐条重试 | `restore()` 幂等判据、lifecycle 兜底相 |
| `probePending` | `boolean` | `probeGraphics()` 失败 | 下次成功写之后重发探测 |

## 7. 验收

**可机检的静态断言**

1. `grep -rn "process\.stdout\.write\|process\.stderr\.write" src` 只命中 `src/runtime/sink.ts`。
2. `grep -rn "process\.exit(" src` 只命中 `src/runtime/exit.ts`。
3. `grep -rn "openSync('/dev/tty'" src` 只命中 `src/runtime/terminal.ts`（上屏通道只有一条）。

**单元测试（任何机器都真跑，不依赖 pty）**

4. `writeSync` 桩：部分写 → 下一次 `EAGAIN` → `frameDropped`/`streamTruncated` 置位、不抛；`EIO`/`ENXIO`/`ENODEV`/`EPIPE` → `ttyState = lost`；`EINTR` → 重试且**不**判失联；**返回 0 → 不进入死循环**（断言迭代次数上限）。
5. `restore()` 的 7 条序列逐条重试：注入「第 3 条第一次 `EAGAIN`、第二次成功」的桩 → 7 条全部送达且 `restoreDelivered === true`；注入「一直 `EAGAIN`」→ 300ms 内放弃并落 `ttyRestoreFailed`。
6. `exit()` 漏斗：`restore`/`release` 抛错时仍走到 `process.exit`；`process.exit` 抛错时降级 `SIGKILL`（mock，不真杀）。

**pty 集成（`npm run test:e2e`，用现成的 `tests/e2e/pty-start.py`，先给它加 `--no-read`）**

7. **用例 A（正常路径）**：`pty-start.py --no-read -- node dist/bin.js --root repro` + `NANO_DATA_ROOT=<tmp>`；前置断言（**先过这三条再谈结论**：子进程 pid 仍活、日志文件已创建、`NANO_TEST_HEARTBEAT_MS=200` 的心跳至少出现过一次）；然后 `kill -9` pty 宿主（挂断的定义：pty 主端消失，内核向会话首领发 SIGHUP）；断言 ≤8s 消失、日志有 `关停`。
8. **用例 B（保险丝）**：`NANO_TEST_STALL_SHUTDOWN=1`；断言 ≤14s 消失、日志有 `fuse`。
9. **用例 C（阻塞回归，反向）**：`NANO_TEST_TTY_FLAGS=blocking` + `NANO_TEST_FILL_BYTES=131072`（必须**主动灌满 >64KiB**，只靠 pty 那 1024B 缓冲造不出反压）；断言「子进程仍活着**且** 1.5s 内日志零增长」，随后 `SIGKILL` 收尾。同一用例去掉该开关时必须**日志持续增长**（证明 `O_NONBLOCK` 生效）。
10. pty 用例在 `NANO_REQUIRE_PTY=1` 时**不许 skip**：环境不满足要 `throw` 并说明原因（当前 `{ skip: '原因' }` 永远不会失败，等于没有执行者；本仓无 CI，发布前必须带该变量跑一次）。

**回归**

11. `nano --version` 打到 stdout（不装改道）；`nano purge` 正常。
12. TUI 里 `console.log('x')` 不上屏，日志出现 `[stdout] x`。
13. sink 打不开（`NANO_DATA_ROOT` 指向不可写目录）时进程照常启动、不抛。
14. `npm run typecheck && npm run lint && npm run build && npm test` 全绿。

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
| O4 | **事件循环被同步阻塞** | **未覆盖**：failsafe 与 SIGKILL 都在同一循环里 | **拆成两半**：①「终端写阻塞」是本仓自己能控制的主因，用 M7（`O_NONBLOCK` + 丢帧）根治；② 剩下的极端情形（NFS hard mount、native 卡死、`execFileSync('stty')` 每个 SIGWINCH 一次、`pbcopy` timeout 1000）**本版不解决**，只留痕（sink 记「关停开始」+ 最后进度）；如需硬保证，另开单用 `worker_threads` 看门狗（心跳 5s 未更新 → `process.kill(pid,'SIGKILL')`，对 D 状态仍无效） | 承认残余洞，不做假承诺 |
| O5 | **关停期间重复信号会砍断 flush** | CC 的 `shutdownInProgress` 直接吞掉后续信号 | SIGINT 第二击才 force；SIGTERM/SIGHUP 只记一行（**有意与 CC 不同**） | 与 CC 行为有差异，需在 ADR 记 |

## 10. 迁移 / 回滚 / 兼容 / 风险

- **迁移**：无数据变更。`NANO_GUARDED` 彻底消失（仓内两个消费方：`docs/evidence/.../drive.mjs` 的判断删除；`src/main.ts:250-255 relaunchInto` 不再需要特殊处理——受控重启只是一个普通 spawn，子进程自己 `openSink`）。`NANO_LOG_FILE` 无消费方，从契约里删掉。
- **回滚**：`git revert` 单个 PR；`bin` 前缀未动，无安装侧影响。
- **兼容**：`--version` / `--help` / `purge` 行为与退出码不变；信号仍退 0；新增 70（连发 4 次）；日志文件名沿用 `nano-<ts>-<pid>.log`。
- **风险**：① 改道只覆盖 JS 层，native 直写 fd1 拦不住（CC 同样放弃；phase-0 实测 0 次）。② 终端写阻塞由 M7 解决，但**日志写在 NFS 上仍可能卡死**（O4 残余）。③ 巡检 30s 粒度（O1）。④ `O_NONBLOCK` 下健康终端也可能出现部分写 → 靠现有的偏移量循环重试，极端情况下掉一帧。

### 改动面

| 文件 | 改什么 |
|---|---|
| `src/runtime/sink.ts`（新建） | `openSink`、`writeDiagnostic`、`writeVisible`、`installWriteRedirect` |
| `src/runtime/exit.ts`（新建） | `exit(code, reason, hooks)` 漏斗 |
| `src/runtime/terminal.ts` | `:54` 改 `O_RDWR\|O_NONBLOCK`；`write` 加 `kind` 与 errno 分类、`n <= 0` 守卫（`:124-131`）；7 条归还序列逐条重试（`:89-97`）；`enter()` 失败只标记状态（`:67` vs `:76`）；新增 `get ttyFd()`（`:27`） |
| `src/render/renderer.ts` | `RendererOptions.write` 带 `kind`（`:80`）；掉帧时调 `invalidate()`（`:193`）、补 `ESC\\` + `ESC[0m` |
| `src/render/activity-image.ts` | 探测序列归 `lifecycle`、失败置 `probePending` |
| `src/main.ts` | `:152` 早退信号改 `exit()`；`:361` `writeToTty` 改 `writeVisible`；7 处裸写改 `writeDiagnostic` |
| `src/bin.ts` | 删 re-exec 分支；`:55/65/68/72` 改 `exit()` |
| `src/app/nano-app.ts` | `:942` 起的 `shutdown` 先 `restore()`；`:1010-1015` 只留 13.5s 保险丝；`:258-273` 注册巡检；`:1028` `clearInterval` |
| `src/runtime/lifecycle.ts:49` | `export const TOTAL_BUDGET_MS`（值不变） |
| `src/runtime/fd-guard.ts` | **整删** |
| `tests/e2e/pty-start.py` | 加 `--no-read` 与 `NANO_TEST_FILL_BYTES` 灌字节 |
| `tests/unit/*`、`tests/e2e/exit-hardening.test.mjs` | §7 的 4–10 |
| `docs/evidence/2026-11-01-nano-question-card-parity/drive.mjs` | 删 `NANO_GUARDED` 判断 |

## 11. 自定细节

- sink 文件权限 `0600`、目录 `0700`（与仓内其它落盘点一致）。
- 改道只在 TUI 路径安装；`plain` 判定沿用 `src/bin.ts:20-22`，不新增副本。
- `writeVisible` 只写 sink + 复用 `Terminal.write(…, 'lifecycle')`；`Terminal` 未 enter（启动期）时只落 sink —— 不再有第二条上屏通道，也不再出现「消息全丢」。
- 漏斗的 `restore` 复用 `terminal.restore()` 的幂等性；`release` 复用现有 `releaseMountClaim`。
- 删掉 `RESTORE_BUDGET_MS`（同步 restore 使其永远不触发）。
- 验收 4 里不再保留「purge 不被自己的日志 fd 占住」的说法（macOS 上 open 的文件本就能删，那是 Windows 才有的问题）。
- `O_NONBLOCK` 只加在**渲染句柄**上；`process.stdin`（终端模拟器给的 fd）一律不动，避免影响输入。
- `frameDropped` 的读侧是渲染器：为真时下一帧走全量重绘，然后清零。

## 12. 审核修订记录

本轮（第四轮重审）共 2 份结论：规格符合性 21 条（含硬性缺项「机制清单」）、对抗 14 条（含 2 高：npm 符号链接、prepack 断言）。

处置：**结构性改法（v5）覆盖了绝大多数**——机制清单已补（§5）、shim 相关的 5 条（符号链接 / prepack / PATH / umask / argv 误判）随 shim 一起消失、NANO_LOG_FILE 与 relaunchInto 的连带问题一并消解；逐条落在 R1–R6 与 §10：漏斗 hook 化、`bin.ts:55/65/68/72` 站点补齐、`writeVisible` 保留 stderr 一路、`RESTORE_BUDGET_MS` 删除、保险丝带 release、8s / 14s 分开断言、`os` 字段不加、`terminal.ts` 行号改 `:54`/`:124`、purge 括号删除。

### v6（本轮追加）

| 来源 | 处置 |
|---|---|
| 用户提问「事件循环被同步阻塞有没有别的办法」+ 实测 | 新增 I5 / R3b / M7：`/dev/tty` 改 `O_NONBLOCK`，`EAGAIN` 丢帧、`EIO` 判失联；验收加「不读 master 的 pty」阻塞回归用例 |
| 依据 | Node 文档〈A note on process I/O〉：POSIX 上 tty 写是同步的；本机实测 pty 缓冲 1024 字节、阻塞写永不返回、`O_NONBLOCK` 下 `EAGAIN` 立即返回 |
| 残余 | 日志写（`writeSync`）在 NFS 上仍可能卡死；native 卡死无解 —— 均在 §9.2 O4 / §10 明写 |

### v7（第五轮轻审）

| # | 严重度 | 发现 | 处置 |
|---|---|---|---|
| 1 | 高 | `restore()` 的 7 条序列与渲染帧共用写函数，EAGAIN 丢尾巴 | R3b 重写：`write(kind)` 分 `frame`/`lifecycle`；7 条逐条重试（300ms 有界）；首次 EAGAIN 暂停渲染帧；幂等判据改「已送达」；兜不住落 `ttyRestoreFailed` 复用 reset 提示 |
| 2 | 高 | `writeVisible` 另开 `/dev/tty`、阻塞写，是第二条上屏通道 | 改为复用 `Terminal.write(…, 'lifecycle')`；I4/R1 措辞统一 |
| 3 | 中 | 探测序列被丢 → 能力误判 + APC 截断吞帧 | 探测归 `lifecycle`、失败置 `probePending` 重发；流恢复见 #4 |
| 4 | 中 | 缺半截转义序列的恢复 | 加 `streamTruncated`：下一帧先发 `ESC\` + `ESC[0m` 再 `invalidate()` |
| 5 | 中 | 状态机缺三态与字段读侧 | 定 `alive/degraded/lost`；**EAGAIN 永不判 lost**（XOFF）；§6 补 7 行；`ttyFd` 与 `fd` 合并为同一个 |
| 6 | 中 | errno 不全；`writeSync` 返回 0 会死循环 | 写死 errno 分类表；`n <= 0` 按 EAGAIN；`EINTR` 只重试不判失联 |
| 7 | 中 | 验收第 8 条造不满缓冲、无心跳、无反向断言 | 重写为「前置断言 + `NANO_TEST_FILL_BYTES` + 心跳 + `NANO_TEST_TTY_FLAGS=blocking` 反向用例」 |
| 8 | 中 | 本仓无 CI；已有 `pty-start.py` 更合适；`npm test` 不 build | 统一用 `pty-start.py --no-read`；`NANO_REQUIRE_PTY=1` 时 skip 改 throw；pty 用例放 `test:e2e` |
| 9 | 低 | §7 有两个「8.」 | 已重编号为 1–14 |
| 10 | 低 | 标题仍写「四条不变量」/v5 | 已改「五条」/v7；ADR 关联同步 |
| 11 | 低 | `execFileSync('stty')`/`pbcopy` 同样阻塞 | I5 收窄为「终端**写**」；残余记入 §9.2 O4 |
| 12 | 低 | `enter()` 首写在 `active=true` 之前 | R3b 明确「写失败只标记状态，关停由调用栈返回后统一执行」 |
