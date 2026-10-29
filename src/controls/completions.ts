/**
 * 补全与 `@` 引用（S02 spec §2）。
 *
 * 三类补全（文件 / 命令 / 技能）经 D01 的 provider 注册 API 接入，源是官方服务：
 * `fileReferences.list`、`commands.list`、`skills.snapshot`。补全打开时
 * Enter 只接受选中项、不提交；Tab 插入不执行；空结果与失败分开显示。
 * 命令同名优先于技能；`snapshot().complete === false` 标「可能不完整」。
 */
import { createElement, type ReactNode } from 'react'
import type { InputModel } from '../app/input-model.ts'
import {
  type CompletionItem,
  type CompletionKind,
  type CompletionProvider,
  CompletionRegistry,
  CompletionSession,
} from '../input/completion.ts'
import type { Key } from '../input/parser.ts'
import { Box, Text } from '../render/components.ts'
import { graphemes } from '../render/text.ts'

export interface CompletionsOptions {
  readonly ctx: any
  readonly input: InputModel
  readonly getAgent: () => any | undefined
  readonly onChange: () => void
  readonly writeDiagnostic: (line: string) => void
}

interface Trigger {
  readonly kind: CompletionKind
  readonly query: string
  /** 从光标往回要替换掉的 grapheme 数（含触发符）。 */
  readonly remove: number
}

export class Completions {
  private readonly options: CompletionsOptions
  readonly registry = new CompletionRegistry()
  readonly session = new CompletionSession()
  private disposers: Array<() => void> = []
  private lastTrigger: Trigger | undefined
  private failures: string[] = []
  private catalogIncomplete = false
  private requestToken = 0

  constructor(options: CompletionsOptions) {
    this.options = options
  }

  /** 注册三类 provider；返回即生效，dispose 时摘下。 */
  install(): void {
    this.disposers.push(this.registry.register(this.fileProvider()))
    this.disposers.push(this.registry.register(this.commandProvider()))
    const skill = this.skillProvider()
    this.disposers.push(this.registry.register(skill.provider))
    this.catalogIncomplete = false
  }

  dispose(): void {
    for (const dispose of this.disposers) dispose()
    this.disposers = []
    this.session.close()
  }

  private fileProvider(): CompletionProvider {
    return {
      id: 'nano.files',
      kind: 'file',
      complete: async (query) => {
        const agent = this.options.getAgent()
        const service = this.options.ctx.get('fileReferences')
        if (!agent || !service) return []
        const signal = new AbortController().signal
        const candidates = await service.list(agent, query, signal)
        return (candidates as Array<{ path: string; kind: string }>).map((candidate) => ({
          label: candidate.path,
          insert: `@${candidate.path}${candidate.kind === 'directory' ? '/' : ' '}`,
          kind: 'file' as const,
          description: candidate.kind === 'directory' ? '目录' : '文件',
        }))
      },
    }
  }

  private commandProvider(): CompletionProvider {
    return {
      id: 'nano.commands',
      kind: 'command',
      complete: (query) => {
        const agent = this.options.getAgent()
        const commands = agent ? (this.options.ctx.get('commands')?.list(agent) ?? []) : []
        const builtins = [{ name: 'model', description: '切换模型与推理强度' }]
        const merged = [...builtins, ...(commands as Array<{ name: string; description: string }>)]
        const seen = new Set<string>()
        return merged
          .filter((command) => command.name.startsWith(query.toLowerCase()))
          .filter((command) => (seen.has(command.name) ? false : (seen.add(command.name), true)))
          .map((command) => ({
            label: `/${command.name}`,
            insert: `/${command.name} `,
            kind: 'command' as const,
            description: command.description,
          }))
      },
    }
  }

  private skillProvider(): { provider: CompletionProvider } {
    return {
      provider: {
        id: 'nano.skills',
        kind: 'skill',
        complete: async (query) => {
          const skills = this.options.ctx.get('skills')
          if (!skills) return []
          try {
            const snapshot = await skills.snapshot()
            this.catalogIncomplete = snapshot?.complete === false
            const summaries = (snapshot?.skills ?? []) as Array<{
              name: string
              description: string
              userInvocable?: boolean
            }>
            return summaries
              .filter((skill) => skill.userInvocable !== false)
              .filter((skill) => skill.name.toLowerCase().includes(query.toLowerCase()))
              .map((skill) => ({
                label: `/${skill.name}`,
                insert: `/${skill.name} `,
                kind: 'skill' as const,
                description: skill.description,
              }))
          } catch (error) {
            // 发现失败保留上次目录：这里不清空已显示的条目，只记录失败。
            this.failures.push(String((error as Error)?.message ?? error))
            return []
          }
        },
      },
    }
  }

  private lastText = ''
  private lastCursor = -1

  /** 每帧调用：只在文本或光标真的变了时才重新查询。 */
  maybeSync(): void {
    const { text, cursor } = this.options.input
    if (text === this.lastText && cursor === this.lastCursor) return
    this.lastText = text
    this.lastCursor = cursor
    this.sync()
  }

