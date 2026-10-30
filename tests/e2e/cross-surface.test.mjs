// B3 跨会话内容隔离（S03 §3.3「跨会话」行）：同一数据根、不同 root，
// 在 A 制造 transcript / 草稿 / 附件 / 审批 / 问题五种内容，B 的界面不得出现。
// 只用真 PTY 与本地 mock；不开窗口、不抢焦点、不碰真实凭据。
//
// 边界：终端 / 队列 / Monitor / 调度四面需要各自的驱动或存储断言，另见 README。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const nodeBin = process.execPath
const home = mkdtempSync(path.join(os.tmpdir(), 'nano-surface-'))
const dshHome = path.join(home, '.dsh')
const dataRoot = path.join(home, 'data')
const workspace = path.join(home, 'workspace')
mkdirSync(dshHome, { recursive: true })
mkdirSync(dataRoot, { recursive: true })
mkdirSync(workspace, { recursive: true })
writeFileSync(path.join(workspace, 'attach-MARKER.txt'), 'attachment marker\n')

function childEnv(port) {
  return {
    HOME: home,
    DSH_HOME: dshHome,
    NANO_DATA_ROOT: dataRoot,
    NANO_THEME: 'dark',
    TERM: 'xterm-256color',
    PATH: process.env.PATH,
    LANG: process.env.LANG,
    LC_ALL: process.env.LC_ALL,
    TMPDIR: process.env.TMPDIR,
    SHELL: process.env.SHELL,
    USER: process.env.USER,
    DEEPSEEK_API_KEY: 'sk-test-00000000000000000000000000000000',
    DEEPSEEK_BASE_URL: `http://127.0.0.1:${port}`,
  }
}

