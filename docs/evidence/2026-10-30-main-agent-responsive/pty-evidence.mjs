// 运行中提交的 PTY 证据（spec 2026-10-30-nano-main-agent-responsive §6）。
//
// 用慢速 mock 模型把回合保持在 running：先发「第一条」，再发「第二条」；
// 第二条应走 steer，输入区显示统一 notice，状态行显示「Enter 插话 · Ctrl+C 停止」。
// 只做自动化证据，不开窗口、不抢焦点。
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Screen } from '../../../tests/e2e/screen.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const tmp = mkdtempSync(path.join(os.tmpdir(), 'nano-responsive-'))
const home = path.join(tmp, 'home')
mkdirSync(home, { recursive: true })

const mock = spawn(process.execPath, ['tests/e2e/mock-model.mjs'], {
  cwd: repoRoot,
  env: { ...process.env, MOCK_SCRIPT: 'slow' },
  stdio: ['ignore', 'pipe', 'pipe'],
})

function mockPort() {
  return new Promise((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(() => reject(new Error(`mock 未在 5s 内启动：${buffer}`)), 5000)
    mock.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      const match = buffer.match(/LISTENING (\d+)/)
      if (match) {
        clearTimeout(timer)
        resolve(Number(match[1]))
      }
    })
    mock.on('error', reject)
  })
}

try {
  const port = await mockPort()
  const env = {}
  for (const key of ['PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'SHELL', 'USER']) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  Object.assign(env, {
    HOME: home,
    DSH_HOME: path.join(home, '.dsh'),
    NANO_DATA_ROOT: path.join(home, '.dsh-tui-nano'),
    NANO_THEME: 'dark',
    TERM: 'xterm-256color',
    DEEPSEEK_API_KEY: 'sk-test-00000000000000000000000000000000',
    DEEPSEEK_BASE_URL: `http://127.0.0.1:${port}`,
  })

  const runningPath = path.join(tmp, 'running.bin')
  const result = spawnSync(
    'python3',
    [
      'tests/e2e/pty-start.py',
      '--out',
      path.join(tmp, 'final.bin'),
      '--split-out',
      runningPath,
      '--wait',
      '10',
      '--until',
      '输入消息',
      '--send',
      '第一条\n第二条',
      '--send-wait',
      '0.8',
      '--cwd',
      repoRoot,
      '--',
      process.execPath,
      'dist/bin.js',
    ],
    { cwd: repoRoot, env, encoding: 'utf8' },
  )
  if (result.status !== 0) throw new Error(`pty-start 失败：${result.stderr || result.stdout}`)

  const screen = new Screen(100, 30)
  screen.feed(readFileSync(runningPath, 'utf8'))
  const lines = screen.lines()
  const text = lines.join('\n')
  const required = [
    '运行中',
    '第一条',
    '第二条',
    '已插入（下一 step 或新回合生效）',
    'Enter 插话 · Ctrl+C 停止',
  ]
  const missing = required.filter((marker) => !text.includes(marker))
  if (missing.length > 0) {
    console.error(`缺少标记：${missing.join('、')}`)
    console.error(lines.join('\n'))
    process.exitCode = 1
  } else {
    console.log(lines.slice(26).join('\n'))
    console.log('PTY 证据通过：运行中提交已插入当前回合，notice 与状态行正确')
  }
} finally {
  mock.kill('SIGTERM')
  rmSync(tmp, { recursive: true, force: true })
}
