import { useMemo } from 'react'
import Panel from '../../components/Panel'
import type { Instrument } from '../../sim/types'
import { chgVar, fmtChg } from './marketUtil'

interface MoversProps {
  instruments: Instrument[]
  selected: string | null
  onSelect: (sym: string) => void
}

export default function MoversRail({ instruments, selected, onSelect }: MoversProps) {
  const { up, down, flat, gainers, losers } = useMemo(() => {
    let up = 0
    let down = 0
    let flat = 0
    for (const i of instruments) {
      if (i.changePct > 0.001) up++
      else if (i.changePct < -0.001) down++
      else flat++
    }
    const gainers = [...instruments].filter((i) => i.changePct > 0).sort((a, b) => b.changePct - a.changePct).slice(0, 4)
    const losers = [...instruments].filter((i) => i.changePct < 0).sort((a, b) => a.changePct - b.changePct).slice(0, 4)
    return { up, down, flat, gainers, losers }
  }, [instruments])

  const total = Math.max(1, instruments.length)
  const upPct = (up / total) * 100
  const downPct = (down / total) * 100

  return (
    <Panel title="MARKET BREADTH // MOVERS" live ledColor="var(--accent-green)" brackets className="shrink-0" bodyClassName="p-2">
      {/* breadth bar */}
      <div className="mb-1 flex items-baseline justify-between">
        <span className="lbl-faint">ADVANCERS / DECLINERS</span>
        <span className="num text-[10px]">
          <span className="text-green">{up}</span>
          <span className="text-faint"> · </span>
          <span className="text-red">{down}</span>
          {flat > 0 && <span className="text-faint"> · {flat}=</span>}
        </span>
      </div>
      <div className="flex h-[9px] overflow-hidden border border-line bg-panel2">
        <div className="bg-green/70 transition-[width] duration-200 ease-tac" style={{ width: `${upPct}%` }} />
        <div className="ml-auto bg-red/70 transition-[width] duration-200 ease-tac" style={{ width: `${downPct}%` }} />
      </div>

      {/* gainers / losers */}
      <div className="mt-2 grid grid-cols-2 gap-x-3">
        <MoverList title="TOP GAINERS" rows={gainers} selected={selected} onSelect={onSelect} />
        <MoverList title="TOP LOSERS" rows={losers} selected={selected} onSelect={onSelect} />
      </div>
    </Panel>
  )
}

function MoverList({
  title,
  rows,
  selected,
  onSelect,
}: {
  title: string
  rows: Instrument[]
  selected: string | null
  onSelect: (sym: string) => void
}) {
  return (
    <div className="min-w-0">
      <div className="lbl-faint mb-0.5">{title}</div>
      <div className="flex flex-col">
        {rows.map((i) => (
          <button
            key={i.symbol}
            type="button"
            onClick={() => onSelect(i.symbol)}
            className={`flex items-center justify-between gap-1 px-1 py-0.5 transition-colors duration-150 ease-tac ${
              i.symbol === selected ? 'bg-accent/10' : 'hover:bg-panel2'
            }`}
          >
            <span className="truncate text-[11px] font-medium text-prim">{i.symbol}</span>
            <span className="num shrink-0 text-[10px]" style={{ color: chgVar(i.changePct) }}>
              {fmtChg(i.changePct)}
            </span>
          </button>
        ))}
        {rows.length === 0 && <div className="lbl-faint px-1 py-0.5 opacity-60">—</div>}
      </div>
    </div>
  )
}
