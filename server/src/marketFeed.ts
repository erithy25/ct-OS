/**
 * Phase 2 — real market-data feed.
 *
 * Polls Kraken's public Ticker API (keyless, no CORS server-side) for the
 * MARKET_BASKET universe and overlays genuine crypto quotes onto the
 * authoritative world via the supplied `inject` callback (EngineHost.injectMarket).
 *
 * Defensive by construction: a network error, a rate-limit (HTTP 429), a
 * non-empty Kraken `error`, a JSON parse failure, a missing result key, or a
 * non-finite number makes the whole cycle a no-op — never a throw. The sim
 * keeps running and instruments stay simulated until the next successful poll.
 *
 * Uses Node 22's global `fetch` (no dependency) with an ~8s AbortController
 * timeout. The Kraken result-key mapping comes from src/sim/markets.ts and is
 * verified against the live public Ticker API.
 */
import { KRAKEN_PAIRS, MARKET_BASKET } from '../../src/sim/markets'
import type { MarketQuote } from '../../src/realtime/protocol'

const KRAKEN_TICKER_URL = 'https://api.kraken.com/0/public/Ticker'
const DEFAULT_POLL_MS = 5000
const FETCH_TIMEOUT_MS = 8000

export interface MarketFeedHandle {
  stop(): void
}

/** the Kraken ticker fields we read (all raw strings / string-arrays on the wire) */
interface KrakenTicker {
  a?: unknown
  b?: unknown
  c?: unknown
  v?: unknown
  l?: unknown
  h?: unknown
  o?: unknown
}

/** parse a Kraken numeric string (or number); anything else → NaN (guarded) */
const num = (v: unknown): number => {
  if (typeof v === 'number') return v
  if (typeof v === 'string') return Number(v)
  return NaN
}

/**
 * Start the market feed. Fetches Kraken immediately, then every `pollMs`
 * (default 5000). Each cycle parses `result[krakenKey]` per MARKET_BASKET into
 * MarketQuote[] and calls `inject(quotes)`. Returns a handle whose `stop()`
 * clears the interval and aborts any in-flight fetch.
 */
export function startMarketFeed(
  inject: (quotes: MarketQuote[]) => void,
  opts: { pollMs?: number } = {},
): MarketFeedHandle {
  const pollMs = typeof opts.pollMs === 'number' && opts.pollMs > 0 ? opts.pollMs : DEFAULT_POLL_MS
  const url = `${KRAKEN_TICKER_URL}?pair=${encodeURIComponent(KRAKEN_PAIRS)}`

  let stopped = false
  let announced = false
  let inFlight: AbortController | null = null

  /** map the Kraken `result` object to MarketQuote[], skipping anything unusable */
  const parse = (result: Record<string, KrakenTicker>): MarketQuote[] => {
    const quotes: MarketQuote[] = []
    for (const entry of MARKET_BASKET) {
      const t = result[entry.krakenKey]
      if (!t || typeof t !== 'object') continue
      const c = t.c
      const h = t.h
      const l = t.l
      const v = t.v
      const b = t.b
      const a = t.a
      if (!Array.isArray(c) || !Array.isArray(h) || !Array.isArray(l) || !Array.isArray(v) || !Array.isArray(b) || !Array.isArray(a)) {
        continue
      }
      const price = num(c[0]) // last trade
      const open = num(t.o) // 24h open
      const high = num(h[1]) // 24h high
      const low = num(l[1]) // 24h low
      const volume = num(v[1]) // 24h base volume
      const bid = num(b[0])
      const ask = num(a[0])
      if (
        !Number.isFinite(price) ||
        !Number.isFinite(open) ||
        open === 0 ||
        !Number.isFinite(high) ||
        !Number.isFinite(low) ||
        !Number.isFinite(volume) ||
        !Number.isFinite(bid) ||
        !Number.isFinite(ask)
      ) {
        continue
      }
      const changePct = ((price - open) / open) * 100
      if (!Number.isFinite(changePct)) continue
      quotes.push({ symbol: entry.symbol, price, changePct, high, low, volume, bid, ask })
    }
    return quotes
  }

  /** one poll cycle — fully guarded; a bad cycle is a silent-ish no-op */
  const poll = async (): Promise<void> => {
    if (stopped) return
    const ctrl = new AbortController()
    inFlight = ctrl
    const timeout = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
    try {
      const res = await fetch(url, { signal: ctrl.signal, headers: { accept: 'application/json' } })
      if (!res.ok) {
        // 429 rate-limit or any non-2xx — skip this cycle, keep running
        console.warn(`[server] market feed: Kraken HTTP ${res.status} — skipping cycle`)
        return
      }
      const json = (await res.json()) as { error?: unknown; result?: Record<string, KrakenTicker> }
      if (Array.isArray(json.error) && json.error.length > 0) {
        console.warn(`[server] market feed: Kraken error [${json.error.join('; ')}] — skipping cycle`)
        return
      }
      if (!json.result || typeof json.result !== 'object') {
        console.warn('[server] market feed: Kraken response missing result — skipping cycle')
        return
      }
      const quotes = parse(json.result)
      if (quotes.length === 0) {
        console.warn('[server] market feed: no usable quotes this cycle — instruments stay simulated')
        return
      }
      if (!announced) {
        announced = true
        console.log(`[server] market feed live · ${quotes.length} instruments · Kraken`)
      }
      inject(quotes)
    } catch (err) {
      // network error / abort / JSON parse — never let it escape. stop()-driven
      // aborts are expected and stay quiet.
      if (!stopped) {
        const msg = err instanceof Error ? err.message : String(err)
        console.warn(`[server] market feed: poll failed (${msg}) — skipping cycle`)
      }
    } finally {
      clearTimeout(timeout)
      if (inFlight === ctrl) inFlight = null
    }
  }

  // first fetch immediately, then on the interval
  void poll()
  const interval = setInterval(() => void poll(), pollMs)

  return {
    stop(): void {
      stopped = true
      clearInterval(interval)
      if (inFlight) {
        try {
          inFlight.abort()
        } catch {
          /* ignore */
        }
        inFlight = null
      }
    },
  }
}
