/**
 * Renderer: owns one terminal-sized cell grid, runs Yoga layout on the React
 * tree and emits only the changed runs. All terminal bytes go through the
 * single `write` callback supplied by the runtime (one writer per process).
 */

import { createElement, type ReactNode } from 'react'
import Reconciler from 'react-reconciler'
import Yoga, { Direction, FlexDirection, type Node as YogaNode } from 'yoga-layout'
import type { Rgb } from '../theme/theme.ts'
import { type ActivityGraphics, type ActivityImage, ActivityImagePlayer } from './activity-image.ts'
import { BLANK, createScreen, encodeDiff, type Screen, type Style, styleEquals } from './ansi.ts'
import {
  type AnyProps,
  freeSubtree,
  type GridNode,
  type HostNode,
  hostConfig,
  type RawTextNode,
  type RootContainer,
  type TextNode,
  textStyle,
} from './host.ts'
import { graphemes, graphemeWidth, wrapText } from './text.ts'

export interface HitRegion {
  readonly id: string
  readonly left: number
  readonly right: number
  readonly top: number
  readonly bottom: number
}

export interface SelectionRange {
  readonly startRow: number
  readonly startCol: number
  readonly endRow: number
  readonly endCol: number
}

interface Rect {
  x0: number
  y0: number
  x1: number
  y1: number
}

interface ReconcilerInstance {
  createContainer: (
    container: RootContainer,
    tag: number,
    hydrationCallbacks: unknown,
    isStrictMode: boolean,
    concurrentUpdatesByDefaultOverride: boolean | null,
    identifierPrefix: string,
    onUncaughtError: (error: unknown) => void,
    onCaughtError: (error: unknown) => void,
    onRecoverableError: (error: unknown) => void,
  ) => unknown
  updateContainer: (element: ReactNode, container: unknown) => void
  updateContainerSync: (
    element: ReactNode,
    container: unknown,
    parentComponent: unknown,
    callback: unknown,
  ) => number
  flushSyncWork?: () => void
}

const createReconciler = Reconciler as unknown as (config: unknown) => ReconcilerInstance

/**
 * 每帧都可能留下 `performance.measure`（开发构建的 React 每次组件渲染打一条，
 * 第三方库也会打），Node 的全局测量缓冲只增不减，长会话会一路涨到 OOM
 * （issue #138）。这里按帧数定期清空，作为「不依赖构建类型」的兜底。
 */
const MEASURE_SWEEP_FRAMES = 60

/** 动画节拍默认值；由 `nano-app` 用同一个常量注入（spec §5.2）。 */
export const DEFAULT_ACTIVITY_INTERVAL_MS = 33

export interface RendererOptions {
  readonly write: (bytes: string) => void
  readonly width: number
  readonly height: number
  readonly defaultFg: Rgb
  /** Called when a rendered frame fails; keeps the process alive but visible. */
  readonly onError?: (error: unknown) => void
  /** 纯动画帧的节拍；与内容刷新共用同一个常量。 */
  readonly activityIntervalMs?: number
}

export class Renderer {
  readonly container: RootContainer
  private readonly rootYoga: YogaNode
  private readonly reconciler: ReconcilerInstance
  private root: unknown
  private previous: Screen | undefined
  private width: number
  private height: number
  private scheduled: NodeJS.Immediate | undefined
  private mounted = false
  private readonly write: (bytes: string) => void
  private readonly defaultFg: Rgb
  private readonly onError: ((error: unknown) => void) | undefined
  private attached: HostNode[] = []
  hitRegions: HitRegion[] = []
  selection: SelectionRange | undefined
  private readonly activityPlayer = new ActivityImagePlayer()
  private activityImage: ActivityImage | undefined
  private activityTimer: NodeJS.Timeout | undefined
  private readonly activityIntervalMs: number
  private graphics: () => ActivityGraphics | undefined = () => undefined
  private activityStopped = false
  private framesSinceSweep = 0
  private cursorCell: { row: number; col: number } | undefined
  private lastCursorCell: { row: number; col: number } | undefined

  constructor(options: RendererOptions) {
    this.width = Math.max(1, options.width)
    this.height = Math.max(1, options.height)
    this.write = options.write
    this.defaultFg = options.defaultFg
    this.onError = options.onError
    this.activityIntervalMs = Math.max(
      1,
      options.activityIntervalMs ?? DEFAULT_ACTIVITY_INTERVAL_MS,
    )
    this.rootYoga = Yoga.Node.create()
    this.rootYoga.setFlexDirection(FlexDirection.Column)
    this.container = {
      children: [],
      width: this.width,
      height: this.height,
      onCommit: () => this.scheduleFrame(),
    }
    this.reconciler = createReconciler({ ...hostConfig, supportsMutation: true })
    this.root = this.reconciler.createContainer(
      this.container,
      0,
      null,
      false,
      null,
      '',
      (error: unknown) => this.reportError(error),
      (error: unknown) => this.reportError(error),
      (error: unknown) => this.reportError(error),
    )
  }

