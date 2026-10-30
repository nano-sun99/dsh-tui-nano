/**
 * 子代理导航状态（spec 2026-10-30 §5）：主视图 / 详情 / 全部列表三种视图，
 * 以及 dock 与列表的焦点。全是纯数据与纯函数，渲染只读、可单测。
 */
import { randomUUID } from 'node:crypto'
import { createElement, type ReactNode } from 'react'
import { TranscriptView } from '../app/App.tsx'
import type { InputModel } from '../app/input-model.ts'
import type { DraftStore } from '../input/drafts.ts'
import { HISTORY_LIMIT, type HistoryStore } from '../input/history.ts'
import type { Key } from '../input/parser.ts'
import { Box, Text } from '../render/components.ts'
import { truncateText } from '../render/text.ts'
import { activeTheme } from '../theme/theme.ts'
import { TranscriptModel } from '../transcript/model.ts'
import {
  composerState,
  detailTitle,
  foldSessionEvent,
  modeAllowsDetail,
  replaySessionMessages,
  type SubagentMode,
} from './detail.ts'
import type { DockStatus, SubagentDock } from './dock.ts'
import {
  buildListRows,
  countDirectChildren,
  isEnterable,
  type ListEntry,
  type ListRow,
  listIds,
  renderSubagentList,
} from './list.ts'

export type ChildOrigin = 'dock' | 'result' | 'list'

export interface MainView {
  readonly mode: 'main'
  readonly dockFocusId?: string
  readonly listOpen: boolean
  readonly listFocusId?: string
  readonly listScrollTop: number
}

export interface ChildView {
  readonly mode: 'child'
  readonly id: string
  readonly origin: ChildOrigin
}

export type ViewState = MainView | ChildView

export function initialView(): MainView {
  return { mode: 'main', listOpen: false, listScrollTop: 0 }
}

/** 焦点在候选行上循环；没有候选时清空。 */
function moveFocus(
  ids: readonly string[],
  current: string | undefined,
  delta: 1 | -1,
): string | undefined {
  if (ids.length === 0) return undefined
  const index = current === undefined ? -1 : ids.indexOf(current)
  if (index < 0) return delta === 1 ? ids[0] : ids[ids.length - 1]
  return ids[(index + delta + ids.length) % ids.length]
}

export function focusDock(view: MainView, ids: readonly string[], delta: 1 | -1): MainView {
  const dockFocusId = moveFocus(ids, view.dockFocusId, delta)
  return dockFocusId === undefined ? { ...view, dockFocusId: undefined } : { ...view, dockFocusId }
}

export function openList(view: MainView, ids: readonly string[]): MainView {
  const listFocusId = view.dockFocusId ?? ids[0]
  return {
    ...view,
    listOpen: true,
    listFocusId,
    listScrollTop: 0,
  }
}

export function closeList(view: MainView): MainView {
  return { ...view, listOpen: false, listFocusId: undefined, listScrollTop: 0 }
}

export function focusList(view: MainView, ids: readonly string[], delta: 1 | -1): MainView {
  return { ...view, listFocusId: moveFocus(ids, view.listFocusId, delta) }
}

export function enterChild(_view: MainView, id: string, origin: ChildOrigin): ChildView {
  return { mode: 'child', id, origin }
}

/** 返回主视图：从列表进的重新打开列表并聚焦原行。 */
export function leaveChild(view: ChildView): {
  view: MainView
  returnTo: { origin: ChildOrigin; id: string }
} {
  const main = initialView()
  const next = view.origin === 'list' ? { ...main, listOpen: true, listFocusId: view.id } : main
  return { view: next, returnTo: { origin: view.origin, id: view.id } }
}

export interface NavigationOptions {
  readonly ctx: any
  readonly rootId: string
  readonly input: InputModel
  readonly drafts: DraftStore
  readonly history?: HistoryStore
  readonly dock: SubagentDock
  readonly expanded: ReadonlySet<string>
  readonly bodyHeight: () => number
  readonly onChange: () => void
  readonly setNotice?: (text: string | undefined, tone?: 'info' | 'danger') => void
  readonly writeDiagnostic?: (line: string) => void
}

interface ChildState {
  readonly id: string
  mode: SubagentMode
  name: string
  readonly model: TranscriptModel
  loading: boolean
  error?: string
  scrollOffset: number
  stickBottom: boolean
  readonly disposers: Array<() => void>
  readonly generation: number
}

