/**
 * Renderer: owns one terminal-sized cell grid, runs Yoga layout on the React
 * tree and emits only the changed runs. All terminal bytes go through the
 * single `write` callback supplied by the runtime (one writer per process).
 */

import { createElement, type ReactNode } from 'react'
import Reconciler from 'react-reconciler'
import Yoga, { Direction, FlexDirection, type Node as YogaNode } from 'yoga-layout'
import type { Rgb } from '../theme/theme.ts'
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

export interface RendererOptions {
  readonly write: (bytes: string) => void
  readonly width: number
  readonly height: number
  readonly defaultFg: Rgb
  /** Called when a rendered frame fails; keeps the process alive but visible. */
  readonly onError?: (error: unknown) => void
}

export class Renderer {
  readonly container: RootContainer
  private readonly rootYoga: YogaNode
  private readonly reconciler: ReconcilerInstance
  private root: unknown
  private previous: Screen | undefined
  private width: number
  private height: number
  private scheduled = false
  private mounted = false
  private readonly write: (bytes: string) => void
  private readonly defaultFg: Rgb
  private readonly onError: ((error: unknown) => void) | undefined
  private attached: HostNode[] = []
  hitRegions: HitRegion[] = []
  selection: SelectionRange | undefined

  constructor(options: RendererOptions) {
    this.width = Math.max(1, options.width)
    this.height = Math.max(1, options.height)
    this.write = options.write
    this.defaultFg = options.defaultFg
    this.onError = options.onError
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

  update(element: ReactNode): void {
    if (!this.mounted) {
      this.mount(element)
      return
    }
    this.commit(element)
  }

  unmount(): void {
    if (!this.mounted) return
    this.mounted = false
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
    if (this.scheduled) return
    this.scheduled = true
    setImmediate(() => {
      this.scheduled = false
      try {
        this.frame()
      } catch (error) {
        this.reportError(error)
      }
    })
  }

  private reportError(error: unknown): void {
    if (this.onError) this.onError(error)
    else process.stderr.write(`nano render error: ${String(error)}\n`)
  }

  private frame(): void {
    if (!this.mounted) return
    this.syncRootChildren()
    this.rootYoga.setWidth(this.width)
    this.rootYoga.setHeight(this.height)
    this.rootYoga.calculateLayout(this.width, this.height, Direction.LTR)
    this.hitRegions = []
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
    const lines = wrap && node.text.length > 0 ? wrapText(node.text, width) : node.text.split('\n')
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
