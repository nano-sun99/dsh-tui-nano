# [2026-11-03-nano-exit-hardening] 诊断写失败不再自激，退出不留活口

- 组标识：`2026-11-03-nano-exit-hardening`
- 状态：**实施版（最小修复）**，待过闸
- Issue：[#164](https://github.com/nano-sun99/dsh-tui-nano/issues/164)
- 本版说明：v1–v7 把「修这个 bug」和「重做终端生命周期」捆在一起，六轮审核仍未收敛（复盘见 [spec-flow#130](https://github.com/nano-sun99/spec-flow/issues/130)）。**v8 只保留修这个 bug 必需的部分**，其余整块挪到后续单。

## 1. 问题与根因

终端挂断后，`process.stderr.write` 抛 `EIO`；`onUncaught` 里**又**调同一个写 → 再抛 → 自激。4 秒可复现，107,244 次未捕获异常，进程吃满一核 83 分钟不退（issue #164 有复现脚本与首条栈）。

自激的充要条件只有一个：**「报错」这个动作本身会抛，而它的落点又是它自己**。

## 2. 改什么（两处，约 40 行）

### R1 诊断写永不抛

新建 `src/runtime/diagnostic.ts`：

```ts
let dead = false

/** 诊断唯一入口：任何情况下不抛。 */
export function writeDiagnostic(line: string): void {
  if (dead) return
  try {
    writeSync(2, line.endsWith('\n') ? line : `${line}\n`)
  } catch {
    dead = true            // EIO / EBADF / EPIPE 一律视为通道已死，本进程内不再尝试
  }
}
```

- 用 `writeSync` 而不是 `process.stderr.write`：流式写的失败可能以异步 `error` 事件逃出调用点，`try/catch` 抓不全。
- **接线点只有一处**：`src/main.ts:214` 的 `writeDiagnostic: (line) => process.stderr.write(...)` 改成它。nano-app 的所有诊断（含 `onUncaught` 那行）都经这个注入，改一处即覆盖出事路径。
- 其余裸 `process.stderr.write` **本次不动**（不在自激环上）。

### R2 退出不留活口

同文件：

```ts
export function forceExit(code: number): void {
  try {
    process.exit(code)
  } catch (error) {
    if (process.env.NODE_ENV === 'test') throw error     // 测试里让断言看得见
    try { process.kill(process.pid, 'SIGKILL') } catch { /* 已退出 */ }
  }
}
```

- 接在 `onUncaught` / `onUnhandledRejection` 走完既有 `shutdown` 之后（`src/app/nano-app.ts:277-287`）：关停成功 → `forceExit(exitCode)`；关停抛错 → 也 `forceExit(1)`。
- 与 Claude Code 一致（`utils/gracefulShutdown.ts:193-232`：`process.exit` 在终端已死时会抛 EIO，兜底是 `SIGKILL`）。

### R3 回归用例

`tests/e2e/exit-hardening.test.mjs`：用**仓里已有的** `tests/e2e/pty-start.py`（先补 `--no-read` 与「打印 child pid」两个能力），跑 `dist/bin.js`，挂断后断言 **8s 内进程消失**、日志里有 `关停`。

- 前置断言必须先过：子进程 pid 仍活、日志文件已建——否则「dist 缺失 → 127 立即退出」会让空断言假绿。
- 环境隔离照现有 pty 用例：合成 `HOME` / `DSH_HOME`，清凭据。

## 3. 验收

1. 上述 pty 用例从红变绿（改前必红：不修就是 100% CPU 不退）。
2. 单测：`writeSync` 抛 `EIO` 桩 → 连续 100 次调用只尝试 1 次、不抛。
3. `npm run typecheck && npm run lint && npm run build && npm test` 全绿。
4. 正常路径不回归：`nano --version`、`nano purge`、Ctrl+C 退出码不变。

## 4. 本次不做（整块挪走，不再进本单）

| 项 | 为什么不做 | 去处 |
|---|---|---|
| 单一退出漏斗（五条退出路径合一） | 加固，不是修 bug | 后续单（待开） |
| 孤儿巡检（父进程先死 / 无 SIGHUP） | 另一类失联，Claude Code 也没做 | 后续单（待开） |
| 终端写不可阻塞（`O_NONBLOCK` / 输出队列） | **另一个 bug**（0% CPU 卡死，非 100% CPU 自激），需要队列级设计 | 后续单（待开） |
| 其余裸 `process.stderr.write` 收敛 | 不在自激环上 | 后续单（待开） |
| 改 ADR / 动进程模型 | 本修复不碰架构，`ADR-20261029` 原样有效 | 不动 |

## 5. 风险

- 只修了「写失败的自激环」，没修「终端彻底卡住时进程可能被同步写阻塞」——后者单独立项，本次如实记录。
- `dead` 熔断后诊断只在日志文件侧可见（终端已死，本来看不见）。
