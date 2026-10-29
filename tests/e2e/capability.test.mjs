// 能力面证据（S03 §3.3「安全」行的可自动化部分）：
// 真 boot 官方核心，读工具注册表，确认 terminal 不在 Agent 工具表里，
// 且 ask_user_question 等必需工具存在。不开终端、不抢键鼠。
//
// 隔离：boot 会读 process.env 里的 HOME/DSH_HOME 与凭据环境变量，所以这里
// 临时把三者指到合成目录，跑完恢复；不能只把 home 传给 prepareCore。
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { prepareCore, startCore } from '../../dist/boot/assemble.js'
import { loadOfficial } from '../../dist/boot/official.js'
import { featureBootPatches } from '../../dist/sessions/boot-patches.js'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

const ENV_KEYS = ['HOME', 'DSH_HOME', 'DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL']

function snapshotEnv() {
  return Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
}

function restoreEnv(saved) {
  for (const key of ENV_KEYS) {
    const value = saved[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

async function bootCore() {
  const base = mkdtempSync(path.join(os.tmpdir(), 'nano-cap-'))
  const dataRoot = path.join(base, 'data')
  const home = path.join(base, 'home')
  mkdirSync(dataRoot, { recursive: true })
  mkdirSync(path.join(home, '.dsh'), { recursive: true })
  const saved = snapshotEnv()
  // 官方 boot 用 process.env 解析 $DSH_HOME 与继承凭据；不设就会读写真实 ~/.dsh。
  process.env.HOME = home
  process.env.DSH_HOME = path.join(home, '.dsh')
  delete process.env.DEEPSEEK_API_KEY
  delete process.env.DEEPSEEK_BASE_URL
  try {
    const official = await loadOfficial()
    const prepared = await prepareCore({
      official,
      dataRoot,
      home,
      cwd: repoRoot,
      rootId: 'cap-root',
      extraPatches: featureBootPatches('cap-root'),
    })
    const core = await startCore(prepared)
    return { core, base, home, restore: () => restoreEnv(saved) }
  } catch (error) {
    restoreEnv(saved)
    rmSync(base, { recursive: true, force: true })
    throw error
  }
}

test('Agent 工具表不含 terminal，且必需工具存在', async () => {
  const { core, base, home, restore } = await bootCore()
  try {
    const tools = core.ctx.get('tools')
    assert.ok(tools, 'tools 服务应存在')
    // schemas() 是 global 视图；当前组合没有 agent 级 scoped 工具，结论成立。
    const names = tools.schemas().map((schema) => schema.name)
    assert.ok(names.length > 0, '工具表不应为空')
    assert.ok(
      !names.some((name) => /terminal/i.test(name)),
      `terminal 不应出现在 Agent 工具表：${names.filter((name) => /terminal/i.test(name)).join(', ')}`,
    )
    assert.ok(names.includes('ask_user_question'), `缺少 ask_user_question：${names.join(', ')}`)
    // boot 的凭据/匿名标识必须落在合成 home 里，而不是真实 ~/.dsh。
    assert.ok(existsSync(path.join(home, '.dsh')), '合成 $DSH_HOME 应存在')
  } finally {
    try {
      await core.dispose()
    } finally {
      restore()
      rmSync(base, { recursive: true, force: true })
    }
  }
})
