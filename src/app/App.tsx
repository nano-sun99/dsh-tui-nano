/**
 * Screen composition: transcript viewport, status line, composer and the two
 * decision overlays. Pure function of an immutable snapshot; the orchestrator
 * re-renders this tree whenever state changes.
 */

import { Fragment, type ReactNode } from 'react'
import {
  APPROVAL_OPTIONS,
  type DecisionManager,
  type QuestionPrompt,
} from '../decisions/manager.ts'
import { Box, Overlay, Text } from '../render/components.ts'
import { displayWidth, graphemes, truncateText } from '../render/text.ts'
import { EDGE, INLINE } from '../theme/spacing.ts'
import type { Theme } from '../theme/theme.ts'
import { renderMarkdown } from '../transcript/markdown.ts'
import type { TranscriptModel } from '../transcript/model.ts'
import { type Row, type Span, type Tone, wrapSpans } from '../transcript/spans.ts'

export interface AppSnapshot {
  readonly transcript: TranscriptModel
  readonly decisions: DecisionManager
  readonly text: string
  readonly cursor: number
  readonly theme: Theme
  readonly width: number
  readonly height: number
  readonly rootId: string
  readonly modelLabel: string
  readonly status: 'idle' | 'running'
  readonly cwd?: string
  readonly expanded: ReadonlySet<string>
  readonly scrollOffset: number
  readonly stickBottom: boolean
  readonly notice?: { readonly text: string; readonly tone: 'info' | 'danger' }
  readonly caretActive?: boolean
  readonly userName: string
  /** 上下文占用 0..1；缺失时不画占比色。 */
  readonly contextRatio?: number
  /** 接线接缝（S02 spec §1）：S02 的正文区内容；没有 features 时为空。 */
  readonly featureBody?: ReactNode
  /** 补全弹层（正文与状态行之间）。 */
  readonly completionBody?: ReactNode
  readonly completionRows?: number
  readonly modelPanelBody?: ReactNode
  readonly modelPanelRows?: number
}

export function toneColor(tone: Tone, theme: Theme): [number, number, number] {
  switch (tone) {
    case 'muted':
      return [...theme.muted]
    case 'faint':
      return [...theme.faint]
    case 'user':
      return [...theme.user]
    case 'assistant':
      return [...theme.assistant]
    case 'success':
      return [...theme.success]
    case 'warning':
      return [...theme.warning]
    case 'danger':
      return [...theme.danger]
    case 'info':
      return [...theme.info]
    case 'accent':
      return [...theme.accent]
    case 'tool':
      return [...theme.toolName]
    case 'code':
      return [...theme.code]
    case 'diffAdd':
      return [...theme.diffAdd]
    case 'diffDel':
      return [...theme.diffDel]
    case 'rule':
      return [...theme.rule]
    default:
      return [...theme.fg]
  }
}

function RowView(props: { row: Row; theme: Theme; width: number }) {
  const { row, theme, width } = props
  const indent = row.indent ?? 0
  return (
    <Box flexDirection="row" width={width} {...(row.pressId ? { onPress: row.pressId } : {})}>
      {indent > 0 ? <Box width={indent} /> : null}
      {row.spans.map((span, index) => {
        const key = `${row.pressId ?? 'row'}-${index}`
        const textElement = (
          <Text
            color={toneColor(span.tone, theme)}
            {...(span.bold ? { bold: true } : {})}
            {...(span.italic ? { italic: true } : {})}
            {...(span.underline ? { underline: true } : {})}
            {...(span.strike ? { strikethrough: true } : {})}
            {...(span.reverse ? { reverse: true } : {})}
            wrap={false}
          >
            {span.text}
          </Text>
        )
        if (span.caret !== true) {
          return <Fragment key={key}>{textElement}</Fragment>
        }
        return (
          <Fragment key={key}>
            <Box width={0} height={1} cursor />
            {textElement}
          </Fragment>
        )
      })}
    </Box>
  )
}

function Transcript(props: { snapshot: AppSnapshot; bodyHeight: number; width: number }) {
  const { snapshot } = props
  const innerWidth = Math.max(1, props.width)
  const lines = snapshot.transcript.layout({ width: innerWidth, expanded: snapshot.expanded })
  const total = lines.length
  const height = Math.max(1, props.bodyHeight)
  const start = snapshot.stickBottom
    ? Math.max(0, total - height)
    : Math.max(0, Math.min(total - height, total - height - snapshot.scrollOffset))
  const visible = lines.slice(start, start + height)
  return (
    <Box flexDirection="column" flexGrow={1} overflow="hidden" width={innerWidth}>
      {visible.map((line) => (
        <RowView key={line.key} row={line.row} theme={snapshot.theme} width={innerWidth} />
      ))}
    </Box>
  )
}

