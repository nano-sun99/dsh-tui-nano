/**
 * 调度的存储后端与路由探针（S02 spec §3.5）。
 *
 * 顺序是硬约束：注册命名后端 → provide service key → `storageDomain` 按路由激活
 * → 探针通过 → 才允许挂官方 schedule。任一步失败都按「启动失败」处理，
 * 不提供 `unsupported` 降级。
 */
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { PROBE_DOMAIN_NAME, SCHEDULE_BACKEND_NAME } from '../sessions/boot-patches.ts'

/**
 * 探针记录的最小 schema。storage-domain 只对表记录调用 `parse()`，
 * 这里做透传即可，不为此引入 zod 依赖（`package.json` 归 S01）。
 */
const passThrough = {
  parse<T>(value: T): T {
    return value
  },
}

/** 探针域：单表一行，写入 `at` 时间戳。 */
const probeSpec = defineDomain({
  name: PROBE_DOMAIN_NAME,
  version: 1,
  // 运行时只调用 `parse()`；`domainTable` 的 zod 类型在此处放宽，避免新增依赖。
  tables: { probes: domainTable(passThrough as any) },
})

export interface ScheduleStorageOptions {
  readonly ctx: any
  readonly dataRoot: string
  readonly rootId: string
}

/**
 * 命名后端 `nano-schedule-json` 的根（spec §3.5）：与 `storage-json` 行同一目录，
 * 靠后端名 + 路由隔离表，不再另开一层。
 */
export function scheduleStorageRoot(dataRoot: string, rootId: string): string {
  return join(dataRoot, 'runtime-data', rootId, 'storage')
}

export class ScheduleStorage {
  private readonly options: ScheduleStorageOptions
  private readonly root: string
  private backend: any
  private unregister: (() => void) | undefined
  private disposeKey: (() => void) | undefined

  constructor(options: ScheduleStorageOptions) {
    this.options = options
    this.root = scheduleStorageRoot(options.dataRoot, options.rootId)
  }

  get storageRoot(): string {
    return this.root
  }

  get probePath(): string {
    return join(this.root, 'nano_probe.json')
  }

  /** 注册命名后端并 provide 服务键；storage-domain 靠这个键才激活路由。 */
  install(): void {
    const { ctx } = this.options
    const backend = new JsonStorageBackend(this.root)
    this.backend = backend
    this.unregister = ctx.storage.backend.register(SCHEDULE_BACKEND_NAME, backend)
    this.disposeKey = ctx.provide(storageBackendServiceKey(SCHEDULE_BACKEND_NAME), backend)
  }

  /** 等 `storageDomain` 激活后写一次探针；损坏残留清掉重试一次。 */
  async probe(timeoutMs = 15_000): Promise<void> {
    const { ctx } = this.options
    const storageDomain = await waitForService(ctx, 'storageDomain', timeoutMs)
    try {
      await this.writeProbe(storageDomain)
    } catch (error) {
      if (!isMediumCorruption(error)) {
        throw new Error(`nano: 调度探针失败（${this.probePath}）：${messageOf(error)}`)
      }
      rmSync(this.probePath, { force: true })
      try {
        await this.writeProbe(storageDomain)
      } catch (retryError) {
        throw new Error(`nano: 调度探针失败（${this.probePath}）：${messageOf(retryError)}`)
      }
    }
  }

  private async writeProbe(storageDomain: any): Promise<void> {
    const domain = await storageDomain.open(probeSpec)
    try {
      await domain.table('probes').put('probe', { at: new Date().toISOString() })
    } finally {
      domain.close()
    }
  }

  /** 关停：先摘服务键与注册表，再关后端。 */
  async dispose(): Promise<void> {
    this.disposeKey?.()
    this.disposeKey = undefined
    this.unregister?.()
    this.unregister = undefined
    try {
      await this.backend?.close?.()
    } finally {
      this.backend = undefined
    }
  }
}

/** 轮询等服务出现；超时点名服务名。 */
export async function waitForService(ctx: any, name: string, timeoutMs = 15_000): Promise<any> {
  const startedAt = Date.now()
  for (;;) {
    const value = ctx.get(name)
    if (value) return value
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`nano: 等待服务 ${name} 超时`)
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

function isMediumCorruption(error: unknown): boolean {
  const code = (error as { code?: string } | undefined)?.code
  return code === 'invalid-record' || code === 'malformed-medium'
}

function messageOf(error: unknown): string {
  return String((error as { message?: string } | undefined)?.message ?? error)
}
