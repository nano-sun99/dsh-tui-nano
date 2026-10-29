/**
 * 终端附着探针：验证 in-process 也能走官方 Remote 流。
 *
 * `terminalController.attach()` 要求 `ctx.invocation`（Remote 调用上下文），
 * 直接调方法会抛错。本探针用 `ctx.typertGateway.stream()` + 自建 `Peer`
 * 打开 `terminal/attach`，验证：拿到 snapshot 帧、写入能回显、关闭干净。
 *
 * 用法：node docs/evidence/2026-10-28-nano-ts/beta/tools/terminal-attach-probe.mjs
 */
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { loadOfficial } from '../../../../../dist/boot/official.js'
import { prepareCore, startCore } from '../../../../../dist/boot/assemble.js'
import { Peer } from '@deepseek-ai/dsh-client-connection'

const ROOT_ID = 'probe-term-root'
const base = '/tmp/nano-term-probe'
const dataRoot = join(base, 'data')
const home = join(base, 'home')
rmSync(base, { recursive: true, force: true })
mkdirSync(dataRoot, { recursive: true })
mkdirSync(home, { recursive: true })

const result = {}
const official = await loadOfficial()
const prepared = await prepareCore({ official, dataRoot, home, cwd: process.cwd(), rootId: ROOT_ID })
prepared.patches.push({
  insert: [{ id: 'terminal-controller', name: '@deepseek-ai/dsh-api-terminal-controller' }],
})
const core = await startCore(prepared)
const ctx = core.ctx

try {
  const selection = ctx.get('agentDefaultModel').currentSelection()
  const agentOptions = { provider: selection.provider, model: selection.model }
  const setup = (agentCtx) => {
    official.agent.installModelSelection(agentCtx, { current: selection, assembled: undefined })
  }
  const handle = await ctx.agents.create({
    sessionId: official.session.SessionId(ROOT_ID),
    meta: { cwd: process.cwd() },
    agentOptions,
    setup,
  })
  const terminal = ctx.get('terminalController')
  const signal = new AbortController().signal
  const info = await terminal.create(handle.agent, { id: 'probe-term-1', cols: 80, rows: 24 }, signal)
  result.created = { id: info.id, shell: info.shell.path, state: info.state }

  // 上行：把写入项推给官方 attach 流。
  const queue = []
  let wake
  const uplink = (async function* push() {
    for (;;) {
      if (queue.length > 0) {
        yield queue.shift()
        continue
      }
      await new Promise((resolve) => {
        wake = resolve
      })
    }
  })()
  const send = (item) => {
    queue.push(item)
    wake?.()
  }

  const peer = new Peer(ctx, { principal: { kind: 'owner' }, interactions: 'none' })
  const gateway = ctx.get('typertGateway')
  const frames = await gateway.stream({
    namespace: 'terminal',
    method: 'attach',
    args: { agentId: ROOT_ID, id: info.id },
    uplink,
    peer,
    signal,
  })

  const seen = []
  const raw = []
  let snapshot = null
  const iter = frames[Symbol.asyncIterator]()
  const deadline = Date.now() + 8000
  let wrote = false
  while (Date.now() < deadline) {
    const next = await Promise.race([
      iter.next(),
      new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 500)),
    ])
    if (next.timeout) {
      if (seen.length > 0 && !wrote) {
        wrote = true
        send({ type: 'write', sequence: 1, data: 'echo nano-terminal-probe\r' })
      }
      continue
    }
    if (next.done) break
    const frame = next.value
    seen.push(frame.type)
    raw.push(JSON.stringify(frame).slice(0, 200))
    if (frame.type === 'snapshot') snapshot = frame.screen ?? JSON.stringify(frame).slice(0, 200)
    const text = JSON.stringify(frame)
    if (text.includes('nano-terminal-probe') && frame.type !== 'snapshot') {
      result.echo = true
      break
    }
  }
  result.frames = seen.slice(0, 12)
  result.raw = raw.slice(0, 6)
  result.snapshotHead = typeof snapshot === 'string' ? snapshot.slice(0, 60) : null
  result.sawSnapshot = snapshot !== null
  result.echo = result.echo ?? false
  await peer.dispose()
  await terminal.close(handle.agent, info.id)
  result.closed = true
} catch (error) {
  result.error = String(error?.message ?? error)
  result.stack = String(error?.stack ?? '').split('\n').slice(0, 6)
}

await core.dispose()
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
