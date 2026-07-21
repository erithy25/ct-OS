import { useEffect, useRef, useState, type ReactNode } from 'react'
import Panel from '../../components/Panel'
import Sparkline from '../../components/Sparkline'
import type { Instrument } from '../../sim/types'
import { chgArrow, chgHex, chgVar, fmtChg, fmtPrice, fmtVol } from './marketUtil'

interface DetailProps {
  inst: Instrument | undefined
  version: number
}

/** measures its own box so the area chart fills the panel responsively. */
function useMeasuredSize() {
  const ref = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    setSize({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [])
  return [ref, size] as const
}

export default function InstrumentDetail({ inst, version }: DetailProps) {
  const live = inst?.source === 'live'
  return (
    <Panel
      title="INSTRUMENT DETAIL"
      live={!!inst}
      brackets
      pulseKey={Math.floor(version / 6)}
      className="min-h-0 flex-1"
      bodyClassName="flex min-h-0 flex-col p-2"
      right={
        inst ? (
          <span
            className={`lbl shrink-0 border px-1 py-px ${
              live ? 'border-accent/60 bg-accent/10 text-accent' : 'border-violet/60 bg-violet/10 text-violet'
            }`}
          >
            {live ? 'SOURCE: LIVE EXCHANGE' : 'SOURCE: SIMULATED'}
          </span>
        ) : undefined
      }
    >
      {!inst ? (
        <div className="flex h-full min-h-[120px] flex-col items-center justify-center gap-2">
          <div className="lbl-faint">NO INSTRUMENT SELECTED</div>
          <div className="lbl-faint max-w-[180px] text-center opacity-60">SELECT A ROW ON THE MARKET BOARD</div>
        </div>
      ) : (
        <DetailBody inst={inst} version={version} live={live} />
      )}
    </Panel>
  )
}

function DetailBody({ inst, version, live }: { inst: Instrument; version: number; live: boolean }) {
  const [chartRef, { w: chartW, h: chartH }] = useMeasuredSize()

  const c = chgVar(inst.changePct)
  const range = Math.max(0, inst.high - inst.low)
  const pos = range > 1e-9 ? Math.max(0, Math.min(1, (inst.price - inst.low) / range)) : 0.5
  const mid = (inst.bid + inst.ask) / 2
  const spread = Math.max(0, inst.ask - inst.bid)
  const spreadBps = mid > 0 ? (spread / mid) * 1e4 : 0
  const vwap = (inst.high + inst.low + inst.price) / 3
  const rangePct = inst.price > 0 ? (range / inst.price) * 100 : 0

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      {/* identity + last */}
      <div className="flex shrink-0 items-end justify-between gap-2">
        <div className="min-w-0">
          <div className="font-grotesk text-[22px] font-semibold leading-6 tracking-wide text-prim">{inst.symbol}</div>
          <div className="lbl truncate text-dim">
            {inst.name} · <span className="text-faint">USD</span>
          </div>
        </div>
        <div className="shrink-0 text-right">
          <div className="num text-[22px] font-medium leading-6 text-prim">{fmtPrice(inst.price)}</div>
          <div className="num flex items-center justify-end gap-1 text-[13px]" style={{ color: c }}>
            <span aria-hidden>{chgArrow(inst.changePct)}</span>
            {fmtChg(inst.changePct)}
          </div>
        </div>
      </div>

      {/* area chart — fills available height (analytical centerpiece) */}
      <div className="panel-surface-2 relative min-h-[110px] flex-1">
        <span className="lbl-faint absolute left-1.5 top-1 z-10">PRICE · LAST 48 TICKS</span>
        <div ref={chartRef} className="absolute inset-0">
          <Sparkline
            data={() => inst.spark ?? []}
            version={version}
            width={Math.max(0, chartW)}
            height={Math.max(0, chartH)}
            color={chgHex(inst.changePct)}
            fill
          />
        </div>
      </div>

      {/* 24h range bar */}
      <div className="shrink-0">
        <div className="mb-1 flex items-baseline justify-between">
          <span className="lbl-faint">24H RANGE</span>
          <span className="num text-[10px] text-dim">
            {fmtPrice(range)} · {rangePct.toFixed(2)}%
          </span>
        </div>
        <div className="relative h-[9px] border border-line bg-panel2">
          <div className="absolute inset-y-0 left-0 bg-accent/20" style={{ width: `${pos * 100}%` }} />
          <div
            className="absolute top-[-2px] h-[13px] w-[2px] bg-accent shadow-glow"
            style={{ left: `calc(${pos * 100}% - 1px)` }}
            aria-hidden
          />
        </div>
        <div className="num mt-0.5 flex items-center justify-between text-[10px]">
          <span className="text-red/80">L {fmtPrice(inst.low)}</span>
          <span className="text-faint">{Math.round(pos * 100)}% OF RANGE</span>
          <span className="text-green/80">H {fmtPrice(inst.high)}</span>
        </div>
      </div>

      {/* microstructure */}
      <div className="grid shrink-0 grid-cols-2 gap-x-3 gap-y-1.5 border-t border-line pt-2">
        <Metric label="BID" value={fmtPrice(inst.bid)} color="var(--accent-green)" />
        <Metric label="ASK" value={fmtPrice(inst.ask)} color="var(--accent-red)" />
        <Metric label="MID" value={fmtPrice(mid)} />
        <Metric label="SPREAD" value={`${fmtPrice(spread)} · ${spreadBps.toFixed(1)}bp`} />
        <Metric label="VWAP≈ (H·L·C)/3" value={fmtPrice(vwap)} />
        <Metric label="24H VOLUME" value={live ? fmtVol(inst.volume) : '— (NO SIM VOL)'} />
      </div>

      <div className="lbl-faint shrink-0 border-t border-line pt-1.5">
        {live ? 'REAL EXCHANGE QUOTE · KRAKEN PUBLIC FEED' : 'DETERMINISTIC LOCAL MODEL · GBM SIMULATOR'}
      </div>
    </div>
  )
}

function Metric({ label, value, color }: { label: string; value: ReactNode; color?: string }) {
  return (
    <div className="min-w-0">
      <div className="lbl-faint truncate">{label}</div>
      <div className="num truncate text-[12px] leading-4 text-prim" style={color ? { color } : undefined}>
        {value}
      </div>
    </div>
  )
}