function StatusLine(props: { snapshot: AppSnapshot; width: number }) {
  const { snapshot } = props
  const hint =
    snapshot.status === 'running'
      ? 'Enter 排队 · Ctrl+S 引导 · Ctrl+C 停止'
      : snapshot.text !== ''
        ? 'Enter 发送 · Shift+Enter 换行'
        : 'Enter 发送 · Ctrl+C 退出'
  const left = snapshot.notice ? snapshot.notice.text : displayCwd(snapshot.cwd)
  const leftColor = snapshot.notice
    ? snapshot.notice.tone === 'danger'
      ? snapshot.theme.danger
      : snapshot.theme.faint
    : snapshot.theme.muted
  const right = hint
  const available = Math.max(1, props.width - 2 * EDGE)
  const showRight = displayWidth(left) + displayWidth(right) + 1 <= available
  const leftBudget = showRight ? Math.max(1, available - displayWidth(right) - 1) : available
  return (
    <Box flexDirection="row" height={1} flexShrink={0} paddingX={EDGE} width={props.width}>
      <Text color={leftColor} wrap={false}>
        {truncateText(left, leftBudget)}
      </Text>
      <Box flexGrow={1} />
      {showRight ? (
        <Text color={snapshot.theme.faint} wrap={false}>
          {right}
        </Text>
      ) : null}
    </Box>
  )
}

function inputInnerWidth(width: number): number {
  return Math.max(1, width - EDGE * 2 - 2)
}

/** 输入区内容（提示符右侧）；InputLine 与高度计算共用。 */
function buildInputSpans(
  snapshot: AppSnapshot,
  withCaret = snapshot.caretActive !== false,
): Span[] {
  const disabled = snapshot.decisions.hasDecision
  const chars = graphemes(snapshot.text)
  const before = chars.slice(0, snapshot.cursor).join('')
  const after = chars.slice(snapshot.cursor).join('')
  const spans: Span[] = []
  if (disabled) {
    spans.push({ text: '等待你处理上面的确认…', tone: 'faint' })
  } else if (snapshot.text === '') {
    if (withCaret) spans.push({ text: ' ', tone: 'normal', reverse: true, caret: true })
    spans.push({ text: ' 输入消息…', tone: 'faint' })
  } else {
    spans.push({ text: before, tone: 'normal' })
    if (withCaret) spans.push({ text: ' ', tone: 'normal', reverse: true, caret: true })
    spans.push({ text: after, tone: 'normal' })
  }
  return spans
}

/** 输入区可见窗口：高度 1–4 行，以 caret 行为中心滚动（spec §3.2）。 */
function inputWindow(
  snapshot: AppSnapshot,
  width: number,
): { rows: Row[]; start: number; visible: number } {
  const innerWidth = inputInnerWidth(width)
  const measured = wrapSpans(buildInputSpans(snapshot, true), innerWidth)
  const rows = wrapSpans(buildInputSpans(snapshot), innerWidth)
  const visible = Math.min(4, Math.max(1, rows.length))
  const caretRow = measured.findIndex((row) => row.spans.some((span) => span.caret === true))
  const anchor = caretRow >= 0 ? Math.min(caretRow, rows.length - 1) : Math.max(0, rows.length - 1)
  const start =
    rows.length <= visible
      ? 0
      : Math.max(0, Math.min(anchor - Math.floor(visible / 2), rows.length - visible))
  return { rows, start, visible }
}

function inputLineCount(snapshot: AppSnapshot, width: number): number {
  return inputWindow(snapshot, width).visible
}

/** 正文区可见高度；滚动上限与渲染共用这一份算法，别各算各的。 */
export function transcriptBodyHeight(snapshot: AppSnapshot): number {
  const inputHeight = inputLineCount(snapshot, snapshot.width) + 2
  const completionRows = snapshot.completionRows ?? 0
  const modelRows = snapshot.modelPanelRows ?? 0
  const headerHeight = 3
  const bottomRows = modelRows > 0 ? modelRows : inputHeight + 1
  return Math.max(1, snapshot.height - bottomRows - completionRows - headerHeight)
}

