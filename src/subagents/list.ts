/**
 * 全部子代理列表（spec 2026-10-30 §4.4）：官方 `listDescendants` 的
 * 递归后代 + 诊断行；N 只数本地直接子代理，行数可以大于 N。
 */
import { createElement, type ReactNode } from 'react'
import { Box, Text } from '../render/components.ts'
import { truncateText } from '../render/text.ts'
import { activeTheme, type Theme } from '../theme/theme.ts'
import { type DockStatus, statusLight, statusWord } from './dock.ts'

export interface ListEntry {
  readonly kind: 'child' | 'diagnostic'
  readonly id: string
  readonly mode?: string
  readonly label?: string
  readonly activity?: 'running' | 'inactive'
  readonly parentId?: string
  readonly depth?: number
  readonly reason?: string
}

export interface ListRow {
  readonly id: string
  readonly name: string
  readonly mode: string
  readonly modeLabel: string
  readonly status: DockStatus
  readonly depth: number
  readonly indent: number
  readonly parentId?: string
  readonly diagnostic?: string
  readonly enterable: boolean
}

const MODE_LABELS: Record<string, string> = {
  'one-shot': '一次性',
  external: '外部',
  unknown: '未知',
}

export function buildListRows(
  entries: readonly ListEntry[],
  statusOf: (id: string) => DockStatus,
  readableOf?: (id: string) => boolean | undefined,
): ListRow[] {
  return entries.map((entry) => {
    const depth = entry.depth ?? 1
    if (entry.kind === 'diagnostic') {
      return {
        id: entry.id,
        name: entry.label ?? entry.id,
        mode: 'unknown',
        modeLabel: '',
        status: 'idle',
        depth,
        indent: Math.max(0, depth - 1),
        ...(entry.parentId !== undefined ? { parentId: entry.parentId } : {}),
        diagnostic: entry.reason ?? 'unavailable',
        enterable: false,
      }
    }
    const known = statusOf(entry.id)
    const status = known !== 'idle' ? known : entry.activity === 'running' ? 'running' : known
    const mode = entry.mode ?? 'unknown'
    const readable = mode === 'one-shot' ? readableOf?.(entry.id) : undefined
    const unreadable = mode === 'one-shot' && readable === false
    return {
      id: entry.id,
      name: entry.label ?? entry.id,
      mode,
      modeLabel: unreadable ? '一次性 · 不可读' : (MODE_LABELS[mode] ?? ''),
      status,
      depth,
      indent: Math.max(0, depth - 1),
      ...(entry.parentId !== undefined ? { parentId: entry.parentId } : {}),
      enterable: mode !== 'external' && !unreadable,
    }
  })
}

/** N：本地直接子代理，不含 external、不含已出列。 */
export function countDirectChildren(
  entries: readonly ListEntry[],
  dismissed: ReadonlySet<string>,
): number {
  return entries.filter(
    (entry) =>
      entry.kind === 'child' &&
      (entry.depth ?? 1) === 1 &&
      entry.mode !== 'external' &&
      !dismissed.has(entry.id),
  ).length
}

export function listIds(rows: readonly ListRow[]): string[] {
  return rows.map((row) => row.id)
}

export function isEnterable(row: ListRow): boolean {
  return row.enterable && row.diagnostic === undefined
}

export interface SubagentListRenderOptions {
  readonly width: number
  readonly height: number
  readonly focusId?: string
  readonly scrollTop: number
  readonly rows: readonly ListRow[]
  readonly count: number
  readonly loading?: boolean
  readonly error?: string
  readonly theme?: Theme
}

/** 列表是记录视图：出列的子代理仍在这里。 */
export function renderSubagentList(options: SubagentListRenderOptions): ReactNode {
  const theme = options.theme ?? activeTheme()
  const width = options.width
  const height = Math.max(1, options.height)
  const header = createElement(
    Box,
    { flexDirection: 'row', width },
    createElement(
      Text,
      { color: [...theme.info] as [number, number, number], bold: true, wrap: false },
      truncateText(`全部子代理 · ${options.count}`, Math.max(1, width - 2)),
    ),
    createElement(Box, { flexGrow: 1 }),
    createElement(
      Box,
      { onPress: 'subagent:list-close' },
      createElement(
        Text,
        { color: [...theme.muted] as [number, number, number], wrap: false },
        '×',
      ),
    ),
  )
  const bodyHeight = Math.max(1, height - 1)
  let body: ReactNode[]
  if (options.error !== undefined) {
    body = [
      createElement(
        Text,
        { key: 'error', color: [...theme.danger] as [number, number, number], wrap: false },
        `读取失败：${options.error}`,
      ),
    ]
  } else if (options.loading === true) {
    body = [
      createElement(
        Text,
        { key: 'loading', color: [...theme.muted] as [number, number, number], wrap: false },
        '读取中…',
      ),
    ]
  } else if (options.rows.length === 0) {
    body = [
      createElement(
        Text,
        { key: 'empty', color: [...theme.muted] as [number, number, number], wrap: false },
        '没有子代理',
      ),
    ]
  } else {
    body = options.rows
      .slice(options.scrollTop, options.scrollTop + bodyHeight)
      .map((row) => renderListRow(row, width, theme, row.id === options.focusId))
  }
  return createElement(Box, { flexDirection: 'column', width, height }, header, ...body)
}

function renderListRow(row: ListRow, width: number, theme: Theme, focused: boolean): ReactNode {
  const indent = row.indent * 2
  const depthMark = row.depth > 1 ? '└ ' : ''
  const suffix = row.modeLabel === '' ? '' : ` · ${row.modeLabel}`
  const fixed =
    2 +
    indent +
    depthMark.length +
    2 +
    (row.diagnostic === undefined ? statusWord(row.status).length + 2 : 0)
  const budget = Math.max(1, width - fixed - suffix.length)
  const light = row.diagnostic === undefined ? statusLight(row.status) : '⚠'
  const status = row.diagnostic === undefined ? statusWord(row.status) : '诊断'
  return createElement(
    Box,
    {
      key: row.id,
      flexDirection: 'row',
      width,
      ...(focused ? { backgroundColor: [...theme.focusBg] as [number, number, number] } : {}),
      onPress: `subagent:list-row:${row.id}`,
    },
    createElement(
      Text,
      { color: focused ? [...theme.accent] : [...theme.faint], wrap: false },
      focused ? '› ' : '  ',
    ),
    indent > 0 ? createElement(Box, { width: indent }) : null,
    createElement(
      Text,
      {
        color: row.diagnostic !== undefined ? [...theme.danger] : lightTone(row.status, theme),
        wrap: false,
      },
      `${light} `,
    ),
    createElement(
      Text,
      { color: [...theme.fg] as [number, number, number], wrap: false },
      truncateText(`${depthMark}${row.name}${suffix}`, budget),
    ),
    createElement(Box, { flexGrow: 1 }),
    createElement(
      Text,
      {
        color:
          row.diagnostic !== undefined
            ? ([...theme.danger] as [number, number, number])
            : ([...theme.muted] as [number, number, number]),
        wrap: false,
      },
      ` ${status}`,
    ),
  )
}

function lightTone(status: DockStatus, theme: Theme): [number, number, number] {
  switch (status) {
    case 'running':
      return [...theme.accent] as [number, number, number]
    case 'done':
      return [...theme.success] as [number, number, number]
    case 'killed':
      return [...theme.warning] as [number, number, number]
    case 'error':
      return [...theme.danger] as [number, number, number]
    default:
      return [...theme.muted] as [number, number, number]
  }
}
