import { useEffect, useMemo, useRef, useState } from 'react'
import Panel from '../../components/Panel'
import Sparkline from '../../components/Sparkline'
import type { Instrument } from '../../sim/types'
import {
  chgArrow,
  chgHex,
  chgVar,
  fmtChg,
  fmtPrice,
  fmtVol,
  sortInstruments,
  type SortDir,
  type SortKey,
} from './marketUtil'

/** shared 7-column template — SYM · LAST · CHG% · TREND · H/L · BID/ASK · VOL */
const GRID =
  'grid grid-cols-[minmax(70px,1.3fr)_minmax(72px,1.05fr)_minmax(60px,0.9fr)_80px_minmax(52px,0.8fr)_minmax(64px,1fr)_minmax(40px,0.55fr)] items-center gap-x-1.5 px-2'

interface BoardProps {
  instruments: Instrument[]
  version: number
  selected: string | null
  onSelect: (sym: string) => void
}

export default function MarketBoard({ instruments, version, selected, onSelect }: BoardProps) {
  const [sortKey, setSortKey] = useState<SortKey>('chg')
  const [sortDir, setSortDir] = useState<SortDir>(-1)

  const rows = useMemo(() => sortInstruments(instruments, sortKey, sortDir), [instruments, sortKey, sortDir])

  const onSort = (k: SortKey) => {
    if (k === sortKey) setSortDir((d) => (d === 1 ? -1 : 1))
    else {
      setSortKey(k)
      setSortDir(k === 'sym' ? 1 : -1)
    }
  }

  return (
    <Panel
      title="LIVE MARKET BOARD // SPOT"
      live
      brackets
      pulseKey={Math.floor(version / 6)}
      className="min-h-0"
      bodyClassName="flex min-h-0 flex-col"
      right={<span className="lbl-faint shrink-0">{instruments.length} PAIRS · USD</span>}
    >
      {/* column header */}
      <div className={`${GRID} h-[22px] shrink-0 border-b border-line bg-panel2/60`}>
        <HeadCell label="SYMBOL" k="sym" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
        <HeadCell label="LAST" k="last" sortKey={sortKey} sortDir={sortDir} onSort={onSort} align="right" />
        <HeadCell label="CHG %" k="chg" sortKey={sortKey} sortDir={sortDir} onSort={onSort} align="right" title="SORT BY MOVE SIZE" />
        <span className="lbl-faint text-center">TREND · 24H</span>
        <span className="lbl-faint text-right">HIGH / LOW</span>
        <span className="lbl-faint text-right">BID / ASK</span>
        <HeadCell label="VOL" k="vol" sortKey={sortKey} sortDir={sortDir} onSort={onSort} align="right" />
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {rows.map((inst) => (
          <MarketRow
            key={inst.symbol}
            inst={inst}
            version={version}
            active={inst.symbol === selected}
            onSelect={() => onSelect(inst.symbol)}
          />
        ))}
        {rows.length === 0 && (
          <div className="lbl-faint flex flex-1 items-center justify-center py-6">MARKET FEED SPOOLING…</div>
        )}
      </div>
    </Panel>
  )
}

function HeadCell({
  label,
  k,
  sortKey,
  sortDir,
  onSort,
  align = 'left',
  title,
}: {
  label: string
  k: SortKey
  sortKey: SortKey
  sortDir: SortDir
  onSort: (k: SortKey) => void
  align?: 'left' | 'right'
  title?: string
}) {
  const active = sortKey === k
  return (
    <button
      type="button"
      onClick={() => onSort(k)}
      title={title ?? `SORT BY ${label}`}
      className={`lbl flex items-center gap-0.5 transition-colors duration-150 ease-tac hover:text-prim ${
        align === 'right' ? 'justify-end' : 'justify-start'
      } ${active ? 'text-accent' : 'text-faint'}`}
    >
      {label}
      <span className="w-2 text-[8px]" aria-hidden>
        {active ? (sortDir === 1 ? '▲' : '▼') : ''}
      </span>
    </button>
  )
}

/** throttled data-update flash on the LAST cell (house idiom; ≤ ~1.4 Hz). */
function usePriceFlash(price: number): boolean {
  const [on, setOn] = useState(false)
  const last = useRef(price)
  const lastFlash = useRef(0)
  useEffect(() => {
    if (price === last.current) return
    last.current = price
    const now = performance.now()
    if (now - lastFlash.current < 700) return
    lastFlash.current = now
    setOn(true)
    const t = setTimeout(() => setOn(false), 420)
    return () => clearTimeout(t)
  }, [price])
  return on
}

function MarketRow({
  inst,
  version,
  active,
  onSelect,
}: {
  inst: Instrument
  version: number
  active: boolean
  onSelect: () => void
}) {
  const flash = usePriceFlash(inst.price)
  const c = chgVar(inst.changePct)

  return (
    <div
      onClick={onSelect}
      title={`FOCUS ${inst.symbol} · ${inst.name}`}
      className={`${GRID} min-h-[42px] flex-1 cursor-pointer border-b border-line/50 transition-colors duration-150 ease-tac ${
        active ? 'bg-accent/10 shadow-[inset_2px_0_0_var(--accent)]' : 'hover:bg-panel2'
      }`}
    >
      {/* SYMBOL + name */}
      <div className="min-w-0">
        <div className="flex items-center gap-1">
          {active && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent shadow-glow" aria-hidden />}
          <span className="truncate text-[13px] font-semibold tracking-wide text-prim">{inst.symbol}</span>
        </div>
        <div className="lbl-faint truncate leading-[12px]">{inst.name}</div>
      </div>

      {/* LAST */}
      <div className={`num rounded-sm px-0.5 text-right text-[14px] font-medium leading-4 text-prim ${flash ? 'flash-cyan' : ''}`}>
        {fmtPrice(inst.price)}
      </div>

      {/* CHG% */}
      <div className="num flex items-center justify-end gap-0.5 text-[12px]" style={{ color: c }}>
        <span className="text-[9px]" aria-hidden>
          {chgArrow(inst.changePct)}
        </span>
        {fmtChg(inst.changePct)}
      </div>

      {/* TREND sparkline */}
      <div className="flex justify-center">
        <Sparkline data={() => inst.spark ?? []} version={version} width={72} height={26} color={chgHex(inst.changePct)} fill />
      </div>

      {/* 24H HIGH / LOW */}
      <div className="num text-right text-[10px] leading-[13px]">
        <div className="text-green/75">{fmtPrice(inst.high)}</div>
        <div className="text-red/75">{fmtPrice(inst.low)}</div>
      </div>

      {/* BID / ASK */}
      <div className="num text-right text-[10px] leading-[13px] text-dim">
        <div>
          <span className="text-faint">B</span> {fmtPrice(inst.bid)}
        </div>
        <div>
          <span className="text-faint">A</span> {fmtPrice(inst.ask)}
        </div>
      </div>

      {/* VOLUME */}
      <div className="num text-right text-[11px] text-dim">{fmtVol(inst.volume)}</div>
    </div>
  )
}
