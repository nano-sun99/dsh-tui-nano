import { createHash } from 'node:crypto'
import { inflateSync } from 'node:zlib'
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { tailFrame, tailMetadata, tailPixels } from '../../src/activity/frames.ts'
import { ActivityState, TAILS } from '../../src/activity/state.ts'
import { App, type AppSnapshot, transcriptBodyHeight } from '../../src/app/App.tsx'
import { ConversationController } from '../../src/conversation/controller.ts'
import { DecisionManager } from '../../src/decisions/manager.ts'
import { InputParser } from '../../src/input/parser.ts'
import { ACTIVITY_IMAGE_ID, ActivityImagePlayer } from '../../src/render/activity-image.ts'
import { Renderer } from '../../src/render/renderer.ts'
import { darkTheme, lightTheme } from '../../src/theme/theme.ts'
import { TranscriptModel } from '../../src/transcript/model.ts'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})
function working(random = vi.fn(() => 0)) {
  const state = new ActivityState(random)
  state.accepted()
  state.startTurn(1)
  state.start({ attemptId: 'root:1', revision: 1, turn: 1 }, 1000)
  return { state, random }
}
describe('activity C01-C13 and P01-P08', () => {
  it('C01 accepts input without drawing; C02 alone samples; C03/C04 are real events; C06 whitespace keeps feedback', () => {
    const random = vi.fn(() => 0.3)
    const s = new ActivityState(random)
    expect(s.project()).toEqual({ text: '' })
    s.accepted()
    expect(s.project()).toEqual({ text: '正在处理…' })
    expect(random).not.toHaveBeenCalled()
    s.startTurn(1)
    s.start({ attemptId: 'a', revision: 1, turn: 1 }, 1000)
    expect(s.project()).toMatchObject({ tail: 'wag', text: '正在处理…' })
    s.body(' \n ')
    expect(s.project().tail).toBe('wag')
    s.reasoning('actual')
    expect(s.project().text).toBe('思考中…')
    s.parameters()
    expect(s.project().text).toBe('正在准备工具…')
  })
  it('C05 callId convergence retains the other tool after a failed result', () => {
    const { state: s } = working()
    s.endAttempt()
    s.toolStart('a', 'Read', 1)
    s.toolStart('b', 'Bash', 1)
    expect(s.project().text).toBe('正在运行 2 个工具…')
    s.toolEnd('a', 1)
    expect(s.project().text).toBe('正在运行 Bash…')
    s.start({ attemptId: 'root:2', revision: 4, turn: 1 }, 2000)
    expect(s.project().tail).toBe('official')
  })
  it('C07/P06 body wins over concurrent ordinary tools; C08/C09/P02 waiting wins over both', () => {
    const { state: s, random } = working()
    s.toolStart('a', 'Bash', 1)
    s.body('visible')
    expect(s.project()).toEqual({ text: '' })
    expect(s.project('approval')).toEqual({ text: '等待你的授权' })
    expect(s.project('question')).toEqual({ text: '等待你的选择' })
    expect(s.project('plan-review')).toEqual({ text: '等待你审阅计划' })
    expect(random).toHaveBeenCalledTimes(1)
  })
  it('C10/P03/P04 decision > stopping > body/tool; C11/C12/P05 terminal beats residual facts; C13 stays empty', () => {
    const { state: s } = working()
    s.body('answer')
    s.toolStart('a', 'Bash', 1)
    s.stop()
    expect(s.project().text).toBe('正在停止…')
    expect(s.project('approval').text).toBe('等待你的授权')
    s.endTurn(1)
    s.toolStart('late', 'Bash', 1)
    s.body('late')
    expect(s.project()).toEqual({ text: '' })
    expect(new ActivityState().project()).toEqual({ text: '' })
  })
  it('P01 hides foreign surfaces; 25 repeated starts, redraws and wait resumes never re-sample', () => {
    const { state: s, random } = working()
    for (let i = 0; i < 25; i++) {
      expect(s.start({ attemptId: 'root:1', revision: 1, turn: 1 })).toBe(false)
      s.project('approval')
      s.project(undefined, false)
      s.project()
    }
    expect(s.project(undefined, false)).toEqual({ text: '' })
    expect(random).toHaveBeenCalledTimes(1)
  })
  it('P07 rejects stale attempts, chunks, terminals, revisions and old turns; new retry samples once', () => {
    const { state: s, random } = working()
    s.endAttempt()
    s.start({ attemptId: 'retry', revision: 10, turn: 1 }, 2000)
    expect(s.frame({ attemptId: 'root:1', revision: 11 })).toBe(false)
    expect(s.start({ attemptId: 'root:1', revision: 1, turn: 1 })).toBe(false)
    s.endTurn(1)
    s.startTurn(2)
    s.start({ attemptId: 'next', revision: 20, turn: 2 }, 3000)
    expect(s.endTurn(1)).toBe(false)
    expect(s.startTurn(1)).toBe(false)
    expect(s.start({ attemptId: 'late', revision: 21, turn: 1 })).toBe(false)
    expect(s.project().requestKey).toBe('next')
    expect(random).toHaveBeenCalledTimes(3)
  })
  it('P08 latches visible body through preview commit; only explicit later work reopens it', () => {
    const { state: s, random } = working()
    s.body('answer')
    s.endAttempt()
    expect(s.project()).toEqual({ text: '' })
    s.toolStart('t', 'Read', 1)
    expect(s.project().text).toBe('正在运行 Read…')
    expect(random).toHaveBeenCalledTimes(1)
    s.endTurn(1)
    expect(s.project()).toEqual({ text: '' })
  })
  it.each([0, 0.249999, 0.25, 0.499999, 0.5, 0.749999, 0.75, 0.999999])(
    'uniform interval %s and legal repeat',
    (n) => {
      const { state: s } = working(vi.fn(() => n))
      expect(s.project().tail).toBe(TAILS[Math.floor(n * 4)])
      s.endAttempt()
      s.start({ attemptId: 'repeat', revision: 2, turn: 1 })
      expect(s.project().tail).toBe(TAILS[Math.floor(n * 4)])
    },
  )
})