  mount(element: ReactNode): void {
    this.mounted = true
    this.commit(element)
  }

  /**
   * `immediate` 跳过 `setImmediate` 合并，直接画出这一帧：输入回显、滚动、
   * resize、退出与审批 / 问卷卡的出现和消失都不该等一个合并窗口（§5.2）。
   */
  update(element: ReactNode, options: { readonly immediate?: boolean } = {}): void {
    if (!this.mounted) {
      this.mount(element)
      return
    }
    this.commit(element)
    if (options.immediate === true) this.paintNow()
  }

  unmount(): void {
    if (!this.mounted) return
    this.mounted = false
    this.stopActivity()
    this.reconciler.updateContainerSync(null, this.root, null, null)
    this.flushFrame()
    // Detach still-attached roots before any node is freed.
    for (const child of this.attached) {
      try {
        this.rootYoga.removeChild(child.yoga)
      } catch {
        // Already removed.
      }
    }
    this.attached = []
    for (const child of this.container.children) freeSubtree(child)
    this.container.children = []
    try {
      this.rootYoga.free()
    } catch {
      // Already freed.
    }
  }

  resize(width: number, height: number): void {
    const nextWidth = Math.max(1, width)
    const nextHeight = Math.max(1, height)
    if (nextWidth === this.width && nextHeight === this.height) return
    const clear = this.activityPlayer.clear()
    if (clear) this.write(clear)
    this.width = nextWidth
    this.height = nextHeight
    this.container.width = nextWidth
    this.container.height = nextHeight
    this.previous = undefined
    this.scheduleFrame()
  }

  /** Force the next frame to repaint every cell (clears terminal-side stale content). */
  invalidate(): void {
    this.previous = undefined
    this.scheduleFrame()
  }

  /** Render pending React work and paint immediately (used by tests). */
  flushFrame(): void {
    if (this.reconciler.flushSyncWork) this.reconciler.flushSyncWork()
    this.frame()
  }

  private commit(element: ReactNode): void {
    this.reconciler.updateContainerSync(element, this.root, null, null)
    this.reconciler.flushSyncWork?.()
  }

  private scheduleFrame(): void {
    if (this.scheduled !== undefined) return
    this.scheduled = setImmediate(() => {
      this.scheduled = undefined
      try {
        this.frame()
      } catch (error) {
        this.reportError(error)
      }
    })
  }

  /** 立刻画一帧；顺手撤掉排队中的那一帧，避免同一内容画两次。 */
  private paintNow(): void {
    if (this.scheduled !== undefined) {
      clearImmediate(this.scheduled)
      this.scheduled = undefined
    }
    try {
      this.frame()
    } catch (error) {
      this.reportError(error)
    }
  }

  private reportError(error: unknown): void {
    if (this.onError) this.onError(error)
    else process.stderr.write(`nano render error: ${String(error)}\n`)
  }

  configureActivity(graphics: () => ActivityGraphics | undefined): void {
    this.graphics = graphics
  }

  stopActivity(): void {
    this.activityStopped = true
    if (this.activityTimer) clearTimeout(this.activityTimer)
    this.activityTimer = undefined
    const bytes = this.activityPlayer.clear()
    if (bytes) {
      try {
        this.write(bytes)
      } catch {
        /* Terminal may already be gone. */
      }
    }
  }

