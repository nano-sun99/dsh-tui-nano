// 跨会话 / 多根证据（S03 §3.3「跨会话」行的可自动化部分）：
// 两个真 PTY 进程共用一份数据根，验证同根拒第二窗口、双 root 并发、
// 会话日志与 storage 按根隔离。不开窗口、不抢焦点、不动剪贴板。
//
// 边界：这里覆盖目录与进程层；九面在内存里的逐面内容隔离仍要专项证据。
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const nodeBin = process.execPath

const home = mkdtempSync(path.join(os.tmpdir(), 'nano-cross-'))
const dshHome = path.join(home, '.dsh')
const dataRoot = path.join(home, 'data')
mkdirSync(dshHome, { recursive: true })
mkdirSync(dataRoot, { recursive: true })

/** 合成 HOME/DSH_HOME，并清掉继承来的凭据变量：否则会打真实模型请求。 */
function env() {
  const out = {
    ...process.env,
    HOME: home,
    DSH_HOME: dshHome,
    NANO_DATA_ROOT: dataRoot,
    NANO_THEME: 'dark',
    TERM: 'xterm-256color',
  }
  for (const key of [
    'DEEPSEEK_API_KEY',
    'DEEPSEEK_BASE_URL',
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
  ]) {
    delete out[key]
  }
  return out
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
    let settled = false
    const finish = (payload) => {
      if (settled) return
      settled = true
      resolve(payload)
    }
    child.on('exit', (status) => {
      const code = Number.parseInt(stdout.trim().split('\n').at(-1) ?? '', 10)
      finish({ code, status, screen: readScreen(out), stderr })
    })
    child.on('error', (error) => {
      finish({ code: -1, status: -1, screen: '', stderr: String(error) })
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

async function waitForMountLock(rootId, timeoutMs = 15000) {
  const lock = path.join(dataRoot, 'mount', `${rootId}.lock`)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(lock)) {
      try {
        const parsed = JSON.parse(readFileSync(lock, 'utf8'))
        if (Number.isInteger(parsed.pid) && parsed.pid > 0) return parsed.pid
      } catch {
        // 锁正在写入，下一轮再读。
      }
    }
    await sleep(100)
  }
  throw new Error(`首窗口未在 ${timeoutMs}ms 内拿到挂载锁`)
}

/** 递归列出目录下的文件。 */
function filesUnder(dir) {
  const out = []
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...filesUnder(full))
    else if (entry.isFile() && statSync(full).size > 0) out.push(full)
  }
  return out
}

/** 会话日志是 zstd；其他文件按文本读。读不出就返回空串。 */
function textOf(file) {
  const bytes = readFileSync(file)
  try {
    return zstdDecompressSync(bytes).toString('utf8')
  } catch {
    return bytes.toString('utf8')
  }
}

test.before(async () => {
  // 先单独起一次完成 profile 初始化，避免两个进程并发首启时的写竞态。
  const warm = startPty('warmup', { wait: 6, until: '输入消息' })
  await warm.done
})

test.after(() => {
  rmSync(home, { recursive: true, force: true })
})

test('同根第二窗口被拒：另一个进程拿不到同一 root', async () => {
  const first = startPty('same-root', { wait: 12, until: null })
  try {
    await waitForMountLock('same-root')
    const second = runPtySync('same-root', { wait: 4 })
    assert.notEqual(second.code, 0, `第二窗口应失败，实际 ${second.code}`)
    assert.match(second.screen, /占用|已被/, `第二窗口应说明被占用：${second.screen.slice(-500)}`)
  } finally {
    first.child.kill('SIGTERM')
    await first.done
  }
})

test('双 root 并发：两个进程同时起界面，会话与 storage 按根隔离', async () => {
  const marker = 'NANO_CROSS_MARKER_A'
  const a = startPty('root-a', { wait: 10, send: marker, sendWait: 5 })
  const b = startPty('root-b', { wait: 10 })
  const [ra, rb] = await Promise.all([a.done, b.done])
  assert.ok(ra.code === 0 || ra.code === 130, `root-a 退出码异常：${ra.code}`)
  assert.ok(rb.code === 0 || rb.code === 130, `root-b 退出码异常：${rb.code}`)
  assert.match(ra.screen, /输入消息/, 'root-a 应起到正式 UI')
  assert.match(rb.screen, /输入消息/, 'root-b 应起到正式 UI')
  // 正控：marker 确实进了 root-a 的界面，否则下面的负向断言没有意义。
  assert.match(ra.screen, new RegExp(marker), 'root-a 应显示自己发送的内容')
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

  // 内容级负向：root-b 的会话日志与 storage 里不应出现 root-a 的输入。
  for (const file of filesUnder(bDir)) {
    assert.ok(!textOf(file).includes(marker), `root-b 会话日志泄漏了 root-a 的输入：${file}`)
  }
  for (const file of filesUnder(path.join(dataRoot, 'runtime-data', 'root-b', 'storage'))) {
    assert.ok(!textOf(file).includes(marker), `root-b storage 泄漏了 root-a 的输入：${file}`)
  }

  for (const rootId of ['root-a', 'root-b']) {
    assert.ok(
      existsSync(path.join(dataRoot, 'runtime-data', rootId, 'storage')),
      `${rootId} 应有自己的 storage 目录`,
    )
  }
})