/** 输入块上/下边框：左侧按上下文占比着色，右侧为普通边框色。 */
function ContextRule(props: { theme: Theme; width: number; ratio?: number }) {
  const bar = Math.max(1, props.width - EDGE * 2)
  const line = '─'
  const filled =
    props.ratio === undefined ? 0 : Math.max(0, Math.min(bar, Math.round(props.ratio * bar)))
  const tone: Tone =
    props.ratio === undefined
      ? 'rule'
      : props.ratio >= 0.95
        ? 'danger'
        : props.ratio >= 0.8
          ? 'warning'
          : 'accent'
  const spans: Span[] = [
    ...(filled > 0 ? [{ text: line.repeat(filled), tone }] : []),
    { text: line.repeat(bar - filled), tone: 'rule' },
  ]
  return (
    <Box flexDirection="row" paddingX={EDGE} width={props.width} height={1} flexShrink={0}>
      <RowView row={{ spans }} theme={props.theme} width={bar} />
    </Box>
  )
}

/** 顶部标题头（design-contract §1）：应用名 + 模型 + 回合状态。 */
function Header(props: { snapshot: AppSnapshot; width: number }) {
  const state = props.snapshot.status === 'running' ? '运行中' : '空闲'
  return (
    <Box flexDirection="row" height={1} flexShrink={0} paddingX={EDGE} width={props.width}>
      <Text color={props.snapshot.theme.fg} bold wrap={false}>
        nano
      </Text>
      <Text color={props.snapshot.theme.muted} wrap={false}>
        {'  '}
        {props.snapshot.modelLabel} · {state}
      </Text>
    </Box>
  )
}

function shortenHome(cwd: string | undefined): string {
  if (!cwd) return ''
  const home = process.env.HOME
  if (home && cwd.startsWith(home)) return `~${cwd.slice(home.length)}`
  return cwd
}

/** 底部状态行的目录：优先 ~，太长只留最后两段，保证右侧提示不被挤掉。 */
function displayCwd(cwd: string | undefined, max = 44): string {
  const short = shortenHome(cwd)
  if (displayWidth(short) <= max) return short
  const parts = short.split('/').filter(Boolean)
  return `…/${parts.slice(-2).join('/')}`
}

function InputLine(props: { snapshot: AppSnapshot; width: number }) {
  const { snapshot } = props
  const innerWidth = inputInnerWidth(props.width)
  const { rows, start, visible } = inputWindow(snapshot, props.width)
  return (
    <Box flexDirection="column" width={props.width}>
      <ContextRule theme={snapshot.theme} width={props.width} ratio={snapshot.contextRatio} />
      <Box flexDirection="column" paddingX={EDGE} width={props.width} height={visible}>
        <Box flexDirection="row">
          <Text color={snapshot.theme.accent} bold>
            {'› '}
          </Text>
          <Box flexDirection="column" width={innerWidth}>
            {rows.slice(start, start + visible).map((row, index) => (
              <RowView key={`input-${index}`} row={row} theme={snapshot.theme} width={innerWidth} />
            ))}
          </Box>
        </Box>
      </Box>
      <ContextRule theme={snapshot.theme} width={props.width} ratio={snapshot.contextRatio} />
    </Box>
  )
}

function DecisionOverlay(props: { snapshot: AppSnapshot; width: number; height: number }) {
  const { snapshot } = props
  const prompt = snapshot.decisions.prompt
  if (!prompt) return null
  if (prompt.kind === 'approval') {
    const panelWidth = Math.min(72, Math.max(30, props.width - 8))
    return (
      <Overlay>
        <Box
          flexDirection="column"
          justifyContent="center"
          alignItems="center"
          width={props.width}
          height={props.height}
        >
          <Box flexDirection="column" width={panelWidth} padding={2} clear>
            <Text color={snapshot.theme.warning} bold>
              {`需要确认：${prompt.toolName}`}
            </Text>
            <Text> </Text>
            {prompt.reason ? (
              <Text color={snapshot.theme.muted} wrap>
                {prompt.reason}
              </Text>
            ) : null}
            <Text> </Text>
            {APPROVAL_OPTIONS.map((option, index) => {
              const selected = index === prompt.selected
              return (
                <Box
                  key={option.outcome}
                  flexDirection="row"
                  onPress={`decision:approval:${index}`}
                  {...(selected ? { backgroundColor: snapshot.theme.focusBg } : {})}
                >
                  <Text color={selected ? snapshot.theme.accent : snapshot.theme.fg}>
                    {selected ? '▸ ' : '  '}
                    {`${index + 1}. ${option.label}`}
                  </Text>
                </Box>
              )
            })}
            <Text> </Text>
            <Text color={snapshot.theme.faint}>
              ↑/↓ 选择 · Enter 确认 · Esc 取消请求（默认拒绝）
            </Text>
          </Box>
        </Box>
      </Overlay>
    )
  }
  return (
    <QuestionOverlay
      prompt={prompt}
      snapshot={snapshot}
      width={props.width}
      height={props.height}
    />
  )
}

