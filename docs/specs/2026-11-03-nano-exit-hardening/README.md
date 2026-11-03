# [2026-11-03-nano-exit-hardening] 诊断写失败不再自激，退出不留活口

- 组标识：`2026-11-03-nano-exit-hardening`
- 状态：**实施版（最小修复）**
- Issue：[#164](https://github.com/nano-sun99/dsh-tui-nano/issues/164)
- 本版说明：v1–v7 把「修这个 bug」和「重做终端生命周期」捆在一起，六轮审核仍未收敛（复盘见 [spec-flow#130](https://github.com/nano-sun99/spec-flow/issues/130)）。**v9 只保留修这个 bug 必需的部分**，其余整块挪走。

## 1. 问题与根因

终端挂断后，`process.stderr.write` 抛 `EIO`；`onUncaught` 里**又**调同一个写 → 再抛 → 自激。4 秒可复现，107,244 次未捕获异常，进程吃满一核 83 分钟不退（issue #164 有复现脚本与首条栈）。

自激的充要条件只有一个：**「报错」这个动作本身会抛，而它的落点又是它自己**。

## 2. 改什么（三处接线 + 一个文件，约 50 行）

### R1 诊断写永不抛

新建 `src/runtime/diagnostic.ts`：

```ts
import { writeSync } from 'node:fs'

let dead = false

/** 诊断唯一入口：任何情况下不抛。 */
export function writeDiagnostic(line: string): void {
  if (dead) return
  try {
    writeSync(2, line.endsWith('\n') ? line : `${line}\n`)   // 部分写可接受
  } catch (error) {
    // EAGAIN 只是这一行没写出去（终端读停），不熔断；其余视为通道已死
    if ((error as NodeJS.ErrnoException).code !== 'EAGAIN') dead = true
  }
}

/** 仅测试用：复位熔断状态。 */
export function resetDiagnosticForTest(): void { dead = false }
```

- 用 `writeSync` 而不是 `process.stderr.write`：流式写的失败可能以异步 `error` 事件逃出调用点，`try/catch` 抓不全。
- **三处接线**（缺任一条，自激环仍留一条尾巴）：
  1. `src/main.ts:214` 的 `writeDiagnostic` 注入 —— 覆盖 nano-app 的全部诊断，含 `onUncaught` 那条；
  2. `src/bin.ts:70` 顶层 `catch` —— 它现在先写 stderr 再 `exit(1)`，写抛了就执行不到 exit，直接落 Node 默认上报（事故栈正是在默认上报里自激）；
  3. `src/main.ts:361` 的 `writeToTty` 的 **stderr 那一路** —— 它在 main 的各 catch 与 `earlySignalHandler`（`:147-158`）里被调用，那个窗口 NanoApp 还没注册 `uncaughtException`。
- **不在本次范围**：`src/controls/feature-host.ts` 另有 7 处自己的 `writeDiagnostic` 注入。同形态，但不在这条事故栈上——留作后续单，不扩大本单。

### R2 退出不留活口

同文件：

```ts
export function forceExit(code: number): void {
  try {
    process.exit(code)
  } catch (error) {
    if (process.env.NODE_ENV === 'test') throw error
    try { process.kill(process.pid, 'SIGKILL') } catch { /* 已退出 */ }
  }
}
```

**接法（两条并行，不要二选一）**：

1. `src/app/nano-app.ts:1010` 的 forceTimer 回调里补 `forceExit(this.exitCode)`（现有回调只 `restore()` + 设 exitCode，**不退出**）。
2. `onUncaught` / `onUnhandledRejection`（`:277-287`）里把现有的 `void this.shutdown(reason)` 改成：

```ts
void this.shutdown(reason)
  .then(() => forceExit(code), () => forceExit(1))
```

- `forceExit` **直接 import** `../runtime/diagnostic.ts`（nano-app 已在 import `runtime/handoff`、`runtime/lifecycle`），**不要**加进 NanoApp 的 options——那会让「三处接线」变成四处。
- 传码用 `this.exitCode`，**不要**写 `this.exitCode || 1`：信号路径的合法值就是 0。

### R3 回归用例（红→绿）

`tests/e2e/exit-hardening.test.mjs`，用仓里已有的 `tests/e2e/pty-start.py`。**关键：必须构造「无守卫态」**，否则永远绿——

```sh
NANO_GUARDED=1 node dist/bin.js --root repro      # 跳过 launcher，fd1/2 = 终端（= 事故现场）
```

守卫态（fd2 = 日志）挂断本来就在 19ms 内干净退出，**拿它做用例必然从红变绿失败**。

- 断言只留一条硬的：**8s 内子进程消失**（`pid` 不再存活）。
- 不要断言「日志里有 `关停`」：无守卫态**根本不建日志**（这正是它的特征）。
- 用例前置断言先过：`pid` 已存在、进程已活过 1s；否则 dist 缺失 → 127 立即退出会让空断言假绿。
- 「改前必红」写进用例注释：不修时该 pid 会稳定 100% CPU 不退，用 `ps -o %cpu` 可复核。
- 环境隔离照现有 pty 用例：合成 `HOME` / `DSH_HOME`，清凭据。

**`pty-start.py` 需要加的能力（只加不改默认，该脚本被 10 个 e2e 文件共用）**：① 打印 child pid（在退出码之前打）；② 真正挂断用「关掉 master」而不是 `--no-read`（`--no-read` 只是让缓冲写满，那是另一个 bug 的形态）；③ 关掉 `--wait` 到点无条件发的 Ctrl+C（`:192-195`）；④ 末尾的 `killpg SIGKILL`（`:216-225`）挪到断言之后。改完跑一遍 `npm run test:e2e` 确认没影响既有 10 个用例。

## 3. 验收

1. 上述 pty 用例：改前红（100% CPU 不退）、改后绿（8s 内消失）。
2. 单测 `tests/unit/diagnostic.test.ts`：`vi.mock('node:fs')` 让 `writeSync` 抛 `EIO` → 连续 100 次调用只尝试 1 次、不抛；抛 `EAGAIN` → **不**熔断；`vi.resetModules()` + `resetDiagnosticForTest()` 隔离用例。
3. `npm run typecheck && npm run lint && npm run build && npm run test:e2e && npm test` 全绿（pty 用例在 `test:e2e`，`npm test` 不收）。
4. 正常路径不回归：`nano --version`、`nano purge`、Ctrl+C 退出码（现成基线用例 `tests/e2e/release.test.mjs` 的启动冒烟）。
5. 人为让 `writeSync(2)` 抛错时，进程仍能退出（`forceExit` 的 SIGKILL 分支）。

## 4. 本次不做（整块挪走，不再进本单）

| 项 | 为什么不做 | 去处 |
|---|---|---|
| 单一退出漏斗（五条退出路径合一） | 加固，不是修 bug | 后续单（待开） |
| 孤儿巡检（父进程先死 / 无 SIGHUP） | 另一类失联，Claude Code 也没做 | 后续单（待开） |
| 终端写不可阻塞（`O_NONBLOCK` / 输出队列） | **另一个 bug**（0% CPU 卡死），需要队列级设计 | 后续单（待开） |
| `feature-host.ts` 的 7 处诊断写 + 其余裸 stderr 写 | 不在事故栈上 | 后续单（待开） |
| **`NANO_GUARDED` 环境变量泄漏本身** | 它是"为什么会跑出无守卫实例"的成因，但**不修也不会再自激**（R1 已切断）；剩余表现：无日志、诊断写到外层终端 | 后续单（待开） |
| 改 ADR / 动进程模型 | 本修复不碰架构 | 不动 |

## 5. 风险（如实写）

- **R1 把诊断从流式写改成同步写 = 主动新增了一条同步写路径**。终端读停时 `writeSync(2)` 会阻塞事件循环，此时 `forceExit` 的兜底与所有定时器都失效。这是被 §4 挪走的那个 bug 的形态，本次**不解决**，只保证它不再自激。
- `dead` 熔断后诊断只在日志文件侧可见（终端已死，本来看不见）。
- 「`process.exit` 在死终端上会抛 EIO」来自 Claude Code 的实现（`utils/gracefulShutdown.ts:193-232`，本机归档）；本机实测 Node v24.18.0 上 `process.exit(7)` 在撤销 tty 上正常退 7、**未触发抛出**。故 `forceExit` 的 SIGKILL 分支是**兜底，本机未观测到触发**，`NODE_ENV==='test'` 的 rethrow 目前是死代码。
