/**
 * 信息面板（S02 spec §2）：技能目录、模型/强度身份、上下文占用。
 *
 * - 技能：官方 `skills.snapshot()`；`complete === false` 标「可能不完整」；
 *   预览只读，不加载技能正文。
 * - 模型/强度：身份是 `provider + model`；只列官方给出的 `efforts`，
 *   `provider`/`model` 同时出现才算有效身份。
 * - 上下文：占用 = `projectedTokens / contextWindow`；任一缺失显示「未知」，
 *   `tokenUsage` 是计费累计，不混用。
 */
import { createElement, type ReactNode } from 'react'
import type { Key } from '../input/parser.ts'
import { Box, Text } from '../render/components.ts'

export interface InfoPanelOptions {
  readonly ctx: any
  readonly getAgent: () => any | undefined
  readonly onChange: () => void
  readonly writeDiagnostic: (line: string) => void
}

export interface SkillRow {
  readonly name: string
  readonly description: string
}

export interface ModelIdentity {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
  readonly efforts?: readonly string[]
}

export class InfoPanel {
  private readonly options: InfoPanelOptions
  private open = false
  private skills: SkillRow[] = []
  private catalogComplete = true
  private model: ModelIdentity | undefined
  private loadFailed: string | undefined
  private notice: string | undefined

  constructor(options: InfoPanelOptions) {
    this.options = options
  }

  get visible(): boolean {
    return this.open
  }

  toggle(): void {
    this.open = !this.open
    if (this.open) void this.refresh()
    this.options.onChange()
  }

  hide(): void {
    this.open = false
    this.options.onChange()
  }

  async refresh(): Promise<void> {
    this.loadFailed = undefined
    const ctx = this.options.ctx
    try {
      const skills = ctx.get('skills')
      if (skills?.snapshot) {
        const snapshot = await skills.snapshot()
        this.catalogComplete = snapshot?.complete !== false
        this.skills = ((snapshot?.skills ?? []) as Array<{ name: string; description: string }>).map(
          (skill) => ({ name: skill.name, description: skill.description }),
        )
      } else {
        this.skills = []
        this.catalogComplete = false
      }
    } catch (error) {
      // 发现失败保留上次目录，只记原因。
      this.loadFailed = String((error as Error)?.message ?? error)
      this.options.writeDiagnostic(`nano: 技能目录读取失败：${this.loadFailed}`)
    }
    this.model = readModelIdentity(ctx)
    if (this.model) {
      const efforts = await readEfforts(ctx, this.model)
      if (efforts.length > 0) this.model = { ...this.model, efforts }
    }
    this.options.onChange()
  }

  handleKey(key: Key): boolean {
    if (!this.open) return false
    if (key.name === 'escape') {
      this.hide()
      return true
    }
    if (key.name === 'char' && key.text === 'r' && !key.ctrl) {
      void this.refresh()
      return true
    }
    return true
  }

  render(width: number, height: number): ReactNode {
    if (!this.open) return null
    const lines: ReactNode[] = []
    lines.push(createElement(Text, { dim: true }, '信息 · r 刷新 · Esc 关闭'))
    const model = this.model
    lines.push(
      createElement(
        Text,
        {},
        `  模型：${model ? `${model.provider} / ${model.model}` : '未知'}${model?.reasoningEffort ? ` · 强度 ${model.reasoningEffort}` : ''}`,
      ),
    )
    if (model?.efforts && model.efforts.length > 0) {
      lines.push(createElement(Text, { dim: true }, `  可选强度：${model.efforts.join(' / ')}`))
    }
    lines.push(createElement(Text, { dim: true }, `  上下文：${occupancyText(this.options.ctx, this.options.getAgent())}`))
    lines.push(
      createElement(
        Text,
        { dim: true },
        `  技能${this.catalogComplete ? '' : '（可能不完整）'}${this.skills.length === 0 ? '：无' : '：'}`,
      ),
    )
    for (const skill of this.skills.slice(0, Math.max(1, height - 8))) {
      lines.push(createElement(Text, {}, `    ${skill.name}  ${skill.description}`))
    }
    if (this.loadFailed) lines.push(createElement(Text, { dim: true }, `  技能发现失败：${this.loadFailed}`))
    if (this.notice) lines.push(createElement(Text, { dim: true }, `  ${this.notice}`))
    return createElement(Box, { flexDirection: 'column', width }, ...lines)
  }
}

/** 模型身份只认 `provider + model` 同时存在。 */
export function readModelIdentity(ctx: any): ModelIdentity | undefined {
  const selection = ctx.get('agentDefaultModel')?.currentSelection?.()
  const provider = String(selection?.provider ?? '')
  const model = String(selection?.model ?? '')
  if (provider === '' || model === '') return undefined
  const efforts = Array.isArray(selection?.efforts)
    ? (selection.efforts as string[])
    : Array.isArray(ctx.get('agentDefaultModel')?.efforts)
      ? (ctx.get('agentDefaultModel').efforts as string[])
      : undefined
  return {
    provider,
    model,
    ...(selection?.reasoningEffort ? { reasoningEffort: String(selection.reasoningEffort) } : {}),
    ...(efforts ? { efforts } : {}),
  }
}

/**
 * 占用 = contextPressure 的 pressureTokens / contextWindow；缺一显示「未知」。
 * `tokenUsage` 是计费累计，按 spec 不混用。
 */
export function occupancyText(ctx: any, agent: any): string {
  const session = agent?.session
  const registry = ctx?.get?.('sessionProjections')
  if (!session || !registry?.snapshot) return '未知'
  let snapshot: any
  try {
    snapshot = registry.snapshot(session, ['contextPressure'])
  } catch {
    return '未知'
  }
  const state = snapshot?.values?.contextPressure ?? snapshot?.contextPressure
  const used = Number(state?.pressureTokens ?? state?.surfaceTokens ?? NaN)
  const window = Number(state?.contextWindow ?? NaN)
  if (!Number.isFinite(used) || !Number.isFinite(window) || window <= 0) return '未知'
  return `${Math.round((used / window) * 100)}%（${used}/${window}）`
}

/** 强度列表：官方 `llm.resolveModelInfo(provider, model)` 的 reasoning.efforts。 */
export async function readEfforts(ctx: any, identity: ModelIdentity | undefined): Promise<string[]> {
  if (!identity) return []
  const llm = ctx?.get?.('llm')
  if (!llm?.resolveModelInfo) return []
  try {
    const info = await llm.resolveModelInfo(identity.provider, identity.model)
    const efforts = info?.reasoning?.efforts
    if (!Array.isArray(efforts)) return []
    return efforts.map((effort: any) => String(effort?.id ?? effort?.name ?? effort)).filter(Boolean)
  } catch {
    return []
  }
}
