/**
 * Phase 2 — market-ops domain layer.
 *
 * A basket of instruments with a deterministic local simulator (worker / inline
 * mode) that the real exchange feed overlays on top of (remote mode). Pure and
 * browser-safe so the EngineHost (browser + node) and the server both use it.
 *
 * The Kraken result-key mapping is verified against the live public Ticker API.
 */
import { Rand } from './seed'
import type { Instrument } from './types'

export interface BasketEntry {
  symbol: string
  name: string
  /** realistic seed price for the local simulator */
  seed: number
  /** annualised volatility for the GBM simulator */
  vol: number
  /** Kraken request pair (public Ticker `pair=`) */
  krakenPair: string
  /** Kraken `result` object key for this pair */
  krakenKey: string
}

/** The tradable universe. Seed prices are realistic starting points; the live
 *  feed replaces them with real quotes when the server is connected. */
export const MARKET_BASKET: BasketEntry[] = [
  { symbol: 'BTC', name: 'BITCOIN', seed: 66400, vol: 0.55, krakenPair: 'XBTUSD', krakenKey: 'XXBTZUSD' },
  { symbol: 'ETH', name: 'ETHEREUM', seed: 1940, vol: 0.6, krakenPair: 'ETHUSD', krakenKey: 'XETHZUSD' },
  { symbol: 'SOL', name: 'SOLANA', seed: 150, vol: 0.85, krakenPair: 'SOLUSD', krakenKey: 'SOLUSD' },
  { symbol: 'XRP', name: 'RIPPLE', seed: 0.52, vol: 0.7, krakenPair: 'XRPUSD', krakenKey: 'XXRPZUSD' },
  { symbol: 'ADA', name: 'CARDANO', seed: 0.36, vol: 0.75, krakenPair: 'ADAUSD', krakenKey: 'ADAUSD' },
  { symbol: 'DOT', name: 'POLKADOT', seed: 4.2, vol: 0.78, krakenPair: 'DOTUSD', krakenKey: 'DOTUSD' },
  { symbol: 'LINK', name: 'CHAINLINK', seed: 11.2, vol: 0.8, krakenPair: 'LINKUSD', krakenKey: 'LINKUSD' },
  { symbol: 'AVAX', name: 'AVALANCHE', seed: 20.5, vol: 0.86, krakenPair: 'AVAXUSD', krakenKey: 'AVAXUSD' },
  { symbol: 'LTC', name: 'LITECOIN', seed: 65, vol: 0.62, krakenPair: 'LTCUSD', krakenKey: 'XLTCZUSD' },
  { symbol: 'DOGE', name: 'DOGECOIN', seed: 0.1, vol: 0.95, krakenPair: 'DOGEUSD', krakenKey: 'XDGUSD' },
  { symbol: 'ATOM', name: 'COSMOS', seed: 4.1, vol: 0.82, krakenPair: 'ATOMUSD', krakenKey: 'ATOMUSD' },
  { symbol: 'UNI', name: 'UNISWAP', seed: 7.3, vol: 0.83, krakenPair: 'UNIUSD', krakenKey: 'UNIUSD' },
]

export const KRAKEN_PAIRS = MARKET_BASKET.map((b) => b.krakenPair).join(',')
export const SPARK_LEN = 48

const decimals = (p: number): number => (p >= 100 ? 2 : p >= 1 ? 3 : 5)
export function roundPrice(p: number): number {
  const d = decimals(p)
  const f = Math.pow(10, d)
  return Math.round(p * f) / f
}

/** Build the initial (simulated) instrument set. */
export function createInstruments(seed: number, nowMs: number): Instrument[] {
  return MARKET_BASKET.map((b) => {
    const price = b.seed
    return {
      symbol: b.symbol,
      name: b.name,
      price,
      changePct: 0,
      high: price,
      low: price,
      volume: 0,
      bid: roundPrice(price * 0.9997),
      ask: roundPrice(price * 1.0003),
      source: 'sim' as const,
      updated: nowMs,
      spark: [price],
    }
  })
}

/** Per-instrument sim carry (session anchor + rolling volatility) kept by the host. */
export interface MarketSimState {
  open: Record<string, number>
  rand: Rand
}

export function createMarketSim(seed: number, instruments: Instrument[]): MarketSimState {
  const open: Record<string, number> = {}
  for (const i of instruments) open[i.symbol] = i.price
  return { open, rand: new Rand(`market:${seed}`) }
}

/**
 * Advance the simulated instruments one step (GBM). `dtSec` is sim-seconds
 * elapsed. Only affects instruments still sourced 'sim' — real ones are driven
 * by the feed. Returns the max absolute per-step move fraction (for events).
 */
export function stepMarketSim(state: MarketSimState, instruments: Instrument[], dtSec: number): number {
  let maxMove = 0
  const dt = dtSec / (365 * 24 * 3600) // annualised
  for (const inst of instruments) {
    if (inst.source !== 'sim') continue
    const entry = MARKET_BASKET.find((b) => b.symbol === inst.symbol)
    const vol = entry ? entry.vol : 0.7
    // standard-normal via Box–Muller on the seeded PRNG
    const u1 = Math.max(1e-9, state.rand.next())
    const u2 = state.rand.next()
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
    const drift = -0.5 * vol * vol * dt
    const shock = vol * Math.sqrt(dt) * z
    const factor = Math.exp(drift + shock)
    const next = roundPrice(inst.price * factor)
    const move = Math.abs(next / inst.price - 1)
    if (move > maxMove) maxMove = move
    inst.price = next
    inst.bid = roundPrice(next * 0.9997)
    inst.ask = roundPrice(next * 1.0003)
    if (next > inst.high) inst.high = next
    if (next < inst.low || inst.low === 0) inst.low = next
    const open = state.open[inst.symbol] || next
    inst.changePct = ((next - open) / open) * 100
    inst.updated = inst.updated // set by caller with wall time
  }
  return maxMove
}

/** Aggregate 0..100 market-stress index from dispersion + drawdown. */
export function marketStressOf(instruments: Instrument[]): number {
  if (instruments.length === 0) return 0
  let sumAbs = 0
  let worst = 0
  for (const i of instruments) {
    sumAbs += Math.abs(i.changePct)
    if (i.changePct < worst) worst = i.changePct
  }
  const meanAbs = sumAbs / instruments.length
  // ~6% mean abs move or a -12% worst name ⇒ ~100
  const stress = (meanAbs / 6) * 60 + (Math.abs(worst) / 12) * 40
  return Math.max(0, Math.min(100, stress))
}
