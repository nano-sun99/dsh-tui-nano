/**
 * Live seam evidence: boots the real official core, registers Nano's two
 * answerers and drives a real approval request (inside an open turn) and a
 * user-questions request. Run with:
 *
 *   node docs/evidence/2026-10-28-nano-ts/alpha/tools/seams-live.mjs
 *
 * Uses the real credentials in $DSH_HOME and a throwaway data root.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadOfficial } from '../../../../../dist/boot/official.js'
import { bootCore } from '../../../../../dist/boot/assemble.js'
import { DecisionManager } from '../../../../../dist/decisions/manager.js'
import { randomUUID } from 'node:crypto'

const official = await loadOfficial()
const dataRoot = mkdtempSync(join(tmpdir(), 'nano-seams-'))
const core = await bootCore({
  official,
  dataRoot,
  home: process.env.DSH_HOME ?? join(process.env.HOME, '.dsh'),
  cwd: process.cwd(),
  rootId: `seams-${randomUUID().slice(0, 8)}`,
})
const ctx = core.ctx
const decisions = new DecisionManager()
decisions.register(ctx)

const selection = ctx.get('agentDefaultModel').currentSelection()
const handle = await ctx.agents.create({
  sessionId: official.session.SessionId(`seams-${randomUUID().slice(0, 8)}`),
  meta: { cwd: process.cwd() },
  agentOptions: { provider: selection.provider, model: selection.model },
  setup: (agentCtx) => {
    official.agent.installModelSelection(agentCtx, { current: selection, assembled: undefined })
  },
})
const agent = handle.agent

// Question seam: agentless programmatic ask, answered through the same
// DecisionManager methods the UI calls.
const questionPromise = ctx.userQuestions
  .ask({
    questions: [
      {
        id: 'color',
        question: 'Pick a color',
        options: [{ label: 'Red' }, { label: 'Blue' }],
      },
    ],
  })
  .then((answer) => ({ ok: true, answer }))
  .catch((error) => ({ ok: false, error: String(error) }))
await waitFor(() => decisions.prompt?.kind === 'question')
decisions.toggleOption()
decisions.advanceQuestion()
const question = await questionPromise
console.log('QUESTION:', JSON.stringify(question))

// Approval seam: the service requires an open turn, so start a turn and
// answer the request while it is open.
let turnStarted = false
const stopObserve = ctx.on('session/event', (session, event) => {
  if (session === agent.session && event.type === 'turn/start') turnStarted = true
})
agent.followup(
  official.llm.createUserMessage({
    content: [{ type: 'text', text: 'Reply with exactly: pending' }],
    source: { kind: 'user' },
  }),
)
await waitFor(() => turnStarted, 15000)
const approvalPromise = ctx.approval
  .request({ agent, toolName: 'demo-tool', reason: '演示：确认一次只读操作' })
  .then((outcome) => ({ ok: true, outcome }))
  .catch((error) => ({ ok: false, error: String(error) }))
await waitFor(() => decisions.prompt?.kind === 'approval')
decisions.move(-1)
decisions.chooseApproval()
const approval = await approvalPromise
console.log('APPROVAL:', JSON.stringify(approval))
agent.cancel({ kind: 'user' })
stopObserve()
await handle.dispose()
await core.dispose()

function waitFor(predicate, timeoutMs = 10000) {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer)
        resolve()
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer)
        reject(new Error('timeout waiting for condition'))
      }
    }, 20)
  })
}
