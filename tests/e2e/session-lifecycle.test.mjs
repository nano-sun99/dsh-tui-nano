// 会话生命周期与多窗口（spec 2026-11-02-nano-session-lifecycle §5）。
// 真 PTY、合成 HOME/DSH_HOME/数据根；不触真实模型与凭据。
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const nodeBin = process.execPath
const bin = path.join(repoRoot, 'dist/bin.js')

const home = mkdtempSync(path.join(os.tmpdir(), 'nano-lifecycle-'))
const dshHome = path.join(home, '.dsh')
const dataRoot = path.join(home, 'data')
for (const dir of [dshHome, dataRoot]) mkdirSync(dir, { recursive: true })

const workA = path.join(home, 'work-a')
const workB = path.join(home, 'work-b')
const workC = path.join(home, 'work-c')
const workD = path.join(home, 'work-d')
const workEmpty = path.join(home, 'work-empty')
for (const dir of [workA, workB, workC, workD, workEmpty]) mkdirSync(dir, { recursive: true })

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

function screenPath(name) {
  return path.join(home, `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}.bin`)
}

function ptyArgs(name, args, options = {}) {
  const {
    cwd = repoRoot,
    wait = 20,
    until = '输入消息',
    keys,
    keysWait = 2,
    keysAfter,
    keysUntil,
    sendRaw,
    sendUntil,
  } = options
  const out = screenPath(name)
  const argv = [
    'tests/e2e/pty-start.py',
    '--out',
    out,
    '--wait',
    String(wait),
    '--cols',
    '100',
    '--rows',
    '30',
    '--cwd',
    cwd,
  ]
  if (until) argv.push('--until', until)
  if (sendRaw) argv.push('--send-raw', sendRaw)
  if (sendUntil) argv.push('--send-until', sendUntil)
  if (keysAfter) argv.push('--keys-after', keysAfter)
  if (keysUntil) argv.push('--keys-until', keysUntil)
  if (keys) argv.push('--keys', keys, '--keys-wait', String(keysWait))
  argv.push('--', nodeBin, bin, ...args)
  return { out, argv }
}

function readScreen(out) {
  try {
    return readFileSync(out, 'utf8').replaceAll(home, '<home>')
  } catch {
    return ''
  }
}

