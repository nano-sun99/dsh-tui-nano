// 子代理 dock 的真实 PTY 证据（issue #119）：mock 模型调用官方 subagent 工具，
// 观察 dock 入列、状态词与完成后的保留。不开窗口、不抢焦点。
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { Screen } from './screen.mjs'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const nodeBin = process.execPath

function childEnv(home, dshHome, port) {
  const env = {}
  for (const key of ['PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'SHELL', 'USER']) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  return {
    ...env,
    HOME: home,
    DSH_HOME: dshHome,
    NANO_DATA_ROOT: path.join(home, '.dsh-tui-nano'),
    NANO_THEME: 'dark',
    TERM: 'xterm-256color',
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

function saveEvidence(name, screen) {
  const dir = process.env.NANO_EVIDENCE_DIR
  if (!dir) return
  mkdirSync(dir, { recursive: true })
  const model = new Screen(100, 30)
  model.feed(screen)
  writeFileSync(path.join(dir, `${name}.txt`), model.lines().join('\n'))
}

test('真实 PTY：subagent 工具启动子代理后 dock 入列并显示状态', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'nano-subagent-'))
  const dshHome = path.join(home, '.dsh')
  const out = path.join(home, 'screen.bin')
  let mock
  try {
    mock = await startMock('subagent')
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
        '--send',
        '跑个子代理',
        '--send-wait',
        '20',
        '--send-until',
        '父任务完成',
        '--keys',
        'esc',
        '--keys-wait',
        '2',
        '--cols',
        '100',
        '--rows',
        '30',
        '--',
        nodeBin,
        path.join(repoRoot, 'dist', 'bin.js'),
        '--root',
        'subagent-dock-e2e',
      ],
      {
        cwd: repoRoot,
        env: childEnv(home, dshHome, mock.port),
        encoding: 'utf8',
        timeout: 120000,
      },
    )
    assert.equal(result.status, 0, `pty-start.py 失败：${result.stderr}`)
    const screen = readFileSync(out, 'utf8').replaceAll(home, '<home>')
    assert.match(screen, /父任务完成：子任务已分派。/, '父对话应收到最终回复')
    assert.match(screen, /查找配置依赖/, 'dock 应显示子代理名字')
    assert.match(screen, /(执行中|完成)/, 'dock 应显示状态词')
    saveEvidence('pty-dock', screen)
  } finally {
    if (mock) mock.child.kill('SIGKILL')
    rmSync(home, { recursive: true, force: true })
  }
})

function runSubagentScreen() {
  const home = mkdtempSync(path.join(os.tmpdir(), 'nano-subagent-'))
  const dshHome = path.join(home, '.dsh')
  const out = path.join(home, 'screen.bin')
  return { home, dshHome, out }
}

function spawnScreen({ home, dshHome, out, port, sendUntil, keys, keysUntil, keysWait, root }) {
  const args = [
    'tests/e2e/pty-start.py',
    '--out',
    out,
    '--wait',
    '10',
    '--until',
    '输入消息',
    '--send',
    '跑个子代理',
    '--send-wait',
    '20',
    '--send-until',
    sendUntil,
    '--cols',
    '100',
    '--rows',
    '30',
  ]
  if (keys) {
    args.push('--keys', keys, '--keys-wait', String(keysWait ?? 3))
    if (keysUntil) args.push('--keys-until', keysUntil)
  }
  args.push('--', nodeBin, path.join(repoRoot, 'dist', 'bin.js'), '--root', root)
  return spawnSync('python3', args, {
    cwd: repoRoot,
    env: childEnv(home, dshHome, port),
    encoding: 'utf8',
    timeout: 120000,
  })
}

test('真实 PTY：Alt+L 打开全部子代理列表并显示计数', async () => {
  const frame = runSubagentScreen()
  let mock
  try {
    mock = await startMock('subagent')
    const result = spawnScreen({
      ...frame,
      port: mock.port,
      sendUntil: '父任务完成',
      keys: 'alt+l',
      keysUntil: '全部子代理',
      root: 'subagent-list-e2e',
    })
    assert.equal(result.status, 0, `pty-start.py 失败：${result.stderr}`)
    const screen = readFileSync(frame.out, 'utf8').replaceAll(frame.home, '<home>')
    assert.match(screen, /全部子代理 · 1/, '列表标题应显示本地直接子代理计数')
    assert.match(screen, /查找配置依赖/, '列表应出现子代理名字')
    assert.match(screen, /×/, '列表应有关闭按钮')
    saveEvidence('pty-list', screen)
  } finally {
    if (mock) mock.child.kill('SIGKILL')
    rmSync(frame.home, { recursive: true, force: true })
  }
})

test('真实 PTY：从 dock 进入详情，顶部标识与输入占位按设计稿', async () => {
  const frame = runSubagentScreen()
  let mock
  try {
    mock = await startMock('subagent')
    const result = spawnScreen({
      ...frame,
      port: mock.port,
      sendUntil: '父任务完成',
      keys: 'down,enter',
      keysUntil: '子任务：核对配置依赖',
      keysWait: 15,
      root: 'subagent-detail-e2e',
    })
    assert.equal(result.status, 0, `pty-start.py 失败：${result.stderr}`)
    const screen = readFileSync(frame.out, 'utf8').replaceAll(frame.home, '<home>')
    const final = new Screen(100, 30)
    final.feed(screen)
    const flat = final.lines().join('\n')
    assert.match(flat, /子代理 · 查找配置依赖/, '详情顶部应显示名字')
    assert.match(flat, /给 查找配置依赖 发送消息/, '详情输入框应显示设计稿占位')
    assert.match(flat, /子任务：核对配置依赖/, '详情应显示 child 正文')
    assert.doesNotMatch(flat, /读取中…/, '详情不应停在读取中')
    saveEvidence('pty-detail', screen)
  } finally {
    if (mock) mock.child.kill('SIGKILL')
    rmSync(frame.home, { recursive: true, force: true })
  }
})

test('真实 PTY：终态 30 秒后 dock 行消失，父对话回执仍在', async () => {
  const frame = runSubagentScreen()
  let mock
  try {
    mock = await startMock('subagent')
    const result = spawnScreen({
      ...frame,
      port: mock.port,
      sendUntil: '父任务完成',
      keys: 'esc',
      keysWait: 33,
      root: 'subagent-grace-e2e',
    })
    assert.equal(result.status, 0, `pty-start.py 失败：${result.stderr}`)
    const text = readFileSync(frame.out, 'utf8').replaceAll(frame.home, '<home>')
    const screen = new Screen(100, 30)
    screen.feed(text)
    const flat = screen.lines().join('\n')
    assert.doesNotMatch(flat, /查找配置依赖/, '30 秒后 dock 行应消失')
    assert.match(
      flat,
      /Background subagent .* finished and will do no further work/,
      '父对话的 settlement notice 仍应保留',
    )
    saveEvidence('pty-grace', text)
  } finally {
    if (mock) mock.child.kill('SIGKILL')
    rmSync(frame.home, { recursive: true, force: true })
  }
})
