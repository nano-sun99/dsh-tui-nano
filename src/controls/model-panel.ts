/**
 * `/model` 选择面板（2026-10-25 视觉规格 §3.3 + 2026-10-26 扫光补充规格）。
 *
 * - 顶部一条 accent 线，替换输入区；transcript 保持可见。
 * - 头部 `模型` + `当前：<模型> · <强度>`；模型列表只有名字，焦点 ▶ + accent/bold。
 * - 强度条铺满内容宽度；默认不点亮；官方档位按顺序分档。
 * - 扫光绑定官方 `efforts[len-2]`（len>=3），1400ms 线性；Max 按 id 脉冲。
 * - `NANO_REDUCED_MOTION=1|true` 时静止。
 */
import { createElement } from 'react'
import type { ConversationController } from '../conversation/controller.ts'
import type { Key } from '../input/parser.ts'
import { Box, Text } from '../render/components.ts'
import { displayWidth, graphemes } from '../render/text.ts'
import { EDGE, NESTED } from '../theme/spacing.ts'
import { activeTheme, type Rgb } from '../theme/theme.ts'

interface Effort {
  readonly id: string
  readonly name: string
}

interface Entry {
  readonly id: string
  readonly name: string
  levels: Effort[]
  defaultEffort?: string
  loaded: boolean
  error?: string
}

export interface ModelPanelOptions {
  readonly conversation: ConversationController
  readonly onChange: () => void
  readonly setNotice: (text: string | undefined) => void
}

const BASE = {
  low: null,
  high: [129, 144, 168] as Rgb,
  xhigh: [93, 127, 173] as Rgb,
  max: [54, 95, 157] as Rgb,
}
const SWEEP_BASE: Rgb = [93, 127, 173]
const SWEEP_HIGHLIGHT: Rgb = [155, 184, 223]
const MAX_BRIGHT: Rgb = [74, 129, 216]
const MAX_LABEL = [111, 156, 221] as Rgb
const TICK_MS = 50
/**
 * 设计稿扫光：1.4s 线性循环，`background-size:220%`、`background-position`
 * 从 100% 走到 -120%。换到填充区坐标，高光中心从 -0.1 个填充宽走到 2.54 个，
 * 高光带半宽 26.4%。中心离开填充区后自然形成约 0.68s 的空窗，再从左缘重播。
 */
const SWEEP_PERIOD_MS = 1400
const SWEEP_START = -0.1
const SWEEP_TRAVEL = 2.64
const SWEEP_RADIUS = 0.264

function mix(a: Rgb, b: Rgb, amount: number): Rgb {
  const t = Math.max(0, Math.min(1, amount))
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ]
}

function scale(color: Rgb, factor: number): Rgb {
  const clamp = (value: number): number => Math.max(0, Math.min(255, Math.round(value)))
  return [clamp(color[0] * factor), clamp(color[1] * factor), clamp(color[2] * factor)]
}

function truncate(text: string, max: number): string {
  if (displayWidth(text) <= max) return text
  let out = ''
  let used = 0
  for (const cell of graphemes(text)) {
    const width = displayWidth(cell)
    if (used + width > Math.max(1, max - 1)) break
    out += cell
    used += width
  }
  return `${out}…`
}