  private frame(): void {
    if (!this.mounted) return
    if (++this.framesSinceSweep >= MEASURE_SWEEP_FRAMES) {
      this.framesSinceSweep = 0
      performance.clearMeasures?.()
    }
    this.syncRootChildren()
    this.rootYoga.setWidth(this.width)
    this.rootYoga.setHeight(this.height)
    this.rootYoga.calculateLayout(this.width, this.height, Direction.LTR)
    this.hitRegions = []
    this.cursorCell = undefined
    this.activityImage = undefined
    const screen = createScreen(this.width, this.height)
    const clip: Rect = { x0: 0, y0: 0, x1: this.width, y1: this.height }
    for (const child of this.container.children) {
      this.computeAbsolute(child, 0, 0, clip)
      this.collectHitRegions(child)
    }
    for (const child of this.container.children) {
      this.paintNode(child, screen, clip)
    }
    this.applySelection(screen)
    const bytes = encodeDiff(this.previous, screen)
    this.previous = screen
    if (bytes !== '') this.write(bytes)
    const imageBytes = this.writeActivity()
    this.scheduleActivity()
    const cell = this.cursorCell as { row: number; col: number } | undefined
    if (cell) {
      const row = Math.min(Math.max(0, Math.floor(cell.row)), this.height - 1)
      const col = Math.min(Math.max(0, Math.floor(cell.col)), this.width - 1)
      const parked = this.lastCursorCell
      if (bytes !== '' || imageBytes !== '' || parked?.row !== row || parked?.col !== col) {
        this.write(`\x1b[${row + 1};${col + 1}H`)
      }
      this.lastCursorCell = { row, col }
    } else if (bytes !== '' || imageBytes !== '') {
      // Writes without a marker move the physical cursor; force a re-park next time.
      this.lastCursorCell = undefined
    }
  }

  /**
   * 纯动画帧：只重发鲸鱼图，复用上一帧算好的图片坐标（§5.2）。
   * 不跑 React、不重算 layout、不重建 screen、不 diff。
   */
  private animationFrame(): void {
    if (!this.mounted || this.activityStopped) return
    this.writeActivity()
    this.scheduleActivity()
  }

  /** 只把鲸鱼图那一块重发一次；没有新帧就不写。 */
  private writeActivity(): string {
    if (this.activityStopped) return ''
    let bytes: string
    try {
      bytes = this.activityPlayer.paint(
        this.activityImage,
        this.graphics(),
        /^(1|true)$/iu.test(process.env.NANO_REDUCED_MOTION ?? ''),
        Date.now(),
      )
    } catch {
      bytes = this.activityPlayer.disable()
    }
    if (bytes === '') return ''
    try {
      this.write(bytes)
    } catch {
      const clear = this.activityPlayer.disable()
      try {
        if (clear) this.write(clear)
      } catch {
        /* Best effort; the agent keeps running. */
      }
    }
    return bytes
  }

  private scheduleActivity(): void {
    if (this.activityTimer) clearTimeout(this.activityTimer)
    this.activityTimer = undefined
    if (!this.shouldAnimate()) return
    this.activityTimer = setTimeout(() => {
      this.activityTimer = undefined
      try {
        this.animationFrame()
      } catch (error) {
        this.reportError(error)
      }
    }, this.activityIntervalMs)
    this.activityTimer.unref()
  }

  private shouldAnimate(): boolean {
    return (
      !this.activityStopped &&
      this.activityImage !== undefined &&
      this.graphics() !== undefined &&
      !this.activityPlayer.disabled &&
      !/^(1|true)$/iu.test(process.env.NANO_REDUCED_MOTION ?? '')
    )
  }

  private syncRootChildren(): void {
    for (const child of this.attached) this.rootYoga.removeChild(child.yoga)
    this.attached = this.container.children.slice()
    this.attached.forEach((child, index) => {
      child.parent = null
      this.rootYoga.insertChild(child.yoga, index)
    })
  }

  private computeAbsolute(node: HostNode, originX: number, originY: number, clip: Rect): void {
    const layout = node.yoga.getComputedLayout()
    node.left = originX + layout.left
    node.top = originY + layout.top
    node.width = layout.width
    node.height = layout.height
    const nextClip: Rect =
      node.kind === 'box' && node.props.overflow === 'hidden'
        ? intersect(clip, {
            x0: node.left,
            y0: node.top,
            x1: node.left + node.width,
            y1: node.top + node.height,
          })
        : clip
    if (node.kind === 'box') {
      for (const child of node.children) this.computeAbsolute(child, node.left, node.top, nextClip)
    }
  }

  private collectHitRegions(node: HostNode): void {
    const id = node.props.onPress
    if (typeof id === 'string' && !node.hidden) {
      this.hitRegions.push({
        id,
        left: node.left,
        right: node.left + Math.max(1, node.width),
        top: node.top,
        bottom: node.top + Math.max(1, node.height),
      })
    }
    if (node.kind === 'box') {
      for (const child of node.children) this.collectHitRegions(child)
    }
  }

