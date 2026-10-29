/**
 * S02 的接线对象（S02 spec §1 接入点例外第 2/3 条）。
 *
 * S01 只把它当成一个可选钩子：`start` 在首帧前 await，`dispose` 在关停 drain
 * 阶段调用。这里按顺序把 S02 的功能面挂上官方根——顺序本身是约束：
 * 命名后端 + 服务键要在 `storageDomain` 之前，探针要在 schedule 之前。
 */
import { createElement, type ReactNode } from 'react'
import type { FeatureContext, FeatureHost } from '../app/nano-app.ts'
import { registerKeybinding } from '../input/keymap.ts'
import type { Key } from '../input/parser.ts'
import { Box } from '../render/components.ts'
import { ScheduleRuntime } from '../schedule/service.ts'
import { ScheduleStorage } from '../schedule/storage.ts'
import { SessionControllerAdapter } from '../sessions/session-controller-adapter.ts'
import { TerminalPane } from '../terminal/pane.ts'
import { Completions } from './completions.ts'

/** 终端面板开关（owner s02）：Ctrl+T。 */
export const TERMINAL_TOGGLE_ACTION = 'terminal.toggle'

function isTerminalToggle(key: Key): boolean {
  return key.name === 'char' && key.ctrl === true && key.text === 't'
}

export class Features implements FeatureHost {
  private context: FeatureContext | undefined
  private storage: ScheduleStorage | undefined
  private schedule: ScheduleRuntime | undefined
  private terminal: TerminalPane | undefined
  private completions: Completions | undefined
  private disposeKeys: (() => void)[] = []

  async start(context: FeatureContext): Promise<void> {
    this.context = context
    const ctx = context.core.ctx

    // 1) 命名后端 + 服务键：storage-domain 的路由靠它激活。
    const storage = new ScheduleStorage({
      ctx,
      dataRoot: context.dataRoot,
      rootId: context.rootId,
    })
    this.storage = storage
    storage.install()

    // 2) 探针：路由真的落到命名后端才继续；失败即启动失败。
    await storage.probe()

    // 3) 最小会话控制器 + 官方 schedule（探针之后才允许打开任务表）。
    const schedule = new ScheduleRuntime({
      ctx,
      sessionController: new SessionControllerAdapter({ agents: ctx.agents }),
    })
    this.schedule = schedule
    await schedule.mount()

    // 4) 终端面板：只用官方 terminalController。
    const pane = new TerminalPane({
      ctx,
      sessionId: context.rootId,
      getAgent: () => context.conversation.agent,
      onChange: () => context.requestRender(),
      writeDiagnostic: (line) => context.renderer // 诊断走 stderr
        ? process.stderr.write(`${line}\n`)
        : undefined,
    })
    this.terminal = pane

    // 5) 补全与 @ 引用：三类 provider 注册到 D01 注册表。
    this.completions = new Completions({
      ctx,
      input: context.input,
      getAgent: () => context.conversation.agent,
      onChange: () => context.requestRender(),
      writeDiagnostic: (line) => process.stderr.write(`${line}\n`),
    })
    this.completions.install()

    this.disposeKeys.push(
      registerKeybinding({
        id: TERMINAL_TOGGLE_ACTION,
        keys: [{ name: 'char', text: 't', ctrl: true }],
        scopes: ['idle', 'input', 'running'],
        description: '打开/关闭终端面板',
        owner: 's02',
      }),
    )
  }

  handleKey(key: Key): boolean {
    // 开关必须交回 keymap：否则面板聚焦时会把 Ctrl+T 当成终端输入吃掉。
    if (isTerminalToggle(key)) return false
    if (this.completions?.handleKey(key)) return true
    if (!this.terminal) return false
    return this.terminal.handleKey(key, false)
  }

  dispatchAction(action: string): boolean {
    if (action === 'focus.next' && this.completions?.open) {
      this.completions.accept()
      return true
    }
    if (action !== TERMINAL_TOGGLE_ACTION) return false
    if (!this.terminal) return false
    if (this.terminal.visible) this.terminal.hide()
    else void this.terminal.open(this.innerWidth(), this.innerHeight())
    return true
  }

  body(): ReactNode {
    this.completions?.maybeSync()
    const width = this.innerWidth()
    const pane = this.terminal?.visible ? this.terminal.render(width, this.innerHeight()) : null
    const popup = this.completions?.render(width) ?? null
    if (pane && popup) return createElement(Box, { flexDirection: 'column', width }, pane, popup)
    return pane ?? popup
  }

  private innerWidth(): number {
    return Math.max(20, (this.context?.terminal.width ?? 80) - 2)
  }

  private innerHeight(): number {
    return Math.max(6, Math.min(20, (this.context?.terminal.height ?? 24) - 12))
  }

  async dispose(): Promise<void> {
    this.completions?.dispose()
    this.completions = undefined
    for (const dispose of this.disposeKeys) dispose()
    this.disposeKeys = []
    await this.terminal?.close().catch?.(() => {})
    this.terminal = undefined
    this.schedule?.dispose()
    this.schedule = undefined
    await this.storage?.dispose()
    this.storage = undefined
    this.context = undefined
  }
}
