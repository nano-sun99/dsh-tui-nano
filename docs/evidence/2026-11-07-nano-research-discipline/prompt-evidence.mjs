// 实施期 A1/A2/A3：真 boot、真根 agent、带 parentAgent 的真子 agent。
// 先 npm ci && npm run build；不调用模型，不读写真实用户 profile。
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { prepareCore, startCore } from '../../../dist/boot/assemble.js'
import { loadOfficial } from '../../../dist/boot/official.js'
import { ConversationController } from '../../../dist/conversation/controller.js'
import { featureBootPatches } from '../../../dist/sessions/boot-patches.js'

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))
const spec = readFileSync(
  new URL('../../specs/2026-11-07-nano-research-discipline/README.md', import.meta.url),
  'utf8',
)
const approved = [...spec.matchAll(/```text\n([\s\S]*?)\n```/g)].map((match) => match[1])
assert.equal(approved.length, 2, 'spec 必须给出两段定稿文本')
const base = mkdtempSync(path.join(os.tmpdir(), 'nano-research-evidence-'))
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
let child
try {
  const official = await loadOfficial()
  const prepared = await prepareCore({
    official,
    dataRoot,
    home,
    cwd: repoRoot,
    rootId: 'research-root',
    extraPatches: featureBootPatches('research-root'),
  })
  core = await startCore(prepared)
  controller = new ConversationController({
    ctx: core.ctx,
    official,
    rootId: 'research-root',
    cwd: repoRoot,
    history: { record() {}, entries: () => [] },
  })
  await controller.start()
  const systemPrompt = core.ctx.get('systemPrompt')
  const assemble = (agent) => systemPrompt.assemble({ agent, scope: agent })
  const inactive = await assemble(controller.agent)
  const nanoSections = inactive.sections.filter((section) => section.name.startsWith('nano:'))
  assert.deepEqual(nanoSections.map((section) => section.name), [
    'nano:research-discipline',
    'nano:question-discipline',
    'nano:delegation-responsiveness',
  ])
  assert.equal(nanoSections[0].text, approved[0], '常驻正文必须与获批 spec 逐字一致')
  console.log('A1 root nano sections: research -> question -> delegation; approved text matches')

  child = await core.ctx.agents.create({
    sessionId: official.session.SessionId('research-child'),
    parentAgent: controller.agent,
    meta: { cwd: repoRoot, origin: 'subagent' },
    agentOptions: controller.agent.model.current(),
  })
  const childAssembly = await assemble(child.agent)
  assert.equal(
    childAssembly.sections.some((section) => section.name === 'nano:research-discipline'),
    false,
    '真实子 agent 不得继承根 agent 的调研纪律',
  )
  console.log('A2 real child (parentAgent=root) has research discipline: false')

  const inactivePolicy = inactive.sections.find((section) => section.name === 'plan:policy')
  assert.ok(inactivePolicy, '官方 plan:policy 段必须存在')
  assert.equal(inactivePolicy.text, '')
  console.log('A3 inactive plan:policy is empty: true')
  await core.ctx.planMode.set(controller.agent, true)
  const active = await assemble(controller.agent)
  const policy = active.sections.find((section) => section.name === 'plan:policy')?.text
  assert.ok(policy)
  assert.ok(policy.includes('Phase 1 — Explore'))
  assert.equal(policy.includes('Explore first.'), false)
  assert.equal(policy, approved[1], 'plan 覆盖正文必须与获批 spec 逐字一致')
  // §5.4 的约束独立列出，防止覆盖时语义回退。
  const constraints = [
    ["conversational agreement does not approve", /conversational agreement[^\n]+approves nothing/],
    ['read-only planning', /Do not edit or write files, change configuration,[^\n]+carry out the plan/],
    ['stable tool catalog', /tool catalog stays the same across modes[^\n]+override any later tool description or guidance/],
    ['no todo_write', /Do not use todo_write to track this planning phase/],
    ['decision-complete plan', /decision-complete:[^\n]+tests, acceptance criteria, and explicit assumptions/],
    ['exit_plan_mode only and final', /Call exit_plan_mode[^\n]+only and final tool call/],
    ['no prose or question approval', /Do not paste the final plan as a plain reply[^\n]+prose or ask_user_question/],
    ['review rejection or abort stays in plan mode', /review rejects it[^\n]+unavailable or aborted, stay in plan mode/],
  ]
  for (const [name, pattern] of constraints) assert.match(policy, pattern, name)
  // assemble 未传 toolSet，只检查注册视图，不声称本步实际披露的工具相同。
  // 官方 exit_plan_mode 另有条件披露；§5.4 这里验证的是提示约束被保留。
  assert.deepEqual(active.tools, inactive.tools, '切模式不改变已注册工具视图')
  console.log('A3 active plan: five phases; approved text matches; official constraints: 8/8; registered tool view unchanged')
  await core.ctx.planMode.set(controller.agent, false)
  assert.equal((await assemble(controller.agent)).sections.find((s) => s.name === 'plan:policy')?.text, '')
  console.log('A3 deactivated plan:policy is empty: true')
  console.log('implementation prompt evidence passed')
} finally {
  try {
    await child?.dispose()
  } finally {
    try {
      await controller?.dispose()
    } finally {
      try {
        await core?.dispose()
      } finally {
        for (const [key, value] of Object.entries(saved)) {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }
        rmSync(base, { recursive: true, force: true })
      }
    }
  }
}
