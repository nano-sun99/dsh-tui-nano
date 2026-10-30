/**
 * 官方调度服务的挂载与只读门面（S02 spec §3.5）。
 *
 * 官方 `dsh-schedule` 必须等探针通过后再挂：它一挂上就会打开 `schedule` 域，
 * 路由不对时会把表开在错误的后端上。挂载前先 provide 最小 `sessionController`，
 * 因为 `ScheduleService.inject` 里有它。
 */
import ScheduleService from '@deepseek-ai/dsh-schedule'
import type { SessionControllerAdapter } from '../sessions/session-controller-adapter.ts'
import { waitForService } from './storage.ts'

export interface ScheduleRuntimeOptions {
  readonly ctx: any
  readonly sessionController: SessionControllerAdapter
}

/** 面板用的调度视图；不复制官方记录，只做展示投影。 */
export interface ScheduleRow {
  readonly id: string
  readonly kind: string
  readonly title: string
  readonly prompt: string
  readonly scheduledAt: string
  readonly state: 'active' | 'inactive'
}

export class ScheduleRuntime {
  private readonly options: ScheduleRuntimeOptions
  private disposeController: (() => void) | undefined
  private schedule: any

  constructor(options: ScheduleRuntimeOptions) {
    this.options = options
  }

  get service(): any {
    return this.schedule
  }

  /** provide 最小会话控制器 → 挂官方 schedule → 等它打开任务表。 */
  async mount(timeoutMs = 15_000): Promise<void> {
    const { ctx, sessionController } = this.options
    this.disposeController = ctx.provide('sessionController', sessionController)
    ctx.plugin(ScheduleService, {})
    this.schedule = await waitForService(ctx, 'schedule', timeoutMs)
    // 读一次任务表：Service.init 的域打开与校验在这里落地，失败即启动失败。
    await this.schedule.catalog()
  }

  /** 当前根的全部任务（活动 + 未活动），按官方顺序。 */
  async catalog(): Promise<ScheduleRow[]> {
    const rows = (await this.schedule.catalog()) as any[]
    return rows.map((row) => {
      // 官方 catalog 返回扁平记录；旧版本/包装层可能把正文放在 record 下。
      // 只做展示投影，两种形状都兼容，避免标题被投影成空串。
      const record = row.record ?? row
      return {
        id: row.id ?? record.id,
        kind: record.kind ?? '',
        title: record.title ?? '',
        prompt: record.prompt ?? '',
        scheduledAt: record.scheduledAt ?? '',
        state: row.status === 'active' ? 'active' : 'inactive',
      }
    })
  }

  /** 关停：Cordis 的 provide 归还服务键；官方服务随根 dispose 卸载。 */
  dispose(): void {
    this.disposeController?.()
    this.disposeController = undefined
    this.schedule = undefined
  }
}
