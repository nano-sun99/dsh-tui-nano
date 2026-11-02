/**
 * 堆看门狗（issue #138）。
 *
 * 两次 OOM 崩溃都是 V8 自己 abort：日志里只有 GC 记录，没有一行「当时在干什么」。
 * 这里只做**观测**——超过预警线写一行诊断，让下次真的炸了时有据可查；
 * 不动堆、不主动退出，因为把上限抬高只是把崩溃时间往后推（见 issue #138）。
 */

/** 超过这个堆占用就写一行诊断；`NANO_HEAP_WARN_MB` 可覆盖。 */
export const HEAP_WARN_MB = 2048
const DEFAULT_INTERVAL_MS = 30_000
/** 同一进程不刷屏：两次诊断至少隔这么久。 */
const DEFAULT_COOLDOWN_MS = 300_000

export interface HeapWatchOptions {
  readonly limitMb?: number
  readonly intervalMs?: number
  readonly cooldownMs?: number
  /** 测试注入：当前堆占用（MB）。 */
  readonly heapUsedMb?: () => number
  /** 测试注入：当前时间（ms）。 */
  readonly now?: () => number
  readonly report: (line: string) => void
}

/** 启动看门狗，返回停止函数。定时器 `unref()`，不会拖住进程退出。 */
export function startHeapWatch(options: HeapWatchOptions): () => void {
  const configured = Number(options.limitMb ?? process.env.NANO_HEAP_WARN_MB ?? HEAP_WARN_MB)
  const limitMb = Number.isFinite(configured) && configured > 0 ? configured : HEAP_WARN_MB
  // 下限 1s：看门狗查的是「几 GB 的堆」，亚秒轮询只会空转。
  const intervalMs = Math.max(1000, options.intervalMs ?? DEFAULT_INTERVAL_MS)
  const cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS
  const heapUsedMb = options.heapUsedMb ?? (() => process.memoryUsage().heapUsed / (1024 * 1024))
  const now = options.now ?? (() => Date.now())
  let lastReport = Number.NEGATIVE_INFINITY

  const timer = setInterval(() => {
    const used = heapUsedMb()
    if (!Number.isFinite(used) || used < limitMb) return
    const at = now()
    if (at - lastReport < cooldownMs) return
    lastReport = at
    options.report(
      `nano: 堆占用 ${Math.round(used)}MB，已超过 ${limitMb}MB 预警线` +
        `（NANO_HEAP_WARN_MB 可调）。长会话请留意，必要时先保存再重启。`,
    )
  }, intervalMs)
  timer.unref()
  return () => clearInterval(timer)
}