  private paintNode(node: HostNode, screen: Screen, clip: Rect): void {
    if (node.hidden) return
    const nodeClip =
      node.kind === 'box' && node.props.overflow === 'hidden'
        ? intersect(clip, {
            x0: node.left,
            y0: node.top,
            x1: node.left + node.width,
            y1: node.top + node.height,
          })
        : clip
    if (node.kind === 'box') {
      if (
        node.props.activityImage &&
        node.top >= clip.y0 &&
        node.top < clip.y1 &&
        node.left >= clip.x0 &&
        node.left + 3 <= clip.x1
      ) {
        this.activityImage = {
          ...node.props.activityImage,
          row: Math.floor(node.top),
          col: Math.floor(node.left),
        }
      }
      if (node.props.cursor === true) {
        this.cursorCell = { row: node.top, col: node.left }
      }
      if (node.props.clear) {
        clearRect(screen, node.left, node.top, node.width, node.height, clip)
      }
      if (node.props.backgroundColor) {
        fillRect(
          screen,
          node.left,
          node.top,
          node.width,
          node.height,
          node.props.backgroundColor,
          clip,
        )
      }
      for (const child of node.children) this.paintNode(child, screen, nodeClip)
      return
    }
    if (node.kind === 'grid') {
      this.paintGrid(node, screen, clip)
      return
    }
    this.paintText(node, screen, clip)
  }

  private paintGrid(node: GridNode, screen: Screen, clip: Rect): void {
    const baseX = Math.floor(node.left)
    const baseY = Math.floor(node.top)
    const width = Math.min(Math.floor(node.width), node.grid.width)
    const height = Math.min(Math.floor(node.height), node.grid.height)
    for (let row = 0; row < height; row++) {
      const y = baseY + row
      if (y < clip.y0 || y >= clip.y1) continue
      const sourceRow = node.grid.rows[row]
      const targetRow = screen.rows[y]
      if (!sourceRow || !targetRow) continue
      for (let col = 0; col < width; col++) {
        const x = baseX + col
        if (x < clip.x0 || x >= clip.x1 || x >= screen.width) continue
        const cell = sourceRow[col]
        if (!cell) continue
        targetRow[x] = cell
      }
    }
  }

  /** Ask for a repaint without changing React state (grid/terminal mutations). */
  requestPaint(): void {
    this.scheduleFrame()
  }

  private paintText(node: TextNode | RawTextNode, screen: Screen, clip: Rect): void {
    const width = Math.max(1, Math.floor(node.width))
    const wrap = node.kind === 'text' ? (node.props.wrap ?? true) : true
    const lines = wrappedLines(node, width, wrap)
    const style = mergeStyle({ fg: this.defaultFg }, textStyle(node.props as AnyProps))
    const maxRows = Math.max(0, Math.min(Math.floor(node.height), lines.length))
    const baseX = Math.floor(node.left)
    const baseY = Math.floor(node.top)
    const background = node.props.backgroundColor
    for (let row = 0; row < maxRows; row++) {
      const y = baseY + row
      if (y < clip.y0 || y >= clip.y1) continue
      const line = lines[row] ?? ''
      let x = baseX
      for (const grapheme of graphemes(line)) {
        const gw = graphemeWidth(grapheme)
        if (gw === 0) continue
        if (x + gw > clip.x1) break
        if (x >= clip.x0 && x + gw <= screen.width) {
          setCell(screen, y, x, grapheme, style)
          if (gw === 2) setContinuation(screen, y, x + 1, style)
        }
        x += gw
      }
      if (background) {
        // Fill only the rows the text occupies, never the terminal background.
        for (let col = baseX; col < baseX + width && col < clip.x1; col++) {
          if (col < clip.x0) continue
          const cell = screen.rows[y]?.[col]
          if (cell && cell.grapheme === ' ')
            setCell(screen, y, col, ' ', { ...style, bg: background })
        }
      }
    }
  }

  private applySelection(screen: Screen): void {
    const selection = this.selection
    if (!selection) return
    for (let row = selection.startRow; row <= selection.endRow; row++) {
      if (row < 0 || row >= screen.height) continue
      const line = screen.rows[row]
      if (!line) continue
      const start = row === selection.startRow ? selection.startCol : 0
      const end = row === selection.endRow ? selection.endCol : screen.width - 1
      for (let col = Math.max(0, start); col <= Math.min(screen.width - 1, end); col++) {
        const cell = line[col]
        if (!cell) continue
        if (cell.continuation) {
          const prev = line[col - 1]
          if (prev) line[col - 1] = { ...prev, style: { ...prev.style, reverse: true } }
          continue
        }
        line[col] = { ...cell, style: { ...cell.style, reverse: true } }
      }
    }
  }

