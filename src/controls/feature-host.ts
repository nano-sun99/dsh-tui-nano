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
import { takeHandoff } from '../runtime/handoff.ts'
import { ScheduleRuntime } from '../schedule/service.ts'
import { ScheduleStorage } from '../schedule/storage.ts'
import { SessionControllerAdapter } from '../sessions/session-controller-adapter.ts'
import { TerminalPane } from '../terminal/pane.ts'
import { INPUT_BYTE_LIMIT } from '../input/segments.ts'
import { assemblePrompt, findReferences } from '../attachments/prompt.ts'
import { parseBashInput, renderBashInjection, runBash } from './bash-mode.ts'
import { JobsPanel } from '../jobs/panel.ts'
import { SessionsPanel } from '../sessions/list.ts'
import { SubagentDock } from '../subagents/dock.ts'
import { Monitor, renderMonitorLines } from '../monitor/monitor.ts'
import { MONITOR_SOURCE } from '../monitor/source.ts'
import { Completions } from './completions.ts'
import { InfoPanel } from './info-panel.ts'

/** 终端面板开关（owner s02）：Ctrl+T。 */
export const TERMINAL_TOGGLE_ACTION = 'terminal.toggle'

/** 任务面板开关（owner s02）：Ctrl+J。 */
export const JOBS_TOGGLE_ACTION = 'jobs.toggle'

/** 会话列表面板开关（owner s02）：Ctrl+L。 */
export const SESSIONS_TOGGLE_ACTION = 'sessions.toggle'

/** 信息面板（技能/模型/上下文）开关（owner s02）：Ctrl+I。 */
export const INFO_TOGGLE_ACTION = 'info.toggle'

function isTerminalToggle(key: Key): boolean {
  return key.name === 'char' && key.ctrl === true && key.text === 't'
}

function isJobsToggle(key: Key): boolean {
  return key.name === 'char' && key.ctrl === true && key.text === 'j'
}

function isSessionsToggle(key: Key): boolean {
  return key.name === 'char' && key.ctrl === true && key.text === 'l'
}

function isInfoToggle(key: Key): boolean {
  return key.name === 'char' && key.ctrl === true && key.text === 'i'
}

export class Features implements FeatureHost {
  private context: FeatureContext | undefined
  private storage: ScheduleStorage | undefined
  private schedule: ScheduleRuntime | undefined
  private terminal: TerminalPane | undefined
  private completions: Completions | undefined
  private jobs: JobsPanel | undefined
  private monitor: Monitor | undefined
  private sessions: SessionsPanel | undefined
  private dock: SubagentDock | undefined
  private info: InfoPanel | undefined
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

    // 受控重启的落点：读走 handoff（读后删），只认目标根一致的那份。
    try {
      const handoff = takeHandoff(context.dataRoot)
      if (handoff && handoff.rootId === context.rootId) {
        const draft = handoff.payload?.draft
        if (typeof draft === 'string' && draft !== '') {
          context.input.insert(draft)
          context.setNotice('已从上一次受控切换恢复草稿')
        }
        const renameTo = handoff.payload?.renameTo
        if (typeof renameTo === 'string' && renameTo !== '') {
          // 冷改名：新进程拿到写锁后写官方标题，失败不猜、只报原因。
          try {
            const session = context.conversation.agent?.session
            const title = context.core.ctx.get('sessionTitle')
            if (session && title) title.rename(session, renameTo)
          } catch (error) {
            // 改名失败不杀启动：草稿已在输入框，报原因即可。
            context.setNotice(`改名失败：${String((error as Error)?.message ?? error)}`)
          }
        }
      }
    } catch (error) {
      // handoff 损坏：官方 takeHandoff 已删除并报错；这里不猜、不静默继续。
      throw new Error(`nano: handoff 损坏，停止启动：${String((error as Error)?.message ?? error)}`)
    }

    // 能力快照（spec §2.5）：β 必需项缺一即启动失败并点名。
    const missing: string[] = []
    if (!ctx.get('terminalController')) missing.push('terminalController')
    if (typeof ctx.get('sessionController')?.resolveAgent !== 'function') {
      missing.push('sessionController.resolveAgent')
    }
    if (!ctx.get('schedule')) missing.push('schedule')
    if (missing.length > 0) {
      throw new Error(`nano: 能力快照失败，缺少：${missing.join('、')}`)
    }

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

