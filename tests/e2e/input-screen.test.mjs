// 输入区/补全的 PTY 屏幕测试（不开窗口）：把真实终端字节喂进最小 VT 模型，
// 断言最终屏幕上的输入行、上下边框和补全弹层。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { Screen } from './screen.mjs'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const nodeBin = process.execPath

function runScreen(raw, { wait = 3 } = {}) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'nano-input-screen-'))
  const out = path.join(home, 'screen.bin')
  const steady = path.join(home, 'steady.bin')
  try {
    const env = {
      ...process.env,
      HOME: home,
      DSH_HOME: path.join(home, '.dsh'),
      NANO_DATA_ROOT: path.join(home, '.dsh-tui-nano'),
      NANO_THEME: 'dark',
      TERM: 'xterm-256color',
    }
    mkdirSync(env.DSH_HOME, { recursive: true })
    for (const key of ['DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL']) delete env[key]
    const result = spawnSync(
      'python3',
      [
        'tests/e2e/pty-start.py',
        '--out',
        out,
        '--wait',
        '10',
        '--until',
        '输入消息',
        '--send-raw',
        raw,
        '--send-wait',
        String(wait),
        '--split-out',
        steady,
        '--cols',
        '100',
        '--rows',
        '35',
        '--',
        nodeBin,
        'tests/e2e/../../dist/bin.js',
        '--root',
        'input-screen',
      ],
      { cwd: repoRoot, env, encoding: 'utf8', timeout: 60000 },
    )
    assert.equal(result.status, 0, `pty-start.py 失败：${result.stderr}`)
    const screen = new Screen(100, 35)
    // 用发 Ctrl+C 之前的稳定态，避免把退出帧当成 UI 状态。
    screen.feed(readFileSync(steady, 'utf8'))
    return screen.lines()
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

test('输入 hello 后占位符消失，输入行上方留白、下方一条下边框', () => {
  const lines = runScreen('hello')
  const row = lines.findIndex((line) => line.includes('hello'))
  assert.ok(row >= 0, `屏幕上应出现 hello：\n${lines.join('\n')}`)
  assert.ok(!lines.join('\n').includes('输入消息'), '输入后占位符应消失')
  assert.equal(lines[row - 1]?.trim(), '', '输入行上方应是一行留白')
  assert.ok(lines[row + 1]?.trimStart().startsWith('▔'), '输入行下方应是下边框')
})

test('输入 /mode 时补全弹层可见、最多 5 项、包含 /model', () => {
  const lines = runScreen('/mode')
  const text = lines.join('\n')
  assert.match(text, /命令 \/ 技能/, '应出现补全提示行')
  assert.match(text, /\/model/, '应包含 /model 候选')
  assert.match(text, /Enter 运行/, '命令补全应提示 Enter 运行')
  const itemLines = lines.filter((line) => line.includes(' – '))
  assert.ok(itemLines.length > 0, '补全候选应带描述')
  assert.ok(itemLines.length <= 5, `候选不应超过 5 项，实际 ${itemLines.length}`)
})
