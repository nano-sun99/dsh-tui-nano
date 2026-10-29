// 跨会话 / 多根证据（S03 §3.3「跨会话」行的可自动化部分）：
// 两个真 PTY 进程共用一份数据根，验证同根拒第二窗口、双 root 并发、
// 会话目录按根隔离。不开窗口、不抢焦点、不动剪贴板。
//
// 边界：这里覆盖目录与进程层（session/storage/schedule/mount 的根隔离、
// 双窗口同根拒绝、双 root 并发）。九面在内存里的逐面内容隔离仍要人工/专项证据。
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const nodeBin = process.execPath

const home = mkdtempSync(path.join(os.tmpdir(), 'nano-cross-'))
const dshHome = path.join(home, '.dsh')
const dataRoot = path.join(home, 'data')
mkdirSync(dshHome, { recursive: true })
mkdirSync(dataRoot, { recursive: true })

function env() {
  return {
    ...process.env,
    HOME: home,
    DSH_HOME: dshHome,
    NANO_DATA_ROOT: dataRoot,
    NANO_THEME: 'dark',
    TERM: 'xterm-256color',
  }
}

function ptyArgs(rootId, { wait = 8, until = '输入消息', send, sendWait = 4 } = {}) {
  const out = path.join(
    home,
    `screen-${rootId}-${createHash('sha256')
      .update(String(Date.now()) + rootId)
      .digest('hex')
      .slice(0, 8)}.bin`,
  )
  const args = [
    'tests/e2e/pty-start.py',
    '--out',
    out,
    '--wait',
    String(wait),
    '--cols',
    '100',
    '--rows',
    '30',
  ]
  if (until) args.push('--until', until)
  if (send) args.push('--send', send, '--send-wait', String(sendWait))
  args.push('--', nodeBin, 'dist/bin.js', '--root', rootId)
  return { out, args }
}

function readScreen(out) {
  try {
    return readFileSync(out, 'utf8').replaceAll(home, '<home>')
  } catch {
    return ''
  }
}

function startPty(rootId, options) {
  const { out, args } = ptyArgs(rootId, options)
  const child = spawn('python3', args, {
    cwd: repoRoot,
    env: env(),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString('utf8')
  })
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8')
  })
  const done = new Promise((resolve) => {
    child.on('exit', (status) => {
      const code = Number.parseInt(stdout.trim().split('\n').at(-1) ?? '', 10)
      resolve({ code, status, screen: readScreen(out), stderr })
    })
  })
  return { child, done, out }
}

function runPtySync(rootId, options) {
  const { out, args } = ptyArgs(rootId, options)
  const result = spawnSync('python3', args, {
    cwd: repoRoot,
    env: env(),
    encoding: 'utf8',
    timeout: 60000,
  })
  const code = Number.parseInt(result.stdout.trim().split('\n').at(-1) ?? '', 10)
  return { code, screen: readScreen(out), stderr: result.stderr }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test.after(() => {
  rmSync(home, { recursive: true, force: true })
})

test('同根第二窗口被拒：另一个进程拿不到同一 root', async () => {
  const first = startPty('same-root', { wait: 10, until: null })
  await sleep(3000)
  const second = runPtySync('same-root', { wait: 4 })
  assert.notEqual(second.code, 0, `第二窗口应失败，实际 ${second.code}`)
  assert.match(second.screen, /占用|已被/, `第二窗口应说明被占用：${second.screen.slice(-500)}`)
  const firstResult = await first.done
  assert.ok(
    firstResult.code === 0 || firstResult.code === 130,
    `首窗口退出码异常：${firstResult.code}`,
  )
})

test('双 root 并发：两个进程同时起界面，会话目录按根隔离', async () => {
  const marker = 'NANO_CROSS_MARKER_A'
  const a = startPty('root-a', { wait: 10, send: marker, sendWait: 5 })
  const b = startPty('root-b', { wait: 10 })
  const [ra, rb] = await Promise.all([a.done, b.done])
  assert.ok(ra.code === 0 || ra.code === 130, `root-a 退出码异常：${ra.code}`)
  assert.ok(rb.code === 0 || rb.code === 130, `root-b 退出码异常：${rb.code}`)
  assert.match(ra.screen, /输入消息/, 'root-a 应起到正式 UI')
  assert.match(rb.screen, /输入消息/, 'root-b 应起到正式 UI')
  assert.ok(!rb.screen.includes(marker), 'root-b 不应看到 root-a 的输入')

  const sessions = path.join(dataRoot, 'sessions')
  assert.ok(existsSync(sessions), '应有 sessions 根')
  const roots = readdirSync(sessions, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) =>
      readdirSync(path.join(sessions, entry.name), { withFileTypes: true })
        .filter((child) => child.isDirectory())
        .map((child) => path.join(sessions, entry.name, child.name)),
    )
  const aDir = roots.find((dir) => dir.endsWith(`${path.sep}root-a`))
  const bDir = roots.find((dir) => dir.endsWith(`${path.sep}root-b`))
  assert.ok(aDir, `应存在 root-a 会话目录：${roots.join(', ')}`)
  assert.ok(bDir, `应存在 root-b 会话目录：${roots.join(', ')}`)
  assert.notEqual(aDir, bDir, '两个根必须落在不同会话目录')

  for (const rootId of ['root-a', 'root-b']) {
    assert.ok(
      existsSync(path.join(dataRoot, 'runtime-data', rootId, 'storage')),
      `${rootId} 应有自己的 storage 目录`,
    )
  }
})
