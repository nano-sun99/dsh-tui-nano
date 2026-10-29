#!/usr/bin/env node
/**
 * 发布前检查（S03 §2.1）：用 `npm-packlist` 断言真正会进 tarball 的文件，
 * 不去递归调用 `npm pack`（否则 prepack 会自己套自己）。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import packlist from 'npm-packlist'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

// npm-packlist 正常吃 Arborist 树；这里只需要它按 package.json 的 files 规则
// 展开，所以给一份最小树。isProjectRoot=false 避开对依赖边（edgesOut）的遍历。
const tree = {
  path: root,
  package: pkg,
  isProjectRoot: false,
  workspaces: new Map(),
  edgesOut: new Map(),
}

let files
try {
  files = await packlist(tree)
} catch (error) {
  console.error('prepack-check: 无法枚举包内文件；先跑 `npm run build`。')
  console.error(`  ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}

const problems = []

const entry = 'dist/bin.js'
if (!files.includes(entry)) problems.push(`缺少入口 ${entry}（files 是否包含 dist？）`)

if (files.includes(entry)) {
  const firstLine = readFileSync(join(root, entry), 'utf8').split('\n', 1)[0] ?? ''
  // 可执行位由 npm 安装 bin 时设置；这里只断言 shebang 存在。
  if (!firstLine.startsWith('#!'))
    problems.push(`${entry} 缺少 shebang（第一行是 ${JSON.stringify(firstLine)}）`)
}

for (const required of ['package.json', 'dist/main.js', 'dist/input/keymap.js']) {
  if (!files.includes(required)) problems.push(`缺少必需文件 ${required}`)
}

const forbiddenPrefixes = ['src/', 'tests/', 'scripts/', 'docs/', 'packaging/', 'node_modules/']
const forbiddenFiles = ['tsconfig.json', 'biome.json', 'vitest.config.ts']
for (const file of files) {
  for (const prefix of forbiddenPrefixes) {
    if (file.startsWith(prefix)) problems.push(`不应进包：${file}`)
  }
  if (forbiddenFiles.includes(file)) problems.push(`不应进包：${file}`)
}

const bin = pkg.bin?.nano
if (bin !== entry) problems.push(`package.json bin.nano 是 ${bin}，期望 ${entry}`)
if (pkg.private !== false) problems.push('package.json private 必须为 false 才能发布')
if (pkg.name !== 'dsh-tui-nano') problems.push(`包名应为 dsh-tui-nano，实际 ${pkg.name}`)
if (pkg.files?.length !== 1 || pkg.files[0] !== 'dist') {
  problems.push(`package.json files 应只含 "dist"，实际 ${JSON.stringify(pkg.files)}`)
}

if (problems.length > 0) {
  console.error('prepack-check: 失败')
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}

console.log(`prepack-check: 通过（${files.length} 个文件，入口 ${entry}）`)
