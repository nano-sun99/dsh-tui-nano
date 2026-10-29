/**
 * S02 的 boot 前补丁（spec §1 接入点例外第 1 条）。
 *
 * 两行官方配置必须在 `boot()` 之前就位：
 * - `terminal-controller` 行：base 不含它，S02 的终端面板要用 `terminalController`；
 * - `storage-domain` 路由：把 `schedule` 与探针域指到本节注册的命名后端
 *   `nano-schedule-json`，避免和会话投影缓存共用默认表。
 *
 * 本文件不碰 S01 的既有行；`src/boot/assemble.ts` 只多做一次 push。
 */

export interface PatchLayer {
  readonly id?: string
  readonly config?: unknown
  readonly insert?: readonly { readonly id: string; readonly name: string; readonly config?: unknown }[]
  readonly [key: string]: unknown
}

/** 命名后端名：schedule 任务表与探针域都走它。 */
export const SCHEDULE_BACKEND_NAME = 'nano-schedule-json'

/** 探针域：boot 后写入一次，证明路由真的落在命名后端上。 */
export const PROBE_DOMAIN_NAME = 'nano_probe'

/**
 * 返回 S02 需要在 boot 前注入的补丁层，顺序即 push 顺序。
 * @param _rootId - 根身份；本份的补丁与根无关，预留参数以便将来按根分流。
 */
export function featureBootPatches(_rootId: string): PatchLayer[] {
  return [
    {
      insert: [{ id: 'terminal-controller', name: '@deepseek-ai/dsh-api-terminal-controller' }],
    },
    {
      id: 'storage-domain',
      config: {
        backend: 'json',
        routes: {
          schedule: SCHEDULE_BACKEND_NAME,
          [PROBE_DOMAIN_NAME]: SCHEDULE_BACKEND_NAME,
        },
      },
    },
  ]
}