function isPrintable(key: Key): boolean {
  return key.name === 'char' && key.text !== undefined && !key.ctrl && !key.alt && !key.meta
}

function isAlt(key: Key, text: string): boolean {
  return key.name === 'char' && key.text === text && key.alt && !key.ctrl && !key.meta
}

function isSpace(key: Key): boolean {
  return key.name === 'char' && key.text === ' '
}

function message(error: unknown): string {
  return String((error as Error)?.message ?? error)
}

/**
 * 三层导航的 S02 编排：持有视图状态、草稿切换、列表读取与 child 正文。
 * 纯状态在文件上半段；这里只做 IO 与按键路由。
 */
export class SubagentNavigation {
  private readonly options: NavigationOptions
  private viewState: ViewState = initialView()
  private listEntries: ListEntry[] = []
  private listLoading = false
  private listError: string | undefined
  private readonly readable = new Map<string, boolean>()
  private childState: ChildState | undefined
  private generation = 0
  private width = 80
  private readonly scrollMemory = new Map<string, { offset: number; stickBottom: boolean }>()

  constructor(options: NavigationOptions) {
    this.options = options
  }

  get view(): ViewState {
    return this.viewState
  }

  get childModel(): TranscriptModel | undefined {
    return this.childState?.model
  }

  get childScrollOffset(): number {
    const child = this.childState
    return child === undefined || child.stickBottom ? 0 : child.scrollOffset
  }

  get replacesTranscript(): boolean {
    return this.viewState.mode === 'child' || this.viewState.listOpen
  }

  private get parentLive(): boolean {
    return this.options.ctx.get?.('agents')?.get?.(this.options.rootId) !== undefined
  }

  private childRunning(id: string | undefined): boolean {
    if (id === undefined) return false
    const agent = this.options.ctx.get?.('agents')?.get?.(id)
    if (agent?.status === 'running') return true
    return this.statusFor(id) === 'running'
  }

  get inputHidden(): boolean {
    const child = this.childState
    if (child === undefined) return false
    return child.mode === 'one-shot' || child.mode === 'unknown'
  }

  get inputDisabled(): boolean {
    if (this.viewState.mode === 'main' && this.viewState.listOpen) return true
    const child = this.childState
    if (child === undefined) return false
    const composer = composerState({
      mode: child.mode,
      parentLive: this.parentLive,
      childRunning: this.childRunning(child.id),
    })
    return !composer.editable
  }

  get inputActive(): boolean {
    return !this.inputHidden && !this.inputDisabled
  }

  inputPlaceholder(): string | undefined {
    const child = this.childState
    if (child === undefined) return undefined
    return `给 ${child.name} 发送消息…`
  }

  body(width: number): ReactNode {
    this.width = Math.max(1, width)
    if (this.viewState.mode === 'child') return this.renderChild(width)
    if (this.viewState.listOpen) return this.renderList(width)
    return this.options.dock.render(width, this.viewState.dockFocusId)
  }

  handleWheel(delta: number): boolean {
    if (this.viewState.mode === 'child') {
      this.scrollChild(delta * 3)
      return true
    }
    if (this.viewState.mode === 'main' && this.viewState.listOpen) {
      this.scrollList(delta * 3)
      return true
    }
    return false
  }

  handleKey(key: Key): boolean {
    if (this.viewState.mode === 'child') return this.handleChildKey(key)
    if (this.viewState.listOpen) return this.handleListKey(key)
    return this.handleMainKey(key)
  }

  handlePress(id: string): boolean {
    if (id === 'subagent:back') {
      this.returnFromChild()
      return true
    }
    if (id === 'subagent:overflow') {
      this.openList()
      return true
    }
    if (id === 'subagent:list-close') {
      this.closeList()
      return true
    }
    if (id.startsWith('subagent:row:')) {
      return this.enter(id.slice('subagent:row:'.length), 'dock')
    }
    if (id.startsWith('subagent:result:')) {
      return this.enter(id.slice('subagent:result:'.length), 'result')
    }
    if (id.startsWith('subagent:list-row:')) {
      const rowId = id.slice('subagent:list-row:'.length)
      const row = this.currentListRows().find((item) => item.id === rowId)
      if (this.viewState.mode !== 'main' || !this.viewState.listOpen || row === undefined)
        return false
      this.viewState = { ...this.viewState, listFocusId: rowId }
      if (isEnterable(row)) {
        this.enter(rowId, 'list')
      } else {
        this.options.onChange()
      }
      return true
    }
    return false
  }