/** 去掉 CSI/OSC 控制序列，断言只看用户可见文字（避免正则字面量里的控制字符）。 */
const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)
const ANSI_SEQUENCES = [
  new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`, 'gu'),
  new RegExp(`${ESC}\\][^${BEL}]*${BEL}`, 'gu'),
  new RegExp(`${ESC}[()][A-Za-z0-9]`, 'gu'),
]

function plain(screen) {
  return ANSI_SEQUENCES.reduce((text, pattern) => text.replace(pattern, ''), screen)
}

function runPty(name, args, options = {}) {
  const { out, argv } = ptyArgs(name, args, options)
  const result = spawnSync('python3', argv, {
    cwd: repoRoot,
    env: env(),
    encoding: 'utf8',
    timeout: 90000,
  })
  const code = Number.parseInt(result.stdout.trim().split('\n').at(-1) ?? '', 10)
  return { code, screen: readScreen(out), text: plain(readScreen(out)), stderr: result.stderr }
}

function startPty(name, args, options = {}) {
  const { out, argv } = ptyArgs(name, args, options)
  const child = spawn('python3', argv, {
    cwd: repoRoot,
    env: env(),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  const done = new Promise((resolve) => {
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8')
    })
    child.on('exit', (status) => {
      resolve({ code: Number.parseInt(stdout.trim().split('\n').at(-1) ?? '', 10), status })
    })
  })
  return { child, done, out }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 数据文件里的 cwd 是 Node 的物理路径（macOS /var → /private/var）。 */
function cwdKey(dir) {
  try {
    return realpathSync.native(dir)
  } catch {
    return dir
  }
}

function lastSession() {
  try {
    return JSON.parse(readFileSync(path.join(dataRoot, 'last-session.json'), 'utf8'))
  } catch {
    return undefined
  }
}

function sessionIds() {
  const root = path.join(dataRoot, 'sessions')
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((project) =>
      readdirSync(path.join(root, project.name), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name),
    )
}

function lockIds() {
  const dir = path.join(dataRoot, 'mount')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => name.endsWith('.lock'))
    .map((name) => name.slice(0, -'.lock'.length))
}

function lockPids() {
  const dir = path.join(dataRoot, 'mount')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => name.endsWith('.lock'))
    .map((name) => {
      try {
        const parsed = JSON.parse(readFileSync(path.join(dir, name), 'utf8'))
        return Number.isInteger(parsed.pid) ? parsed.pid : undefined
      } catch {
        return undefined
      }
    })
    .filter((pid) => pid !== undefined)
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

async function waitFor(predicate, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = predicate()
    if (value) return value
    await sleep(100)
  }
  throw new Error(`等待超时（${timeoutMs}ms）`)
}

test.before(async () => {
  // 先单独完成 profile 初始化，避免并发首启的写竞态。
  const warm = runPty('warmup', ['--root', 'warmup'], { cwd: workA, wait: 25 })
  assert.ok(warm.code === 0 || warm.code === 130, `warmup 退出码异常：${warm.code}`)
  assert.match(warm.text, /输入消息/)
  await sleep(300)
})

test.after(() => {
  rmSync(home, { recursive: true, force: true })
})

test('--help 显示新的启动矩阵，互斥组合在进 TUI 前报错', () => {
  const help = spawnSync(nodeBin, [bin, '--help'], {
    cwd: repoRoot,
    env: env(),
    encoding: 'utf8',
  })
  assert.equal(help.status, 0)
  assert.match(help.stdout, /-c, --continue/)
  assert.match(help.stdout, /-r, --resume/)
  assert.match(help.stdout, /--root <id>\s+使用指定会话身份/)
  assert.doesNotMatch(help.stdout, /默认沿用上一次的根/)

  const rootWithContinue = runPty('mutex-root', ['--root', 'x', '-c'], {
    cwd: workEmpty,
    until: null,
    wait: 8,
  })
  assert.notEqual(rootWithContinue.code, 0)
  assert.match(rootWithContinue.text, /--root 不能和 -c \/ -r 同时使用/)

  const continueWithResume = runPty('mutex-cr', ['-c', '-r'], {
    cwd: workEmpty,
    until: null,
    wait: 8,
  })
  assert.notEqual(continueWithResume.code, 0)
  assert.match(continueWithResume.text, /-c 和 -r 只能选一个/)
})

test('同一 cwd 开两个 nano：两个会话 id、两把锁；关 A 不终止 B', async () => {
  const beforeLocks = new Set(lockIds())

  // B 保持运行（until:null）；A 看到 UI 后由 pty-start 发 Ctrl+C 正常退出。
  const b = startPty('two-b', [], { cwd: workB, wait: 30, until: null })
  let a
  try {
    const bId = await waitFor(() => {
      const fresh = lockIds().filter((id) => !beforeLocks.has(id))
      return fresh.length === 1 ? fresh[0] : undefined
    })

    a = startPty('two-a', [], { cwd: workB, wait: 30, until: '输入消息' })
    const ids = await waitFor(() => {
      const fresh = lockIds().filter((id) => !beforeLocks.has(id))
      return fresh.length === 2 ? fresh : undefined
    })
    assert.equal(new Set(ids).size, 2, '两个窗口应各拿一把不同会话的锁')
    const aId = ids.find((id) => id !== bId)
    assert.ok(aId, '应能分辨 A 的锁')
    const pids = lockPids()
    assert.ok(pids.length >= 2, '两把锁都应带存活 pid')
    for (const pid of pids) assert.ok(pidAlive(pid), `锁里的 pid ${pid} 应存活`)

    await a.done
    assert.match(plain(readScreen(a.out)), /输入消息/, 'A 应起到正式 UI 再退出')
    assert.ok(!lockIds().includes(aId), 'A 正常退出应释放自己的锁')
    assert.ok(lockIds().includes(bId), 'B 的锁应保留')
    const bLock = JSON.parse(readFileSync(path.join(dataRoot, 'mount', `${bId}.lock`), 'utf8'))
    assert.ok(pidAlive(bLock.pid), '关 A 不应终止 B')
    assert.ok(b.child.exitCode === null, 'B 的 pty 进程应仍在运行')
  } finally {
    if (a !== undefined && a.child.exitCode === null) a.child.kill('SIGTERM')
    b.child.kill('SIGTERM')
    await Promise.all([a?.done ?? Promise.resolve(), b.done])
  }
})

test('`-c` 续 last-session 指向的会话，而不是最新创建的那个', () => {
  const first = runPty('continue-first', [], { cwd: workC, wait: 30 })
  assert.match(first.text, /输入消息/)
  const s1 = lastSession()?.byCwd?.[cwdKey(workC)]?.sessionId
  assert.ok(s1, '首个会话应写入 last-session')

  const second = runPty('continue-second', [], { cwd: workC, wait: 30 })
  assert.match(second.text, /输入消息/)
  const s2 = lastSession()?.byCwd?.[cwdKey(workC)]?.sessionId
  assert.ok(s2 && s2 !== s1, '第二次默认启动应生成不同会话')

  // 精确恢复旧会话后，last-session 指回 s1；随后 `-c` 必须选 s1。
  const restored = runPty('continue-restore', ['-r', s1], { cwd: workC, wait: 30 })
  assert.match(restored.text, /输入消息/)
  assert.equal(lastSession()?.byCwd?.[cwdKey(workC)]?.sessionId, s1)

  const before = sessionIds().length
  const continued = runPty('continue-hit', ['-c'], { cwd: workC, wait: 30 })
  assert.match(continued.text, /输入消息/)
  assert.equal(sessionIds().length, before, '-c 不应新建会话文件')
  assert.equal(lastSession()?.byCwd?.[cwdKey(workC)]?.sessionId, s1)
})

test('`-c` 在无会话的 cwd 报错退出，不创建会话', () => {
  const before = new Set(sessionIds())
  const result = runPty('continue-empty', ['-c'], { cwd: workEmpty, until: null, wait: 10 })
  assert.notEqual(result.code, 0)
  assert.match(result.text, /当前目录没有可续接的会话/)
  assert.deepEqual(
    sessionIds().filter((id) => !before.has(id)),
    [],
    '-c 失败不应创建会话',
  )
})

test('`-r` 先建默认新会话再开面板；只有当前会话时显示空态，Esc 留在新会话', () => {
  const before = sessionIds().length
  const result = runPty('resume-panel', ['-r'], {
    cwd: workD,
    wait: 30,
    until: '全部目录',
    keys: 'esc',
    keysWait: 2,
  })
  assert.match(result.text, /会话 · /)
  assert.match(result.text, /a 全部目录/)
  assert.match(result.text, /（当前）/)
  assert.match(result.text, /没有可恢复的会话；直接在新会话里开始，或按 a 看全部目录/)
  assert.equal(sessionIds().length, before + 1, '-r 只应创建默认新会话，不额外 create')
  assert.match(result.text, /输入消息/)
})

test('`-r` 面板 a 切全部目录；选择已有会话经受控重启进入', () => {
  // 默认只看当前 cwd：workD 自己的会话；a 之后能看到 work-c 的会话。
  const allDirs = runPty('resume-all-dirs', ['-r'], {
    cwd: workD,
    wait: 30,
    until: '全部目录',
    sendRaw: 'a',
    sendUntil: 'work-c',
    keys: 'esc',
    keysWait: 2,
  })
  assert.match(allDirs.text, /work-c/)

  // 同一 cwd 选另一个会话：面板里的当前新会话排第一，down 选旧会话后 Enter。
  const before = lastSession()?.byCwd?.[cwdKey(workC)]?.sessionId
  const selected = runPty('resume-select', ['-r'], {
    cwd: workC,
    wait: 30,
    until: '（当前）',
    keys: 'down,enter',
    keysAfter: '（当前）',
    keysUntil: '输入消息',
    keysWait: 20,
  })
  assert.match(selected.text, /输入消息/)
  const after = lastSession()?.byCwd?.[cwdKey(workC)]?.sessionId
  assert.ok(after && after !== before, '面板选择后应重启进入另一个会话')
})

test('`-r <id>` 精确恢复；NotFound、跨目录、被占用都报错且不创建', async () => {
  const before = new Set(sessionIds())
  const seed = runPty('resume-seed', [], { cwd: workC, wait: 30 })
  assert.match(seed.text, /输入消息/)
  const id = lastSession()?.byCwd?.[cwdKey(workC)]?.sessionId
  assert.ok(id, '应拿到 seed 会话 id')

  const restored = runPty('resume-id', ['-r', id], { cwd: workC, wait: 30 })
  assert.match(restored.text, /输入消息/)
  assert.deepEqual(
    sessionIds().filter((session) => !before.has(session)),
    [id],
    '精确恢复不应新建会话',
  )

  const missing = runPty('resume-missing', ['-r', 'no-such-session'], {
    cwd: workC,
    until: null,
    wait: 10,
  })
  assert.notEqual(missing.code, 0)
  assert.match(missing.text, /会话 no-such-session 不存在/)

  const crossDir = runPty('resume-crossdir', ['-r', id], {
    cwd: workEmpty,
    until: null,
    wait: 10,
  })
  assert.notEqual(crossDir.code, 0)
  assert.match(crossDir.text, /该会话属于 .*work-c；请在该目录启动 nano。/)

  // 第一窗口占住会话；第二窗口必须报 pid 与出路，且不删锁、不影响第一窗口。
  const holder = startPty('resume-holder', ['--root', id], { cwd: workC, wait: 30 })
  try {
    await waitFor(() => existsSync(path.join(dataRoot, 'mount', `${id}.lock`)))
    const occupied = runPty('resume-occupied', ['-r', id], {
      cwd: workC,
      until: null,
      wait: 15,
    })
    assert.notEqual(occupied.code, 0)
    assert.match(occupied.text, /已在另一个窗口打开（pid \d+）/)
    assert.match(occupied.text, /换一个会话用 nano -r/)
    const holderLock = JSON.parse(readFileSync(path.join(dataRoot, 'mount', `${id}.lock`), 'utf8'))
    assert.ok(pidAlive(holderLock.pid), '占用失败不应删锁或杀掉第一窗口')
  } finally {
    holder.child.kill('SIGTERM')
    await holder.done
  }
})

test('默认启动忽略 last-root；last-session 损坏时回退官方 createdAt', () => {
  const sentinel = 'last-root-sentinel'
  writeFileSync(path.join(dataRoot, 'last-root'), `${sentinel}\n`)

  const fresh = runPty('lastroot', [], { cwd: workEmpty, wait: 30 })
  assert.match(fresh.text, /输入消息/)
  const chosen = lastSession()?.byCwd?.[cwdKey(workEmpty)]?.sessionId
  assert.ok(chosen && chosen !== sentinel, '默认启动不应沿用 last-root')
  assert.ok(!sessionIds().includes(sentinel), 'last-root 指向的会话不应被打开或创建')
  assert.equal(readFileSync(path.join(dataRoot, 'last-root'), 'utf8').trim(), sentinel)

  // 同一 cwd 再开一个，拿到更新的会话；损坏提示后 `-c` 应回退到 createdAt 最新。
  const newer = runPty('lastsession-second', [], { cwd: workEmpty, wait: 30 })
  assert.match(newer.text, /输入消息/)
  const newest = lastSession()?.byCwd?.[cwdKey(workEmpty)]?.sessionId
  assert.ok(newest && newest !== chosen)
  writeFileSync(path.join(dataRoot, 'last-session.json'), '{oops')

  const fallback = runPty('lastsession-corrupt', ['-c'], { cwd: workEmpty, wait: 30 })
  assert.match(fallback.text, /输入消息/)
  const repaired = JSON.parse(readFileSync(path.join(dataRoot, 'last-session.json'), 'utf8'))
  assert.equal(repaired.byCwd[cwdKey(workEmpty)].sessionId, newest)
})

test('last-session 不可写时 `-c` 仍按官方列表启动', () => {
  const target = path.join(dataRoot, 'last-session.json')
  rmSync(target, { recursive: true, force: true })
  mkdirSync(target)
  const result = runPty('lastsession-unwritable', ['-c'], { cwd: workEmpty, wait: 30 })
  assert.match(result.text, /输入消息/)
})
