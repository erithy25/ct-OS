import { useEffect, useMemo, useRef, useState } from 'react'
import Panel from '../../components/Panel'
import { useSim } from '../../sim/store'
import type { ThreatEntry } from '../../sim/types'

type SortKey = 'risk' | 'name' | 'sector'
type SortDir = 1 | -1

const riskColor = (v: number): string =>
  v >= 70 ? 'var(--accent-red)' : v >= 45 ? 'var(--accent-amber)' : 'var(--accent-green)'

const GRID = 'grid grid-cols-[34px_52px_minmax(0,1fr)_96px_46px_38px_26px] items-center gap-1 px-2'

/**
 * Ranked table of flagged fictional entities. Sortable by RISK / NAME / SECTOR;
 * clicking a row selects the entity and jumps to the PROFILER (graph view).
 */
export default function ThreatBoard({ className = '' }: { className?: string }) {
  const board = useSim((s) => s.threatBoard)
  const select = useSim((s) => s.select)
  const setView = useSim((s) => s.setView)

  const [sortKey, setSortKey] = useState<SortKey>('risk')
  const [sortDir, setSortDir] = useState<SortDir>(-1)

  // bump a pulse key whenever the board snapshot is replaced (drives bracket flash)
  const rev = useRef(0)
  const lastBoard = useRef<ThreatEntry[] | null>(null)
  if (lastBoard.current !== board) {
    lastBoard.current = board
    rev.current += 1
  }

  const rows = useMemo(() => {
    const ranked = [...board].sort((a, b) => b.risk - a.risk || a.id.localeCompare(b.id))
    const rankOf = new Map(ranked.map((e, i) => [e.id, i + 1]))
    const sorted = [...board].sort((a, b) => {
      let c: number
      if (sortKey === 'risk') c = a.risk - b.risk
      else if (sortKey === 'name') c = a.name.localeCompare(b.name)
      else c = a.sector.localeCompare(b.sector)
      return c * sortDir || a.id.localeCompare(b.id)
    })
    return sorted.map((e) => ({ e, rank: rankOf.get(e.id) ?? 0 }))
  }, [board, sortKey, sortDir])

  const onSort = (k: SortKey) => {
    if (sortKey === k) setSortDir((d) => (d === 1 ? -1 : 1))
    else {
      setSortKey(k)
      setSortDir(k === 'risk' ? -1 : 1)
    }
  }

  const openProfile = (id: string) => {
    select(id)
    setView('graph')
  }

  return (
    <Panel
      title="THREAT BOARD // FLAGGED ENTITIES"
      live
      ledColor="var(--accent-red)"
      brackets
      pulseKey={rev.current}
      className={`min-h-0 ${className}`}
      bodyClassName="flex min-h-0 flex-col"
      right={
        <span className="flex shrink-0 items-center gap-1.5">
          <span className="num lbl-faint">{board.length} TRACKED CASES</span>
          <span className="lbl border border-violet/60 px-1 py-px text-violet">SOURCE: SIMULATED</span>
        </span>
      }
    >
      {/* column header */}
      <div className={`${GRID} h-[18px] shrink-0 border-b border-line bg-panel2/60`}>
        <span className="lbl-faint">RANK</span>
        <span className="lbl-faint">ID</span>
        <SortTh label="NAME" k="name" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
        <SortTh label="RISK" k="risk" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
        <SortTh label="SECTOR" k="sector" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
        <span className="lbl-faint text-right">FLAGS</span>
        <span className="lbl-faint text-center">TRK</span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {rows.map(({ e, rank }) => (
          <ThreatRow key={e.id} e={e} rank={rank} onClick={() => openProfile(e.id)} />
        ))}
        {rows.length === 0 && <div className="lbl-faint px-2 py-4 text-center">RANKING ENGINE WARMING UP</div>}
      </div>
    </Panel>
  )
}

function SortTh({
  label,
  k,
  sortKey,
  sortDir,
  onSort,
}: {
  label: string
  k: SortKey
  sortKey: SortKey
  sortDir: SortDir
  onSort: (k: SortKey) => void
}) {
  const active = sortKey === k
  return (
    <button
      type="button"
      onClick={() => onSort(k)}
      title={`SORT BY ${label}`}
      className={`lbl flex items-center gap-0.5 text-left transition-colors duration-150 ease-tac hover:text-prim ${
        active ? 'text-accent' : 'text-faint'
      }`}
    >
      {label}
      <span className="w-2 text-[8px]" aria-hidden>
        {active ? (sortDir === 1 ? '▲' : '▼') : ''}
      </span>
    </button>
  )
}

function ThreatRow({ e, rank, onClick }: { e: ThreatEntry; rank: number; onClick: () => void }) {
  const [flashing, setFlashing] = useState(false)
  const shown = Math.round(e.risk)
  const lastShown = useRef(shown)
  const lastFlash = useRef(0)

  // subtle cyan flash when the displayed risk value changes (throttled)
  useEffect(() => {
    if (shown === lastShown.current) return
    lastShown.current = shown
    const now = performance.now()
    if (now - lastFlash.current < 900) return
    lastFlash.current = now
    setFlashing(true)
    const t = setTimeout(() => setFlashing(false), 430)
    return () => clearTimeout(t)
  }, [shown])

  const c = riskColor(e.risk)
  return (
    <div
      className={`${GRID} h-6 cursor-pointer border-b border-line/50 transition-colors duration-150 ease-tac hover:bg-panel2 ${
        flashing ? 'flash-cyan' : ''
      }`}
      onClick={onClick}
      title={`OPEN PROFILE // ${e.id}`}
    >
      <span className="num text-[10px] text-faint">{String(rank).padStart(2, '0')}</span>
      <span className="num truncate text-[10px] text-dim">{e.id}</span>
      <span className="truncate text-[11px] text-prim/90">{e.name}</span>
      <span className="flex items-center gap-1.5">
        <span className="h-[5px] min-w-0 flex-1 border border-line/60 bg-panel2">
          <span
            className="block h-full transition-[width] duration-200 ease-tac"
            style={{ width: `${Math.max(0, Math.min(100, e.risk))}%`, background: c }}
          />
        </span>
        <span className="num w-6 shrink-0 text-right text-[11px]" style={{ color: c }}>
          {shown}
        </span>
      </span>
      <span className="num text-[10px] text-dim">{e.sector.replace('SECTOR-', 'S-')}</span>
      <span className={`num text-right text-[10px] ${e.flags > 2 ? 'text-amber' : 'text-dim'}`}>{e.flags}</span>
      <span className="flex items-center justify-center">
        {e.tracked ? (
          <span className="h-1.5 w-1.5 rounded-full bg-accent shadow-glow" title="TRACKED" />
        ) : (
          <span className="text-[10px] text-faint" aria-hidden>
            ·
          </span>
        )}
      </span>
    </div>
  )
}