describe('fixed assets and bounded player', () => {
  it.each(TAILS)('%s preserves every path and mask plus its period', (tail) => {
    const a = tailMetadata.animations[tail]
    expect(a.frames.length).toBe({ official: 150, wag: 24, sway: 24, twist: 36 }[tail])
    expect(createHash('sha256').update(JSON.stringify(a.paths)).digest('hex')).toBe(a.sha256)
    for (const mask of a.frames)
      expect(inflateSync(Buffer.from(mask, 'base64'))).toHaveLength(128 * 128)
    expect(tailFrame(tail, a.periodMs)).toBe(0)
    expect(tailFrame(tail, a.periodMs - 1)).toBe(a.frames.length - 1)
    expect(
      inflateSync(Buffer.from(tailPixels(tail, 0, 37, darkTheme.accent), 'base64')),
    ).toHaveLength(37 * 37 * 4)
  })
  it('one id, square <= one row/3ch, save/restore cursor, static has zero later frames, cleanup is idempotent', () => {
    const p = new ActivityImagePlayer()
    const image = {
      text: 'thinking',
      tail: 'twist' as const,
      requestKey: 'a',
      startedAt: 0,
      row: 10,
      col: 2,
      color: darkTheme.accent,
    }
    const first = p.paint(image, { cellWidth: 17, cellHeight: 37 }, true, 0)
    expect(first).toContain(`i=${ACTIVITY_IMAGE_ID}`)
    expect(first).toContain('s=37,v=37')
    expect(first).toContain('C=1,q=2')
    const esc = String.fromCharCode(27)
    expect(first).toContain(`${esc}7`)
    expect(first.endsWith(`${esc}8`)).toBe(true)
    expect(p.paint(image, { cellWidth: 17, cellHeight: 37 }, true, 1000)).toBe('')
    expect(p.paint(undefined, { cellWidth: 17, cellHeight: 37 }, false, 1000)).toContain('a=d,d=I')
    expect(p.clear()).toBe('')
    expect(p.paint(image, undefined, false, 1000)).toBe('')
    p.disable()
    expect(p.paint(image, { cellWidth: 17, cellHeight: 37 }, false, 0)).toBe('')
  })
})

