// 事故回归（issue #164 → #166）：终端挂断 → 诊断写抛 EIO → onUncaught 里又写 → 自激，
// 进程吃满一核不退。判据只有一条硬的：**挂断后 8s 内子进程自己消失**。
//
// 必须构造「无守卫态」（NANO_GUARDED=1 跳过 launcher）：守卫态 fd 1/2 指向日志文件，
// 挂断本来就在 19ms 内干净退出，拿它做用例永远绿、从红变绿失败。
// 改前必红：不修时该 pid 会稳定 100% CPU 不退；用 `ps -o %cpu -p <pid>` 可复核。
// 也不断言「日志里有『关停』」：无守卫态根本不建日志，这正是它的特征。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const nodeBin = process.execPath

/** 合成 HOME/DSH_HOME，并清掉继承来的凭据变量：否则会打真实模型请求。 */
function childEnv(home, dshHome) {
  const env = {
    ...process.env,
    HOME: home,
    DSH_HOME: dshHome,
    NANO_DATA_ROOT: path.join(home, '.dsh-tui-nano'),
    NANO_THEME: 'dark',
    TERM: 'xterm-256color',
    // 无守卫态 = 事故现场：fd 1/2 就是终端。
    NANO_GUARDED: '1',
  }
  for (const key of [
    'DEEPSEEK_API_KEY',
    'DEEPSEEK_BASE_URL',
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
  ]) {
    delete env[key]
  }
  return env
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** 子进程 setsid 出来的，pgid == pid：整组杀掉，避免遗留持锁进程。 */
function killgroup(pid) {
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    // 已经没了。
  }
}

test('挂断后 8s 内进程自己消失（无守卫态）', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'nano-exit-hardening-'))
  const dshHome = path.join(home, '.dsh')
  mkdirSync(dshHome, { recursive: true })
  const out = path.join(home, 'screen.bin')
  let pid = 0
  try {
    const startedAt = Date.now()
    const result = spawnSync(
      'python3',
      [
        'tests/e2e/pty-start.py',
        '--out',
        out,
        '--wait',
        '15',
        '--until',
        '输入消息',
        // 真挂断：关掉 master，让 slave 侧的写入拿到 EIO（不是 --no-read 那种缓冲写满）。
        '--hangup',
        // 到点没退也别替用例收拾现场：先让断言看见「pid 还在」。
        '--no-cleanup',
        '--min-uptime',
        '1.2',
        '--exit-wait',
        '8',
        '--cols',
        '100',
        '--rows',
        '30',
        '--',
        nodeBin,
        'dist/bin.js',
        '--root',
        'repro',
      ],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: 180000,
        env: childEnv(home, dshHome),
      },
    )
    const elapsed = Date.now() - startedAt
    assert.equal(result.status, 0, `pty-start.py 失败：${result.stderr}`)

    const lines = result.stdout.trim().split('\n')
    const pidLine = lines.find((line) => line.startsWith('pid='))
    assert.ok(pidLine, `pty 必须打印 child pid：${result.stdout}`)
    pid = Number.parseInt(pidLine.slice(4), 10)

    // 前置断言先过：否则 dist 缺失 → 127 立即退出会让后面的空断言假绿。
    assert.ok(Number.isInteger(pid) && pid > 0, `非法 pid：${pidLine}`)
    assert.ok(elapsed > 1000, `进程必须活过 1s，实际 ${elapsed}ms`)
    const screen = readFileSync(out, 'utf8')
    assert.match(screen, /输入消息/, '界面必须真的起来过（启动即崩不算复现）')

    // 唯一硬断言：挂断后 8s 内 pid 消失。
    assert.equal(
      lines.find((line) => line.startsWith('exited=')),
      'exited=1',
      `挂断后 8s 内进程必须自己退出（不修时这里 100% CPU 不退）；pid=${pid}`,
    )
    assert.equal(alive(pid), false, `挂断后 pid 仍在：${pid}`)
  } finally {
    if (pid > 0) killgroup(pid)
    rmSync(home, { recursive: true, force: true })
  }
})
