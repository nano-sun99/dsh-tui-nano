/**
 * react-reconciler host for Nano. Each host node owns a Yoga node; React's
 * commit phase only marks the tree dirty and a frame is produced on the next
 * tick, so the terminal sees at most one write per rendered state.
 */
import Yoga, {
  Align,
  Display,
  Edge,
  FlexDirection,
  Justify,
  MeasureMode,
  Overflow,
  PositionType,
  type Node as YogaNode,
} from 'yoga-layout'
import type { Rgb } from '../theme/theme.ts'
import type { Style } from './ansi.ts'
import type { CellGrid } from './grid.ts'
import { displayWidth, sanitizeText, wrapText } from './text.ts'

export interface BoxProps {
  /** Identifier reported by the renderer when this node is clicked. */
  readonly onPress?: string
  readonly width?: number | string
  readonly height?: number | string
  readonly minWidth?: number
  readonly maxWidth?: number
  readonly minHeight?: number
  readonly maxHeight?: number
  readonly flexGrow?: number
  readonly flexShrink?: number
  readonly flexDirection?: 'row' | 'column'
  readonly justifyContent?: 'start' | 'end' | 'center' | 'space-between' | 'space-around'
  readonly alignItems?: 'start' | 'end' | 'center' | 'stretch'
  readonly alignSelf?: 'auto' | 'start' | 'end' | 'center' | 'stretch'
  readonly padding?: number
  readonly paddingX?: number
  readonly paddingY?: number
  readonly paddingTop?: number
  readonly paddingBottom?: number
  readonly paddingLeft?: number
  readonly paddingRight?: number
  readonly margin?: number
  readonly marginX?: number
  readonly marginY?: number
  readonly marginTop?: number
  readonly marginBottom?: number
  readonly marginLeft?: number
  readonly marginRight?: number
  readonly position?: 'relative' | 'absolute'
  readonly top?: number
  readonly left?: number
  readonly right?: number
  readonly bottom?: number
  readonly overflow?: 'hidden' | 'visible'
  readonly backgroundColor?: Rgb
  /** Erase the node's rectangle to the terminal default before painting children. */
  readonly clear?: boolean
  /** Zero-width marker: park the hidden hardware cursor on this box's cell. */
  readonly cursor?: boolean
  readonly display?: 'flex' | 'none'
  readonly children?: unknown
}

export interface TextProps {
  readonly onPress?: string
  readonly color?: Rgb
  readonly backgroundColor?: Rgb
  readonly bold?: boolean
  readonly dim?: boolean
  readonly italic?: boolean
  readonly underline?: boolean
  readonly reverse?: boolean
  readonly strikethrough?: boolean
  readonly wrap?: boolean
  readonly width?: number | string
  readonly flexGrow?: number
  readonly flexShrink?: number
  readonly children?: unknown
}

export type AnyProps = BoxProps & TextProps

interface BaseHostNode {
  readonly type: string
  props: AnyProps
  readonly yoga: YogaNode
  parent: ParentNode | null
  hidden: boolean
  /** Computed absolute rectangle, filled in during layout. */
  left: number
  top: number
  width: number
  height: number
}

export interface BoxNode extends BaseHostNode {
  readonly kind: 'box'
  children: HostNode[]
}

export interface TextNode extends BaseHostNode {
  readonly kind: 'text'
  text: string
  lines: string[]
  measuredWidth: number
}

export interface RawTextNode extends BaseHostNode {
  readonly kind: 'raw-text'
  text: string
  lines: string[]
  measuredWidth: number
}

export interface GridNode extends BaseHostNode {
  readonly kind: 'grid'
  grid: CellGrid
}

export type HostNode = BoxNode | TextNode | RawTextNode | GridNode
type ParentNode = BoxNode

export interface RootContainer {
  children: HostNode[]
  width: number
  height: number
  onCommit: () => void
}

function isParent(node: HostNode | ParentNode): node is ParentNode {
  return node.kind === 'box'
}

