/**
 * Nano's own colour language (ADR-20261022-independent-tui-theme).
 *
 * The terminal's default background is intentionally never painted; only local
 * surfaces (selection, diff, focus) carry an explicit RGB background.
 *
 * 色值唯一来源：`docs/specs/2026-10-22-nano-theme-transparency/README.md` §3.2
 * （与设计稿 preview/index.html 的 CSS 变量一致）。语义角色的别名映射：
 * user → accent、assistant/code/tool → fg、info → accent、faint → muted、
 * danger → error。不要在这里另起第二套色板。
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
}

const dark: Theme = {
  name: 'dark',
  fg: [232, 230, 224], // #e8e6e0
  muted: [141, 149, 166], // #8d95a6
  faint: [141, 149, 166],
  accent: [125, 161, 222], // #7da1de
  user: [125, 161, 222],
  assistant: [232, 230, 224],
  success: [154, 196, 166], // #9ac4a6
  warning: [216, 178, 112], // #d8b270
  danger: [218, 138, 147], // #da8a93
  info: [125, 161, 222],
  toolName: [232, 230, 224],
  code: [232, 230, 224],
  diffAdd: [161, 200, 170], // #a1c8aa
  diffDel: [226, 160, 170], // #e2a0aa
  diffAddBg: [36, 56, 44], // #24382c
  diffDelBg: [56, 37, 42], // #38252a
  selectionBg: [59, 74, 102], // #3b4a66
  focusBg: [36, 43, 53], // #242b35
}

const light: Theme = {
  name: 'light',
  fg: [52, 57, 69], // #343945
  muted: [98, 105, 120], // #626978
  faint: [98, 105, 120],
  accent: [54, 95, 157], // #365f9d
  user: [54, 95, 157],
  assistant: [52, 57, 69],
  success: [49, 95, 62], // #315f3e
  warning: [133, 91, 24], // #855b18
  danger: [163, 62, 76], // #a33e4c
  info: [54, 95, 157],
  toolName: [52, 57, 69],
  code: [52, 57, 69],
  diffAdd: [49, 95, 62], // #315f3e
  diffDel: [143, 53, 69], // #8f3545
  diffAddBg: [220, 235, 221], // #dcebdd
  diffDelBg: [241, 220, 223], // #f1dcdf
  selectionBg: [213, 222, 242], // #d5def2
  focusBg: [232, 232, 229], // #e8e8e5
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
