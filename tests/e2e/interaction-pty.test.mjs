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

/** 合成 HOME/DSH_HOME，并清掉继承来的凭据变量：否则会打真实模型请求。 */
function childEnv(home, dshHome) {
  const env = {
    ...process.env,
    HOME: home,
    DSH_HOME: dshHome,
    NANO_DATA_ROOT: path.join(home, '.dsh-tui-nano'),
    NANO_THEME: 'dark',
    TERM: 'xterm-256color',
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

function runInteractive(send, { sendWait = 6, extraEnv = {} } = {}) {
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
        env: { ...childEnv(home, dshHome), ...extraEnv },
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
  assert.match(screen, /no API key for provider route/, '应带出官方 missing-credential 原文')
})

test('网络不可达：连接被拒时界面显示回合出错且进程不崩', () => {
  const { code, screen } = runInteractive('hello-offline', {
    sendWait: 30,
    extraEnv: {
      DEEPSEEK_API_KEY: 'sk-test-00000000000000000000000000000000',
      DEEPSEEK_BASE_URL: 'http://127.0.0.1:9',
    },
  })
  assert.ok(code === 0 || code === 130, `退出码异常：${code}`)
  assert.match(screen, /回合出错/, '应显示回合出错')
  assert.match(screen, /ECONNREFUSED|fetch failed|transport failed|network/i, '应带出网络错误原文')
})
test('/model 打开模型选择面板（标题/列表/强度）', () => {
  const { code, screen } = runInteractive('/model', {
    sendWait: 4,
    extraEnv: {
      DEEPSEEK_API_KEY: 'sk-test-00000000000000000000000000000000',
      DEEPSEEK_BASE_URL: 'http://127.0.0.1:9',
    },
  })
  assert.ok(code === 0 || code === 130, `退出码异常：${code}`)
  assert.match(screen, /模型/, '应显示面板标题')
  assert.match(screen, /当前：/, '应显示当前模型')
  assert.match(screen, /DeepSeek|deepseek/, '应列出模型')
  assert.match(screen, /Off|off/, '应列出官方强度')
})

test('/model 直接切换与目录外拒绝', () => {
  const { code, screen } = runInteractive(
    '/model deepseek-official/deepseek-flash\n/model deepseek-official/nope-model',
    {
      sendWait: 3,
      extraEnv: {
        DEEPSEEK_API_KEY: 'sk-test-00000000000000000000000000000000',
        DEEPSEEK_BASE_URL: 'http://127.0.0.1:9',
      },
    },
  )
  assert.ok(code === 0 || code === 130, `退出码异常：${code}`)
  assert.match(screen, /模型已切换：deepseek-official\/deepseek-flash/, '应切换成功')
  assert.match(screen, /模型不在目录/, '目录外模型应被拒绝')
})

test('!! 与 ! 各自提示，文案区分是否注入', () => {
  const { code, screen } = runInteractive('!!echo first\n!echo second', { sendWait: 3 })
  assert.ok(code === 0 || code === 130, `退出码异常：${code}`)
  assert.match(screen, /不注入上下文/, '!! 的提示应说明不注入上下文')
  assert.match(screen, /会作为上下文注入/, '! 的提示应说明会注入上下文')
  assert.match(screen, /first/, '!! 命令应执行并显示输出')
  assert.match(screen, /second/, '! 命令应执行并显示输出')
})

test('人工命令：!echo 立即执行并显示输出与退出码', () => {
  const { code, screen } = runInteractive('!echo nano-bang', { sendWait: 4 })
  assert.ok(code === 0 || code === 130, `退出码异常：${code}`)
  assert.match(screen, /\$ echo nano-bang/, '应显示命令行')
  assert.match(screen, /nano-bang/, '应显示命令输出')
  assert.match(screen, /退出码 0/, '应显示退出码')
  // S08 §2.2：首次使用 ! 明确提示「以用户权限运行、不是 Agent 授权」。
  assert.match(screen, /以你的用户权限运行，不是 Agent 授权/, '首次 ! 应提示权限边界')
  assert.match(screen, /会作为上下文注入/, '! 的提示应说明输出会注入上下文')
  assert.ok(
    screen.indexOf('以你的用户权限运行') < screen.indexOf('$ echo nano-bang'),
    '权限提示应出现在命令行之前',
  )
})
