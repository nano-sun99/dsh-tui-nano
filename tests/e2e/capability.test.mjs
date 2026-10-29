// 能力面证据（S03 §3.3「安全」行的可自动化部分）：
// 真boot 官方核心，读工具注册表，确认 terminal 不在 Agent 工具表里，
// 且 ask_user_question 等必需工具存在。不开终端、不抢键鼠。
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { prepareCore, startCore } from '../../dist/boot/assemble.js'
import { loadOfficial } from '../../dist/boot/official.js'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

async function bootCore() {
  const base = mkdtempSync(path.join(os.tmpdir(), 'nano-cap-'))
  const dataRoot = path.join(base, 'data')
  const home = path.join(base, 'home')
  mkdirSync(dataRoot, { recursive: true })
  mkdirSync(home, { recursive: true })
  const official = await loadOfficial()
  const prepared = await prepareCore({
    official,
    dataRoot,
    home,
    cwd: repoRoot,
    rootId: 'cap-root',
  })
  const core = await startCore(prepared)
  return { core, base }
}

test('Agent 工具表不含 terminal，且必需工具存在', async () => {
  const { core, base } = await bootCore()
  try {
    const tools = core.ctx.get('tools')
    assert.ok(tools, 'tools 服务应存在')
    const names = tools.schemas().map((schema) => schema.name)
    assert.ok(names.length > 0, '工具表不应为空')
    assert.ok(
      !names.some((name) => /terminal/i.test(name)),
      `terminal 不应出现在 Agent 工具表：${names.filter((name) => /terminal/i.test(name)).join(', ')}`,
    )
    assert.ok(names.includes('ask_user_question'), `缺少 ask_user_question：${names.join(', ')}`)
  } finally {
    await core.dispose()
    rmSync(base, { recursive: true, force: true })
  }
})
