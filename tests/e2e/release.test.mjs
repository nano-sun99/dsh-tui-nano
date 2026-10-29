// 发布级 e2e（S03 §6）：用合成 HOME / DSH_HOME / 数据根 / 安装前缀，对
// `npm pack` 产物做「全新安装 → 启动 → 升级 → purge → 卸载 → 重装」，
// 每步记录文件清单与哈希。不读写用户真实目录。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const nodeBin = process.execPath
const packageJson = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
const expectedVersion = packageJson.version

function tempDir(prefix) {
  return mkdtempSync(path.join(os.tmpdir(), `${prefix}-`))
}

/** 递归清单：相对路径 → sha256；符号链接记录目标。 */
function hashTree(root, skip = []) {
  const out = {}
  if (!existsSync(root)) return out
  const walk = (dir, rel) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (skip.includes(entry.name)) continue
      const full = path.join(dir, entry.name)
      const key = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(full, key)
      else if (entry.isSymbolicLink()) out[key] = `symlink:${readlinkSync(full)}`
      else if (entry.isFile())
        out[key] = createHash('sha256').update(readFileSync(full)).digest('hex')
    }
  }
  walk(root, '')
  return out
}

function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function baseEnv(extra = {}) {
  // 不覆盖 npm cache：合成一份空 cache 会把整棵官方依赖树重新下载一遍，
  // 慢且容易在网络上抖。安装前缀、HOME、DSH_HOME、数据根仍然是合成的。
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    ...extra,
  }
}

function run(command, args, { env, cwd, input } = {}) {
  return spawnSync(command, args, {
    cwd: cwd ?? repoRoot,
    env: env ?? baseEnv(),
    encoding: 'utf8',
    input,
    timeout: 180000,
  })
}

function mustRun(command, args, options) {
  const result = run(command, args, options)
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} 退出码 ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    )
  }
  return result
}

