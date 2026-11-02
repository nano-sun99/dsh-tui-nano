import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { App, type AppSnapshot } from '../../src/app/App.tsx'
import {
  applyApprovalSettlement,
  approvalCommandFromArgs,
  buildApprovalCard,
  focusScrollOffset,
} from '../../src/app/approval-card.ts'
import { DecisionManager } from '../../src/decisions/manager.ts'
import { Renderer } from '../../src/render/renderer.ts'
import { darkTheme } from '../../src/theme/theme.ts'
import { TranscriptModel } from '../../src/transcript/model.ts'
import { rowText } from '../../src/transcript/spans.ts'

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

async function approval(width = 100, height = 30) {
  const model = new TranscriptModel()
  model.appendUser('跑一下测试', 'req-1')
  model.appendTool('call-1', 'bash', JSON.stringify({ command: 'npm test' }))
  const decisions = new DecisionManager()
  void decisions.askApproval({
    toolName: 'bash',
    reason: '命令需要在工作区外写权限。',
    callId: 'call-1',
  })
  await tick()
  const prompt = decisions.prompt
  if (prompt?.kind !== 'approval') throw new Error('expected approval prompt')
  return { model, decisions, prompt, width, height }
}

function snapshot(
  state: Awaited<ReturnType<typeof approval>>,
  overrides: Partial<AppSnapshot> = {},
): AppSnapshot {
  const card = buildApprovalCard(state.prompt, 'npm test', state.width)
  return {
    transcript: state.model,
    decisions: state.decisions,
    text: '',
    cursor: 0,
    theme: darkTheme,
    width: state.width,
    height: state.height,
    rootId: 'r',
    modelLabel: 'deepseek-official/deepseek-chat',
    status: 'running',
    cwd: '/tmp/project',
    expanded: new Set<string>(),
    scrollOffset: 0,
    stickBottom: true,
    userName: '你',
    approvalRows: card.rows,
    ...overrides,
  }
}

function render(snap: AppSnapshot): Renderer {
  const renderer = new Renderer({
    write: () => {},
    width: snap.width,
    height: snap.height,
    defaultFg: darkTheme.fg,
  })
  renderer.mount(createElement(App, { snapshot: snap }))
  renderer.flushFrame()
  return renderer
}

function flatten(model: TranscriptModel): string[] {
  return model
    .units({ width: 100, expanded: new Set<string>() })
    .flatMap((unit) => unit.rows.map((row) => rowText(row)))
}

describe('approval card rows', () => {
  it('renders title, four options, descriptions and the fail-closed focus', async () => {
    const state = await approval()
    const card = buildApprovalCard(state.prompt, 'npm test', 100)
    const lines = card.rows.map((row) => rowText(row))
    expect(lines[0]).toContain('─')
    expect(lines.some((line) => line.includes('是否运行这条检查命令？'))).toBe(true)
    expect(lines.some((line) => line.includes('4. 无法回答（按失败关闭处理）'))).toBe(true)
    expect(lines.filter((line) => line.includes('仅允许本次命令')).length).toBe(1)
    expect(lines.filter((line) => line.includes('不执行本次命令')).length).toBe(1)
    expect(rowText(card.rows[card.focusRow]!)).toContain('2. 拒绝')
    expect(card.rows.some((row) => row.pressId === 'decision:approval:1')).toBe(true)
  })

  it('caps the command at eight lines and reports the remainder', async () => {
    const state = await approval()
    const command = Array.from({ length: 11 }, (_, index) => `line-${index + 1}`).join('\n')
    const card = buildApprovalCard(state.prompt, command, 100)
    const lines = card.rows.map((row) => rowText(row))
    expect(lines.filter((line) => line.startsWith('line-')).length).toBe(8)
    expect(lines.some((line) => line.includes('…还有 3 行'))).toBe(true)
  })
})

describe('approval card in the transcript', () => {
  it('stays in the transcript after a re-render', async () => {
    const state = await approval()
    const renderer = render(snapshot(state))
    const before = renderer
      .snapshotLines()
      .findIndex((line) => line.includes('是否运行这条检查命令？'))
    expect(before).toBeGreaterThan(-1)
    renderer.update(createElement(App, { snapshot: snapshot(state, { text: 'x' }) }))
    renderer.flushFrame()
    const after = renderer
      .snapshotLines()
      .findIndex((line) => line.includes('是否运行这条检查命令？'))
    expect(after).toBe(before)
    const hasOverlay = (node: { type?: string; children?: unknown[] }): boolean =>
      node.type === 'overlay' ||
      (node.children ?? []).some((child) =>
        hasOverlay(child as { type?: string; children?: unknown[] }),
      )
    expect(hasOverlay(renderer.container)).toBe(false)
    renderer.unmount()
  })
})

