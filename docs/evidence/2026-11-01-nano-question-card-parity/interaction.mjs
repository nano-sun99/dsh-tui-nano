// Real official host + local mock model + automated PTY; not a visual screenshot substitute.
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Screen } from '../../../tests/e2e/screen.mjs'

const out = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(out, '../../..')
const tmp = mkdtempSync(path.join(os.tmpdir(), 'nano-question-125-'))
const mock = spawn(process.execPath, ['tests/e2e/mock-model.mjs'], { cwd: root, env: { ...process.env, MOCK_SCRIPT: 'question-parity' }, stdio: ['ignore', 'pipe', 'pipe'] })
const port = await new Promise((resolve, reject) => {
  let buffer = ''
  const timer = setTimeout(() => reject(new Error('mock startup timed out')), 5000)
  mock.stdout.on('data', (chunk) => { buffer += chunk; const match = buffer.match(/LISTENING (\d+)/u); if (match) { clearTimeout(timer); resolve(Number(match[1])) } })
  mock.on('error', reject)
})
try {
  for (const mode of ['submit', 'cancel']) {
    const home = path.join(tmp, mode)
    mkdirSync(home)
    const env = { PATH: process.env.PATH, LANG: 'en_US.UTF-8', HOME: home, DSH_HOME: path.join(home, '.dsh'), NANO_DATA_ROOT: path.join(home, '.nano'), NANO_THEME: 'dark', TERM: 'xterm-256color', DEEPSEEK_API_KEY: 'sk-test-00000000000000000000000000000000', DEEPSEEK_BASE_URL: `http://127.0.0.1:${port}` }
    const steps = [{ send: '显示问卷\r', until: '等待你的选择', timeout: 15 }]
    if (mode === 'submit') steps.push(
      { send: '2', delay: .2, until: '确认', timeout: 3 },
      { send: ' ', delay: .2 },
      { send: '\r', delay: .2, until: '提交这组答案', timeout: 3 },
      { send: '\r', delay: .2, until: 'QUESTION_PARITY_RESULT', timeout: 10 },
    )
    else steps.push({ send: '\x1b', delay: .2, until: 'QUESTION_PARITY_RESULT', timeout: 10 })
    const binary = path.join(tmp, `${mode}.bin`)
    const run = spawnSync('python3', ['tests/e2e/pty-sequence.py', '--out', binary, '--cols', '100', '--rows', '36', '--cwd', home, '--steps', JSON.stringify(steps), '--', process.execPath, path.join(root, 'dist/bin.js')], { cwd: root, env, encoding: 'utf8', timeout: 45000 })
    if (run.status !== 0) throw new Error(`${mode} failed: ${run.stderr} ${run.stdout} status=${run.status}`)
    const screen = new Screen(100, 36)
    screen.feed(readFileSync(binary, 'utf8'))
    const text = screen.lines().map((line) => line.trimEnd()).join('\n')
    if (mode === 'cancel' && !text.includes('aborted before the user answered')) throw new Error(`cancellation did not reach tool: ${text}`)
    if (mode === 'submit' && (!text.includes('完整回归') || !text.includes('普通宽度'))) throw new Error(`answers missing: ${text}`)
    writeFileSync(path.join(out, `${mode}.terminal.txt`), `Scenario: ${mode}\nDimensions: 100x36\nInput: ${JSON.stringify(steps)}\n\n${text}\n`)
    console.log(`${mode}: official tool result verified`)
  }
} finally { mock.kill('SIGTERM'); rmSync(tmp, { recursive: true, force: true }) }
