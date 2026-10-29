// 视觉 token 的无头验证（S03 §3.3「视觉」行的可自动化部分）：
// 在真 PTY 里跑 nano，解析它发出的 SGR 字节。不开窗口、不抢焦点、不动剪贴板。
//
// 边界：PTY 只证明「nano 发了什么颜色/序列」，不证明 Ghostty 的合成、透明、
// 字体与窗口观感；后者仍需要真机截图，不能由本文件替代。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const nodeBin = process.execPath

function runInPty(theme, cols) {
  const home = mkdtempSync(path.join(os.tmpdir(), `nano-vision-${theme}-`))
  const dshHome = path.join(home, '.dsh')
  mkdirSync(dshHome, { recursive: true })
  const out = path.join(home, 'screen.bin')
  const result = spawnSync(
    'python3',
    [
      'tests/e2e/pty-start.py',
      '--out',
      out,
      '--wait',
      '6',
      '--cols',
      String(cols),
      '--rows',
      '30',
      '--',
      nodeBin,
      'dist/bin.js',
      '--root',
      'vision',
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
        NANO_THEME: theme,
        TERM: 'xterm-256color',
      },
    },
  )
  assert.equal(result.status, 0, `pty-start.py 失败：${result.stderr}`)
  const code = Number.parseInt(result.stdout.trim().split('\n').at(-1) ?? '', 10)
  return { code, screen: readFileSync(out, 'utf8') }
}

/** 拆出每个 SGR 的参数列表；`38;2;r;g;b` 的 RGB 数值不算独立颜色码。 */
function sgrParams(screen) {
  const blocks = []
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 解析终端 SGR 必须匹配 ESC
  const re = /\x1b\[([0-9;]*)m/g
  let match = re.exec(screen)
  while (match) {
    blocks.push(
      (match[1] ?? '')
        .split(';')
        .filter((part) => part !== '')
        .map((part) => Number.parseInt(part, 10)),
    )
    match = re.exec(screen)
  }
  return blocks
}

function hasTruecolor(blocks) {
  return blocks.some((params) => {
    for (let i = 0; i < params.length - 1; i++) {
      if (params[i] === 38 && params[i + 1] === 2) return true
      if (params[i] === 48 && params[i + 1] === 2) return true
    }
    return false
  })
}

function firstNamedColor(blocks) {
  for (const params of blocks) {
    for (let i = 0; i < params.length; i++) {
      const code = params[i]
      if (code === 38 || code === 48) {
        // 38/48 后面的模式与取值不是独立颜色码：2 带 3 个数，5 带 1 个数。
        const mode = params[i + 1]
        if (mode === 2) i += 4
        else if (mode === 5) i += 2
        else i += 1
        continue
      }
      if (
        (code >= 30 && code <= 37) ||
        (code >= 40 && code <= 47) ||
        (code >= 90 && code <= 97) ||
        (code >= 100 && code <= 107)
      ) {
        return code
      }
    }
  }
  return undefined
}

test('深色主题：只发真彩色，不发 ANSI 命名色', () => {
  const { code, screen } = runInPty('dark', 100)
  assert.ok(code === 0 || code === 130, `退出码异常：${code}`)
  const blocks = sgrParams(screen)
  assert.ok(hasTruecolor(blocks), '应出现 38;2 / 48;2 真彩色')
  assert.equal(firstNamedColor(blocks), undefined, '不应出现 ANSI 命名色')
})

test('浅色主题与深色主题的像素字节不同', () => {
  const dark = runInPty('dark', 100).screen
  const light = runInPty('light', 100).screen
  assert.notEqual(dark, light, 'NANO_THEME=light 的输出应与 dark 不同')
  assert.ok(hasTruecolor(sgrParams(light)), '浅色主题也应使用真彩色')
})

test('60 列与 100 列都能起界面', () => {
  for (const cols of [60, 100]) {
    const { code, screen } = runInPty('dark', cols)
    assert.ok(code === 0 || code === 130, `${cols} 列退出码异常：${code}`)
    assert.match(screen, /nano/, `${cols} 列应出现界面内容`)
  }
})