  async refreshList(): Promise<void> {
    this.listLoading = true
    this.options.onChange()
    try {
      const subagents = this.options.ctx.get?.('subagents')
      const entries = (await subagents?.listDescendants?.(this.options.rootId)) as
        | ListEntry[]
        | undefined
      this.listEntries = entries ?? []
      this.listError = undefined
      await this.probeOneShots()
    } catch (error) {
      this.listError = message(error)
    } finally {
      this.listLoading = false
      const rows = this.currentListRows()
      const view = this.viewState
      if (view.mode === 'main' && view.listOpen) {
        const ids = listIds(rows)
        const focusId =
          view.listFocusId !== undefined && ids.includes(view.listFocusId)
            ? view.listFocusId
            : ids[0]
        this.viewState = { ...view, listFocusId: focusId }
      }
      const child = this.childState
      if (child !== undefined && child.mode === 'unknown') {
        const mode = this.modeFor(child.id)
        if (mode !== 'unknown') child.mode = mode
      }
      if (this.viewState.mode === 'main' && this.viewState.listOpen) {
        const height = Math.max(1, this.options.bodyHeight() - 1)
        const max = Math.max(0, rows.length - height)
        if (this.viewState.listScrollTop > max) {
          this.viewState = { ...this.viewState, listScrollTop: max }
        }
      }
      this.options.onChange()
    }
  }

  dispose(): void {
    this.closeChild()
  }

  /** 一次性会话先验历史可读性：读不到的行退成不可导航只读行。 */
  private async probeOneShots(): Promise<void> {
    const targets = this.listEntries.filter(
      (entry) =>
        entry.kind === 'child' && entry.mode === 'one-shot' && !this.readable.has(entry.id),
    )
    await Promise.all(targets.map((entry) => this.probeOneShot(entry.id)))
  }

  private async probeOneShot(id: string): Promise<boolean> {
    const query = this.options.ctx.get?.('sessionQuery')
    try {
      if (query?.readSession === undefined) throw new Error('会话查询服务不可用')
      await query.readSession(id)
      this.readable.set(id, true)
      return true
    } catch {
      this.readable.set(id, false)
      return false
    }
  }

  // ---- 视图 ----

  private handleMainKey(key: Key): boolean {
    if (this.viewState.mode !== 'main') return false
    if (isAlt(key, 'l')) {
      if (this.viewState.listOpen) this.closeList()
      else this.openList()
      return true
    }
    const main = this.viewState
    if (main.dockFocusId !== undefined) {
      const ids = this.options.dock.entryIds()
      if (key.name === 'up' || key.name === 'down') {
        this.viewState = focusDock(main, ids, key.name === 'up' ? -1 : 1)
        this.options.onChange()
        return true
      }
      if (key.name === 'enter' || key.name === 'right' || isSpace(key)) {
        this.activateDockFocus()
        return true
      }
      if (key.name === 'escape') {
        this.viewState = { ...main, dockFocusId: undefined }
        this.options.onChange()
        return true
      }
      if (key.name === 'char' && key.text === 'x' && !key.ctrl && !key.alt && !key.meta) {
        this.options.dock.dismiss(main.dockFocusId)
        this.options.onChange()
        return true
      }
      if (isPrintable(key)) {
        this.viewState = { ...main, dockFocusId: undefined }
        this.options.onChange()
        return false
      }
      return false
    }
    if ((key.name === 'up' || key.name === 'down') && this.options.input.text === '') {
      const ids = this.options.dock.entryIds()
      if (ids.length > 0) {
        this.viewState = focusDock(main, ids, key.name === 'up' ? -1 : 1)
        this.options.onChange()
        return true
      }
    }
    return false
  }

  private activateDockFocus(): void {
    if (this.viewState.mode !== 'main') return
    const focusId = this.viewState.dockFocusId
    if (focusId === undefined) return
    if (focusId === 'overflow') {
      this.openList()
      return
    }
    this.enter(focusId, 'dock')
  }

