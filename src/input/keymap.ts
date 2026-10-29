/**
 * The single keymap source (D01). S01 owns the table; S02 registers feature
 * keys through `registerKeybinding`; S03 renders README/--help from
 * `describeBindings()`.
 */
import type { Key, KeyName } from './parser.ts'

export type Scope = 'input' | 'idle' | 'running' | 'overlay' | 'selection'

export interface KeySpec {
  readonly name: KeyName
  readonly text?: string
  readonly ctrl?: boolean
  readonly alt?: boolean
  readonly shift?: boolean
  readonly meta?: boolean
}

export interface KeyBinding {
  /** Stable action id consumed by the app, e.g. `conversation.submit`. */
  readonly id: string
  readonly keys: readonly KeySpec[]
  /** Empty means "any scope"; otherwise the binding applies when the scope is present. */
  readonly scopes?: readonly Scope[]
  readonly description: string
  /** English description for README.en.md (S03 §5); falls back to `description`. */
  readonly descriptionEn?: string
  /** Feature owner: `s01` or a later slice. */
  readonly owner?: 's01' | 's02' | 's03'
}

const registry: KeyBinding[] = []

/** Register one binding. Later registrations win for the same key/scope. */
export function registerKeybinding(binding: KeyBinding): () => void {
  registry.push(binding)
  const index = registry.indexOf(binding)
  return () => {
    const at = registry.indexOf(binding)
    if (at >= 0) registry.splice(at, 1)
    void index
  }
}

/** Resolve a key to the highest-priority action id for the active scopes. */
export function resolveKey(key: Key, scopes: readonly Scope[]): string | undefined {
  for (let i = registry.length - 1; i >= 0; i--) {
    const binding = registry[i]
    if (!binding) continue
    if (binding.scopes && binding.scopes.length > 0) {
      if (!binding.scopes.some((scope) => scopes.includes(scope))) continue
    }
    if (binding.keys.some((spec) => matches(spec, key))) return binding.id
  }
  return undefined
}

/** All registered bindings, for docs and `--help` generation (S03). */
export function describeBindings(): readonly KeyBinding[] {
  return registry.slice()
}

function matches(spec: KeySpec, key: Key): boolean {
  if (spec.name !== key.name) return false
  if (spec.text !== undefined && spec.text !== key.text) return false
  if ((spec.ctrl ?? false) !== key.ctrl) return false
  if ((spec.alt ?? false) !== key.alt) return false
  if ((spec.shift ?? false) !== key.shift) return false
  if ((spec.meta ?? false) !== key.meta) return false
  return true
}