describe('graphics responses cannot enter drafts', () => {
  it('reassembles every split boundary across timeout including the two-byte APC prefix', () => {
    const E = String.fromCharCode(27),
      response = `${E}_Gi=129002;OK${E}\\${E}[6;37;17t`
    for (let i = 1; i < response.length; i++) {
      const p = new InputParser()
      const events = p.feed(response.slice(0, i))
      events.push(...p.flushPending(true), ...p.feed(`${response.slice(i)}中文`))
      expect(
        events
          .filter((e) => e.type === 'key')
          .map((e) => (e.type === 'key' ? e.key.text : ''))
          .join(''),
      ).toBe('中文')
    }
  })
  it('drops a stalled protocol prefix after the graphics window instead of swallowing later input', () => {
    const p = new InputParser()
    p.feed(`${String.fromCharCode(27)}_G`)
    expect(p.flushPending(true)).toEqual([])
    expect(p.flushPending(false)).toEqual([])
    expect(p.feed('a')).toMatchObject([{ type: 'key', key: { text: 'a' } }])
  })
  it('swallows unknown, failed and delayed APC/DCS responses and preserves paste and arrows', () => {
    const E = String.fromCharCode(27),
      p = new InputParser()
    const events = p.feed(
      `${E}_Gi=129002;ENOTSUP${E}\\${E}Punknown${E}\\${E}[200~hello${E}[201~${E}[A`,
    )
    expect(events.filter((e) => e.type === 'paste')).toEqual([{ type: 'paste', text: 'hello' }])
    expect(events.filter((e) => e.type === 'key')).toMatchObject([{ key: { name: 'up' } }])
  })
})

function view(overrides: Partial<AppSnapshot> = {}): AppSnapshot {
  return {
    transcript: new TranscriptModel(),
    decisions: new DecisionManager(),
    text: 'draft 中文',
    cursor: 8,
    theme: darkTheme,
    width: 100,
    height: 32,
    rootId: 'r',
    modelLabel: 'model',
    status: 'running',
    expanded: new Set(),
    scrollOffset: 0,
    stickBottom: true,
    userName: '你',
    ...overrides,
  }
}
describe('core activity layout and actual renderer', () => {
  it.each([60, 100])(
    'fixed line and hit budget at %s columns across themes, multi-line input, completion and dock',
    (width) => {
      for (const theme of [darkTheme, lightTheme])
        for (const text of ['draft', 'a\nb\nc\nd']) {
          const writes: string[] = []
          const r = new Renderer({
            write: (b) => writes.push(b),
            width,
            height: 32,
            defaultFg: theme.fg,
          })
          r.configureActivity(() => ({ cellWidth: 17, cellHeight: 37 }))
          const base = view({
            width,
            theme,
            text,
            completionRows: 2,
            completionBody: createElement('text', {}, 'COMPLETION'),
            dockRows: 5,
            dockBody: createElement('text', {}, 'SUBAGENT'),
          })
          const positions: number[] = []
          for (const activity of [
            { text: '' },
            {
              text: '正在处理…',
              tail: 'official' as const,
              requestKey: 'r:1',
              startedAt: Date.now(),
            },
            { text: '等待你的选择' },
            { text: '' },
          ]) {
            r.update(createElement(App, { snapshot: { ...base, activity } }))
            r.flushFrame()
            const lines = r.snapshotLines()
            positions.push(lines.findIndex((l) => l.includes('› ')))
            expect(lines.findIndex((l) => l.includes('SUBAGENT'))).toBeGreaterThan(
              lines.findIndex((l) => l.includes('Enter ')),
            )
            expect(lines.every((l) => l.length <= width)).toBe(true)
          }
          expect(new Set(positions).size).toBe(1)
          expect(writes.join('')).toContain('a=d,d=I')
          r.unmount()
        }
    },
  )
  it('no graphics capability sends no image bytes; hidden/idle/reduced produce no frame loop and images preserve caret', async () => {
    vi.useFakeTimers()
    const writes: string[] = []
    const r = new Renderer({
      write: (b) => writes.push(b),
      width: 100,
      height: 32,
      defaultFg: darkTheme.fg,
    })
    const active = view({
      activity: { text: '思考中…', tail: 'wag', requestKey: 'a', startedAt: Date.now() },
    })
    r.update(createElement(App, { snapshot: active }))
    r.flushFrame()
    expect(writes.join('')).not.toContain('_G')
    r.configureActivity(() => ({ cellWidth: 17, cellHeight: 37 }))
    r.flushFrame()
    expect(writes.at(-1)).toMatch(/H$/u)
    r.update(createElement(App, { snapshot: { ...active, activity: { text: '' } } }))
    r.flushFrame()
    const count = writes.length
    await vi.advanceTimersByTimeAsync(2000)
    expect(writes.length).toBe(count)
    vi.stubEnv('NANO_REDUCED_MOTION', 'true')
    r.update(createElement(App, { snapshot: active }))
    r.flushFrame()
    const staticCount = writes.length
    await vi.advanceTimersByTimeAsync(2000)
    expect(writes.length).toBe(staticCount)
    r.unmount()
  })
  it('question supersedes model panel, occupies its own line above footer, and retains dock/hits', async () => {
    const d = new DecisionManager()
    const pending = d.simulateQuestion([{ id: 'q', question: 'pick', options: [{ label: 'A' }] }])
    await Promise.resolve()
    const r = new Renderer({ write: () => {}, width: 60, height: 32, defaultFg: darkTheme.fg })
    const s = view({
      width: 60,
      decisions: d,
      modelPanelRows: 5,
      activity: { text: '等待你的选择' },
      dockRows: 2,
      dockBody: createElement('text', {}, 'SUBAGENT'),
    })
    r.update(createElement(App, { snapshot: s }))
    r.flushFrame()
    const lines = r.snapshotLines()
    expect(lines.filter((l) => l.includes('等待你的选择'))).toHaveLength(1)
    expect(lines.join('')).not.toContain('› draft')
    expect(lines.findIndex((l) => l.includes('SUBAGENT'))).toBeGreaterThan(
      lines.findIndex((l) => l.includes('Enter ')),
    )
    expect(r.hitRegions.some((h) => h.id === 'decision:option:0')).toBe(true)
    expect(transcriptBodyHeight(s)).toBe(transcriptBodyHeight({ ...s, modelPanelRows: 0 }))
    d.cancelQuestions()
    await expect(pending).rejects.toMatchObject({ code: 'ASK_ABORTED' })
    r.unmount()
  })
})