  private handleListKey(key: Key): boolean {
    if (this.viewState.mode !== 'main') return false
    const view = this.viewState
    if (key.name === 'escape' || isAlt(key, 'l')) {
      this.closeList()
      return true
    }
    const ids = listIds(this.currentListRows())
    if (key.name === 'up' || key.name === 'down') {
      this.viewState = focusList(view, ids, key.name === 'up' ? -1 : 1)
      this.ensureListVisible()
      this.options.onChange()
      return true
    }
    if (key.name === 'pageup' || key.name === 'pagedown') {
      this.scrollList(key.name === 'pageup' ? -5 : 5)
      return true
    }
    if (key.name === 'enter') {
      const row = this.currentListRows().find((item) => item.id === view.listFocusId)
      if (row !== undefined && isEnterable(row)) this.enter(row.id, 'list')
      return true
    }
    if (
      isPrintable(key) ||
      key.name === 'backspace' ||
      key.name === 'delete' ||
      key.name === 'left' ||
      key.name === 'right' ||
      key.name === 'home' ||
      key.name === 'end' ||
      key.name === 'tab'
    ) {
      return true
    }
    return false
  }

  private handleChildKey(key: Key): boolean {
    const child = this.childState
    if (child === undefined) return false
    if (key.name === 'escape') {
      this.returnFromChild()
      return true
    }
    if (isAlt(key, 'l')) {
      this.returnFromChild()
      this.openList()
      return true
    }
    if (isAlt(key, 'k')) {
      if (child.mode === 'continuable' && this.childRunning(child.id)) this.stopChild()
      return true
    }
    if (key.name === 'enter' && key.alt) {
      void this.send('steer')
      return true
    }
    if (key.name === 'enter' && !key.shift && !key.ctrl && !key.alt) {
      void this.send('queue')
      return true
    }
    if (key.name === 'left' && this.options.input.text === '') {
      this.returnFromChild()
      return true
    }
    if (key.name === 'pageup' || key.name === 'pagedown') {
      this.scrollChild(key.name === 'pageup' ? this.halfPage() : -this.halfPage())
      return true
    }
    if (key.name === 'home') {
      this.scrollChild(this.maxChildScroll())
      return true
    }
    if (key.name === 'end') {
      this.scrollChild(-Number.MAX_SAFE_INTEGER)
      return true
    }
    if (this.inputDisabled || this.inputHidden) {
      if (key.name === 'up' || key.name === 'down') {
        this.scrollChild(key.name === 'up' ? 1 : -1)
        return true
      }
      if (
        isPrintable(key) ||
        key.name === 'backspace' ||
        key.name === 'delete' ||
        key.name === 'left' ||
        key.name === 'right' ||
        key.name === 'tab'
      ) {
        return true
      }
    }
    return false
  }

  private openList(): void {
    if (this.viewState.mode !== 'main') return
    const ids = listIds(this.currentListRows())
    this.viewState = openList(this.viewState, ids)
    void this.refreshList()
    this.options.onChange()
  }

  private closeList(): void {
    if (this.viewState.mode !== 'main') return
    this.viewState = closeList(this.viewState)
    this.options.onChange()
  }

  private scrollList(delta: number): void {
    const view = this.viewState
    if (view.mode !== 'main' || !view.listOpen) return
    const height = Math.max(1, this.options.bodyHeight() - 1)
    const max = Math.max(0, this.currentListRows().length - height)
    const top = Math.max(0, Math.min(max, view.listScrollTop + delta))
    this.viewState = { ...view, listScrollTop: top }
    this.options.onChange()
  }

  private ensureListVisible(): void {
    const view = this.viewState
    if (view.mode !== 'main' || !view.listOpen) return
    const rows = this.currentListRows()
    const height = Math.max(1, this.options.bodyHeight() - 1)
    const index = rows.findIndex((row) => row.id === view.listFocusId)
    if (index < 0) return
    let top = view.listScrollTop
    if (index < top) top = index
    else if (index >= top + height) top = index - height + 1
    this.viewState = { ...view, listScrollTop: Math.max(0, top) }
  }

  // ---- 进入 / 返回 ----

