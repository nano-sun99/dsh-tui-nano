/**
 * `/model` 选择面板（设计稿 model-default-100-dark）：
 * 顶部一条线 → `模型` + 当前模型摘要 → 模型列表 → 分隔线 → 强度行。
 * ↑↓ 选模型、←→ 选强度、Enter 应用、Esc 关闭。
 */
import { createElement } from 'react'
import type { ConversationController } from '../conversation/controller.ts'
import type { Key } from '../input/parser.ts'
import { Box, Text } from '../render/components.ts'
import { EDGE } from '../theme/spacing.ts'
import { activeTheme } from '../theme/theme.ts'

export interface ModelPanelOptions {
  readonly conversation: ConversationController
  readonly onChange: () => void
  readonly notice: (text: string, tone?: 'info' | 'warning' | 'danger') => void
}

export class ModelPanel {
  private readonly options: ModelPanelOptions
  private visible = false
  private provider = ''
  private models: string[] = []
  private modelIndex = 0
  private efforts: string[] = []
  private effortIndex = 0

  constructor(options: ModelPanelOptions) {
    this.options = options
  }

  get open(): boolean {
    return this.visible
  }

  async openPanel(): Promise<void> {
    const conversation = this.options.conversation
    const current = conversation.modelSelection
    if (!current) {
      this.options.notice('没有可用的模型')
      return
    }
    this.provider = current.provider
    const list = await conversation.listModels(this.provider)
    const ids = list
      .map((entry: any) => String(entry?.id ?? entry?.model ?? entry?.name ?? ''))
      .filter(Boolean)
    this.models = ids.length > 0 ? ids : [current.model]
    if (!this.models.includes(current.model)) this.models.unshift(current.model)
    this.modelIndex = Math.max(0, this.models.indexOf(current.model))
    await this.refreshEfforts()
    this.visible = true
    this.options.onChange()
  }

  private async refreshEfforts(): Promise<void> {
    const model = this.models[this.modelIndex]
    if (!model) {
      this.efforts = []
      this.effortIndex = 0
      return
    }
    const current = this.options.conversation.modelSelection
    this.efforts = await this.options.conversation.resolveModelEfforts(this.provider, model)
    const currentEffort =
      current?.model === model && current.provider === this.provider
        ? current.reasoningEffort
        : undefined
    this.effortIndex = currentEffort ? Math.max(0, this.efforts.indexOf(currentEffort)) : 0
  }

  handleKey(key: Key): boolean {
    if (!this.visible) return false
    if (key.name === 'up' || key.name === 'down') {
      const delta = key.name === 'up' ? -1 : 1
      const count = this.models.length
      if (count > 0) this.modelIndex = (this.modelIndex + delta + count) % count
      void this.refreshEfforts().then(() => this.options.onChange())
      return true
    }
    if (key.name === 'left' || key.name === 'right') {
      const delta = key.name === 'left' ? -1 : 1
      if (this.efforts.length > 0) {
        this.effortIndex = (this.effortIndex + delta + this.efforts.length) % this.efforts.length
      }
      this.options.onChange()
      return true
    }
    if (key.name === 'enter') {
      void this.apply()
      return true
    }
    if (key.name === 'escape') {
      this.visible = false
      this.options.onChange()
      return true
    }
    return false
  }

  private async apply(): Promise<void> {
    const model = this.models[this.modelIndex]
    if (!model) return
    const effort = this.efforts[this.effortIndex]
    try {
      const next = await this.options.conversation.selectModel(this.provider, model, effort)
      this.visible = false
      this.options.notice(
        `模型已切换：${next.provider}/${next.model}${next.reasoningEffort ? ` · 强度 ${next.reasoningEffort}` : ' · 强度默认'}（下一次请求生效）`,
        'info',
      )
    } catch (error) {
      this.options.notice(`模型切换失败：${String((error as Error)?.message ?? error)}`, 'danger')
    }
    this.options.onChange()
  }

  rows(): number {
    if (!this.visible) return 0
    const models = Math.min(5, this.models.length)
    return 1 + 1 + models + (this.efforts.length > 0 ? 2 : 0)
  }

  render(width: number): ReturnType<typeof createElement> | null {
    if (!this.visible) return null
    const theme = activeTheme()
    const bar = '─'.repeat(Math.max(1, width - EDGE * 2))
    const current = this.options.conversation.modelSelection
    const summary = current
      ? `当前：${current.model}${current.reasoningEffort ? ` · ${current.reasoningEffort}` : ' · 默认'}`
      : ''
    const lines = [
      createElement(Text, { color: theme.rule }, `  ${bar}`),
      createElement(
        Box,
        { flexDirection: 'row', paddingX: EDGE, width },
        createElement(Text, { color: theme.muted }, '模型'),
        createElement(Box, { flexGrow: 1 }),
        createElement(Text, { color: theme.muted }, summary),
      ),
    ]
    this.models.slice(0, 5).forEach((model, index) => {
      const selected = index === this.modelIndex
      lines.push(
        createElement(
          Text,
          { ...(selected ? { color: theme.accent } : {}) },
          `  ${selected ? '▶ ' : '  '}${model}`,
        ),
      )
    })
    if (this.efforts.length > 0) {
      lines.push(createElement(Text, { color: theme.rule }, `  ${bar}`))
      lines.push(
        createElement(
          Box,
          { flexDirection: 'row', paddingX: EDGE, width },
          ...this.efforts.map((effort, index) =>
            createElement(
              Text,
              { ...(index === this.effortIndex ? { reverse: true } : { color: theme.muted }) },
              ` ${effort} `,
            ),
          ),
        ),
      )
    }
    return createElement(Box, { flexDirection: 'column', width }, ...lines)
  }
}