  /** 每次输入框内容变化后调用：决定开/关补全并异步取条目。 */
  sync(): void {
    const trigger = detectTrigger(this.options.input.text, this.options.input.cursor)
    this.lastTrigger = trigger
    if (!trigger) {
      if (this.session.isOpen) this.session.close()
      return
    }
    const token = ++this.requestToken
    void this.refresh(trigger, token)
  }

  private async refresh(trigger: Trigger, token: number): Promise<void> {
    this.failures = []
    if (trigger.kind === 'file') {
      const { items, failures } = await this.registry.query('file', trigger.query)
      if (token !== this.requestToken) return
      this.reportFailures(failures)
      this.session.open('file', trigger.query, items)
    } else {
      // 命令 + 技能一起出；同名时命令在前（命令优先于技能）。
      const commands = await this.registry.query('command', trigger.query)
      const skills = await this.registry.query('skill', trigger.query)
      if (token !== this.requestToken) return
      this.reportFailures([...commands.failures, ...skills.failures])
      const byLabel = new Map<string, CompletionItem>()
      for (const item of commands.items) byLabel.set(item.label, item)
      for (const item of skills.items) if (!byLabel.has(item.label)) byLabel.set(item.label, item)
      this.session.open('command', trigger.query, [...byLabel.values()])
    }
    this.options.onChange()
  }

  private reportFailures(failures: Array<{ id: string; error: unknown }>): void {
    for (const failure of failures) {
      const message = String((failure.error as Error)?.message ?? failure.error)
      this.failures.push(`${failure.id}: ${message}`)
      this.options.writeDiagnostic(`nano: 补全源 ${failure.id} 失败：${message}`)
    }
  }

  get open(): boolean {
    return this.session.isOpen
  }

  /** 补全打开时的按键；返回 true 表示已消费。 */
  handleKey(key: Key): boolean {
    if (!this.session.isOpen) return false
    if (key.name === 'up') {
      this.session.move(-1)
      this.options.onChange()
      return true
    }
    if (key.name === 'down') {
      this.session.move(1)
      this.options.onChange()
      return true
    }
    if (key.name === 'escape') {
      this.session.close()
      this.options.onChange()
      return true
    }
    if (key.name === 'enter') {
      // 补全打开时 Enter 只接受选中项，不提交消息。
      this.accept()
      return true
    }
    if (key.name === 'tab') {
      this.accept()
      return true
    }
    return false
  }

  /** Tab 走 keymap 时的入口（S01 未消费的 action）。 */
  accept(): void {
    const trigger = this.lastTrigger
    const inserted = this.session.accept()
    if (inserted === undefined || !trigger) {
      this.session.close()
      this.options.onChange()
      return
    }
    for (let index = 0; index < trigger.remove; index++) this.options.input.backspace()
    this.options.input.insert(inserted)
    this.options.onChange()
    this.sync()
  }

  /** 正文区底部的补全面板；没开补全时不出。 */
  render(width: number): ReactNode {
    if (!this.session.isOpen) return null
    const items = this.session.items
    const lines: ReactNode[] = []
    const title = this.session.kind === 'file' ? '@ 引用' : '命令 / 技能'
    lines.push(
      createElement(
        Text,
        { dim: true },
        `${title} · ↑↓ 选择 · Tab 插入 · Enter 接受 · Esc 关闭${this.catalogIncomplete ? ' · 技能目录可能不完整' : ''}`,
      ),
    )
    if (items.length === 0) {
      lines.push(createElement(Text, { dim: true }, '  （没有匹配）'))
    }
    items.slice(0, 6).forEach((item, index) => {
      const selected = index === this.session.selectedIndex
      lines.push(
        createElement(
          Text,
          { ...(selected ? { reverse: true } : {}) },
          `  ${item.label}${item.description ? ` — ${truncate(item.description, Math.max(12, width - 24))}` : ''}`,
        ),
      )
    })
    for (const failure of this.failures.slice(0, 2)) {
      lines.push(createElement(Text, { dim: true }, `  补全失败：${failure}`))
    }
    return createElement(Box, { flexDirection: 'column', width }, ...lines)
  }
}

/** 单行截断，避免补全描述换行把列表挤爆。 */
function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}…`
}

/** 从光标往回找触发符：`@` 在开头或空白后；`/` 只在整行开头。 */
export function detectTrigger(text: string, cursor: number): Trigger | undefined {
  const cells = graphemes(text)
  const before = cells.slice(0, cursor)
  const head = before.join('')
  // 命令只在整行以 `/` 开头且还没打字到空白时触发。
  if (head.startsWith('/') && !/\s/u.test(head)) {
    return { kind: 'command', query: head.slice(1), remove: before.length }
  }
  // `@`：从光标往回找最近的 `@`，且它前面必须是行首或空白。
  for (let index = before.length - 1; index >= 0; index--) {
    const char = before[index]
    if (char === '@') {
      const prev = index > 0 ? before[index - 1] : undefined
      if (prev === undefined || /\s/u.test(prev ?? '')) {
        return {
          kind: 'file',
          query: before.slice(index + 1).join(''),
          remove: before.length - index,
        }
      }
      return undefined
    }
    if (/\s/u.test(char ?? '')) return undefined
  }
  return undefined
}
