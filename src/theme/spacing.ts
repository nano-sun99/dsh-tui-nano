/**
 * Spacing tokens (ADR-20261026-spacing-token-architecture). Renderers must
 * reference these instead of raw blank lines or bare indents.
 */

/** Horizontal tokens, in terminal cells. */
export const EDGE = 2
export const INDENT = 2
export const NESTED = 4
export const INLINE = 1
export const CHROME_GAP = 1

/** Vertical gap roles between transcript units. */
export const GapRole = {
  None: 0,
  Section: 1,
  Block: 1,
} as const

export type GapRoleName = keyof typeof GapRole

/** Adjacent gap roles take the max, never the sum. */
export function gapBetween(a: GapRoleName, b: GapRoleName): number {
  return Math.max(GapRole[a], GapRole[b])
}