  /** Text under a screen rectangle, used for mouse selection copy. */
  extractText(range: SelectionRange): string {
    const screen = this.previous
    if (!screen) return ''
    const lines: string[] = []
    for (let row = range.startRow; row <= range.endRow; row++) {
      const line = screen.rows[row]
      if (!line) continue
      const start = row === range.startRow ? range.startCol : 0
      const end = row === range.endRow ? range.endCol : screen.width - 1
      let text = ''
      let from = Math.max(0, start)
      // Starting inside a wide grapheme selects that whole grapheme.
      if (line[from]?.continuation) from = Math.max(0, from - 1)
      for (let col = from; col <= Math.min(screen.width - 1, end); col++) {
        const cell = line[col]
        if (!cell || cell.continuation) continue
        text += cell.grapheme === '' ? ' ' : cell.grapheme
      }
      lines.push(text.replace(/ +$/u, ''))
    }
    return lines.join('\n')
  }

  /** Plain-text snapshot of the last painted frame (tests and evidence). */
  snapshotLines(): string[] {
    const screen = this.previous
    if (!screen) return []
    return screen.rows.map((row) =>
      row
        .map((cell) => (cell.continuation ? '' : cell.grapheme === '' ? ' ' : cell.grapheme))
        .join('')
        .replace(/ +$/u, ''),
    )
  }

  /** Topmost pressable region at a screen coordinate (overlays win). */
  pressIdAt(x: number, y: number): string | undefined {
    for (let index = this.hitRegions.length - 1; index >= 0; index--) {
      const region = this.hitRegions[index]
      if (!region) continue
      if (y >= region.top && y < region.bottom && x >= region.left && x < region.right) {
        return region.id
      }
    }
    return undefined
  }
}

/**
 * 每个 text 节点每帧都要一遍换行；`text` 引用与宽度没变就复用上一帧的结果
 * （spec §5.3）。React 只在内容真的变了时才换掉 `node.text`，所以引用比较就够。
 */
function wrappedLines(
  node: TextNode | RawTextNode,
  width: number,
  wrap: boolean,
): readonly string[] {
  const cache = node.wrapCache
  if (cache !== undefined && cache.text === node.text && cache.width === width) return cache.lines
  const lines = wrap && node.text.length > 0 ? wrapText(node.text, width) : node.text.split('\n')
  node.wrapCache = { text: node.text, width, lines }
  return lines
}

function mergeStyle(base: Style, extra: Style): Style {
  return { ...base, ...extra }
}

function intersect(a: Rect, b: Rect): Rect {
  const rect = {
    x0: Math.max(a.x0, b.x0),
    y0: Math.max(a.y0, b.y0),
    x1: Math.min(a.x1, b.x1),
    y1: Math.min(a.y1, b.y1),
  }
  return rect
}

/** Erase to the terminal default (no bg colour) so an overlay is opaque to text. */
function clearRect(
  screen: Screen,
  x: number,
  y: number,
  width: number,
  height: number,
  clip: Rect,
): void {
  const y0 = Math.max(0, Math.floor(y), clip.y0)
  const y1 = Math.min(screen.height, Math.floor(y + height), clip.y1)
  const x0 = Math.max(0, Math.floor(x), clip.x0)
  const x1 = Math.min(screen.width, Math.floor(x + width), clip.x1)
  for (let row = y0; row < y1; row++) {
    const line = screen.rows[row]
    if (!line) continue
    for (let col = x0; col < x1; col++) {
      line[col] = { grapheme: ' ', style: {} }
    }
  }
}

function fillRect(
  screen: Screen,
  x: number,
  y: number,
  width: number,
  height: number,
  bg: Rgb,
  clip: Rect,
): void {
  const y0 = Math.max(0, Math.floor(y), clip.y0)
  const y1 = Math.min(screen.height, Math.floor(y + height), clip.y1)
  const x0 = Math.max(0, Math.floor(x), clip.x0)
  const x1 = Math.min(screen.width, Math.floor(x + width), clip.x1)
  for (let row = y0; row < y1; row++) {
    const line = screen.rows[row]
    if (!line) continue
    for (let col = x0; col < x1; col++) {
      line[col] = { grapheme: ' ', style: { bg } }
    }
  }
}

function setCell(screen: Screen, row: number, col: number, grapheme: string, style: Style): void {
  const line = screen.rows[row]
  if (!line) return
  line[col] = { grapheme, style }
}

function setContinuation(screen: Screen, row: number, col: number, style: Style): void {
  const line = screen.rows[row]
  if (!line || col >= line.length) return
  line[col] = { grapheme: '', style, continuation: true }
}

/** Create a text element without JSX (used by non-.tsx helpers/tests). */
export function text(content: string, props: AnyProps = {}): ReactNode {
  return createElement('text', props, content)
}

/** Create a box element without JSX. */
export function box(props: AnyProps, ...children: ReactNode[]): ReactNode {
  return createElement('box', props, ...children)
}

export { BLANK, styleEquals }