  private enter(id: string, origin: ChildOrigin): boolean {
    if (this.viewState.mode !== 'main') return false
    const mode = this.modeFor(id)
    if (!modeAllowsDetail(mode)) return false
    // 目录还没读到 mode 时先补一次，避免把一次性会话当成可续聊。
    if (mode === 'unknown' && !this.listEntries.some((entry) => entry.id === id)) {
      void this.resolveAndEnter(id, origin)
      return true
    }
    // 一次性会话先验历史可读性；读不到就不进入，保持不可导航只读行。
    if (mode === 'one-shot' && !this.readable.has(id)) {
      void this.probeOneShot(id).then((readable) => {
        if (readable) this.enterNow(id, origin, mode)
        else {
          this.options.setNotice?.('该一次性子代理历史不可读，无法进入', 'danger')
          this.options.onChange()
        }
      })
      return true
    }
    this.enterNow(id, origin, mode)
    return true
  }

  private async resolveAndEnter(id: string, origin: ChildOrigin): Promise<void> {
    await this.refreshList()
    if (this.viewState.mode !== 'main') return
    const mode = this.modeFor(id)
    if (!modeAllowsDetail(mode)) {
      this.options.setNotice?.('外部子代理不可进入', 'danger')
      return
    }
    if (mode === 'one-shot') {
      const readable = this.readable.get(id) ?? (await this.probeOneShot(id))
      if (!readable) {
        this.options.setNotice?.('该一次性子代理历史不可读，无法进入', 'danger')
        this.options.onChange()
        return
      }
    }
    this.enterNow(id, origin, mode)
  }

  private enterNow(id: string, origin: ChildOrigin, mode: SubagentMode): void {
    if (this.viewState.mode !== 'main') return
    this.saveInput({ root: this.options.rootId })
    const main = this.viewState
    this.viewState = enterChild(main, id, origin)
    this.restoreInput({ root: this.options.rootId, subagent: id }, mode === 'continuable')
    this.openChild(id, mode)
    this.options.onChange()
  }

  private returnFromChild(): void {
    const view = this.viewState
    if (view.mode !== 'child') return
    const child = this.childState
    if (child?.mode === 'continuable') {
      this.saveInput({ root: this.options.rootId, subagent: view.id })
    }
    const left = leaveChild(view)
    const restored =
      left.returnTo.origin === 'dock' && this.options.dock.entryIds().includes(left.returnTo.id)
        ? { ...left.view, dockFocusId: left.returnTo.id }
        : left.view
    this.viewState = restored
    this.closeChild()
    this.restoreInput({ root: this.options.rootId }, true)
    if (this.options.history !== undefined) {
      this.options.input.setHistory(
        this.options.history.entries(HISTORY_LIMIT).map((entry) => entry.display),
      )
    }
    if (left.view.listOpen) void this.refreshList()
    this.options.onChange()
  }

  private saveInput(address: { root: string; subagent?: string }): void {
    this.options.drafts.save(address, {
      text: this.options.input.text,
      cursor: this.options.input.cursor,
      scrollAnchor: 0,
    })
  }

  private restoreInput(address: { root: string; subagent?: string }, enabled: boolean): void {
    if (!enabled) {
      this.options.input.clear()
      return
    }
    const draft = this.options.drafts.get(address)
    if (draft !== undefined) {
      this.options.input.text = draft.text
      this.options.input.cursor = draft.cursor
    } else {
      this.options.input.clear()
    }
  }

  // ---- child 正文 ----

  private openChild(id: string, mode: SubagentMode): void {
    this.closeChild()
    const memory = this.scrollMemory.get(id)
    const child: ChildState = {
      id,
      mode,
      name: this.nameFor(id),
      model: new TranscriptModel(),
      loading: true,
      scrollOffset: memory?.offset ?? 0,
      stickBottom: memory?.stickBottom ?? true,
      disposers: [],
      generation: ++this.generation,
    }
    this.childState = child
    this.options.input.setHistory([])
    void this.loadChild(child)
  }

  private closeChild(): void {
    const child = this.childState
    if (child === undefined) return
    for (const dispose of child.disposers) dispose()
    this.scrollMemory.set(child.id, {
      offset: child.scrollOffset,
      stickBottom: child.stickBottom,
    })
    this.childState = undefined
  }

