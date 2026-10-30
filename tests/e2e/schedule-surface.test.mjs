// B3「调度」面：0.2.0 没有调度 UI，内容落在官方 schedule 的按根存储。
// 这里直接 boot 两个 root 的官方核心 + nano 调度门面，验证 A 创建的任务
// 不出现在 B 的 catalog。不触真实模型/网络。
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { prepareCore, startCore } from '../../dist/boot/assemble.js'
import { loadOfficial } from '../../dist/boot/official.js'
import { featureBootPatches } from '../../dist/sessions/boot-patches.js'
import { ScheduleRuntime } from '../../dist/schedule/service.js'
import { ScheduleStorage } from '../../dist/schedule/storage.js'
import { SessionControllerAdapter } from '../../dist/sessions/session-controller-adapter.js'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const base = mkdtempSync(path.join(os.tmpdir(), 'nano-schedule-'))
const dataRoot = path.join(base, 'data')
const home = path.join(base, 'home')
mkdirSync(dataRoot, { recursive: true })
mkdirSync(path.join(home, '.dsh'), { recursive: true })

const saved = {}
for (const key of ['HOME', 'DSH_HOME', 'DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL']) {
  saved[key] = process.env[key]
}
process.env.HOME = home
process.env.DSH_HOME = path.join(home, '.dsh')
delete process.env.DEEPSEEK_API_KEY
delete process.env.DEEPSEEK_BASE_URL

async function boot(rootId) {
  const official = await loadOfficial()
  const prepared = await prepareCore({
    official,
    dataRoot,
    home,
    cwd: repoRoot,
    rootId,
    extraPatches: featureBootPatches(rootId),
  })
  const core = await startCore(prepared)
  const storage = new ScheduleStorage({ ctx: core.ctx, dataRoot, rootId })
  storage.install()
  await storage.probe()
  const runtime = new ScheduleRuntime({
    ctx: core.ctx,
    sessionController: new SessionControllerAdapter({ agents: core.ctx.agents }),
  })
  await runtime.mount()
  return { core, runtime, storage }
}

test.after(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(base, { recursive: true, force: true })
})

test('调度：A 创建的任务不出现在 B 的 catalog', async () => {
  const a = await boot('schedule-a')
  try {
    const created = await a.runtime.service.create('schedule-a', {
      title: 'SCHEDULE_MARKER',
      prompt: '只应出现在 A',
      after_seconds: 3600,
    })
    assert.match(created.title, /SCHEDULE_MARKER/)
    const rowsA = await a.runtime.service.catalog()
    assert.ok(rowsA.some((row) => row.title === 'SCHEDULE_MARKER'), 'A 应有任务')
  } finally {
    await a.core.dispose()
  }
  const b = await boot('schedule-b')
  try {
    const rowsB = await b.runtime.service.catalog()
    assert.ok(!rowsB.some((row) => row.title === 'SCHEDULE_MARKER'), 'B 不应看到 A 的任务')
  } finally {
    await b.core.dispose()
  }
})
