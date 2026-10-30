/**
 * 子代理详情（spec 2026-10-30 §4.2 / §4.3）：顶部标识、可续聊判定与
 * 把官方 child session 的消息投影折回 transcript。渲染复用主对话模型。
 */
import type { Block, TranscriptModel } from '../transcript/model.ts'
import { type DockStatus, statusWord } from './dock.ts'

export type SubagentMode = 'one-shot' | 'continuable' | 'external' | 'unknown'

export interface ComposerInput {
  readonly mode: SubagentMode
  readonly parentLive: boolean
  readonly childRunning: boolean
}

export interface ComposerState {
  readonly showInput: boolean
  readonly editable: boolean
  readonly showStop: boolean
}

/** 顶部标识：`子代理 · 名字 · 状态词`。 */
export function detailTitle(name: string, status: DockStatus): string {
  return `子代理 · ${name} · ${statusWord(status)}`
}

export function modeAllowsDetail(mode: SubagentMode): boolean {
  return mode !== 'external'
}

/**
 * S12 §2 / 不变量 10：parent live 时可续聊；parent 不可用时输入禁用，
 * child 运行中仍保留独立 Stop；一次性与未知模式只读。
 */
export function composerState(input: ComposerInput): ComposerState {
  if (input.mode !== 'continuable') {
    return { showInput: false, editable: false, showStop: false }
  }
  return {
    showInput: true,
    editable: input.parentLive,
    showStop: input.childRunning,
  }
}

function textOf(content: readonly any[] | undefined): string {
  return (content ?? [])
    .filter((part) => part?.type === 'text')
    .map((part) => String(part.text ?? ''))
    .join('')
}

/** 从官方 message projection 重建一份可读的 transcript。 */
export function replaySessionMessages(model: TranscriptModel, messages: readonly any[]): void {
  let seq = 0
  for (const message of messages) {
    seq++
    if (message.role === 'user') {
      const text = textOf(message.content)
      if (message.source?.kind === 'user' && text.trim() !== '') {
        model.confirmUser(-seq, text)
      }
      continue
    }
    if (message.role === 'assistant') {
      const blocks: Block[] = []
      const calls: Array<{ id: string; name: string; arguments?: string }> = []
      for (const block of message.content ?? []) {
        if (block.type === 'text') blocks.push({ type: 'text', text: block.text })
        else if (block.type === 'reasoning') blocks.push({ type: 'reasoning', text: block.text })
        else if (block.type === 'tool-call')
          calls.push({ id: block.id, name: block.name, arguments: block.arguments })
      }
      if (blocks.some((block) => block.type === 'text')) model.appendAssistant(-seq, blocks)
      for (const call of calls) model.appendTool(call.id, call.name, call.arguments ?? '')
      continue
    }
    if (message.role === 'tool') {
      model.completeTool(
        message.toolCallId,
        textOf(message.content),
        message.isError === true,
        message.meta,
      )
    }
  }
}

/**
 * 实时事件折入正文：只处理阅读面相关内容；turn/end、标题由调用方处理。
 * 与 ConversationController 的 fold 规则保持一致。
 */
export function foldSessionEvent(model: TranscriptModel, event: any): void {
  const data = event.data ?? {}
  switch (event.type) {
    case 'user/message': {
      const text = textOf(data.content)
      const sourceKind = data.source?.kind ?? 'unknown'
      if (sourceKind === 'user') {
        model.confirmUser(event.seq, text)
      } else if (data.source?.form === 'notice') {
        const summary = String(data.source.summary ?? text)
        if (summary.trim() !== '') model.appendNotice(summary, 'info')
      }
      break
    }
    case 'assistant/message': {
      const blocks: Block[] = []
      for (const block of data.message?.content ?? []) {
        if (block.type === 'text') blocks.push({ type: 'text', text: block.text })
        else if (block.type === 'reasoning') blocks.push({ type: 'reasoning', text: block.text })
      }
      model.appendAssistant(event.seq, blocks)
      break
    }
    case 'assistant/attempt':
      model.clearPreview()
      if (!data.interrupted) model.appendNotice('本次回复未确认（没有产生可见消息）。', 'warning')
      break
    case 'tool/call':
      model.appendTool(data.callId, data.name, data.arguments ?? '')
      break
    case 'tool/result': {
      const text = textOf(data.message?.content)
      const isError = data.message?.isError === true || data.error !== undefined
      const reason =
        typeof data.error?.reason === 'string' && data.error.reason !== ''
          ? data.error.reason
          : undefined
      model.completeTool(
        data.message?.toolCallId ?? data.message?.source?.callId,
        reason ? `${reason}\n${text}` : text,
        isError,
        data.meta,
      )
      break
    }
    default:
      break
  }
}