function applyBoxProps(node: YogaNode, props: AnyProps): void {
  node.setFlexDirection(props.flexDirection === 'row' ? FlexDirection.Row : FlexDirection.Column)
  if (props.flexGrow !== undefined) node.setFlexGrow(props.flexGrow)
  else node.setFlexGrow(0)
  if (props.flexShrink !== undefined) node.setFlexShrink(props.flexShrink)
  else node.setFlexShrink(1)
  node.setDisplay(props.display === 'none' ? Display.None : Display.Flex)

  applyDimension(node, props.width, 'width')
  applyDimension(node, props.height, 'height')
  if (props.minWidth !== undefined) node.setMinWidth(props.minWidth)
  if (props.maxWidth !== undefined) node.setMaxWidth(props.maxWidth)
  if (props.minHeight !== undefined) node.setMinHeight(props.minHeight)
  if (props.maxHeight !== undefined) node.setMaxHeight(props.maxHeight)

  const justify = props.justifyContent
  node.setJustifyContent(
    justify === 'end'
      ? Justify.FlexEnd
      : justify === 'center'
        ? Justify.Center
        : justify === 'space-between'
          ? Justify.SpaceBetween
          : justify === 'space-around'
            ? Justify.SpaceAround
            : Justify.FlexStart,
  )
  const align = props.alignItems ?? props.alignSelf
  node.setAlignItems(
    align === 'end'
      ? Align.FlexEnd
      : align === 'center'
        ? Align.Center
        : align === 'stretch'
          ? Align.Stretch
          : Align.FlexStart,
  )
  if (props.alignSelf !== undefined) {
    node.setAlignSelf(
      props.alignSelf === 'end'
        ? Align.FlexEnd
        : props.alignSelf === 'center'
          ? Align.Center
          : props.alignSelf === 'stretch'
            ? Align.Stretch
            : Align.Auto,
    )
  }

  if (props.padding !== undefined) node.setPadding(Edge.All, props.padding)
  if (props.paddingTop !== undefined) node.setPadding(Edge.Top, props.paddingTop)
  if (props.paddingBottom !== undefined) node.setPadding(Edge.Bottom, props.paddingBottom)
  if (props.paddingLeft !== undefined) node.setPadding(Edge.Left, props.paddingLeft)
  if (props.paddingRight !== undefined) node.setPadding(Edge.Right, props.paddingRight)
  if (props.paddingY !== undefined && props.padding === undefined) {
    node.setPadding(Edge.Top, props.paddingY)
    node.setPadding(Edge.Bottom, props.paddingY)
  }
  if (props.paddingX !== undefined && props.padding === undefined) {
    node.setPadding(Edge.Left, props.paddingX)
    node.setPadding(Edge.Right, props.paddingX)
  }

  if (props.margin !== undefined) node.setMargin(Edge.All, props.margin)
  if (props.marginTop !== undefined) node.setMargin(Edge.Top, props.marginTop)
  if (props.marginBottom !== undefined) node.setMargin(Edge.Bottom, props.marginBottom)
  if (props.marginLeft !== undefined) node.setMargin(Edge.Left, props.marginLeft)
  if (props.marginRight !== undefined) node.setMargin(Edge.Right, props.marginRight)
  if (props.marginY !== undefined) {
    node.setMargin(Edge.Top, props.marginY)
    node.setMargin(Edge.Bottom, props.marginY)
  }
  if (props.marginX !== undefined) {
    node.setMargin(Edge.Left, props.marginX)
    node.setMargin(Edge.Right, props.marginX)
  }

  node.setPositionType(
    props.position === 'absolute' ? PositionType.Absolute : PositionType.Relative,
  )
  if (props.top !== undefined) node.setPosition(Edge.Top, props.top)
  if (props.left !== undefined) node.setPosition(Edge.Left, props.left)
  if (props.right !== undefined) node.setPosition(Edge.Right, props.right)
  if (props.bottom !== undefined) node.setPosition(Edge.Bottom, props.bottom)
  node.setOverflow(props.overflow === 'hidden' ? Overflow.Hidden : Overflow.Visible)
}

function applyDimension(
  node: YogaNode,
  value: number | string | undefined,
  axis: 'width' | 'height',
): void {
  if (value === undefined) {
    if (axis === 'width') node.setWidthAuto()
    else node.setHeightAuto()
    return
  }
  if (typeof value === 'number') {
    if (axis === 'width') node.setWidth(value)
    else node.setHeight(value)
    return
  }
  const percent = Number.parseFloat(value.replace('%', ''))
  if (Number.isNaN(percent)) {
    if (axis === 'width') node.setWidthAuto()
    else node.setHeightAuto()
    return
  }
  if (axis === 'width') node.setWidthPercent(percent)
  else node.setHeightPercent(percent)
}

/** Style contributed by a Text host, inherited by nested raw text. */
export function textStyle(props: TextProps): Style {
  return {
    ...(props.color !== undefined ? { fg: props.color } : {}),
    ...(props.backgroundColor !== undefined ? { bg: props.backgroundColor } : {}),
    ...(props.bold ? { bold: true } : {}),
    ...(props.dim ? { dim: true } : {}),
    ...(props.italic ? { italic: true } : {}),
    ...(props.underline ? { underline: true } : {}),
    ...(props.reverse ? { reverse: true } : {}),
    ...(props.strikethrough ? { strikethrough: true } : {}),
  }
}

function textContent(children: unknown): string {
  if (typeof children === 'string') return children
  if (typeof children === 'number') return String(children)
  if (Array.isArray(children)) return children.map(textContent).join('')
  return ''
}

