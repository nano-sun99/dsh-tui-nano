/**
 * 诊断写与强制退出的唯一入口：任何情况下都不抛。
 *
 * 事故（issue #164）：终端挂断后 `process.stderr.write` 抛 `EIO`，`onUncaught`
 * 里又调同一个写 → 再抛 → 自激，4 秒 107,244 次未捕获异常、一条核烧 83 分钟不退。
 * 切断自激只有一个办法：让「报错」这个动作自己不会抛（spec 2026-11-03 §2 R1/R2）。
 */
import { writeSync } from 'node:fs'

let dead = false

/** 诊断唯一入口：任何情况下不抛。 */
export function writeDiagnostic(line: string): void {
  if (dead) return
  try {
    writeSync(2, line.endsWith('\n') ? line : `${line}\n`) // 部分写可接受
  } catch (error) {
    // EAGAIN 只是这一行没写出去（终端读停），不熔断；其余视为通道已死。
    if ((error as NodeJS.ErrnoException).code !== 'EAGAIN') dead = true
  }
}

/** 退出兜底：`process.exit` 在死终端上也可能抛，那就自己发 SIGKILL。 */
export function forceExit(code: number): void {
  try {
    process.exit(code)
  } catch (error) {
    if (process.env.NODE_ENV === 'test') throw error
    try {
      process.kill(process.pid, 'SIGKILL')
    } catch {
      // 已退出。
    }
  }
}

/** 仅测试用：复位熔断状态。 */
export function resetDiagnosticForTest(): void {
  dead = false
}
