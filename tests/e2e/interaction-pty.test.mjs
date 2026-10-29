// 交互路径证据（S03 §3.3「异常」「安全」行的可自动化部分）：
// 真 PTY 里输入内容并观察界面反应。不开窗口、不抢焦点、不动剪贴板。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const nodeBin = process.execPath

function runInteractive(send, { sendWait = 6 } = {}) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'nano-interaction-'))
  const dshHome = path.join(home, '.dsh')
  mkdirSync(dshHome, { recursive: true })
  const out = path.join(home, 'screen.bin')
  try {
    const result = spawnSync(
      'python3',
      [
        'tests/e2e/pty-start.py',
        '--out',
        out,
        '--wait',
        '8',
        '--until',
        '输入消息',
        '--send',
        send,
        '--send-wait',
        String(sendWait),
        '--cols',
        '100',
        '--rows',
        '30',
        '--',
        nodeBin,
        'dist/bin.js',
        '--root',
        'interaction',
      ],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: 90000,
        env: {
          ...process.env,
          HOME: home,
          DSH_HOME: dshHome,
          NANO_DATA_ROOT: path.join(home, '.dsh-tui-nano'),
          NANO_THEME: 'dark',
          TERM: 'xterm-256color',
        },
      },
    )
    assert.equal(result.status, 0, `pty-start.py 失败：${result.stderr}`)
    const code = Number.parseInt(result.stdout.trim().split('\n').at(-1) ?? '', 10)
    return { code, screen: readFileSync(out, 'utf8').replaceAll(home, '<home>') }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

test('官方调用失败：界面显示回合出错且进程不崩', () => {
  const { code, screen } = runInteractive('hello-no-creds', { sendWait: 6 })
  assert.ok(code === 0 || code === 130, `退出码异常：${code}`)
  assert.match(screen, /回合出错/, '应显示回合出错')
  assert.match(screen, /no API key|API key/i, '应带出官方错误原因')
  assert.doesNotMatch(screen, /fatal|uncaught/i, '不应出现进程级崩溃')
})

test('人工命令：!echo 立即执行并显示输出与退出码', () => {
  const { code, screen } = runInteractive('!echo nano-bang', { sendWait: 4 })
  assert.ok(code === 0 || code === 130, `退出码异常：${code}`)
  assert.match(screen, /\$ echo nano-bang/, '应显示命令行')
  assert.match(screen, /nano-bang/, '应显示命令输出')
  assert.match(screen, /退出码 0/, '应显示退出码')
})