    // 6) 任务面板：官方 jobs 只读。
    this.monitor = new Monitor({
      ctx,
      sessionId: context.rootId,
      onChange: () => context.requestRender(),
      writeDiagnostic: (line) => process.stderr.write(`${line}\n`),
      deliver: (text, mode) => this.deliverMonitor(text, mode),
    })
    this.dock = new SubagentDock({
      ctx,
      rootId: context.rootId,
      onChange: () => context.requestRender(),
      writeDiagnostic: (line) => process.stderr.write(`${line}\n`),
    })
    this.dock.start()
    this.info = new InfoPanel({
      ctx,
      getAgent: () => context.conversation.agent,
      onChange: () => context.requestRender(),
      writeDiagnostic: (line) => process.stderr.write(`${line}\n`),
    })
    this.sessions = new SessionsPanel({
      ctx,
      rootId: context.rootId,
      onChange: () => context.requestRender(),
      writeDiagnostic: (line) => process.stderr.write(`${line}\n`),
      onSwitch: (rootId) => context.requestRestart({ rootId, reason: 'root-switch', payload: { draft: context.input.text } }),
      onRename: (rootId, title) => {
        if (rootId === context.rootId) {
          try {
            const session = context.conversation.agent?.session
            const service = ctx.get('sessionTitle')
            if (session && service) service.rename(session, title)
          } catch (error) {
            const message = String((error as Error)?.message ?? error)
            context.conversation.model.appendNotice(`改名失败：${message}`, 'danger')
            context.requestRender()
          }
          return
        }
        context.requestRestart({
          rootId,
          reason: 'cold-rename',
          payload: { draft: context.input.text, renameTo: title },
        })
      },
    })
    this.jobs = new JobsPanel({
      ctx,
      sessionId: context.rootId,
      onChange: () => context.requestRender(),
      writeDiagnostic: (line) => process.stderr.write(`${line}\n`),
      watch: (jobId, mode) => this.monitor?.watch(jobId, mode),
    })

    this.disposeKeys.push(
      registerKeybinding({
        id: INFO_TOGGLE_ACTION,
        keys: [{ name: 'char', text: 'i', ctrl: true }],
        scopes: ['idle', 'input', 'running'],
        description: '打开/关闭信息面板（技能/模型/上下文）',
        owner: 's02',
      }),
      registerKeybinding({
        id: SESSIONS_TOGGLE_ACTION,
        keys: [{ name: 'char', text: 'l', ctrl: true }],
        scopes: ['idle', 'input', 'running'],
        description: '打开/关闭会话列表',
        owner: 's02',
      }),
      registerKeybinding({
        id: JOBS_TOGGLE_ACTION,
        keys: [{ name: 'char', text: 'j', ctrl: true }],
        scopes: ['idle', 'input', 'running'],
        description: '打开/关闭任务面板',
        owner: 's02',
      }),
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
    if (isTerminalToggle(key) || isJobsToggle(key) || isSessionsToggle(key) || isInfoToggle(key)) return false
    if (this.completions?.handleKey(key)) return true
    if (this.info?.handleKey(key)) return true
    if (this.sessions?.handleKey(key)) return true
    if (this.jobs?.handleKey(key)) return true
    if (this.terminal?.visible && this.terminal.handleKey(key, false)) return true
    // 带图片引用时 Enter 走附件链：持久化 + 官方准入后再提交。
    if (key.name === 'enter' && !key.shift && !key.ctrl && !key.alt) {
      const text = this.context?.input.text ?? ''
      // 所有 S02 提交路径共用 S01 的 32 KiB 上限（含附件引用文本）。
      if (Buffer.byteLength(text, 'utf8') > INPUT_BYTE_LIMIT) {
        this.context?.setNotice('超过 32 KiB 上限，未发送（草稿保留）')
        return true
      }
      if (text.trimStart().startsWith('/')) {
        void this.runSlashCommand(text)
        return true
      }
      const bash = parseBashInput(text)
      if (bash) {
        void this.runManualCommand(bash.command, bash.inject)
        return true
      }
      if (findReferences(text).some((reference) => reference.image)) {
        void this.submitWithAttachments(text)
        return true
      }
    }
    return false
  }

  /**
   * `/` 命令：只检索与转发官方命令（含 `/permission <preset>`、`/compact`）。
   * 同名时命令优先于技能；未知 `/name` 按普通消息发送并标「未注入」。
   */
  private async runSlashCommand(text: string): Promise<void> {
    const context = this.context
    if (!context) return
    const model = context.conversation.model
    const agent = context.conversation.agent
    const commands = context.core.ctx.get('commands')
    const name = (text.trim().slice(1).split(/\s+/u)[0] ?? '').toLowerCase()
    context.requestRender()
    const definition = agent && commands ? commands.find(agent, name) : undefined
    if (!definition) {
      model.appendNotice(`未知命令 /${name}：按普通消息发送（未注入命令）`, 'warning')
      try {
        context.conversation.submit(text)
      } catch (error) {
        model.appendNotice(`发送失败：${String((error as Error)?.message ?? error)}`, 'danger')
      }
      context.requestRender()
      return
    }
    try {
      const execution = await commands.execute(agent, text, [], new AbortController().signal)
      const result = execution?.result
      if (result?.kind === 'success') {
        context.input.take()
        if (result.text) model.appendNotice(result.text, 'info')
      } else if (result?.kind === 'error') {
        model.appendNotice(`命令失败：${result.text}`, 'danger')
        if (name === 'permission') {
          // 权限失败不乐观更新：保留原值，提示可能已部分生效。
          model.appendNotice('可能已部分生效，请重开 /permission 核对', 'warning')
        }
      }
    } catch (error) {
      model.appendNotice(`命令失败：${String((error as Error)?.message ?? error)}`, 'danger')
      if (name === 'permission') {
        model.appendNotice('可能已部分生效，请重开 /permission 核对', 'warning')
      }
    }
    context.requestRender()
  }