/** `npm pack` 到指定目录，返回 tarball 路径、哈希与文件清单。 */
function packTo(destination) {
  mkdirSync(destination, { recursive: true })
  const before = new Set(readdirSync(destination))
  mustRun('npm', ['pack', '--pack-destination', destination], { env: baseEnv(), cwd: repoRoot })
  const created = readdirSync(destination).filter(
    (file) => file.endsWith('.tgz') && !before.has(file),
  )
  assert.equal(created.length, 1, `npm pack 应产出一个 tarball，实际 ${created.join(', ')}`)
  const tarball = path.join(destination, created[0])
  const files = mustRun('tar', ['-tzf', tarball], { env: baseEnv() })
    .stdout.split('\n')
    .map((line) => line.replace(/^package\//, ''))
    .filter(Boolean)
  return { tarball, sha256: sha256File(tarball), files }
}

/**
 * 造一个「升级版」tarball：解包 → 改 version → `--ignore-scripts` 重打包。
 * 只用于验证「旧版 → 新版」的安装路径，不冒充真实发布物。
 */
function packUpgradeVariant(tarball, destination, nextVersion) {
  const work = tempDir('nano-e2e-upgrade-src')
  mustRun('tar', ['-xzf', tarball, '-C', work])
  const pkgPath = path.join(work, 'package', 'package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  pkg.version = nextVersion
  // 提取出来的包没有源码与 devDependencies，prepack 跑不了；这里只验证安装路径。
  delete pkg.scripts
  for (const extra of ['README.md', 'README.en.md', 'LICENSE']) {
    cpSync(path.join(repoRoot, extra), path.join(work, 'package', extra), { force: true })
  }
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2))
  mkdirSync(destination, { recursive: true })
  const before = new Set(readdirSync(destination))
  mustRun('npm', ['pack', '--ignore-scripts', '--pack-destination', destination], {
    env: baseEnv(),
    cwd: path.join(work, 'package'),
  })
  const created = readdirSync(destination).filter(
    (file) => file.endsWith('.tgz') && !before.has(file),
  )
  assert.equal(created.length, 1, `升级包应产出一个 tarball，实际 ${created.join(', ')}`)
  return path.join(destination, created[0])
}

function installGlobal(tarball, prefix) {
  mustRun('npm', ['install', '-g', '--prefix', prefix, '--no-audit', '--no-fund', tarball], {
    env: baseEnv(),
  })
}

function uninstallGlobal(prefix) {
  mustRun('npm', ['uninstall', '-g', '--prefix', prefix, 'dsh-tui-nano'], { env: baseEnv() })
}

function nanoBin(prefix) {
  return path.join(prefix, 'bin', 'nano')
}

function runNano(prefix, args, env) {
  return run(nanoBin(prefix), args, { env: baseEnv(env) })
}

/** 用 Python 开真 PTY 跑一次启动冒烟（macOS 的 `script` 不接受非 TTY stdin）。 */
function startInPty(prefix, env, { waitMs = 7000, nodeBin: extraNode } = {}) {
  const out = path.join(tempDir('nano-e2e-pty'), 'screen.bin')
  // bin 的 shebang 是 `#!/usr/bin/env node`；把指定 Node 放到 PATH 最前即可换运行时。
  const extraEnv = extraNode ? { PATH: `${path.dirname(extraNode)}:${process.env.PATH}` } : {}
  const result = run(
    'python3',
    [
      'tests/e2e/pty-start.py',
      '--out',
      out,
      '--wait',
      String(waitMs / 1000),
      '--',
      nanoBin(prefix),
      '--root',
      'e2e-root',
    ],
    { env: baseEnv({ ...env, ...extraEnv }), cwd: repoRoot },
  )
  assert.equal(result.status, 0, `pty-start.py 失败：${result.stderr}`)
  const code = Number.parseInt(result.stdout.trim().split('\n').at(-1) ?? '', 10)
  let output = ''
  try {
    output = readFileSync(out, 'utf8')
  } catch {}
  return { code, output }
}

// ── 一次打包，全文件共用 ────────────────────────────────────────────────

const ctx = { artifacts: tempDir('nano-e2e-artifacts') }

test.before(() => {
  ctx.packed = packTo(path.join(ctx.artifacts, 'pack'))
  const packFiles = ctx.packed.files
  assert.ok(packFiles.includes('dist/bin.js'), 'tarball 必须包含 dist/bin.js')
  assert.ok(!packFiles.some((file) => file.startsWith('src/')), 'tarball 不应包含 src/')
  assert.ok(!packFiles.some((file) => file.startsWith('tests/')), 'tarball 不应包含 tests/')
  const entry = path.join(repoRoot, 'dist', 'bin.js')
  assert.match(readFileSync(entry, 'utf8').split('\n')[0], /^#!/, 'dist/bin.js 必须带 shebang')
  ctx.prefix = tempDir('nano-e2e-prefix')
  ctx.home = tempDir('nano-e2e-home')
  ctx.dshHome = path.join(ctx.home, '.dsh')
  ctx.dataRoot = path.join(ctx.home, '.dsh-tui-nano')
  mkdirSync(ctx.dshHome, { recursive: true })
  ctx.env = { HOME: ctx.home, DSH_HOME: ctx.dshHome, NANO_DATA_ROOT: ctx.dataRoot }
})

test('pack 产物与哈希可复现', () => {
  assert.match(ctx.packed.sha256, /^[0-9a-f]{64}$/)
  assert.ok(ctx.packed.tarball.endsWith(`dsh-tui-nano-${expectedVersion}.tgz`))
})

test('全新安装后 nano --version 可用', () => {
  installGlobal(ctx.packed.tarball, ctx.prefix)
  assert.ok(existsSync(nanoBin(ctx.prefix)))
  const result = runNano(ctx.prefix, ['--version'], ctx.env)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, new RegExp(`nano ${expectedVersion.replaceAll('.', '\\.')}`))
  assert.match(result.stdout, /harness 0\.2\.1-rc\.2/)
})

test('--help 含用法与键位段', () => {
  const result = runNano(ctx.prefix, ['--help'], ctx.env)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /用法：nano/)
  assert.match(result.stdout, /键位：/)
  assert.match(result.stdout, /Ctrl\+T/)
})

