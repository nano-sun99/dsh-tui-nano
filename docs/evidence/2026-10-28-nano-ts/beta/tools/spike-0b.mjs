/**
 * spike-0b：S02 的合入前提实测。
 *
 * 1. `terminal-controller` 行加上后 `ctx.terminalController` 是否存在、能否真开 PTY；
 * 2. 命名后端 `nano-schedule-json` + service key + `storage-domain` 路由 + 探针域写字；
 * 3. 最小 `sessionController` 适配器（只暴露 `resolveAgent`）能否让官方 schedule 挂起并打开任务表；
 * 4. 挂载顺序：boot → 注册后端 → 服务键 → storage-domain 激活 → 探针 → 挂 schedule。
 *
 * 用法：node docs/evidence/2026-10-28-nano-ts/beta/tools/spike-0b.mjs
 * 前提：先 `npm ci && npm run build`（本脚本导入 `dist/`）。
 */
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { loadOfficial } from '../../../../../dist/boot/official.js'
import { prepareCore, startCore } from '../../../../../dist/boot/assemble.js'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import ScheduleService from '@deepseek-ai/dsh-schedule'

const ROOT_ID = 'spike0b-root'
const base = '/tmp/nano-spike-0b'
const dataRoot = join(base, 'data')
const home = join(base, 'home')
rmSync(base, { recursive: true, force: true })
mkdirSync(dataRoot, { recursive: true })
mkdirSync(home, { recursive: true })

const result = {
  bootMs: 0,
  terminalController: false,
  terminalList: null,
  pty: null,
  namedBackend: null,
  probeDomain: null,
  sessionController: null,
  schedule: null,
  errors: [],
}

const official = await loadOfficial()
const prepared = await prepareCore({
  official,
  dataRoot,
  home,
  cwd: process.cwd(),
  rootId: ROOT_ID,
})

// β 的两处 boot 前配置：terminal-controller 行 + storage-domain 路由。
prepared.patches.push({
  insert: [{ id: 'terminal-controller', name: '@deepseek-ai/dsh-api-terminal-controller' }],
})
prepared.patches.push({
  id: 'storage-domain',
  config: {
    backend: 'json',
    routes: { schedule: 'nano-schedule-json', nano_probe: 'nano-schedule-json' },
  },
})

const core = await startCore(prepared)
result.bootMs = Math.round(core.bootMs)
const ctx = core.ctx
result.terminalController = Boolean(ctx.get('terminalController'))

const waitFor = async (name, timeoutMs = 15000) => {
  const startedAt = Date.now()
  for (;;) {
    const value = ctx.get(name)
    if (value) return value
    if (Date.now() - startedAt > timeoutMs) throw new Error(`等待服务 ${name} 超时`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

const scheduleRoot = join(dataRoot, 'runtime-data', ROOT_ID, 'schedule-storage')

// 1) 命名后端 + service key（storage-domain 靠这个键激活路由）。
const backendPlugin = {
  name: 'nano-schedule-storage',
  inject: ['storage'],
  apply(inner) {
    const backend = new JsonStorageBackend(scheduleRoot)
    inner.effect(() => {
      const unregister = inner.storage.backend.register('nano-schedule-json', backend)
      return async () => {
        unregister()
        await backend.close()
      }
    })
    inner.provide(storageBackendServiceKey('nano-schedule-json'), backend)
  },
}
ctx.plugin(backendPlugin)

// 2) 探针域：路由到命名后端就必须落在 scheduleRoot/nano_probe.json。
const probeSpec = defineDomain({
  name: 'nano_probe',
  version: 1,
  tables: { rows: domainTable(z.object({ at: z.string() })) },
})
const storageDomain = await waitFor('storageDomain')
const probe = await storageDomain.open(probeSpec)
await probe.table('rows').put('probe', { at: new Date().toISOString() })
probe.close()
const probeFile = join(scheduleRoot, 'nano_probe.json')
result.probeDomain = {
  file: probeFile,
  exists: existsSync(probeFile),
  files: existsSync(scheduleRoot) ? readdirSync(scheduleRoot) : [],
}

// 3) 最小 sessionController 适配器：只暴露 resolveAgent(sessionId)。
const adapterPlugin = {
  name: 'nano-session-controller',
  inject: ['agents', 'sessionPersistence'],
  apply(inner) {
    inner.provide('sessionController', {
      async resolveAgent(sessionId) {
        const live = inner.agents.get(sessionId)
        if (live) return { agent: live }
        try {
          const handle = await inner.agents.resume({ resumeSessionId: sessionId })
          return { agent: handle.agent }
        } catch (error) {
          return {
            error: {
              code: isNotFound(error) ? 'session/not-found' : 'gateway/internal',
              message: String(error?.message ?? error),
            },
          }
        }
      },
    })
  },
}
function isNotFound(error) {
  const name = error?.name ?? ''
  const message = String(error?.message ?? error)
  return name === 'SessionPersistenceNotFoundError' || /not found/i.test(message)
}
ctx.plugin(adapterPlugin)
await waitFor('sessionController')
result.sessionController = true

// 4) 挂官方 schedule（boot 后扩展点）。
ctx.plugin(ScheduleService, {})
const schedule = await waitFor('schedule')
const catalog = await schedule.catalog()
let created = null
try {
  created = await schedule.create(ROOT_ID, {
    prompt: 'spike-0b reminder',
    title: 'spike-0b',
    after_seconds: 600,
  })
} catch (error) {
  created = { error: String(error?.message ?? error) }
}
const scheduleFile = join(scheduleRoot, 'schedule.json')
result.schedule = {
  catalogLength: catalog.length,
  created: created && created.id ? { id: created.id, kind: created.kind } : created,
  file: scheduleFile,
  exists: existsSync(scheduleFile),
  files: existsSync(scheduleRoot) ? readdirSync(scheduleRoot) : [],
}

// 5) 终端：list（无需 agent）与真实 PTY 创建。
const terminal = ctx.get('terminalController')
result.terminalList = terminal.list(ROOT_ID).length
try {
  const selection = ctx.get('agentDefaultModel')?.currentSelection?.()
  const sessionId = official.session.SessionId(ROOT_ID)
  const agentOptions = { provider: selection.provider, model: selection.model }
  const setup = (agentCtx) => {
    official.agent.installModelSelection(agentCtx, { current: selection, assembled: undefined })
  }
  const handle = await ctx.agents.create({ sessionId, meta: { cwd: process.cwd() }, agentOptions, setup })
  const signal = new AbortController().signal
  const info = await terminal.create(handle.agent, {
    id: 'spike0b-term-1',
    cols: 80,
    rows: 24,
  }, signal)
  result.pty = { id: info.id, shell: info.shell.path, state: info.state, cwd: info.cwd }
  await terminal.close(handle.agent, info.id)
} catch (error) {
  result.pty = { error: String(error?.message ?? error), stack: String(error?.stack ?? '') }
}

await core.dispose()
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
