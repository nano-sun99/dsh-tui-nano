// 视觉 token 的无头验证（S03 §3.3「视觉」行的可自动化部分）：
// 在真 PTY 里跑 nano，解析它发出的 SGR 字节。不开窗口、不抢焦点、不动剪贴板。
//
// 边界：PTY 只证明「nano 发了什么颜色/序列」，不证明 Ghostty 的合成、透明、
// 字体与窗口观感；后者仍需要真机截图，不能由本文件替代。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import stringWidth from 'string-width'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const nodeBin = process.execPath

function runInPty(theme, cols) {
  const home = mkdtempSync(path.join(os.tmpdir(), `nano-vision-${theme}-`))
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
    const screen = readFileSync(out, 'utf8')
    // 屏幕里带着临时 HOME 路径；比较主题时必须先归一化，否则换目录就会「不同」。
    return { code, screen: screen.replaceAll(home, '<home>') }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
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

/** 骨架按整行输出，每行以 `ESC[K` 收尾；取这些行的显示宽度。 */
function skeletonLineWidths(screen) {
  const widths = []
  for (const chunk of screen.split('\r\n')) {
    if (!chunk.includes('\x1b[K')) continue
    if (/\x1b\[\d+;\d+H/.test(chunk)) continue // 后面带光标定位的是正式 UI 片段，不是整行
    // 去掉 CSI（含 `ESC[>1u` 这类 kitty 协议）与行尾残留的 `\r`。
    const text = chunk.replace(/\x1b\[[0-9;?>]*[A-Za-z]/g, '').replace(/\r+$/, '')
    widths.push(stringWidth(text))
  }
  return widths
}

test('深色主题：真彩色 token 命中深色盘，且不带 ANSI 命名色', () => {
  const { code, screen } = runInPty('dark', 100)
  assert.ok(code === 0 || code === 130, `退出码异常：${code}`)
  const blocks = sgrParams(screen)
  assert.ok(hasTruecolor(blocks), '应出现 38;2 / 48;2 真彩色')
  assert.ok(screen.includes('38;2;125;211;252'), '深色强调色应为 125,211,252')
  assert.ok(screen.includes('38;2;226;232;240'), '深色前景色应为 226,232,240')
  assert.equal(firstNamedColor(blocks), undefined, '不应出现 ANSI 命名色')
})

test('浅色主题：真彩色 token 命中浅色盘，且不带 ANSI 命名色', () => {
  const { code, screen } = runInPty('light', 100)
  assert.ok(code === 0 || code === 130, `退出码异常：${code}`)
  const blocks = sgrParams(screen)
  assert.ok(screen.includes('38;2;3;105;161'), '浅色强调色应为 3,105,161')
  assert.ok(screen.includes('38;2;30;41;59'), '浅色前景色应为 30,41,59')
  assert.equal(firstNamedColor(blocks), undefined, '浅色主题也不应出现 ANSI 命名色')
  // 主题确实生效：浅色盘与深色盘的关键 token 不能同时出现。
  assert.ok(!screen.includes('38;2;125;211;252'), '浅色主题不应出现深色强调色')
})

test('60 与 100 列：骨架行不超过列宽，且有一行铺满', () => {
  for (const cols of [60, 100]) {
    const { code, screen } = runInPty('dark', cols)
    assert.ok(code === 0 || code === 130, `${cols} 列退出码异常：${code}`)
    const widths = skeletonLineWidths(screen)
    assert.ok(widths.length > 0, `${cols} 列应能解析出骨架行`)
    const widest = Math.max(...widths)
    assert.ok(
      widths.every((width) => width <= cols),
      `${cols} 列存在超宽行：${widths.filter((width) => width > cols).join(', ')}`,
    )
    assert.equal(widest, cols, `${cols} 列应有一行铺满到 ${cols}，实际最宽 ${widest}`)
  }
})