test('purge 无 --yes 且非交互时拒绝并保留数据根', () => {
  mkdirSync(ctx.dataRoot, { recursive: true })
  const marker = path.join(ctx.dataRoot, 'marker.txt')
  writeFileSync(marker, 'keep')
  const result = runNano(ctx.prefix, ['purge'], ctx.env)
  assert.notEqual(result.status, 0, '非交互 purge 必须失败')
  assert.match(result.stderr, /--yes/)
  assert.ok(existsSync(marker), '数据根不能被删除')
})

test('purge --yes 删除数据根', () => {
  const result = runNano(ctx.prefix, ['purge', '--yes'], ctx.env)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(existsSync(ctx.dataRoot), false, '数据根应被删除')
})

test('启动冒烟：真 PTY 下起骨架并干净退出，$DSH_HOME 只允许官方标识变化', () => {
  const before = hashTree(ctx.dshHome)
  const { code, output } = startInPty(ctx.prefix, ctx.env)
  const after = hashTree(ctx.dshHome)
  const added = Object.keys(after).filter((key) => !(key in before))
  const changed = Object.keys(after).filter((key) => key in before && after[key] !== before[key])
  assert.deepEqual(
    added.filter((key) => key !== '.anonymous-user-id'),
    [],
    '新增的 $DSH_HOME 文件只能是 .anonymous-user-id',
  )
  assert.deepEqual(changed, [], '$DSH_HOME 既有文件不应被改动')
  assert.ok(existsSync(ctx.dataRoot), '启动后应创建数据根')
  assert.match(output, /nano|DeepSeek/i, 'PTY 输出应包含界面内容')
  assert.ok(code === 0 || code === 130, `退出码异常：${code}\n${output.slice(0, 2000)}`)
})

test('未知 harness 版本拒绝启动', () => {
  const fake = tempDir('nano-e2e-harness')
  writeFileSync(
    path.join(fake, 'package.json'),
    JSON.stringify({ name: '@deepseek-ai/dsh', version: '9.9.9' }),
  )
  const official = pathToFileURL(path.join(repoRoot, 'dist', 'boot', 'official.js')).href
  const script = `import(${JSON.stringify(official)}).then(async (m) => {
    try { await m.loadOfficial(${JSON.stringify(path.join(fake, 'package.json'))}); console.log('NO_THROW') }
    catch (error) { console.log(error.message) }
  })`
  const result = run(nodeBin, ['--input-type=module', '-e', script], { env: baseEnv() })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /版本不受支持/)
})

test('强杀残留：陈旧挂载锁让下次启动提示 reset', () => {
  const mountDir = path.join(ctx.dataRoot, 'mount')
  mkdirSync(mountDir, { recursive: true })
  // 999999 是不存在的 pid：等价于上次进程被 SIGKILL 后留下的锁（锁文件是 JSON）。
  writeFileSync(path.join(mountDir, 'e2e-root.lock'), JSON.stringify({ pid: 999999 }))
  const { code, output } = startInPty(ctx.prefix, ctx.env)
  assert.match(output, /reset/, '启动应在界面提示 reset')
  assert.ok(code === 0 || code === 130, `退出码异常：${code}`)
})

// 本机没有对应 Node 时跳过；发布证据运行会显式设置这两个变量。
const node22 = process.env.NANO_NODE_22
const node20 = process.env.NANO_NODE_20

