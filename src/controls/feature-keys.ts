/**
 * S02 功能键的静态清单（S03 §5）：运行时注册与键位文档共用这一份，
 * 避免 `scripts/keymap-docs.mjs` 去猜运行时才注册的按键。
 *
 * 这里只放不依赖 Cordis 上下文的元数据；注册动作仍在 `Features` 构造时通过
 * `registerKeybinding` 完成。
 */
import type { KeyBinding } from '../input/keymap.ts'

/** 终端面板开关（owner s02）：Ctrl+T。 */
export const TERMINAL_TOGGLE_ACTION = 'terminal.toggle'

/** 任务面板开关（owner s02）：Ctrl+J。 */
export const JOBS_TOGGLE_ACTION = 'jobs.toggle'

/** 会话列表面板开关（owner s02）：Ctrl+L。 */
export const SESSIONS_TOGGLE_ACTION = 'sessions.toggle'

/** 信息面板（技能/模型/上下文）开关（owner s02）：Ctrl+I。 */
export const INFO_TOGGLE_ACTION = 'info.toggle'

export const FEATURE_KEYBINDINGS: readonly KeyBinding[] = [
  {
    id: INFO_TOGGLE_ACTION,
    keys: [{ name: 'char', text: 'i', ctrl: true }],
    scopes: ['idle', 'input', 'running'],
    description: '打开/关闭信息面板（技能/模型/上下文）',
    descriptionEn: 'Toggle the info panel (skills / model / context)',
    owner: 's02',
  },
  {
    id: SESSIONS_TOGGLE_ACTION,
    keys: [{ name: 'char', text: 'l', ctrl: true }],
    scopes: ['idle', 'input', 'running'],
    description: '打开/关闭会话列表',
    descriptionEn: 'Toggle the session list',
    owner: 's02',
  },
  {
    id: JOBS_TOGGLE_ACTION,
    keys: [{ name: 'char', text: 'j', ctrl: true }],
    scopes: ['idle', 'input', 'running'],
    description: '打开/关闭任务面板',
    descriptionEn: 'Toggle the jobs panel',
    owner: 's02',
  },
  {
    id: TERMINAL_TOGGLE_ACTION,
    keys: [{ name: 'char', text: 't', ctrl: true }],
    scopes: ['idle', 'input', 'running'],
    description: '打开/关闭终端面板',
    descriptionEn: 'Toggle the terminal panel',
    owner: 's02',
  },
]