  private async loadChild(child: ChildState): Promise<void> {
    const ctx = this.options.ctx
    const agent = ctx.get?.('agents')?.get?.(child.id)
    if (agent?.session !== undefined) {
      try {
        replaySessionMessages(child.model, agent.session.deriveMessages())
      } catch (error) {
        child.error = message(error)
      }
      const onEvent = (subject: any, event: any) => {
        if (subject !== agent.session) return
        foldSessionEvent(child.model, event)
        this.options.onChange()
      }
      const onStream = (payload: any) => {
        if (payload?.agent !== agent) return
        this.foldStream(child.model, payload.frame)
        this.options.onChange()
      }
      ctx.on?.('session/event', onEvent)
      ctx.on?.('agent/assistant-stream', onStream)
      child.disposers.push(() => ctx.off?.('session/event', onEvent))
      child.disposers.push(() => ctx.off?.('agent/assistant-stream', onStream))
      child.loading = false
      this.syncChildHistory(child)
      this.options.onChange()
      return
    }
    try {
      const snapshot = await ctx.get?.('sessionQuery')?.readSession?.(child.id)
      if (this.childState?.generation !== child.generation) return
      for (const event of snapshot?.events ?? []) foldSessionEvent(child.model, event)
    } catch (error) {
      if (this.childState?.generation === child.generation) child.error = message(error)
    } finally {
      if (this.childState?.generation === child.generation) {
        child.loading = false
        this.syncChildHistory(child)
        this.options.onChange()
      }
    }
  }

  /** 子代理历史来自该地址的会话投影，不写文件（ADR-20261022-input-history）。 */
  private syncChildHistory(child: ChildState): void {
    const texts = child.model.all
      .filter((entry) => entry.kind === 'user')
      .map((entry) => (entry.kind === 'user' ? entry.text : ''))
      .filter((text) => text.trim() !== '')
      .reverse()
    this.options.input.setHistory(texts)
  }

  private foldStream(model: TranscriptModel, frame: any): void {
    switch (frame?.type) {
      case 'start':
        model.setPreview({
          attemptId: String(frame.attemptId),
          revision: frame.revision,
          reasoning: '',
          text: '',
        })
        break
      case 'chunk': {
        const current = model.preview
        if (!current || current.attemptId !== String(frame.attemptId)) return
        const chunk = frame.chunk
        if (chunk?.type === 'reasoning-delta') {
          model.setPreview({ ...current, reasoning: current.reasoning + chunk.text })
        } else if (chunk?.type === 'text-delta') {
          model.setPreview({ ...current, text: current.text + chunk.text })
        }
        break
      }
      case 'end':
        model.clearPreview()
        break
      default:
        break
    }
  }

  private async send(delivery: 'queue' | 'steer'): Promise<void> {
    const child = this.childState
    if (child === undefined || child.mode !== 'continuable') return
    if (!this.parentLive) return
    const text = this.options.input.text.trim()
    if (text === '') return
    const subagents = this.options.ctx.get?.('subagents')
    if (subagents?.prompt === undefined) {
      this.options.setNotice?.('子代理服务不可用', 'danger')
      return
    }
    const requestId = randomUUID()
    child.model.appendUser(text, requestId)
    try {
      await subagents.prompt(
        {
          requestId,
          parentSessionId: this.options.rootId,
          childSessionId: child.id,
          mode: 'continuable',
          delivery,
          content: [{ type: 'text', text }],
        },
        new AbortController().signal,
      )
      if (this.options.input.text.trim() === text) this.options.input.take()
      this.options.drafts.save(
        { root: this.options.rootId, subagent: child.id },
        { text: this.options.input.text, cursor: this.options.input.cursor, scrollAnchor: 0 },
      )
      this.options.onChange()
    } catch (error) {
      child.model.markUnconfirmed(requestId)
      this.options.setNotice?.(`发送失败：${message(error)}（草稿保留）`, 'danger')
      this.options.onChange()
    }
  }

  private stopChild(): void {
    const child = this.childState
    if (child === undefined) return
    const subagents = this.options.ctx.get?.('subagents')
    if (subagents?.interruptByParent === undefined) {
      this.options.setNotice?.('子代理服务不可用', 'danger')
      return
    }
    try {
      subagents.interruptByParent(child.id, this.options.rootId, 'continuable')
      this.options.setNotice?.('已请求停止当前回合')
    } catch (error) {
      this.options.setNotice?.(`停止失败：${message(error)}`, 'danger')
    }
    this.options.onChange()
  }

