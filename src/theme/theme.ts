/**
 * Nano's own colour language (ADR-20261022-independent-tui-theme). The
 * terminal's default background is intentionally never painted; only local
 * surfaces (selection, diff, focus) carry an explicit RGB background.
 */

export type Rgb = readonly [number, number, number]

export interface Theme {
  readonly name: 'dark' | 'light'
  readonly fg: Rgb
  readonly muted: Rgb
  readonly faint: Rgb
  readonly accent: Rgb
  readonly user: Rgb
  readonly assistant: Rgb
  readonly success: Rgb
  readonly warning: Rgb
  readonly danger: Rgb
  readonly info: Rgb
  readonly toolName: Rgb
  readonly code: Rgb
  readonly diffAdd: Rgb
  readonly diffDel: Rgb
  readonly diffAddBg: Rgb
  readonly diffDelBg: Rgb
  readonly selectionBg: Rgb
  readonly focusBg: Rgb
  readonly overlayBg: Rgb
}

const dark: Theme = {
  name: 'dark',
  fg: [226, 232, 240],
  muted: [148, 163, 184],
  faint: [100, 116, 139],
  accent: [125, 211, 252],
  user: [147, 197, 253],
  assistant: [229, 231, 235],
  success: [134, 239, 172],
  warning: [253, 224, 71],
  danger: [252, 165, 165],
  info: [196, 181, 253],
  toolName: [253, 186, 116],
  code: [191, 219, 254],
  diffAdd: [187, 247, 208],
  diffDel: [254, 202, 202],
  diffAddBg: [20, 83, 45],
  diffDelBg: [127, 29, 29],
  selectionBg: [30, 58, 95],
  focusBg: [51, 65, 85],
  overlayBg: [30, 41, 59],
}

const light: Theme = {
  name: 'light',
  fg: [30, 41, 59],
  muted: [71, 85, 105],
  faint: [100, 116, 139],
  accent: [3, 105, 161],
  user: [29, 78, 216],
  assistant: [15, 23, 42],
  success: [22, 101, 52],
  warning: [161, 98, 7],
  danger: [185, 28, 28],
  info: [109, 40, 217],
  toolName: [154, 52, 18],
  code: [30, 64, 175],
  diffAdd: [22, 101, 52],
  diffDel: [185, 28, 28],
  diffAddBg: [220, 252, 231],
  diffDelBg: [254, 226, 226],
  selectionBg: [191, 219, 254],
  focusBg: [226, 232, 240],
  overlayBg: [241, 245, 249],
}

let cached: Theme | undefined

/** Resolve the active theme from `NANO_THEME` (dark default). */
export function activeTheme(env: NodeJS.ProcessEnv = process.env): Theme {
  if (cached) return cached
  cached = env.NANO_THEME === 'light' ? light : dark
  return cached
}

/** Test hook: force a theme regardless of the environment. */
export function setActiveTheme(theme: Theme | undefined): void {
  cached = theme
}

export { dark as darkTheme, light as lightTheme }

/**
 * Blend two RGB colours; `amount` is the weight of `b` (0..1). Used for
 * subdued surfaces without introducing a second palette.
 */
export function blend(a: Rgb, b: Rgb, amount: number): Rgb {
  const t = Math.max(0, Math.min(1, amount))
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ]
}
