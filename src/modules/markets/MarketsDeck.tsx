import { useRef, useState } from 'react'
import CornerBrackets from '../../components/CornerBrackets'
import Gauge from '../../components/Gauge'
import { useSim } from '../../sim/store'
import MarketBoard from './MarketBoard'
import InstrumentDetail from './InstrumentDetail'
import MoversRail from './MoversRail'
import { biggestMover, stressVar } from './marketUtil'

/**
 * MARKET OPS // NOVA CAPITAL DESK — a dense, live spot-crypto trading board.
 *
 * Reads instruments (~2 Hz) / marketStress / marketSource from the sim store.
 * Selection is LOCAL (markets have no store entity selection); the default
 * focus is the biggest absolute mover. Sparklines redraw on a render-time `rev`
 * counter bumped whenever the instruments array identity changes.
 */
export default function MarketsDeck() {
  const instruments = useSim((s) => s.instruments)
  const marketStress = useSim((s) => s.marketStress)
  const marketSource = useSim((s) => s.marketSource)

  // bump a version whenever the store swaps the instruments array (house idiom)
  const rev = useRef(0)
  const lastInstruments = useRef(instruments)
  if (lastInstruments.current !== instruments) {
    lastInstruments.current = instruments
    rev.current += 1
  }

  const [selectedSym, setSelectedSym] = useState<string | null>(null)
  const mover = biggestMover(instruments)
  const selected = (selectedSym ? instruments.find((i) => i.symbol === selectedSym) : undefined) ?? mover
  const selSym = selected?.symbol ?? null

  const live = marketSource === 'live'
  const stressCol = stressVar(marketStress)
  const volatile = marketStress > 65

  return (
    <div className="flex h-full min-h-0 w-full flex-col gap-1.5 overflow-hidden p-1.5">
      {/* ── HEADER STRIP ─────────────────────────────────────────────── */}
      <header className="panel-surface relative flex shrink-0 items-stretch gap-3 px-3 py-2">
        <CornerBrackets />

        <div className="flex min-w-0 flex-col justify-center">
          <div className="font-grotesk text-[16px] font-semibold tracking-wide text-prim">
            MARKET OPS <span className="text-dim">// NOVA CAPITAL DESK</span>
          </div>
          <div className="mt-0.5 flex items-center gap-2">
            <span className="lbl border border-line px-1 py-px text-dim">CRYPTO · USD</span>
            <span className="lbl-faint">SPOT</span>
            <span className="lbl-faint">· {instruments.length} INSTRUMENTS</span>
          </div>
        </div>

        <div className="flex-1" />

        {volatile && (
          <span
            className={`led-pulse lbl flex items-center gap-1 self-center border px-1.5 py-0.5 ${
              marketStress >= 80 ? 'border-red/70 bg-red/10 text-red' : 'border-amber/70 bg-amber/10 text-amber'
            }`}
          >
            ▲ ELEVATED VOLATILITY
          </span>
        )}

        {/* market stress */}
        <div className="flex items-center gap-2 self-center border-l border-line pl-3">
          <div className="flex flex-col items-end">
            <span className="lbl-faint">MARKET STRESS</span>
            <span className="num text-[15px] font-medium leading-4" style={{ color: stressCol }}>
              {marketStress.toFixed(1)}%
            </span>
          </div>
          <Gauge value={marketStress} size={52} color={stressCol} label="STRS" />
        </div>

        {/* LIVE / SIM honesty badge */}
        <div className="flex items-center self-center border-l border-line pl-3">
          {live ? (
            <span className="lbl flex items-center gap-1.5 border border-green/60 bg-green/10 px-2 py-1 text-green">
              <span
                className="led-pulse h-1.5 w-1.5 rounded-full bg-green"
                style={{ boxShadow: '0 0 6px var(--accent-green)' }}
                aria-hidden
              />
              LIVE · REAL EXCHANGE
            </span>
          ) : (
            <span className="lbl flex items-center gap-1.5 border border-amber/60 bg-amber/10 px-2 py-1 text-amber">
              <span aria-hidden>◐</span>
              SIMULATED
            </span>
          )}
        </div>
      </header>

      {/* ── BODY: board (left) + detail / movers (right) ─────────────── */}
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,2.1fr)_minmax(0,1fr)] gap-1.5">
        <MarketBoard instruments={instruments} version={rev.current} selected={selSym} onSelect={setSelectedSym} />

        <div className="flex min-h-0 flex-col gap-1.5">
          <InstrumentDetail inst={selected} version={rev.current} />
          <MoversRail instruments={instruments} selected={selSym} onSelect={setSelectedSym} />
        </div>
      </div>

      {/* ── HONESTY FOOTER ───────────────────────────────────────────── */}
      <footer className="flex shrink-0 items-center gap-2 px-1">
        <span className={`lbl ${live ? 'text-green/70' : 'text-amber/70'}`}>{live ? '●' : '◐'}</span>
        <span className="lbl-faint truncate">
          {live
            ? 'LIVE DATA · KRAKEN PUBLIC FEED · DELAYED/INDICATIVE'
            : 'SIMULATED MARKET — DETERMINISTIC LOCAL MODEL (RUN THE SERVER FOR LIVE EXCHANGE DATA)'}
        </span>
      </footer>
    </div>
  )
}
