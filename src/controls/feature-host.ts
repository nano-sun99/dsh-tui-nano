/**
 * S02 的接线对象（S02 spec §1 接入点例外第 2/3 条）。
 *
 * S01 只把它当成一个可选钩子：`start` 在首帧前 await，`dispose` 在关停 drain
 * 阶段调用。这里按顺序把 S02 的功能面挂上官方根——顺序本身是约束：
 * 命名后端 + 服务键要在 `storageDomain` 之前，探针要在 schedule 之前。
 */
import type { FeatureContext, FeatureHost } from '../app/nano-app.ts'
import { ScheduleRuntime } from '../schedule/service.ts'
import { ScheduleStorage } from '../schedule/storage.ts'
import { SessionControllerAdapter } from '../sessions/session-controller-adapter.ts'

export class Features implements FeatureHost {
  private context: FeatureContext | undefined
  private storage: ScheduleStorage | undefined
  private schedule: ScheduleRuntime | undefined

  async start(context: FeatureContext): Promise<void> {
    this.context = context
    const ctx = context.core.ctx

    // 1) 命名后端 + 服务键：storage-domain 的路由靠它激活。
    const storage = new ScheduleStorage({
      ctx,
      dataRoot: context.dataRoot,
      rootId: context.rootId,
    })
    this.storage = storage
    storage.install()

    // 2) 探针：路由真的落到命名后端才继续；失败即启动失败。
    await storage.probe()

    // 3) 最小会话控制器 + 官方 schedule（探针之后才允许打开任务表）。
    const schedule = new ScheduleRuntime({
      ctx,
      sessionController: new SessionControllerAdapter({ agents: ctx.agents }),
    })
    this.schedule = schedule
    await schedule.mount()
  }

  async dispose(): Promise<void> {
    this.schedule?.dispose()
    this.schedule = undefined
    await this.storage?.dispose()
    this.storage = undefined
    this.context = undefined
  }
}