  /**
   * 人工命令：单次 danger-full-access，不注册 job、不进任务表。
   * `inject` 为真时把输出以合成 user 消息注入模型（不新开回合、不当场唤醒）。
   */
  private async runManualCommand(command: string, inject: boolean): Promise<void> {
    const context = this.context
    if (!context) return
    const model = context.conversation.model
    model.appendNotice(`$ ${command}`, 'info')
    context.input.take()
    context.requestRender()
    try {
      const result = await runBash({ ctx: context.core.ctx, command, workdir: context.cwd })
      const output = [result.stdout, result.stderr].filter((part) => part !== '').join('\n')
      if (output !== '') model.appendNotice(output, result.exitCode === 0 ? 'info' : 'danger')
      model.appendNotice(
        result.timedOut ? '已超时' : `退出码 ${String(result.exitCode ?? 'null')}`,
        result.exitCode === 0 ? 'info' : 'warning',
      )
      if (inject) {
        this.injectIntoModel(renderBashInjection(result))
      }
    } catch (error) {
      model.appendNotice(`人工命令失败：${String((error as Error)?.message ?? error)}`, 'danger')
    }
    context.requestRender()
  }

  /**
   * Monitor 收件：quiet 走 inject（不唤醒、不新建回合）；notify 走 followup
   * （会唤醒并计费，开启时已提示）。
   */
  private deliverMonitor(text: string, mode: 'quiet' | 'notify'): void {
    const context = this.context
    const agent = context?.conversation.agent
    const llm = context?.official?.llm
    const model = context?.conversation.model
    model?.appendNotice(text, 'info')
    context?.requestRender()
    if (!agent || !llm?.createUserMessage) return
    const message = llm.createUserMessage({ content: [{ type: 'text', text }], source: MONITOR_SOURCE })
    try {
      if (mode === 'notify') agent.followup(message)
      else agent.inject(message)
    } catch (error) {
      process.stderr.write(`nano: Monitor 投递失败：${String((error as Error)?.message ?? error)}\n`)
    }
  }

  /** 注入语义：不新开回合、不唤醒；运行中的 Agent 在最近 step boundary 取走。 */
  private injectIntoModel(text: string): void {
    const context = this.context
    const agent = context?.conversation.agent
    const llm = context?.official?.llm
    if (!agent || !llm?.createUserMessage) return
    try {
      agent.inject(llm.createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
    } catch (error) {
      process.stderr.write(`nano: 注入人工命令输出失败：${String((error as Error)?.message ?? error)}\n`)
    }
  }

  /** 附件链提交：失败保留草稿并提示，不静默吞掉。 */
  private async submitWithAttachments(text: string): Promise<void> {
    const context = this.context
    if (!context) return
    try {
      const assembled = await assemblePrompt({
        ctx: context.core.ctx,
        cwd: context.cwd,
        text,
      })
      if (assembled.rejected.length > 0) throw new Error(assembled.rejected.join('；'))
      context.conversation.submitContent({ content: assembled.content, displayText: text })
      context.input.take()
      context.setNotice(undefined)
    } catch (error) {
      const message = String((error as Error)?.message ?? error)
      context.setNotice(`附件提交失败：${message}（草稿已保留）`)
    }
  }

  dispatchAction(action: string): boolean {
    if (action === INFO_TOGGLE_ACTION) {
      this.info?.toggle()
      return true
    }
    if (action === SESSIONS_TOGGLE_ACTION) {
      this.sessions?.toggle()
      return true
    }
    if (action === JOBS_TOGGLE_ACTION) {
      this.jobs?.toggle()
      return true
    }
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
    const info = this.info?.visible ? this.info.render(width, this.innerHeight()) : null
    const sessions = this.sessions?.visible ? this.sessions.render(width, this.innerHeight()) : null
    const jobs = this.jobs?.visible
      ? this.jobs.render(width, this.innerHeight(), this.monitor?.watching)
      : null
    const popup = this.completions?.render(width) ?? null
    const dock = this.dock?.visible ? this.dock.render(width) : null
    const stack = [pane, info, sessions, jobs, popup, dock].filter(Boolean)
    if (stack.length === 0) return null
    if (stack.length === 1) return stack[0]
    return createElement(Box, { flexDirection: 'column', width }, ...stack)
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
    this.info = undefined
    this.dock?.stop()
    this.dock = undefined
    this.sessions = undefined
    this.monitor?.dispose()
    this.monitor = undefined
    this.jobs = undefined
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