function startMock(mode) {
  const child = spawn(nodeBin, ['tests/e2e/mock-model.mjs'], {
    cwd: repoRoot,
    env: { ...process.env, MOCK_SCRIPT: mode },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return new Promise((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`mock 未在 5s 内启动：${buffer}`))
    }, 5000)
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      const match = buffer.match(/LISTENING (\d+)/)
      if (match) {
        clearTimeout(timer)
        resolve({ child, port: Number(match[1]) })
      }
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

function runRoot({ rootId, port, send, sendRaw, sendUntil, wait = 10, sendWait = 8, split }) {
  const out = path.join(home, `screen-${rootId}.bin`)
  const splitPath = split ? path.join(home, `split-${rootId}.bin`) : undefined
  const args = [
    'tests/e2e/pty-start.py',
    '--out',
    out,
    '--wait',
    String(wait),
    '--until',
    '输入消息',
    '--cwd',
    workspace,
    '--cols',
    '100',
    '--rows',
    '30',
  ]
  if (splitPath) args.push('--split-out', splitPath)
  if (send) args.push('--send', send, '--send-wait', String(sendWait))
  if (sendUntil) args.push('--send-until', sendUntil)
  if (sendRaw) args.push('--send-raw', sendRaw, '--send-wait', String(sendWait))
  args.push('--', nodeBin, path.join(repoRoot, 'dist', 'bin.js'), '--root', rootId)
  return new Promise((resolve) => {
    const child = spawn('python3', args, {
      cwd: repoRoot,
      env: childEnv(port ?? 9),
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
    child.on('exit', (status) => {
      const file = splitPath && existsSync(splitPath) ? splitPath : out
      const screen = existsSync(file) ? readFileSync(file, 'utf8').replaceAll(home, '<home>') : ''
      resolve({ status, screen, stderr })
    })
  })
}

function runSequence({ rootId, steps, wait = 10, split, port = 9 }) {
  const out = path.join(home, `seq-${rootId}.bin`)
  const splitPath = split ? path.join(home, `seq-split-${rootId}.bin`) : undefined
  const args = [
    'tests/e2e/pty-sequence.py',
    '--out',
    out,
    '--wait',
    String(wait),
    '--until',
    '输入消息',
    '--cwd',
    workspace,
    '--cols',
    '100',
    '--rows',
    '30',
    '--steps',
    JSON.stringify(steps),
  ]
  if (splitPath) args.push('--split-out', splitPath)
  args.push('--', nodeBin, path.join(repoRoot, 'dist', 'bin.js'), '--root', rootId)
  return new Promise((resolve) => {
    const child = spawn('python3', args, {
      cwd: repoRoot,
      env: childEnv(port),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8')
    })
    child.on('exit', (status) => {
      const file = splitPath && existsSync(splitPath) ? splitPath : out
      const screen = existsSync(file) ? readFileSync(file, 'utf8').replaceAll(home, '<home>') : ''
      resolve({ status, screen, stderr })
    })
  })
}

function expectOnlyInA(a, b, marker) {
  assert.match(a.screen, new RegExp(marker), `发起会话应出现 ${marker}`)
  assert.doesNotMatch(b.screen, new RegExp(marker), `另一 root 不应出现 ${marker}`)
}

test.before(async () => {
  // 先完成一次 profile 初始化，避免并发首启写竞态。
  await runRoot({ rootId: 'surface-warmup', wait: 6 })
})

test.after(() => {
  rmSync(home, { recursive: true, force: true })
})

test('transcript：A 的对话内容不出现在 B', async () => {
  const mock = await startMock('text')
  try {
    const a = await runRoot({
      rootId: 'transcript-a',
      port: mock.port,
      send: 'TRANSCRIPT_MARKER',
      sendWait: 8,
      split: true,
    })
    const b = await runRoot({ rootId: 'transcript-b', wait: 6 })
    expectOnlyInA(a, b, 'TRANSCRIPT_MARKER')
  } finally {
    mock.child.kill('SIGKILL')
  }
})

test('草稿：A 未发送的草稿不出现在 B', async () => {
  const a = await runRoot({
    rootId: 'draft-a',
    sendRaw: 'DRAFT_MARKER',
    sendWait: 1,
    split: true,
  })
  const b = await runRoot({ rootId: 'draft-b', wait: 6 })
  expectOnlyInA(a, b, 'DRAFT_MARKER')
})

test('附件：A 的 @ 引用不出现在 B', async () => {
  const a = await runRoot({
    rootId: 'attach-a',
    sendRaw: '@attach-MARKER.txt',
    sendWait: 1,
    split: true,
  })
  const b = await runRoot({ rootId: 'attach-b', wait: 6 })
  expectOnlyInA(a, b, 'attach-MARKER')
})

test('审批：A 的待确认卡不出现在 B', async () => {
  const mock = await startMock('approval')
  try {
    const a = await runRoot({
      rootId: 'approval-a',
      port: mock.port,
      send: '触发审批',
      sendUntil: '需要确认：bash',
      sendWait: 20,
      split: true,
    })
    const b = await runRoot({ rootId: 'approval-b', wait: 6 })
    expectOnlyInA(a, b, '需要确认：bash')
  } finally {
    mock.child.kill('SIGKILL')
  }
})

test('队列：A 排队中的下一条不出现在 B', async () => {
  const mock = await startMock('slow')
  try {
    const a = await runRoot({
      rootId: 'queue-a',
      port: mock.port,
      send: 'QUEUE_MARKER_ONE\nQUEUE_MARKER_TWO',
      sendWait: 0.7,
      split: true,
    })
    const b = await runRoot({ rootId: 'queue-b', wait: 6 })
    expectOnlyInA(a, b, 'QUEUE_MARKER_TWO')
  } finally {
    mock.child.kill('SIGKILL')
  }
})


test('Monitor：A 的后台任务与监听器不出现在 B', async () => {
  const mock = await startMock('monitor')
  try {
    const a = await runSequence({
      rootId: 'monitor-a',
      port: mock.port,
      split: true,
      steps: [
        { send: '启动后台任务\r', until: '需要确认：bash', timeout: 20 },
        { send: '\u001b[A\r', until: 'MONITOR_STARTED', timeout: 20 },
        { send: '\u001b[106;5u', until: '任务', timeout: 10 },
        { send: 'm', until: 'Monitor', timeout: 8 },
      ],
    })
    const b = await runSequence({
      rootId: 'monitor-b',
      split: true,
      steps: [{ send: '\u001b[106;5u', until: '任务', timeout: 10 }],
    })
    assert.match(a.screen, /MONITOR_STARTED/, 'A 应完成启动回执')
    assert.match(a.screen, /运行中 sleep 30/, 'A 应出现后台任务')
    assert.match(a.screen, /Monitor bash-/, 'A 应出现监听器')
    assert.doesNotMatch(b.screen, /MONITOR_STARTED/, 'B 不应出现 A 的回合回执')
    assert.doesNotMatch(b.screen, /运行中 sleep 30/, 'B 不应出现 A 的后台任务')
    assert.doesNotMatch(b.screen, /Monitor bash-/, 'B 不应出现 A 的监听器')
  } finally {
    mock.child.kill('SIGKILL')
  }
})

test('终端：A 的终端内容不出现在 B', async () => {
  const a = await runSequence({
    rootId: 'term-a',
    split: true,
    steps: [
      { delay: 0.2, send: '\u0014' },
      { delay: 1.0, send: 'echo TERMINAL_MARKER\r' },
      { delay: 1.0, send: '' },
    ],
  })
  const b = await runSequence({
    rootId: 'term-b',
    split: true,
    steps: [
      { delay: 0.2, send: '\u0014' },
      { delay: 1.0, send: 'echo B_TERMINAL\r' },
      { delay: 1.0, send: '' },
    ],
  })
  expectOnlyInA(a, b, 'TERMINAL_MARKER')
})

test('问题：A 的待回答卡不出现在 B', async () => {
  const mock = await startMock('question')
  try {
    const a = await runRoot({
      rootId: 'question-a',
      port: mock.port,
      send: '触发问题',
      sendUntil: 'QUESTION_MARKER',
      sendWait: 20,
      split: true,
    })
    const b = await runRoot({ rootId: 'question-b', wait: 6 })
    expectOnlyInA(a, b, 'QUESTION_MARKER')
  } finally {
    mock.child.kill('SIGKILL')
  }
})
