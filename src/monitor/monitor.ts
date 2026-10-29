/**
 * Monitor（S02 spec §3.4）：盯后台任务输出，按预算把新增内容注入会话。
 *
 * 默认 `quiet` = 官方 inject：不唤醒模型、不产生独立回合，内容随下一次被接受的
 * 请求进上下文并计费。`notify` 会唤醒模型，必须由调用方先明确告知用户。
 *
 * 读取一律用 `readAt` 的绝对偏移，不推进模型的消费游标；真实收件以
 * accepted step / durable user/message 为准，本模块只负责把内容送进 inbox。
 */

import { createElement, type ReactNode } from 'react'
import type { Key } from '../input/parser.ts'
import { Box, Text } from '../render/components.ts'

export type MonitorMode = 'quiet' | 'notify'

export interface MonitorBudgets {
  /** 累计到这么多字节才投递一次；默认 4096。 */
  readonly bytes: number
  /** 单次投递的最大行数；超出按行裁剪。 */
  readonly lines: number
}

export interface MonitorListener {
  readonly jobId: string
  readonly mode: MonitorMode
  offset: number
  pending: string
  delivered: number
  readonly budget: MonitorBudgets
  settled: boolean
}

export interface MonitorOptions {
  readonly ctx: any
  readonly sessionId: string
  readonly onChange: () => void
  readonly writeDiagnostic: (line: string) => void
  readonly deliver: (text: string, mode: MonitorMode) => void
}

export const DEFAULT_BUDGET: MonitorBudgets = { bytes: 4096, lines: 40 }

export class Monitor {
  private readonly options: MonitorOptions
  private readonly listeners = new Map<string, MonitorListener>()
  private timer: NodeJS.Timeout | undefined
  private readonly intervalMs: number

  constructor(options: MonitorOptions & { intervalMs?: number }) {
    this.options = options
    this.intervalMs = options.intervalMs ?? 1000
  }

  get watching(): readonly MonitorListener[] {
    return [...this.listeners.values()]
  }

  /**
   * 开始盯一个任务。`from` 默认当前输出总量（只看之后的新内容）。
   */
  watch(jobId: string, mode: MonitorMode = 'quiet', budget: MonitorBudgets = DEFAULT_BUDGET): void {
    const jobs = this.options.ctx.get('jobs')
    if (!jobs) throw new Error('jobs 服务不可用')
    if (this.listeners.has(jobId)) return
    const view = this.safeGet(jobId)
    const offset = view?.output?.total ?? 0
    this.listeners.set(jobId, {
      jobId,
      mode,
      offset,
      pending: '',
      delivered: 0,
      budget,
      settled: false,
    })
    this.ensureTimer()
    this.options.onChange()
  }

  /** 停止监听 ≠ 停止任务。 */
  stop(jobId: string): void {
    this.listeners.delete(jobId)
    if (this.listeners.size === 0) this.clearTimer()
    this.options.onChange()
  }

  stopAll(): void {
    this.listeners.clear()
    this.clearTimer()
    this.options.onChange()
  }

  /** 收件：quiet 走 inject（不唤醒），notify 走 followup（会唤醒并计费）。 */
  private deliverListener(listener: MonitorListener, text: string): void {
    if (text.trim() === '') return
    this.options.deliver(`[Monitor] ${listener.jobId}\n${text}`, listener.mode)
    listener.delivered += 1
  }

  private ensureTimer(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.poll(), this.intervalMs)
    this.timer.unref?.()
  }

  private clearTimer(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = undefined
  }

  /** 轮询一次：读增量、按预算投递、settled 时补齐并收尾。 */
  poll(): void {
    const jobs = this.options.ctx.get('jobs')
    if (!jobs) return
    for (const listener of [...this.listeners.values()]) {
      try {
        const read = jobs.readAt(listener.jobId, listener.offset, this.options.sessionId) as {
          chunks?: Array<{ text: string }>
          next?: number
          lossy?: boolean
        }
        const text = (read.chunks ?? []).map((chunk) => chunk.text).join('')
        listener.offset = read.next ?? listener.offset
        if (text !== '') listener.pending += text
        const view = this.safeGet(listener.jobId)
        const settled = view ? !['running', 'stopping'].includes(String(view.status)) : true
        if (settled) listener.settled = true
        // 预算耗尽或任务已结束：把攒下的内容投递一次。
        if (
          listener.pending.length >= listener.budget.bytes ||
          (settled && listener.pending !== '')
        ) {
          const chunk = trimLines(listener.pending, listener.budget.lines)
          listener.pending = ''
          this.deliverListener(listener, chunk.text)
        }
        // settled 且已补齐：停止监听（不等于停止任务）。
        if (settled) this.stop(listener.jobId)
      } catch (error) {
        this.options.writeDiagnostic(
          `nano: Monitor 读取 ${listener.jobId} 失败：${String((error as Error)?.message ?? error)}`,
        )
        this.stop(listener.jobId)
      }
    }
    this.options.onChange()
  }

  private safeGet(jobId: string): any {
    try {
      return this.options.ctx.get('jobs')?.get(jobId, this.options.sessionId)
    } catch {
      return undefined
    }
  }

  dispose(): void {
    this.stopAll()
  }
}

/** 按行数裁剪，保留最新内容并标注已裁剪。 */
export function trimLines(text: string, maxLines: number): { text: string; trimmed: boolean } {
  const lines = text.split('\n')
  if (lines.length <= maxLines) return { text, trimmed: false }
  return {
    text: `…（已裁剪 ${lines.length - maxLines} 行）\n${lines.slice(-maxLines).join('\n')}`,
    trimmed: true,
  }
}

/** 面板行：监听中的任务与已投递次数。 */
export function renderMonitorLines(listeners: readonly MonitorListener[]): ReactNode {
  if (listeners.length === 0) return null
  return createElement(
    Box,
    { flexDirection: 'column' },
    ...listeners.map((listener) =>
      createElement(
        Text,
        { dim: true },
        `  Monitor ${listener.jobId} · ${listener.mode}${listener.mode === 'notify' ? '（会唤醒模型并计费）' : ''} · 已投递 ${listener.delivered}`,
      ),
    ),
  )
}

export type { Key }