function installMeasure(node: TextNode | RawTextNode): void {
  node.yoga.setMeasureFunc((width, widthMode) => {
    const available =
      widthMode === MeasureMode.Undefined ? Number.POSITIVE_INFINITY : Math.max(1, width)
    const whitespaceOnly = node.text !== '' && node.text.trim() === ''
    const wrap = node.kind === 'text' ? (node.props.wrap ?? true) : true
    const lines =
      wrap && !whitespaceOnly
        ? wrapText(node.text, Number.isFinite(available) ? available : 4000)
        : node.text.split('\n')
    node.lines = lines
    node.measuredWidth = Number.isFinite(available)
      ? Math.min(available, Math.max(0, ...lines.map((line) => displayWidth(line))))
      : Math.max(0, ...lines.map((line) => displayWidth(line)))
    return { width: node.measuredWidth, height: Math.max(1, lines.length) }
  })
}

function markDirty(node: HostNode): void {
  node.yoga.markDirty()
}

export const hostConfig = {
  supportsMutation: true,
  supportsPersistence: false,
  supportsHydration: false,
  isPrimaryRenderer: true,
  getRootHostContext: () => ({}),
  getChildHostContext: (parent: object) => parent,
  getPublicInstance: (instance: HostNode) => instance,
  createInstance(
    type: string,
    props: AnyProps,
    _rootContainer: RootContainer,
    _hostContext: object,
    _handle: unknown,
  ): HostNode {
    const yoga = Yoga.Node.create()
    if (type === 'text') {
      const node: TextNode = {
        kind: 'text',
        type,
        props: {},
        yoga,
        parent: null,
        hidden: false,
        left: 0,
        top: 0,
        width: 0,
        height: 0,
        text: sanitizeText(textContent(props.children)),
        lines: [],
        measuredWidth: 0,
      }
      node.props = props
      installMeasure(node)
      return node
    }
    if (type === 'grid') {
      const grid = (props as { grid?: CellGrid }).grid
      if (!grid) throw new Error('nano: <Grid> 需要 grid 属性')
      const gridProps: AnyProps = {
        ...props,
        width: props.width ?? grid.width,
        height: props.height ?? grid.height,
      }
      const node: GridNode = {
        kind: 'grid',
        type,
        props: gridProps,
        yoga,
        parent: null,
        hidden: false,
        left: 0,
        top: 0,
        width: 0,
        height: 0,
        grid,
      }
      applyBoxProps(yoga, gridProps)
      return node
    }
    if (type === 'overlay') {
      const overlayProps: AnyProps = {
        ...props,
        position: 'absolute',
        left: 0,
        top: 0,
        width: '100%',
        height: '100%',
      }
      const node: BoxNode = {
        kind: 'box',
        type,
        props: overlayProps,
        yoga,
        parent: null,
        hidden: false,
        left: 0,
        top: 0,
        width: 0,
        height: 0,
        children: [],
      }
      applyBoxProps(yoga, overlayProps)
      return node
    }
    const node: BoxNode = {
      kind: 'box',
      type,
      props,
      yoga,
      parent: null,
      hidden: false,
      left: 0,
      top: 0,
      width: 0,
      height: 0,
      children: [],
    }
    applyBoxProps(yoga, props)
    return node
  },
  createTextInstance(
    text: string,
    _rootContainer: RootContainer,
    _hostContext: object,
    _handle: unknown,
  ): RawTextNode {
    const yoga = Yoga.Node.create()
    const node: RawTextNode = {
      kind: 'raw-text',
      type: '#text',
      props: {},
      yoga,
      parent: null,
      hidden: false,
      left: 0,
      top: 0,
      width: 0,
      height: 0,
      text: sanitizeText(text),
      lines: [],
      measuredWidth: 0,
    }
    installMeasure(node)
    return node
  },
  appendInitialChild(parent: ParentNode, child: HostNode): void {
    appendChildNode(parent, child)
  },
  finalizeInitialChildren(): boolean {
    return false
  },
  shouldSetTextContent(type: string): boolean {
    return type === 'text'
  },
  appendChild(parent: ParentNode, child: HostNode): void {
    appendChildNode(parent, child)
  },
  appendChildToContainer(container: RootContainer, child: HostNode): void {
    appendRootChild(container, child, null)
  },
  insertBefore(parent: ParentNode, child: HostNode, before: HostNode): void {
    insertChildNode(parent, child, before)
  },
  insertInContainerBefore(container: RootContainer, child: HostNode, before: HostNode): void {
    appendRootChild(container, child, before)
  },
  removeChild(parent: ParentNode, child: HostNode): void {
    removeChildNode(parent, child)
  },
  clearContainer(container: RootContainer): void {
    for (const child of container.children) freeSubtree(child)
    container.children = []
    container.onCommit()
  },
  removeChildFromContainer(container: RootContainer, child: HostNode): void {
    const index = container.children.indexOf(child)
    if (index >= 0) container.children.splice(index, 1)
    child.parent = null
    freeSubtree(child)
    container.onCommit()
  },
  detachDeletedInstance(instance: HostNode): void {
    freeSubtree(instance)
  },
  commitUpdate(instance: HostNode, _type: string, _prev: AnyProps, next: AnyProps): void {
    instance.props = next
    if (instance.kind === 'text') {
      const text = sanitizeText(textContent(next.children))
      if (text !== instance.text) {
        instance.text = text
        markDirty(instance)
      }
    }
    if (instance.kind === 'box') applyBoxProps(instance.yoga, next)
    else if (instance.kind === 'grid') {
      const grid = (next as { grid?: CellGrid }).grid
      if (grid) instance.grid = grid
      applyBoxProps(instance.yoga, next)
    } else instance.yoga.markDirty()
  },
  commitTextUpdate(instance: RawTextNode, _old: string, next: string): void {
    const sanitized = sanitizeText(next)
    if (instance.text !== sanitized) {
      instance.text = sanitized
      markDirty(instance)
    }
  },
  resetAfterCommit(container: RootContainer): void {
    container.onCommit()
  },
  prepareForCommit: () => null,
  getCurrentUpdatePriority: () => 32,
  setCurrentUpdatePriority: () => {},
  resolveUpdatePriority: () => 32,
  trackSchedulerEvent: () => {},
  resolveEventType: () => null,
  resolveEventTimeStamp: () => -1.1,
  shouldAttemptEagerTransition: () => false,
  getInstanceFromNode: () => null,
  preparePortalMount: () => {},
  resetTextContent: () => {},
  bindToConsole: () => console,
  supportsMicrotasks: false,
  scheduleMicrotask: queueMicrotask,
  maySuspendCommit: () => false,
  maySuspendCommitOnUpdate: () => false,
  maySuspendCommitInSyncRender: () => false,
  preloadInstance: () => true,
  startSuspendingCommit: () => null,
  suspendInstance: () => {},
  waitForCommitToBeReady: () => null,
  getSuspendedCommitReason: () => null,
  scheduleTimeout: setTimeout,
  cancelTimeout: clearTimeout,
  noTimeout: -1,
  hideInstance(instance: HostNode): void {
    instance.hidden = true
    instance.yoga.setDisplay(Display.None)
  },
  unhideInstance(instance: HostNode): void {
    instance.hidden = false
    instance.yoga.setDisplay(Display.Flex)
  },
  hideTextInstance(instance: RawTextNode): void {
    instance.hidden = true
    instance.yoga.setDisplay(Display.None)
  },
  unhideTextInstance(instance: RawTextNode): void {
    instance.hidden = false
    instance.yoga.setDisplay(Display.Flex)
  },
}

