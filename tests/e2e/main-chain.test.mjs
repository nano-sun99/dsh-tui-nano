// 主链路 e2e（S03 §3.3「主链路」行）：对话 → 工具 → 差异 → 审批 → 完成。
// 用一个本地 Anthropic Messages SSE mock 当模型，不打真实请求、不需要真实凭据。
// 全程真 PTY、不开窗口、不抢焦点、不动剪贴板。
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const nodeBin = process.execPath

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

function stopMock(mock) {
  mock.child.kill('SIGKILL')
}

function runChain({ port, mode, send, keys, workspace, sendWait = 6 }) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'nano-main-'))
  const dshHome = path.join(home, '.dsh')
  mkdirSync(dshHome, { recursive: true })
  const out = path.join(home, 'screen.bin')
  const args = [
    'tests/e2e/pty-start.py',
    '--out',
    out,
    '--wait',
    '10',
    '--until',
    '输入消息',
    '--send',
    send,
    '--send-wait',
    String(sendWait),
    '--cwd',
    workspace,
    '--cols',
    '100',
    '--rows',
    '30',
  ]
  if (keys) args.push('--keys', keys, '--keys-wait', '6')
  args.push('--', nodeBin, path.join(repoRoot, 'dist', 'bin.js'), '--root', `main-${mode}`)
  const env = {
    ...process.env,
    HOME: home,
    DSH_HOME: dshHome,
    NANO_DATA_ROOT: path.join(home, '.dsh-tui-nano'),
    NANO_THEME: 'dark',
    TERM: 'xterm-256color',
    DEEPSEEK_API_KEY: 'sk-test-00000000000000000000000000000000',
    DEEPSEEK_BASE_URL: `http://127.0.0.1:${port}`,
  }
  for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY']) delete env[key]
  try {
    const result = spawnSync('python3', args, {
      cwd: repoRoot,
      env,
      encoding: 'utf8',
      timeout: 90000,
    })
    assert.equal(result.status, 0, `pty-start.py 失败：${result.stderr}`)
    const code = Number.parseInt(result.stdout.trim().split('\n').at(-1) ?? '', 10)
    return { code, screen: readFileSync(out, 'utf8').replaceAll(home, '<home>') }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

test('对话 → 读取 → 编辑（差异）→ 完成', async () => {
  const mock = await startMock('edit')
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'nano-main-ws-'))
  const file = path.join(workspace, 'note.txt')
  writeFileSync(file, 'old line\n')
  try {
    const { code, screen } = runChain({
      port: mock.port,
      mode: 'edit',
      send: '把 note 改一下',
      workspace,
    })
    assert.ok(code === 0 || code === 130, `退出码异常：${code}`)
    assert.equal(readFileSync(file, 'utf8'), 'new line\n', '文件应被 edit 工具改写')
    assert.match(screen, /note\.txt/, '应出现 read/edit 工具行')
    assert.match(screen, /edit note\.txt/, '应出现 edit 工具调用')
    assert.match(screen, /点击展开/, '差异块默认折叠，应显示可展开入口')
    assert.match(screen, /主链路完成：文件已改。/, '应收到最终回复')
  } finally {
    stopMock(mock)
    rmSync(workspace, { recursive: true, force: true })
  }
})

test('审批卡默认拒绝，选「允许一次」后完成', async () => {
  const mock = await startMock('approval')
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'nano-main-ws-'))
  try {
    const { code, screen } = runChain({
      port: mock.port,
      mode: 'approval',
      send: '需要一次提权',
      keys: 'up,enter',
      workspace,
      sendWait: 8,
    })
    assert.ok(code === 0 || code === 130, `退出码异常：${code}`)
    assert.match(screen, /需要确认：bash/, '应弹出审批卡')
    assert.match(screen, /▸ 2\. 拒绝/, '默认焦点应在「拒绝」')
    assert.match(screen, /1\. 允许一次/, '应提供「允许一次」选项')
    assert.ok(existsSync(path.join(workspace, 'approval-ok.txt')), '允许后命令应执行')
    assert.match(screen, /主链路完成：审批已通过。/, '审批后应收到最终回复')
  } finally {
    stopMock(mock)
    rmSync(workspace, { recursive: true, force: true })
  }
})