registerKeybinding({
  id: 'conversation.submit',
  keys: [{ name: 'enter' }],
  scopes: ['input'],
  description: '提交输入',
  descriptionEn: 'Submit the input',
  owner: 's01',
})
registerKeybinding({
  id: 'input.newline',
  keys: [
    { name: 'enter', shift: true },
    { name: 'enter', ctrl: true },
    { name: 'enter', alt: true },
  ],
  scopes: ['input'],
  description: '输入换行',
  descriptionEn: 'Insert a newline',
  owner: 's01',
})
registerKeybinding({
  id: 'conversation.cancel',
  keys: [{ name: 'char', text: 'c', ctrl: true }],
  scopes: ['running'],
  description: '停止当前回合（保留队列）',
  descriptionEn: 'Stop the current turn (keep the queue)',
  owner: 's01',
})
registerKeybinding({
  id: 'conversation.steer',
  keys: [{ name: 'char', text: 's', ctrl: true }],
  scopes: ['running'],
  description: '引导当前回合（下一 step 生效）',
  descriptionEn: 'Steer the current turn (applies at the next step)',
  owner: 's01',
})
registerKeybinding({
  id: 'conversation.clear',
  keys: [{ name: 'char', text: 'x', ctrl: true }],
  scopes: ['running', 'idle'],
  description: '停止当前回合并清空队列',
  descriptionEn: 'Stop the current turn and clear the queue',
  owner: 's01',
})
registerKeybinding({
  id: 'app.exit',
  keys: [
    { name: 'char', text: 'c', ctrl: true },
    { name: 'char', text: 'd', ctrl: true },
  ],
  scopes: ['idle'],
  description: '退出 Nano',
  descriptionEn: 'Exit Nano',
  owner: 's01',
})
registerKeybinding({
  id: 'input.backspace',
  keys: [{ name: 'backspace' }],
  scopes: ['input'],
  description: '删除前一个字符',
  descriptionEn: 'Delete the previous character',
  owner: 's01',
})
registerKeybinding({
  id: 'input.delete',
  keys: [{ name: 'delete' }],
  scopes: ['input'],
  description: '删除后一个字符',
  descriptionEn: 'Delete the next character',
  owner: 's01',
})
registerKeybinding({
  id: 'input.deleteWord',
  keys: [
    { name: 'backspace', alt: true },
    { name: 'char', text: 'w', ctrl: true },
  ],
  scopes: ['input'],
  description: '删除前一个词',
  descriptionEn: 'Delete the previous word',
  owner: 's01',
})
registerKeybinding({
  id: 'input.clear',
  keys: [{ name: 'char', text: 'u', ctrl: true }],
  scopes: ['input'],
  description: '清空当前输入',
  descriptionEn: 'Clear the current input',
  owner: 's01',
})
registerKeybinding({
  id: 'cursor.left',
  keys: [{ name: 'left' }, { name: 'char', text: 'b', ctrl: true }],
  scopes: ['input'],
  description: '向左移动光标',
  descriptionEn: 'Move the cursor left',
  owner: 's01',
})
registerKeybinding({
  id: 'cursor.right',
  keys: [{ name: 'right' }, { name: 'char', text: 'f', ctrl: true }],
  scopes: ['input'],
  description: '向右移动光标',
  descriptionEn: 'Move the cursor right',
  owner: 's01',
})
registerKeybinding({
  id: 'cursor.wordLeft',
  keys: [
    { name: 'left', alt: true },
    { name: 'left', ctrl: true },
  ],
  scopes: ['input'],
  description: '按词左移',
  descriptionEn: 'Move left by one word',
  owner: 's01',
})
registerKeybinding({
  id: 'cursor.wordRight',
  keys: [
    { name: 'right', alt: true },
    { name: 'right', ctrl: true },
  ],
  scopes: ['input'],
  description: '按词右移',
  descriptionEn: 'Move right by one word',
  owner: 's01',
})
registerKeybinding({
  id: 'cursor.home',
  keys: [{ name: 'home' }, { name: 'char', text: 'a', ctrl: true }],
  scopes: ['input'],
  description: '行首',
  descriptionEn: 'Move to the start of the line',
  owner: 's01',
})
registerKeybinding({
  id: 'cursor.end',
  keys: [{ name: 'end' }, { name: 'char', text: 'e', ctrl: true }],
  scopes: ['input'],
  description: '行尾',
  descriptionEn: 'Move to the end of the line',
  owner: 's01',
})
registerKeybinding({
  id: 'history.prev',
  keys: [{ name: 'up' }],
  scopes: ['input'],
  description: '上一条历史（当前项目）',
  descriptionEn: 'Previous history entry (this project)',
  owner: 's01',
})
registerKeybinding({
  id: 'history.next',
  keys: [{ name: 'down' }],
  scopes: ['input'],
  description: '下一条历史',
  descriptionEn: 'Next history entry',
  owner: 's01',
})
registerKeybinding({
  id: 'transcript.scrollUp',
  keys: [{ name: 'pageup' }, { name: 'up', shift: true }],
  description: '向上滚动 transcript',
  descriptionEn: 'Scroll the transcript up',
  owner: 's01',
})
registerKeybinding({
  id: 'transcript.scrollDown',
  keys: [{ name: 'pagedown' }, { name: 'down', shift: true }],
  description: '向下滚动 transcript',
  descriptionEn: 'Scroll the transcript down',
  owner: 's01',
})
registerKeybinding({
  id: 'transcript.scrollBottom',
  keys: [{ name: 'end', ctrl: true }],
  description: '跳到转录末尾并粘底',
  descriptionEn: 'Jump to the end and stick to the bottom',
  owner: 's01',
})
registerKeybinding({
  id: 'overlay.escape',
  keys: [{ name: 'escape' }],
  scopes: ['overlay'],
  description: '关闭当前覆盖层',
  descriptionEn: 'Close the current overlay',
  owner: 's01',
})
registerKeybinding({
  id: 'focus.next',
  keys: [{ name: 'tab' }],
  scopes: ['overlay'],
  description: '切换覆盖层焦点',
  descriptionEn: 'Switch overlay focus',
  owner: 's01',
})