function QuestionOverlay(props: {
  prompt: QuestionPrompt
  snapshot: AppSnapshot
  width: number
  height: number
}) {
  const { prompt, snapshot } = props
  const question = prompt.questions[prompt.current]
  if (!question) return null
  const draft = prompt.drafts.get(question.id)
  const panelWidth = Math.min(84, Math.max(36, props.width - 8))
  const detailRows =
    question.detail && question.detail.trim() !== ''
      ? renderMarkdown(question.detail, panelWidth - 4).slice(0, 14)
      : []
  return (
    <Overlay>
      <Box
        flexDirection="column"
        justifyContent="center"
        alignItems="center"
        width={props.width}
        height={props.height}
      >
        <Box flexDirection="column" width={panelWidth} padding={2} clear>
          <Text color={snapshot.theme.info} bold>
            {question.header ?? (prompt.planReview ? '计划审阅' : '需要你的回答')}
            {prompt.questions.length > 1
              ? `  (${prompt.current + 1}/${prompt.questions.length})`
              : ''}
          </Text>
          <Text> </Text>
          <Text color={snapshot.theme.fg} wrap>
            {question.question}
          </Text>
          {detailRows.map((row, index) => (
            <RowView
              key={`detail-${index}`}
              row={row}
              theme={snapshot.theme}
              width={panelWidth - 4}
            />
          ))}
          <Text> </Text>
          {(question.options ?? []).map((option, index) => {
            const focused = index === prompt.focusedOption
            const selected = draft?.selected.has(option.label) ?? false
            const mark = question.multiSelect
              ? selected
                ? '[x] '
                : '[ ] '
              : selected
                ? '(•) '
                : '( ) '
            const approve =
              question.intent?.kind === 'plan-review' && question.intent.approve === option.label
            return (
              <Box
                key={option.label}
                flexDirection="row"
                onPress={`decision:option:${index}`}
                {...(focused ? { backgroundColor: snapshot.theme.focusBg } : {})}
              >
                <Text color={focused ? snapshot.theme.accent : snapshot.theme.fg}>
                  {focused ? '▸ ' : '  '}
                  {`${mark}${option.label}`}
                  {approve ? '  (批准)' : ''}
                </Text>
              </Box>
            )
          })}
          <Box
            flexDirection="row"
            onPress="decision:custom"
            {...(draft?.customMode ? { backgroundColor: snapshot.theme.focusBg } : {})}
          >
            <Text color={draft?.customMode ? snapshot.theme.accent : snapshot.theme.muted}>
              {`  ${draft?.customMode ? '✎' : '＋'} 其他：${draft?.custom ?? ''}${draft?.customMode ? '▏' : ''}`}
            </Text>
          </Box>
          <Text> </Text>
          <Text color={snapshot.theme.faint}>
            ↑/↓ 选择 · Space 勾选 · Enter 下一题/提交 · c 自定义 · Esc 跳过
          </Text>
        </Box>
      </Box>
    </Overlay>
  )
}

export function App(props: { snapshot: AppSnapshot }) {
  const { snapshot } = props
  const width = snapshot.width
  const height = snapshot.height
  // 跟 Claude Code 的输入区高度：上方一行留白 + 输入行 + 一条下边框。
  const bodyHeight = transcriptBodyHeight(snapshot)
  const modelRows = snapshot.modelPanelRows ?? 0
  return (
    <Box flexDirection="column" width={width} height={height}>
      <Box height={1} />
      <Header snapshot={snapshot} width={width} />
      <Box height={1} />
      <Box flexDirection="column" flexGrow={0} height={bodyHeight} width={width}>
        <Transcript snapshot={snapshot} bodyHeight={bodyHeight} width={width} />
        {snapshot.featureBody}
      </Box>
      {snapshot.completionBody}
      {modelRows > 0 ? (
        snapshot.modelPanelBody
      ) : (
        <>
          <InputLine snapshot={snapshot} width={width} />
          <StatusLine snapshot={snapshot} width={width} />
        </>
      )}
      <DecisionOverlay snapshot={snapshot} width={width} height={height} />
    </Box>
  )
}

export { INLINE, truncateText }
