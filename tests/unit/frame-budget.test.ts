/**
 * 帧预算与文本快路径（spec 2026-11-10-stream-render-perf §5.2/§5.3）。
 *
 * 这一组盯三件事：ASCII 快路径与分字路径结果一致；立即绘制真的立即；
 * 动画帧不再走 layout/paint/diff；内容刷新按 33ms 合并且末帧必补。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NanoApp } from '../../src/app/nano-app.ts'
import { box, Renderer, text } from '../../src/render/renderer.ts'
import { displayWidth, graphemes } from '../../src/render/text.ts'
import { darkTheme } from '../../src/theme/theme.ts'

const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' })

/** 慢路径参考实现：逐段走 Intl.Segmenter。 */
function reference(text: string): string[] {
  return [...segmenter.segment(text)].map((entry) => entry.segment)
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('plain ASCII fast path', () => {
  it('splits exactly like the segmenter for printable ASCII and newlines', () => {
    const samples = [
      '',
      'hello world',
      'a\nb\n\nc',
      'const value = compute(1, "第 1 行")',
      '  trailing spaces   ',
      '~!@#$%^&*()_+-=[]{}|;:\'",.<>/?',
    ]
    for (const sample of samples) {
      expect(graphemes(sample)).toEqual(reference(sample))
      expect(displayWidth(sample)).toBe(
        reference(sample)
          .filter((g) => g !== '\n')
          .reduce((sum, g) => sum + displayWidth(g), 0),
      )
    }
  })

  it('falls back to the segmenter for anything else', () => {
    const samples = [
      '中文测试',
      'emoji 🧑‍🚀 宽字符',
      'e\u0301 combining',
      'tab\there',
      'control\u0007bell',
      'full-width ＡＢＣ',
    ]
    for (const sample of samples) {
      expect(graphemes(sample)).toEqual(reference(sample))
    }
    expect(displayWidth('中文测试')).toBe(8)
    // 制表符走慢路径，结果与逐 grapheme 累加一致（string-width 把 \t 记 0 格）。
    expect(displayWidth('a\tb')).toBe(
      reference('a\tb').reduce((sum, g) => sum + displayWidth(g), 0),
    )
  })

  it('keeps CJK width and ASCII width consistent under wrapping-sized inputs', () => {
    const ascii = 'x'.repeat(48 * 1024)
    expect(displayWidth(ascii)).toBe(48 * 1024)
    expect(graphemes(ascii)).toHaveLength(48 * 1024)
    expect(displayWidth(`${'中'.repeat(8)}\na`)).toBe(17)
  })
})

describe('renderer frame budget', () => {
  function createRenderer(width = 20, height = 4): { renderer: Renderer; writes: string[] } {
    const writes: string[] = []
    const renderer = new Renderer({
      write: (bytes) => writes.push(bytes),
      width,
      height,
      defaultFg: darkTheme.fg,
      activityIntervalMs: 33,
    })
    return { renderer, writes }
  }

  it('paints an immediate update synchronously', () => {
    const { renderer, writes } = createRenderer()
    renderer.mount(box({ height: 4 }, text('one')))
    renderer.flushFrame()
    writes.length = 0
    renderer.update(box({ height: 4 }, text('two')), { immediate: true })
    expect(writes.join('')).toContain('two')
    renderer.unmount()
  })

  it('repaints only the animated image on animation frames', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-10T00:00:00Z'))
    const { renderer, writes } = createRenderer()
    renderer.configureActivity(() => ({ cellWidth: 17, cellHeight: 37 }))
    renderer.mount(
      box(
        {
          width: 20,
          height: 4,
          activityImage: {
            text: '思考中…',
            tail: 'wag' as const,
            requestKey: 'r',
            startedAt: Date.now(),
            color: [255, 255, 255] as const,
          },
        },
        text('hello'),
      ),
    )
    renderer.flushFrame()
    expect(writes.join('')).toContain('hello')
    const painted = renderer.snapshotLines()
    writes.length = 0
    vi.advanceTimersByTime(200)
    const animated = writes.join('')
    // 只重发图片：写入里全是 Kitty APC 序列，没有整屏 diff 的文本。
    expect(animated).toContain('_G')
    expect(animated).not.toContain('hello')
    expect(renderer.snapshotLines()).toEqual(painted)
    renderer.unmount()
  })

  it('reuses the wrap result while text and width stay put', () => {
    const { renderer } = createRenderer(12, 4)
    renderer.mount(box({ width: 12, height: 4 }, text('alpha beta gamma')))
    renderer.flushFrame()
    const node = renderer.container.children[0] as unknown as {
      children: Array<{ width: number; wrapCache?: { width: number; lines: readonly string[] } }>
    }
    const child = node.children[0] as { width: number; wrapCache?: object }
    const first = child.wrapCache
    expect(first).toBeDefined()
    renderer.flushFrame()
    expect(child.wrapCache).toBe(first)
    renderer.unmount()
  })
})

describe('content render coalescing', () => {
  function makeApp(): { app: NanoApp; schedule: (immediate?: boolean) => void } {
    const renderer = {
      update: () => {},
      configureActivity: () => {},
    }
    const app = new NanoApp({
      core: { ctx: {} } as never,
      official: {} as never,
      terminal: { width: 80, height: 24 } as never,
      renderer: renderer as never,
      claim: { rootId: 'root', path: '/tmp/claim', recovered: false },
      dataRoot: '/tmp',
      cwd: '/tmp',
      rootId: 'root',
      conversation: {} as never,
      history: { entries: () => [], record: () => {} } as never,
      writeDiagnostic: () => {},
    })
    const schedule = (
      app as unknown as { scheduleRender: (immediate?: boolean) => void }
    ).scheduleRender.bind(app)
    return { app, schedule }
  }

  it('draws at most one frame per window and always draws the trailing one', () => {
    vi.useFakeTimers()
    const { app, schedule } = makeApp()
    const draw = vi.spyOn(app, 'render').mockImplementation(() => {})
    ;(app as unknown as { lastRenderAt: number }).lastRenderAt = performance.now()
    schedule()
    schedule()
    schedule()
    expect(draw).not.toHaveBeenCalled()
    vi.advanceTimersByTime(32)
    expect(draw).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(draw).toHaveBeenCalledTimes(1)
  })

  it('paints the immediate whitelist without waiting for the window', () => {
    vi.useFakeTimers()
    const { app, schedule } = makeApp()
    const draw = vi.spyOn(app, 'render').mockImplementation(() => {})
    ;(app as unknown as { lastRenderAt: number }).lastRenderAt = performance.now()
    schedule()
    schedule(true)
    expect(draw).toHaveBeenCalledTimes(1)
    // 立刻画掉之后，排队中的那一帧不该再重复画一次。
    vi.advanceTimersByTime(64)
    expect(draw).toHaveBeenCalledTimes(1)
  })

  it('does not schedule anything once the app is stopping', () => {
    vi.useFakeTimers()
    const { app, schedule } = makeApp()
    const draw = vi.spyOn(app, 'render').mockImplementation(() => {})
    ;(app as unknown as { stopping: boolean }).stopping = true
    schedule()
    schedule(true)
    vi.advanceTimersByTime(64)
    expect(draw).not.toHaveBeenCalled()
  })
})