describe('controller event wiring', () => {
  it('filters old end, keeps the committed answer hidden, and samples retries by official identity', () => {
    const c = new ConversationController({
      ctx: {},
      official: {} as never,
      rootId: 'r',
      cwd: '/tmp',
      history: {} as never,
    })
    const x = c as unknown as {
      handleStreamFrame: (f: unknown) => void
      handleSessionEvent: (f: unknown) => void
    }
    x.handleSessionEvent({ seq: 1, type: 'turn/start', data: { turn: 1 } })
    x.handleStreamFrame({ type: 'start', attemptId: 'a', revision: 1, turn: 1 })
    x.handleStreamFrame({
      type: 'chunk',
      attemptId: 'a',
      revision: 2,
      chunk: { type: 'text-delta', text: 'answer' },
    })
    x.handleSessionEvent({
      seq: 2,
      type: 'assistant/message',
      data: { turn: 1, message: { content: [{ type: 'text', text: 'answer' }] } },
    })
    x.handleStreamFrame({ type: 'end', attemptId: 'a', revision: 3 })
    expect(c.activity.project().text).toBe('')
    x.handleStreamFrame({ type: 'start', attemptId: 'b', revision: 4, turn: 1 })
    x.handleStreamFrame({ type: 'end', attemptId: 'a', revision: 5 })
    expect(c.model.preview?.attemptId).toBe('b')
    x.handleSessionEvent({ seq: 3, type: 'turn/end', data: { turn: 1 } })
    expect(c.activity.project()).toEqual({ text: '' })
    x.handleStreamFrame({ type: 'start', attemptId: 'a', revision: 1, turn: 1 })
    expect(c.activity.project()).toEqual({ text: '' })
  })
})
