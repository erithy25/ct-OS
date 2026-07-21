/**
 * MARKET OPS — shared formatting, color, and sort helpers.
 *
 * Concrete accent hexes mirror src/theme/tokens.css so canvas sparklines (which
 * can't resolve CSS vars) and inline styles stay on-palette.
 */
import type { Instrument } from '../../sim/types'

export const M_GREEN = '#34D399'
export const M_RED = '#FF3B47'
export const M_CYAN = '#22D3EE'
export const M_AMBER = '#F5A623'
export const M_VIOLET = '#8B5CF6'

/** up/down stroke color (hex — for canvas) */
export const chgHex = (c: number): string => (c >= 0 ? M_GREEN : M_RED)
/** up/down text color (css var — for DOM inline style) */
export const chgVar = (c: number): string => (c >= 0 ? 'var(--accent-green)' : 'var(--accent-red)')
export const chgArrow = (c: number): string => (c >= 0 ? '▲' : '▼')

/** stress→color threshold: green <45, amber <70, red ≥70 */
export const stressVar = (s: number): string =>
  s >= 70 ? 'var(--accent-red)' : s >= 45 ? 'var(--accent-amber)' : 'var(--accent-green)'

/** decimals: 2dp ≥100, 3dp ≥1, 5dp <1 (mirrors markets.ts roundPrice) */
export const priceDecimals = (p: number): number => (p >= 100 ? 2 : p >= 1 ? 3 : 5)

export function fmtPrice(p: number): string {
  const d = priceDecimals(p)
  return p.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })
}

export function fmtChg(c: number): string {
  return `${c >= 0 ? '+' : ''}${c.toFixed(2)}%`
}

/** abbreviated 24h base volume: 12.3B / 1.2M / 850K · — when absent (sim has none) */
export function fmtVol(v: number): string {
  if (!(v > 0)) return '—'
  if (v >= 1e9) return `${(v / 1e9).toFixed(v >= 1e11 ? 0 : 1)}B`
  if (v >= 1e6) return `${(v / 1e6).toFixed(v >= 1e8 ? 0 : 1)}M`
  if (v >= 1e3) return `${(v / 1e3).toFixed(0)}K`
  return v.toFixed(0)
}

export type SortKey = 'sym' | 'last' | 'chg' | 'vol'
export type SortDir = 1 | -1

/** returns a NEW sorted array; `chg` sorts by move magnitude (biggest movers). */
export function sortInstruments(list: Instrument[], key: SortKey, dir: SortDir): Instrument[] {
  return [...list].sort((a, b) => {
    let c: number
    if (key === 'sym') c = a.symbol.localeCompare(b.symbol)
    else if (key === 'last') c = a.price - b.price
    else if (key === 'chg') c = Math.abs(a.changePct) - Math.abs(b.changePct)
    else c = a.volume - b.volume
    return c * dir || a.symbol.localeCompare(b.symbol)
  })
}

/** the instrument with the largest absolute % move (default detail focus). */
export function biggestMover(list: Instrument[]): Instrument | undefined {
  if (list.length === 0) return undefined
  return list.reduce((a, b) => (Math.abs(b.changePct) > Math.abs(a.changePct) ? b : a))
}