export class ModelPanel {
  private readonly options: ModelPanelOptions
  private visible = false
  private provider = ''
  private entries: Entry[] = []
  private modelIndex = 0
  private effortIndex = 0
  private phaseStart = Date.now()
  private timer: NodeJS.Timeout | undefined

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
      this.options.setNotice('没有可用的模型')
      return
    }
    this.provider = current.provider
    const catalog = await conversation.listModels(this.provider)
    const entries: Entry[] = catalog
      .map((entry: any) => ({
        id: String(entry?.id ?? entry?.model ?? ''),
        name: String(entry?.name ?? entry?.id ?? entry?.model ?? ''),
      }))
      .filter((entry: { id: string }) => entry.id !== '')
      .map((entry: { id: string; name: string }) => ({
        ...entry,
        levels: [],
        loaded: false,
      }))
    if (!entries.some((entry) => entry.id === current.model)) {
      entries.unshift({
        id: current.model,
        name: current.model,
        levels: [],
        loaded: false,
      })
    }
    this.entries = entries
    this.modelIndex = Math.max(
      0,
      entries.findIndex((entry) => entry.id === current.model),
    )
    this.effortIndex = 0
    this.visible = true
    this.phaseStart = Date.now()
    this.options.setNotice(undefined)
    await this.loadFocus()
    this.ensureTick()
    this.options.onChange()
  }

  private get focus(): Entry | undefined {
    return this.entries[this.modelIndex]
  }

  private get levels(): Effort[] {
    return this.focus?.levels ?? []
  }

  private async loadFocus(): Promise<void> {
    const entry = this.focus
    if (!entry || entry.loaded) return
    entry.loaded = true
    try {
      const meta = await this.options.conversation.resolveModelMeta(this.provider, entry.id)
      entry.levels = meta.efforts
      if (meta.defaultEffort) entry.defaultEffort = meta.defaultEffort
    } catch (error) {
      entry.error = String((error as Error)?.message ?? error)
    }
    this.options.onChange()
  }

  private get reducedMotion(): boolean {
    const value = process.env.NANO_REDUCED_MOTION
    return value === '1' || value === 'true'
  }

  /** 扫光档：官方 efforts 的倒数第二档，len>=3 才成立。 */
  private get sweepLevel(): number | undefined {
    return this.levels.length >= 3 ? this.levels.length - 1 : undefined
  }

  private get sweepActive(): boolean {
    const index = this.sweepLevel
    if (index === undefined || this.effortIndex !== index) return false
    return this.levels[index - 1]?.id !== 'max'
  }

  private get maxActive(): boolean {
    if (this.effortIndex < 1) return false
    return this.levels[this.effortIndex - 1]?.id === 'max'
  }

  private ensureTick(): void {
    const needed = this.visible && !this.reducedMotion && (this.sweepActive || this.maxActive)
    if (needed && !this.timer) {
      this.timer = setInterval(() => this.options.onChange(), TICK_MS)
    } else if (!needed && this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  private close(): void {
    this.visible = false
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    this.options.onChange()
  }

  handleKey(key: Key): boolean {
    if (!this.visible) return false
    if (key.name === 'escape') {
      this.options.setNotice('已取消，模型与强度未提交。')
      this.close()
      return true
    }
    if (key.name === 'up' || key.name === 'down') {
      const delta = key.name === 'up' ? -1 : 1
      const next = Math.max(0, Math.min(this.entries.length - 1, this.modelIndex + delta))
      if (next !== this.modelIndex) {
        this.modelIndex = next
        this.effortIndex = 0
        this.phaseStart = Date.now()
        void this.loadFocus().then(() => {
          this.ensureTick()
          this.options.onChange()
        })
      }
      return true
    }
    if (key.name === 'left' || key.name === 'right') {
      const count = this.levels.length + 1
      if (count > 1) {
        const delta = key.name === 'left' ? -1 : 1
        this.effortIndex = (this.effortIndex + delta + count) % count
        this.phaseStart = Date.now()
        this.ensureTick()
        this.options.onChange()
      }
      return true
    }
    if (key.name === 'enter') {
      void this.apply()
      return true
    }
    // 退出键必须放行：面板不能把 Ctrl+C / Ctrl+D 一起吞掉。
    if (key.ctrl && key.name === 'char' && (key.text === 'c' || key.text === 'd')) return false
    // 面板打开时吞掉其他按键，避免泄漏到底层输入/快捷键。
    return true
  }

  private async apply(): Promise<void> {
    const entry = this.focus
    if (!entry) return
    const effort = this.effortIndex > 0 ? this.levels[this.effortIndex - 1]?.id : undefined
    try {
      const next = await this.options.conversation.selectModel(this.provider, entry.id, effort)
      const effortName = effort ? (this.levels[this.effortIndex - 1]?.name ?? effort) : '默认'
      this.options.setNotice(`已选择 ${next.model} · ${effortName}。`)
      this.close()
    } catch (error) {
      this.options.setNotice(`模型切换失败：${String((error as Error)?.message ?? error)}`)
      this.options.onChange()
    }
  }

  private effortLabel(): string {
    if (this.levels.length === 0) return this.focus?.error ? '—' : '不可调'
    if (this.effortIndex === 0) {
      const name = this.levels.find((level) => level.id === this.focus?.defaultEffort)?.name
      return name ? `默认（模型默认：${name}）` : '默认'
    }
    return this.levels[this.effortIndex - 1]?.name ?? '默认'
  }

  private phase(period: number): number {
    return ((Date.now() - this.phaseStart) % period) / period
  }

  private fillColor(index: number, fillWidth: number): Rgb {
    if (this.reducedMotion) {
      if (this.sweepActive) return SWEEP_BASE
      if (this.maxActive) return BASE.max!
    }
    if (this.sweepActive) {
      const radius = Math.max(2, fillWidth * SWEEP_RADIUS)
      const elapsed = Date.now() - this.phaseStart
      const phase = ((elapsed % SWEEP_PERIOD_MS) + SWEEP_PERIOD_MS) % SWEEP_PERIOD_MS
      const center = (SWEEP_START + SWEEP_TRAVEL * (phase / SWEEP_PERIOD_MS)) * fillWidth
      const intensity = Math.max(0, 1 - Math.abs(index - center) / radius)
      return mix(SWEEP_BASE, SWEEP_HIGHLIGHT, intensity)
    }
    if (this.maxActive) {
      const wave = 0.5 - 0.5 * Math.cos(this.phase(1200) * Math.PI * 2)
      return mix(BASE.max!, MAX_BRIGHT, wave)
    }
    const id = this.levels[this.effortIndex - 1]?.id
    if (id === 'low') return activeTheme().muted
    if (id === 'high') return BASE.high!
    if (id === 'xhigh') return BASE.xhigh!
    if (id === 'max') return BASE.max!
    return activeTheme().muted
  }

  private barCells(fillWidth: number, barWidth: number): Array<{ color: Rgb; count: number }> {
    const theme = activeTheme()
    const runs: Array<{ color: Rgb; count: number }> = []
    for (let index = 0; index < barWidth; index++) {
      const color = index < fillWidth ? this.fillColor(index, fillWidth) : theme.rule
      const last = runs[runs.length - 1]
      if (
        last &&
        last.color[0] === color[0] &&
        last.color[1] === color[1] &&
        last.color[2] === color[2]
      ) {
        last.count += 1
      } else {
        runs.push({ color, count: 1 })
      }
    }
    return runs
  }

  private labelRow(barWidth: number): ReturnType<typeof createElement> {
    const theme = activeTheme()
    const count = this.levels.length
    const cells: Array<{ text: string; color: Rgb; bold: boolean } | undefined> =
      Array(barWidth).fill(undefined)
    this.levels.forEach((level, index) => {
      const label = level.name
      const width = displayWidth(label)
      const anchor =
        count <= 1 ? Math.floor(barWidth / 2) : Math.round((index / (count - 1)) * barWidth)
      const left =
        index === 0 ? 0 : index === count - 1 ? anchor - width : anchor - Math.floor(width / 2)
      const start = Math.max(0, Math.min(barWidth - width, left))
      const active = this.effortIndex === index + 1
      const isMax = level.id === 'max' && active
      const wave =
        isMax && !this.reducedMotion ? 0.5 - 0.5 * Math.cos(this.phase(1200) * Math.PI * 2) : 0
      const color = isMax
        ? mix(MAX_LABEL, SWEEP_HIGHLIGHT, wave)
        : active
          ? theme.accent
          : theme.muted
      cells[start] = { text: label, color, bold: active }
    })
    const spans: Array<{ text: string; color: Rgb; bold: boolean }> = []
    for (let index = 0; index < barWidth; index++) {
      const cell = cells[index]
      if (cell) {
        spans.push(cell)
        index += displayWidth(cell.text) - 1
      } else {
        const last = spans[spans.length - 1]
        if (last && !last.bold && last.color === theme.muted && last.text === ' ') last.text += ' '
        else spans.push({ text: ' ', color: theme.muted, bold: false })
      }
    }
    return createElement(
      Box,
      { flexDirection: 'row', paddingX: EDGE, width: barWidth + EDGE * 2 },
      ...spans.map((span) =>
        createElement(Text, { color: span.color, ...(span.bold ? { bold: true } : {}) }, span.text),
      ),
    )
  }

  rows(): number {
    if (!this.visible) return 0
    const models = Math.min(8, this.entries.length)
    // 两条边距各占一个垂直单位（1 行）。
    return 2 + 1 + models + 1 + (this.levels.length > 0 ? 3 : 1)
  }

  render(width: number): ReturnType<typeof createElement> | null {
    if (!this.visible) return null
    const theme = activeTheme()
    const barWidth = Math.max(1, width - EDGE * 2)
    const summary = `当前：${this.focus?.name ?? ''} · ${this.effortLabel()}`
    const lines: Array<ReturnType<typeof createElement>> = [
      createElement(
        Box,
        { flexDirection: 'row', paddingX: EDGE, width },
        createElement(Text, { color: theme.accent }, '─'.repeat(barWidth)),
      ),
      createElement(
        Box,
        { flexDirection: 'row', paddingX: EDGE, width },
        createElement(Text, { color: theme.accent, bold: true }, '模型'),
        createElement(Box, { flexGrow: 1 }),
        createElement(Text, { color: theme.muted }, truncate(summary, Math.max(10, barWidth - 4))),
      ),
    ]
    // 模型列表：在面板内容的基础上再缩进一个水平单位，上下各留一个垂直单位。
    lines.push(createElement(Text, {}, ' '))
    const visible = this.entries.slice(0, 8)
    visible.forEach((entry, index) => {
      const selected = index === this.modelIndex
      lines.push(
        createElement(
          Box,
          { flexDirection: 'row', paddingLeft: NESTED, paddingRight: EDGE, width },
          // `▶` 在渲染器里按 2 格计宽；再留 1 格间隙，和设计稿的 1ch 指针 + 1ch gap 对齐。
          // `wrap:false` 让间隙格也显式落一个空格，清掉上一帧可能留下的字符。
          createElement(
            Box,
            { width: 3 },
            createElement(
              Text,
              { wrap: false, ...(selected ? { color: theme.accent, bold: true } : {}) },
              selected ? '▶ ' : '   ',
            ),
          ),
          createElement(
            Text,
            { ...(selected ? { color: theme.accent, bold: true } : {}) },
            truncate(entry.name, Math.max(8, barWidth - 4)),
          ),
        ),
      )
    })
    lines.push(createElement(Text, {}, ' '))
    if (this.levels.length === 0) {
      const text = this.focus?.error ? '强度：—' : '强度：该模型未声明（不可调）'
      lines.push(
        createElement(
          Box,
          { flexDirection: 'row', paddingX: EDGE, width },
          createElement(Text, { color: theme.muted }, text),
        ),
      )
    } else {
      lines.push(
        createElement(
          Box,
          { flexDirection: 'row', paddingX: EDGE, width },
          createElement(Text, { color: theme.rule }, '─'.repeat(barWidth)),
        ),
      )
      const percent =
        this.effortIndex === 0
          ? 0
          : this.levels.length === 1
            ? 1
            : (this.effortIndex - 1) / (this.levels.length - 1)
      const fillWidth = Math.round(percent * barWidth)
      lines.push(
        createElement(
          Box,
          { flexDirection: 'row', paddingX: EDGE, width },
          ...this.barCells(fillWidth, barWidth).map((run) =>
            createElement(Text, { color: run.color }, '█'.repeat(run.count)),
          ),
        ),
      )
      lines.push(this.labelRow(barWidth))
    }
    return createElement(Box, { flexDirection: 'column', width }, ...lines)
  }
}
