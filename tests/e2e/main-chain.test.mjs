// 主链路 e2e（S03 §3.3「主链路」行）：对话 → 工具 → 差异 → 审批 → 完成，
// 全部在**同一条链路**里跑完。模型用本地 Anthropic Messages SSE mock，
// 不打真实请求、不需要真实凭据。全程真 PTY、不开窗口、不抢焦点、不动剪贴板。
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const nodeBin = process.execPath

/** 只保留跑 TUI 必需的变量；凭据/base URL 显式指向 mock。 */
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

function runChain({ port, mode, send, workspace, sendUntil, keys, keysUntil, clickMarker }) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'nano-main-'))
  const dshHome = path.join(home, '.dsh')
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
    '20',
    '--cwd',
    workspace,
    '--cols',
    '100',
    '--rows',
    '30',
  ]
  if (sendUntil) args.push('--send-until', sendUntil)
  if (keys) args.push('--keys', keys, '--keys-wait', '15')
  if (keysUntil) args.push('--keys-until', keysUntil)
  if (clickMarker) args.push('--click-marker', clickMarker, '--click-wait', '3')
  args.push('--', nodeBin, path.join(repoRoot, 'dist', 'bin.js'), '--root', `main-${mode}`)
  try {
    const result = spawnSync('python3', args, {
      cwd: repoRoot,
      env: childEnv(home, dshHome, port),
      encoding: 'utf8',
      timeout: 120000,
    })
    assert.equal(result.status, 0, `pty-start.py 失败：${result.stderr}`)
    const code = Number.parseInt(result.stdout.trim().split('\n').at(-1) ?? '', 10)
    return { code, screen: readFileSync(out, 'utf8').replaceAll(home, '<home>') }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

test('同一条链路：对话 → read → edit（差异）→ 审批允许 → 完成', async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'nano-main-ws-'))
  let mock
  try {
    writeFileSync(path.join(workspace, 'note.txt'), 'old line\n')
    mock = await startMock('chain')
    const { code, screen } = runChain({
      port: mock.port,
      mode: 'chain',
      send: '改文件并跑一次审批',
      workspace,
      sendUntil: '需要确认：bash',
      keys: 'up,enter',
      keysUntil: '主链路完成',
      clickMarker: 'edit note.txt',
    })
    assert.ok(code === 0 || code === 130, `退出码异常：${code}`)
    // 工具：文件确实被 edit 改写
    assert.equal(readFileSync(path.join(workspace, 'note.txt'), 'utf8'), 'new line\n')
    // 审批：卡片出现、默认焦点在拒绝、允许一次后命令执行
    assert.match(screen, /需要确认：bash/, '应弹出审批卡')
    assert.match(screen, /▸ 2\. 拒绝/, '默认焦点应在「拒绝」')
    assert.ok(existsSync(path.join(workspace, 'approval-ok.txt')), '允许后命令应执行')
    // 差异：展开 edit 行后应看到 -old / +new
    assert.match(screen, /- old line/, '展开后应出现删除行')
    assert.match(screen, /\+ new line/, '展开后应出现新增行')
    // 完成
    assert.match(screen, /主链路完成：文件已改、审批已通过。/, '应收到最终回复')
  } finally {
    if (mock) mock.child.kill('SIGKILL')
    rmSync(workspace, { recursive: true, force: true })
  }
})

test('同一条链路：默认拒绝时不执行命令，mock 也不谎报完成', async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'nano-main-ws-'))
  let mock
  try {
    writeFileSync(path.join(workspace, 'note.txt'), 'old line\n')
    mock = await startMock('chain')
    const { code, screen } = runChain({
      port: mock.port,
      mode: 'chain-deny',
      send: '改文件并跑一次审批',
      workspace,
      sendUntil: '需要确认：bash',
      keys: 'enter',
      keysUntil: '主链路结束',
    })
    assert.ok(code === 0 || code === 130, `退出码异常：${code}`)
    assert.ok(!existsSync(path.join(workspace, 'approval-ok.txt')), '拒绝后命令不应执行')
    assert.match(screen, /主链路结束：审批被拒绝或命令失败。/, 'mock 应按 is_error 返回失败文本')
    assert.doesNotMatch(screen, /审批已通过/, '拒绝后不得出现成功文本')
  } finally {
    if (mock) mock.child.kill('SIGKILL')
    rmSync(workspace, { recursive: true, force: true })
  }
})