  // ---- 数据 ----

  private currentListRows(): ListRow[] {
    return buildListRows(
      this.listEntries,
      (id) => this.statusFor(id),
      (id) => this.readable.get(id),
    )
  }

  private listEntry(id: string): ListEntry | undefined {
    return this.listEntries.find((entry) => entry.id === id)
  }

  private modeFor(id: string): SubagentMode {
    const entry = this.listEntry(id)
    const raw = entry?.mode ?? this.options.dock.modeOf(id)
    if (raw === 'one-shot' || raw === 'continuable' || raw === 'external' || raw === 'unknown') {
      return raw
    }
    const live = this.options.ctx.get?.('agents')?.get?.(id)
    return live !== undefined ? 'continuable' : 'unknown'
  }

  private nameFor(id: string): string {
    return this.listEntry(id)?.label ?? this.options.dock.nameOf(id) ?? id
  }

  private statusFor(id: string): DockStatus {
    const known = this.options.dock.statusOf(id)
    if (known !== 'idle') return known
    const entry = this.listEntry(id)
    if (entry?.kind === 'child' && entry.activity === 'running') return 'running'
    return known
  }

  // ---- 渲染 ----

  private renderChild(width: number): ReactNode {
    const child = this.childState
    if (child === undefined) return null
    const theme = activeTheme()
    const height = Math.max(1, this.options.bodyHeight())
    const header = createElement(
      Box,
      { flexDirection: 'row', width },
      createElement(
        Box,
        { onPress: 'subagent:back' },
        createElement(
          Text,
          { color: [...theme.accent] as [number, number, number], wrap: false },
          '‹ 返回 ',
        ),
      ),
      createElement(
        Text,
        { color: [...theme.fg] as [number, number, number], bold: true, wrap: false },
        truncateText(detailTitle(child.name, this.statusFor(child.id)), Math.max(1, width - 8)),
      ),
    )
    let content: ReactNode
    if (child.error !== undefined) {
      content = createElement(
        Text,
        { color: [...theme.danger] as [number, number, number], wrap: false },
        `正文读取失败：${child.error}`,
      )
    } else if (child.loading) {
      content = createElement(
        Text,
        { color: [...theme.muted] as [number, number, number], wrap: false },
        '读取中…',
      )
    } else {
      content = createElement(TranscriptView, {
        model: child.model,
        expanded: this.options.expanded,
        width,
        height: Math.max(1, height - 1),
        scrollOffset: child.stickBottom ? 0 : child.scrollOffset,
        stickBottom: child.stickBottom,
        theme,
      })
    }
    return createElement(Box, { flexDirection: 'column', width, height }, header, content)
  }

  private renderList(width: number): ReactNode {
    const rows = this.currentListRows()
    return renderSubagentList({
      width,
      height: Math.max(1, this.options.bodyHeight()),
      focusId: this.viewState.mode === 'main' ? this.viewState.listFocusId : undefined,
      scrollTop: this.viewState.mode === 'main' ? this.viewState.listScrollTop : 0,
      rows,
      count: countDirectChildren(this.listEntries, this.options.dock.dismissedIds()),
      loading: this.listLoading,
      error: this.listError,
      theme: activeTheme(),
    })
  }

  // ---- child 滚动 ----

  private childLineCount(): number {
    const child = this.childState
    if (child === undefined) return 0
    return child.model.layout({ width: this.width, expanded: this.options.expanded }).length
  }

  private childViewHeight(): number {
    return Math.max(1, this.options.bodyHeight() - 1)
  }

  private maxChildScroll(): number {
    return Math.max(0, this.childLineCount() - this.childViewHeight())
  }

  private halfPage(): number {
    return Math.max(1, Math.floor(this.childViewHeight() / 2))
  }

  private scrollChild(delta: number): void {
    const child = this.childState
    if (child === undefined) return
    const current = child.stickBottom ? 0 : child.scrollOffset
    const next = Math.max(0, Math.min(this.maxChildScroll(), current + delta))
    child.scrollOffset = next
    child.stickBottom = next === 0
    this.scrollMemory.set(child.id, { offset: next, stickBottom: child.stickBottom })
    this.options.onChange()
  }
}
