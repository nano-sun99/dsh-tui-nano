/** Public component surface for Nano screens (`<Box>`, `<Text>`, `<Overlay>`). */
import { createElement } from 'react'
import type { CellGrid } from './grid.ts'
import type { BoxProps, TextProps } from './host.ts'

export interface PressableBoxProps extends BoxProps {
  /** Identifier reported by the renderer when this box is clicked. */
  readonly onPress?: string
}

export interface PressableTextProps extends TextProps {
  readonly onPress?: string
}

export function Box(props: PressableBoxProps) {
  return createElement('box', props)
}

export function Text(props: PressableTextProps) {
  return createElement('text', props)
}

/** Full-screen layer painted after normal content (modals, question panels). */
export function Overlay(props: BoxProps) {
  return createElement('overlay', props)
}

export interface GridProps {
  readonly grid: CellGrid
  readonly width?: number
  readonly height?: number
}

/** Embedded terminal grid painted cell-by-cell (D01). */
export function Grid(props: GridProps) {
  return createElement('grid', props)
}
