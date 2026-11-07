// spec 2026-11-07-nano-research-discipline §8.1 的 spec 期探针。
//
// 真 boot 官方核心 + 真 ConversationController.start()，注入一个 marker 覆盖
// plan-mode 的 section，然后分别组装 plan 未激活 / 激活时的系统提示：
// - 未激活：不应出现 marker；
// - 激活后：应出现 marker，且不再出现官方 "Explore first."。
//
// 运行前先 `npm run build`（本脚本从 dist/ 导入）。
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
const marker = '__NANO_PLAN_OVERRIDE_MARKER__'
const base = mkdtempSync(path.join(os.tmpdir(), 'nano-plan-probe-'))
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

let core
let controller
try {
  const official = await loadOfficial()
  const prepared = await prepareCore({
    official,
    dataRoot,
    home,
    cwd: repoRoot,
    rootId: 'probe-root',
    extraPatches: [
      ...featureBootPatches('probe-root'),
      { id: 'plan-mode', config: { section: marker } },
    ],
  })
  core = await startCore(prepared)
  const systemPrompt = core.ctx.get('systemPrompt')
  controller = new ConversationController({
    ctx: core.ctx,
    official,
    rootId: 'probe-root',
    cwd: repoRoot,
    history: { record() {}, entries: () => [] },
  })
  await controller.start()

  const inactive = renderPrompt(
    await systemPrompt.assemble({ agent: controller.agent, scope: controller.agent }),
  )
  await core.ctx.planMode.set(controller.agent, true)
  const active = renderPrompt(
    await systemPrompt.assemble({ agent: controller.agent, scope: controller.agent }),
  )

  const problems = []
  if (inactive.includes(marker)) problems.push('plan 未激活时不应出现覆盖 marker')
  if (!active.includes(marker)) problems.push('plan 激活后应出现覆盖 marker')
  if (active.includes('Explore first.')) problems.push('覆盖后不应再出现官方 Explore first.')

  console.log(`inactive has marker: ${inactive.includes(marker)}`)
  console.log(`active has marker: ${active.includes(marker)}`)
  console.log(`active has official "Explore first.": ${active.includes('Explore first.')}`)
  if (problems.length > 0) {
    console.error(problems.join('\n'))
    process.exitCode = 1
  } else {
    console.log('spec probe passed')
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