function appendChildNode(parent: ParentNode, child: HostNode): void {
  if (child.parent !== null) removeChildNode(child.parent, child)
  child.parent = parent
  parent.children.push(child)
  parent.yoga.insertChild(child.yoga, parent.children.length - 1)
}

function insertChildNode(parent: ParentNode, child: HostNode, before: HostNode): void {
  if (child.parent !== null) removeChildNode(child.parent, child)
  const index = parent.children.indexOf(before)
  child.parent = parent
  if (index < 0) {
    parent.children.push(child)
    parent.yoga.insertChild(child.yoga, parent.children.length - 1)
    return
  }
  parent.children.splice(index, 0, child)
  parent.yoga.insertChild(child.yoga, index)
}

function removeChildNode(parent: ParentNode, child: HostNode): void {
  const index = parent.children.indexOf(child)
  if (index < 0) return
  parent.children.splice(index, 1)
  parent.yoga.removeChild(child.yoga)
  child.parent = null
}

/** Free a detached subtree's Yoga nodes; the host objects are garbage after this. */
export function freeSubtree(node: HostNode): void {
  if ((node as { freed?: boolean }).freed === true) return
  ;(node as { freed?: boolean }).freed = true
  if (node.kind === 'box') {
    const children = node.children.slice()
    node.children = []
    // Detach before freeing: a freed child must not remain attached.
    while (node.yoga.getChildCount() > 0) {
      const child = node.yoga.getChild(0)
      if (!child) break
      node.yoga.removeChild(child)
    }
    for (const child of children) freeSubtree(child)
  }
  try {
    node.yoga.free()
  } catch {
    // Already freed; React may report the same deletion twice.
  }
}

function appendRootChild(container: RootContainer, child: HostNode, before: HostNode | null): void {
  if (child.parent !== null) {
    removeChildNode(child.parent, child)
  }
  const index = before === null ? -1 : container.children.indexOf(before)
  if (index < 0) container.children.push(child)
  else container.children.splice(index, 0, child)
  container.onCommit()
}

export { isParent }
