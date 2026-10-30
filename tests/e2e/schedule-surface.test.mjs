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
import { ScheduleRuntime } from '../../dist/schedule/service.js'
import { ScheduleStorage } from '../../dist/schedule/storage.js'
import { featureBootPatches } from '../../dist/sessions/boot-patches.js'
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

test('调度：A/B 各自可见自己的任务，门面投影与按根隔离都成立', async () => {
  const a = await boot('schedule-a')
  let b
  try {
    const createdA = await a.runtime.service.create('schedule-a', {
      title: 'SCHEDULE_MARKER',
      prompt: '只应出现在 A',
      after_seconds: 3600,
    })
    assert.match(createdA.title, /SCHEDULE_MARKER/)
    // 走 nano 门面，不直接读官方 service：投影丢字段会在这一步暴露。
    const rowsA = await a.runtime.catalog()
    assert.ok(
      rowsA.some((row) => row.title === 'SCHEDULE_MARKER'),
      'A 门面应显示 A 的任务',
    )
    assert.ok(
      rowsA.every((row) => row.id && row.title && row.prompt && row.scheduledAt),
      '门面投影不应把官方扁平记录字段丢成空串',
    )

    b = await boot('schedule-b')
    // B 正控：B 自己能创建并看到自己的任务，排除「catalog 恒空所以隔离看似成立」。
    const createdB = await b.runtime.service.create('schedule-b', {
      title: 'B_SCHEDULE_MARKER',
      prompt: '只应出现在 B',
      after_seconds: 3600,
    })
    assert.match(createdB.title, /B_SCHEDULE_MARKER/)
    const rowsB = await b.runtime.catalog()
    assert.ok(
      rowsB.some((row) => row.title === 'B_SCHEDULE_MARKER'),
      'B 门面应显示 B 自己的任务（正控）',
    )
    assert.ok(!rowsB.some((row) => row.title === 'SCHEDULE_MARKER'), 'B 不应看到 A 的任务')
    const rowsAAfterB = await a.runtime.catalog()
    assert.ok(!rowsAAfterB.some((row) => row.title === 'B_SCHEDULE_MARKER'), 'A 不应看到 B 的任务')
  } finally {
    await a.core.dispose()
    if (b) await b.core.dispose()
  }
})