test('Node 22.19（下限）里能启动', { skip: node22 ? false : '未设置 NANO_NODE_22' }, () => {
  const version = run(node22, [path.join(repoRoot, 'dist', 'bin.js'), '--version'], {
    env: baseEnv({ NANO_DATA_ROOT: ctx.dataRoot }),
  })
  assert.equal(version.status, 0, version.stderr)
  assert.match(version.stdout, new RegExp(`nano ${expectedVersion.replaceAll('.', '\\.')}`))
  const { code, output } = startInPty(ctx.prefix, ctx.env, { nodeBin: node22 })
  assert.ok(code === 0 || code === 130, `22.19 启动退出码异常：${code}\n${output.slice(0, 1500)}`)
})

test('低于 22.19 拒绝启动并给可操作错误', { skip: node20 ? false : '未设置 NANO_NODE_20' }, () => {
  const result = run(node20, [path.join(repoRoot, 'dist', 'bin.js'), '--version'], {
    env: baseEnv({ NANO_DATA_ROOT: ctx.dataRoot }),
  })
  assert.equal(result.status, 1, result.stdout)
  assert.match(result.stderr, /需要 Node\.js >= 22\.19\.0/)
  assert.match(result.stderr, /nvm install 22\.19/)
})

test('升级：安装更高版本后 --version 跟着变', () => {
  const next = packUpgradeVariant(ctx.packed.tarball, path.join(ctx.artifacts, 'upgrade'), '0.2.1')
  installGlobal(next, ctx.prefix)
  const upgraded = runNano(ctx.prefix, ['--version'], ctx.env)
  assert.equal(upgraded.status, 0, upgraded.stderr)
  assert.match(upgraded.stdout, /nano 0\.2\.1/)
  // 回到被验收的版本，后面的卸载/重装以它为准
  installGlobal(ctx.packed.tarball, ctx.prefix)
  assert.match(
    runNano(ctx.prefix, ['--version'], ctx.env).stdout,
    new RegExp(`nano ${expectedVersion.replaceAll('.', '\\.')}`),
  )
})

test('普通卸载保留数据根，重装后仍可启动', () => {
  mkdirSync(ctx.dataRoot, { recursive: true })
  writeFileSync(path.join(ctx.dataRoot, 'profile-marker'), 'keep')
  uninstallGlobal(ctx.prefix)
  assert.equal(existsSync(nanoBin(ctx.prefix)), false, '卸载后 bin 应消失')
  assert.ok(existsSync(path.join(ctx.dataRoot, 'profile-marker')), '普通卸载必须保留数据根')
  installGlobal(ctx.packed.tarball, ctx.prefix)
  const result = runNano(ctx.prefix, ['--version'], ctx.env)
  assert.equal(result.status, 0, result.stderr)
})

test('keymap 文档与源码一致', () => {
  mustRun(nodeBin, ['scripts/keymap-docs.mjs', '--check'], { env: baseEnv(), cwd: repoRoot })
})

test('架构门禁：仓库内无旧工具链/桥接引用', () => {
  const tracked = mustRun(
    'git',
    [
      'ls-files',
      '-z',
      '--',
      'src',
      'package.json',
      'packaging',
      'tests',
      'scripts',
      'README.md',
      'README.en.md',
      'AGENTS.md',
      '.github',
      '.gitignore',
    ],
    { env: baseEnv(), cwd: repoRoot },
  ).stdout
  const files = tracked.split('\0').filter(Boolean)
  // 门禁正则从 spec §4 现场提取，既保证单一来源，也避免测试文件自己带着字面量自匹配。
  const spec = readFileSync(
    path.join(repoRoot, 'docs/specs/2026-10-28-nano-ts/S03-release.md'),
    'utf8',
  )
  const match = spec.match(/grep -nE '([^']+)'/)
  assert.ok(match, 'S03 spec §4 应包含 grep 门禁命令')
  const pattern = new RegExp(match[1])
  const hits = []
  for (const file of files) {
    const text = readFileSync(path.join(repoRoot, file), 'utf8')
    text.split('\n').forEach((line, index) => {
      if (pattern.test(line)) hits.push(`${file}:${index + 1}:${line.trim()}`)
    })
  }
  assert.deepEqual(hits, [], `门禁命中：\n${hits.join('\n')}`)
})
