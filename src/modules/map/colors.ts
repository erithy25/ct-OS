/**
 * TACTICAL MAP — canvas paint constants.
 *
 * Canvas 2D cannot resolve CSS custom properties, so these mirror
 * src/theme/tokens.css exactly (single source of truth for the DOM side).
 * Alpha ramps are precomputed string tables so the 60 fps draw loop never
 * builds a color string.
 */

export const COL = {
  void: '#05070a',
  panel: '#0a0e14',
  panel2: '#0d131c',
  line: '#1a2430',
  lineBright: '#26384a',
  prim: '#c9d6e4',
  dim: '#6b7c8f',
  faint: '#3a4756',
  accent: '#22d3ee',
  amber: '#f5a623',
  red: '#ff3b47',
  green: '#34d399',
  violet: '#8b5cf6',
  water: '#060a10',
} as const

export const FONT_8 = '8px "JetBrains Mono", ui-monospace, monospace'
export const FONT_9 = '9px "JetBrains Mono", ui-monospace, monospace'
export const FONT_10 = '600 10px "JetBrains Mono", ui-monospace, monospace'

function steps(r: number, g: number, b: number): string[] {
  const out: string[] = new Array(101)
  for (let i = 0; i <= 100; i++) out[i] = `rgba(${r},${g},${b},${(i / 100).toFixed(2)})`
  return out
}

/** alpha 0..1 → table index (clamped) */
export function aIdx(a: number): number {
  const i = (a * 100) | 0
  return i < 0 ? 0 : i > 100 ? 100 : i
}

export const A_ACCENT = steps(34, 211, 238)
export const A_AMBER = steps(245, 166, 35)
export const A_RED = steps(255, 59, 71)
export const A_GREEN = steps(52, 211, 153)
export const A_VIOLET = steps(139, 92, 246)
export const A_PRIM = steps(201, 214, 228)
export const A_DIM = steps(107, 124, 143)
