#!/usr/bin/env node
/**
 * 键位文档生成（S03 §5）。
 *
 * 输入是编译后的单一源：`dist/input/keymap.js`（S01 绑定）加
 * `dist/controls/feature-keys.js`（S02 功能键静态清单）。输出写进 README.md /
 * README.en.md 的标记区块。
 *
 *   node scripts/keymap-docs.mjs --write   写回两个 README
 *   node scripts/keymap-docs.mjs --check   只比对，过期返回 1（挂 prepack）
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FEATURE_KEYBINDINGS } from '../dist/controls/feature-keys.js'
import { describeBindings } from '../dist/input/keymap.js'
import { renderKeymapMarkdown, replaceKeymapBlock } from '../dist/input/keymap-docs.js'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const write = process.argv.includes('--write')
const targets = [
  { file: 'README.md', lang: 'zh' },
  { file: 'README.en.md', lang: 'en' },
]

const bindings = [...describeBindings(), ...FEATURE_KEYBINDINGS]
let failed = false

for (const { file, lang } of targets) {
  const path = join(root, file)
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    console.error(`keymap-docs: 读不到 ${file}（${String(error)}）`)
    failed = true
    continue
  }
  const result = replaceKeymapBlock(text, renderKeymapMarkdown(bindings, lang))
  if (!result.ok) {
    console.error(`keymap-docs: ${file} ${result.reason}`)
    failed = true
    continue
  }
  if (write) {
    if (result.text !== text) {
      writeFileSync(path, result.text)
      console.log(`keymap-docs: 已写入 ${file}`)
    } else {
      console.log(`keymap-docs: ${file} 无需改动`)
    }
    continue
  }
  if (result.text !== text) {
    console.error(`keymap-docs: ${file} 的键位区块已过期；跑 \`npm run keymap:docs -- --write\``)
    failed = true
  }
}

if (!write && !failed) console.log('keymap-docs: 两个 README 均为最新')
process.exit(failed ? 1 : 0)