describe('approval helpers', () => {
  it('prefers args.command and truncates the key: value fallback to one line', () => {
    expect(approvalCommandFromArgs({ command: 'npm test' })).toBe('npm test')
    const long = 'x'.repeat(400)
    const fallback = approvalCommandFromArgs({ content: long, file_path: 'a.ts' })
    expect(fallback?.split('\n').length).toBe(2)
    expect(fallback?.split('\n')[0]).toContain('content:')
    expect(fallback?.split('\n')[0]?.endsWith('…')).toBe(true)
    expect(approvalCommandFromArgs({})).toBeUndefined()
    expect(approvalCommandFromArgs(undefined)).toBeUndefined()
  })

  it('keeps the focus row inside the viewport', () => {
    expect(focusScrollOffset(40, 10, 0, 35)).toBe(0)
    expect(focusScrollOffset(40, 10, 0, 5)).toBe(25)
    expect(focusScrollOffset(40, 10, 20, 15)).toBe(20)
    expect(focusScrollOffset(40, 10, 0, 39)).toBe(0)
  })

  it('settles on the tool row, or falls back to a notice for unknown calls', () => {
    const model = new TranscriptModel()
    model.appendTool('call-1', 'bash', JSON.stringify({ command: 'npm test' }))
    const known = applyApprovalSettlement(model, { callId: 'call-1' }, 'cancelled')
    expect(known).toBe(true)
    expect(flatten(model).some((line) => line.includes('已取消 · 未执行'))).toBe(true)
    expect(applyApprovalSettlement(model, { callId: 'missing' }, 'rejected')).toBe(false)
    expect(flatten(model).some((line) => line.includes('已拒绝 · 未执行'))).toBe(true)
    expect(applyApprovalSettlement(model, { callId: 'call-1' }, 'allowed-once')).toBe(false)
  })
})

describe('approval decisions in the transcript', () => {
  it('leaves a decision row for rejected and no row for allowed', async () => {
    const state = await approval()
    expect(state.model.markApprovalDecision('call-1', 'allowed-once')).toBe(false)
    expect(flatten(state.model).some((line) => line.includes('已拒绝'))).toBe(false)
    expect(state.model.markApprovalDecision('call-1', 'rejected')).toBe(true)
    const lines = flatten(state.model)
    expect(lines.some((line) => line.includes('已拒绝 · 未执行'))).toBe(true)
  })

  it('summarises mixed decisions on a read-like group row', async () => {
    const model = new TranscriptModel()
    model.appendTool('read-1', 'read', JSON.stringify({ file_path: 'a.ts' }))
    model.appendTool('read-2', 'read', JSON.stringify({ file_path: 'b.ts' }))
    model.markApprovalDecision('read-1', 'rejected')
    model.markApprovalDecision('read-2', 'cancelled')
    const lines = flatten(model)
    expect(lines.some((line) => line.includes('已拒绝 1 · 已取消 1'))).toBe(true)
  })

  it('renders cancelled and unavailable rows', () => {
    const model = new TranscriptModel()
    model.appendTool('call-1', 'bash', JSON.stringify({ command: 'npm test' }))
    model.appendTool('call-2', 'write', JSON.stringify({ file_path: 'a.ts' }))
    model.markApprovalDecision('call-1', 'cancelled')
    model.markApprovalDecision('call-2', 'unavailable')
    const lines = flatten(model)
    expect(lines.some((line) => line.includes('已取消 · 未执行'))).toBe(true)
    expect(lines.some((line) => line.includes('无法回答 · 按失败关闭处理'))).toBe(true)
  })

  it('shows each decision under its entry when a read group is expanded', () => {
    const model = new TranscriptModel()
    model.appendTool('read-1', 'read', JSON.stringify({ file_path: 'a.ts' }))
    model.appendTool('read-2', 'read', JSON.stringify({ file_path: 'b.ts' }))
    model.markApprovalDecision('read-1', 'rejected')
    model.markApprovalDecision('read-2', 'cancelled')
    const lines = model
      .units({ width: 100, expanded: new Set(['group-tool-read-1']) })
      .flatMap((unit) => unit.rows.map((row) => rowText(row)))
    expect(lines.filter((line) => line.includes('已拒绝 · 未执行')).length).toBe(1)
    expect(lines.filter((line) => line.includes('已取消 · 未执行')).length).toBe(1)
  })

  it('returns false when the call is unknown so the caller can notify', () => {
    const model = new TranscriptModel()
    expect(model.markApprovalDecision('missing', 'cancelled')).toBe(false)
  })
})
