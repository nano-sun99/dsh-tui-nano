// 根 agent 系统提示组装证据（spec 2026-10-30-nano-main-agent-responsive A4/§6）。
//
// 真 boot 官方核心 + 真 ConversationController.start()，然后对根 agent 和另一个
// 未注册该段的 agent 各组装一次系统提示：根 agent 应包含
// nano:delegation-responsiveness，另一个 agent 不应包含。
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { prepareCore, startCore } from '../../../dist/boot/assemble.js'
import { ConversationController } from '../../../dist/conversation/controller.js'
import { loadOfficial } from '../../../dist/boot/official.js'
import { featureBootPatches } from '../../../dist/sessions/boot-patches.js'

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))
const base = mkdtempSync(path.join(os.tmpdir(), 'nano-prompt-'))
const dataRoot = path.join(base, 'data')
const home = path.join(base, 'home')
mkdirSync(dataRoot, { recursive: true })
mkdirSync(path.join(home, '.dsh'), { recursive: true })

const saved = Object.fromEntries(
  ['HOME', 'DSH_HOME', 'DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL'].map((key) => [key, process.env[key]]),
)
process.env.HOME = home
process.env.DSH_HOME = path.join(home, '.dsh')
delete process.env.DEEPSEEK_API_KEY
delete process.env.DEEPSEEK_BASE_URL

const marker = 'nano:delegation-responsiveness'
let core
let controller
try {
  const official = await loadOfficial()
  const prepared = await prepareCore({
    official,
    dataRoot,
    home,
    cwd: repoRoot,
    rootId: 'prompt-root',
    extraPatches: featureBootPatches('prompt-root'),
  })
  core = await startCore(prepared)
  const systemPrompt = core.ctx.get('systemPrompt')
  controller = new ConversationController({
    ctx: core.ctx,
    official,
    rootId: 'prompt-root',
    cwd: repoRoot,
    history: { record() {}, entries: () => [] },
  })
  await controller.start()

  const rootAssembly = await systemPrompt.assemble({
    agent: controller.agent,
    scope: controller.agent,
  })
  const rootText = renderPrompt(rootAssembly)

  const other = await core.ctx.agents.create({
    sessionId: official.session.SessionId('prompt-other'),
    meta: { cwd: repoRoot },
    agentOptions: {
      provider: 'deepseek-official',
      model: 'deepseek-flash',
    },
  })
  const otherAssembly = await systemPrompt.assemble({ agent: other.agent, scope: other.agent })
  const otherText = renderPrompt(otherAssembly)

  const guidance = 'Delegated subagents run in the background'
  const problems = []
  if (!rootAssembly.sections.some((section) => section.name === marker)) {
    problems.push('根 agent sections 缺少 nano:delegation-responsiveness')
  }
  if (!rootText.includes(guidance)) problems.push('根 agent 组装结果缺少纪律正文')
  if (otherText.includes(guidance)) problems.push('未注册该段的 agent 组装结果不应包含纪律正文')
  if (otherAssembly.sections.some((section) => section.name === marker)) {
    problems.push('未注册该段的 agent 的 sections 不应包含该段')
  }
  const names = rootAssembly.sections.map((section) => section.name)
  const at = names.indexOf(marker)
  const suffix = names.indexOf('deployment:persona-suffix')
  if (at < 0) problems.push('根 agent sections 缺少该段')
  if (suffix >= 0 && at > suffix) problems.push('该段应位于 deployment:persona-suffix 之前')

  if (problems.length > 0) {
    console.error(problems.join('\n'))
    process.exitCode = 1
  } else {
    console.log(`根 agent sections: ${names.slice(Math.max(0, at - 1), at + 2).join(' | ')}`)
    console.log(`根 agent 组装结果包含纪律正文：${rootText.includes(guidance)}`)
    console.log(`未注册该段的 agent 组装结果包含纪律正文：${otherText.includes(guidance)}`)
    console.log('A4 组装证据通过')
  }
} finally {
  try {
    await controller?.dispose?.()
  } catch {}
  try {
    await core?.dispose?.()
  } catch {}
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(base, { recursive: true, force: true })
}
