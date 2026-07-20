/**
 * PANOPTICON // OS — INFRASTRUCTURE CONTROL module.
 *
 * The "own the city" control board: POWER breakers, TRAFFIC signal states,
 * TRANSIT lines, BRIDGES, COMMS mesh and WATER telemetry, headed by the
 * SYSTEM INTEGRITY master readout. All switch state lives in the sim store
 * (single source of truth); live per-sector stats (congestion, cams,
 * incidents) are polled from the non-reactive world at ~1 Hz.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import Panel from '../../components/Panel'
import { uiClick } from '../../lib/audio'
import { sectorAt } from '../../sim/cityGen'
import { getWorld, useSim } from '../../sim/store'
import type { SectorId, TrafficMode, TransitMode } from '../../sim/types'
import { congestionColor, SegmentedControl, StateTag, TacticalSwitch, useValueFlash, type SegOption } from './controls'
import SectorCard from './SectorCard'
import SystemIntegrityBar from './SystemIntegrityBar'

/* ── module-scoped keyframes (namespaced `infra-`) ─────────────────── */

const MODULE_CSS = `
@keyframes infra-dot {
  from { left: 2%; }
  to { left: calc(100% - 9px); }
}
@keyframes infra-alarm-pulse {
  0%, 100% { background-color: rgba(255, 59, 71, 0.10); box-shadow: 0 0 8px rgba(255, 59, 71, 0.12); }
  50% { background-color: rgba(255, 59, 71, 0.30); box-shadow: 0 0 18px rgba(255, 59, 71, 0.45); }
}
.infra-alarm { animation: infra-alarm-pulse 1.1s ease-in-out infinite; }
`

/* ── live world stats (non-reactive → polled at ~1 Hz) ─────────────── */

interface LiveStats {
  /** per sector index 0..8 */
  congestion: number[]
  camsOnline: number[]
  camsTotal: number[]
  incidents: number[]
  /** city-wide avg congestion, 0..100 */
  avgCongestion: number
  trend: -1 | 0 | 1
}

const sIdx = (id: SectorId): number => {
  const n = Number(id.slice(7))
  return Number.isFinite(n) && n >= 1 && n <= 9 ? n - 1 : 0
}

function sampleStats(hist: number[]): LiveStats {
  const w = getWorld()
  const congestion = new Array<number>(9).fill(0)
  for (let i = 0; i < 9; i++) congestion[i] = w.congestion[`SECTOR-${i + 1}`] ?? 0
  const camsOnline = new Array<number>(9).fill(0)
  const camsTotal = new Array<number>(9).fill(0)
  for (const cam of w.cameras) {
    const i = sIdx(cam.sector)
    camsTotal[i]++
    if (cam.online) camsOnline[i]++
  }
  const incidents = new Array<number>(9).fill(0)
  for (const inc of w.incidents) {
    if (inc.phase !== 'RESOLVED') incidents[sIdx(inc.sector)]++
  }
  const avgCongestion = (congestion.reduce((a, b) => a + b, 0) / 9) * 100
  hist.push(avgCongestion)
  if (hist.length > 6) hist.shift()
  const delta = avgCongestion - hist[0]
  const trend: -1 | 0 | 1 = delta > 0.75 ? 1 : delta < -0.75 ? -1 : 0
  return { congestion, camsOnline, camsTotal, incidents, avgCongestion, trend }
}

function useLiveStats(): LiveStats {
  const hist = useRef<number[]>([])
  const [stats, setStats] = useState<LiveStats>(() => sampleStats(hist.current))
  useEffect(() => {
    const id = setInterval(() => setStats(sampleStats(hist.current)), 1000)
    return () => clearInterval(id)
  }, [])
  return stats
}

/* ── TRAFFIC ───────────────────────────────────────────────────────── */

const TRAFFIC_OPTS: readonly SegOption<TrafficMode>[] = [
  { value: 'NORMAL', label: 'NORMAL', activeCls: 'bg-accent/10 text-accent shadow-[inset_0_0_0_1px_rgba(34,211,238,0.45)]' },
  { value: 'FORCE_GREEN', label: 'GREEN', activeCls: 'bg-green/15 text-green shadow-[inset_0_0_0_1px_rgba(52,211,153,0.5)]' },
  { value: 'FORCE_RED', label: 'RED', activeCls: 'bg-red/15 text-red shadow-[inset_0_0_0_1px_rgba(255,59,71,0.5)]' },
  { value: 'BLACKOUT', label: 'DARK', activeCls: 'bg-amber/20 text-amber shadow-[inset_0_0_0_1px_rgba(245,166,35,0.6)]' },
]

function TrafficRow({
  id,
  name,
  mode,
  congestion,
  onMode,
}: {
  id: SectorId
  name: string
  mode: TrafficMode
  congestion: number
  onMode: (id: SectorId, mode: TrafficMode) => void
}) {
  const flashEl = useValueFlash(mode, (m) => (m === 'BLACKOUT' || m === 'FORCE_RED' ? 'amber' : 'cyan'))
  const pct = Math.round(congestion * 100)
  return (
    <div className="relative flex min-h-[52px] flex-1 flex-col justify-center gap-1 border-b border-line/60 px-2 py-1 last:border-b-0">
      {flashEl}
      <div className="flex items-center gap-1.5">
        <span className="num text-[10px] leading-3.5 text-prim/90">{id}</span>
        <span className="lbl-faint truncate text-[8px]">{name}</span>
        <span className="ml-auto" />
        {mode === 'BLACKOUT' && <StateTag text="SIGNALS DARK" tone="red" />}
        {mode === 'FORCE_RED' && <StateTag text="LOCKED RED" tone="amber" />}
        {mode === 'FORCE_GREEN' && <StateTag text="GREEN WAVE" tone="green" />}
      </div>
      <SegmentedControl value={mode} options={TRAFFIC_OPTS} onChange={(m) => onMode(id, m)} />
      <div className="flex items-center gap-1.5">
        <div className="h-[3px] min-w-0 flex-1 bg-panel2">
          <div
            className="h-full transition-[width] duration-500 ease-linear"
            style={{ width: `${pct}%`, background: congestionColor(pct) }}
          />
        </div>
        <span className="num w-7 shrink-0 text-right text-[8px] leading-3" style={{ color: congestionColor(pct) }}>
          {pct}%
        </span>
      </div>
    </div>
  )
}

/* ── TRANSIT ───────────────────────────────────────────────────────── */

const LINE_TONE: Record<string, string> = {
  'METRO-A': 'var(--accent)',
  'METRO-B': 'var(--accent-green)',
  'METRO-C': 'var(--accent-violet)',
}
const LINE_DUR: Record<string, number> = { 'METRO-A': 5.2, 'METRO-B': 6.4, 'METRO-C': 4.4 }
const STATIONS = [0, 25, 50, 75, 100]

function TransitRow({
  line,
  mode,
  onSet,
}: {
  line: string
  mode: TransitMode
  onSet: (line: string, mode: TransitMode) => void
}) {
  const flashEl = useValueFlash(mode, (m) => (m === 'HOLD' ? 'amber' : 'cyan'))
  const run = mode === 'RUN'
  const tone = run ? (LINE_TONE[line] ?? 'var(--accent)') : 'var(--accent-amber)'
  return (
    <div className="relative flex min-h-[40px] flex-1 items-center gap-2 border-b border-line/60 px-2 last:border-b-0">
      {flashEl}
      <span className="num w-[58px] shrink-0 text-[10px]" style={{ color: run ? 'var(--text-primary)' : 'var(--accent-amber)' }}>
        {line}
      </span>
      {/* line diagram: station dots + traveling car (freezes amber on HOLD) */}
      <div className="relative h-4 min-w-0 flex-1">
        <div className="absolute inset-x-0 top-1/2 h-px" style={{ background: run ? 'var(--line-bright)' : 'rgba(245,166,35,0.4)' }} />
        {STATIONS.map((p) => (
          <span
            key={p}
            className="absolute top-1/2 h-[5px] w-[5px] -translate-x-1/2 -translate-y-1/2 border"
            style={{
              left: `${2 + (p * 96) / 100}%`,
              borderColor: run ? 'var(--line-bright)' : 'rgba(245,166,35,0.55)',
              background: 'var(--bg-panel-2)',
            }}
          />
        ))}
        <span
          className="absolute top-1/2 h-[7px] w-[7px] -translate-y-1/2"
          style={{
            animation: `infra-dot ${LINE_DUR[line] ?? 5.6}s linear infinite alternate`,
            animationPlayState: run ? 'running' : 'paused',
            background: tone,
            boxShadow: `0 0 6px ${tone}`,
          }}
        />
      </div>
      <TacticalSwitch
        on={run}
        onLabel="RUN"
        offLabel="HOLD"
        onTone="green"
        offTone="amber"
        title={`${line} — ${run ? 'HOLD AT PLATFORM' : 'RESUME SERVICE'}`}
        onToggle={(next) => onSet(line, next ? 'RUN' : 'HOLD')}
      />
    </div>
  )
}

/* ── BRIDGES ───────────────────────────────────────────────────────── */

function BridgeGlyph({ raised, moving }: { raised: boolean; moving: boolean }) {
  const deckCol = moving || raised ? 'var(--accent-amber)' : 'var(--text-dim)'
  return (
    <div className="relative h-[22px] w-[52px] shrink-0" aria-hidden>
      {/* water */}
      <div className="absolute inset-x-1 bottom-[2px] border-b border-dashed border-accent/25" />
      {/* piers */}
      <div className="absolute bottom-[2px] left-[5px] h-[8px] w-[2px] bg-lineb" />
      <div className="absolute bottom-[2px] right-[5px] h-[8px] w-[2px] bg-lineb" />
      {/* deck halves — rotate up ~35° when raised */}
      <div
        className="absolute bottom-[9px] left-[6px] h-[3px] w-[19px] transition-transform duration-[600ms] ease-tac"
        style={{ transformOrigin: 'left center', transform: raised ? 'rotate(-35deg)' : 'rotate(0deg)', background: deckCol }}
      />
      <div
        className="absolute bottom-[9px] right-[6px] h-[3px] w-[19px] transition-transform duration-[600ms] ease-tac"
        style={{ transformOrigin: 'right center', transform: raised ? 'rotate(35deg)' : 'rotate(0deg)', background: deckCol }}
      />
      {/* hazard beacon while the span is in motion */}
      {moving && (
        <span
          className="blink absolute left-1/2 top-0 h-1.5 w-1.5 -translate-x-1/2 rounded-full"
          style={{ background: 'var(--accent-amber)', boxShadow: '0 0 6px var(--accent-amber)' }}
        />
      )}
    </div>
  )
}

function BridgeRow({
  id,
  sector,
  sectorName,
  raised,
  onSet,
}: {
  id: string
  sector: SectorId
  sectorName: string
  raised: boolean
  onSet: (id: string, raised: boolean) => void
}) {
  const flashEl = useValueFlash(raised, (r) => (r ? 'amber' : 'cyan'))
  /* 'moving' is animation-only local state: ~600 ms after any change (local or external) */
  const [moving, setMoving] = useState(false)
  const prev = useRef(raised)
  useEffect(() => {
    if (prev.current === raised) return
    prev.current = raised
    setMoving(true)
    const t = setTimeout(() => setMoving(false), 620)
    return () => clearTimeout(t)
  }, [raised])

  return (
    <div className="relative flex min-h-[40px] flex-1 items-center gap-2 border-b border-line/60 px-2 last:border-b-0">
      {flashEl}
      <BridgeGlyph raised={raised} moving={moving} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="num truncate text-[9px] leading-3.5 text-prim/90">{id}</span>
          {moving ? (
            <span className="lbl blink shrink-0 text-[7px] text-amber">⚠ MOVING</span>
          ) : (
            raised && <StateTag text="SPAN OPEN" tone="amber" />
          )}
        </div>
        <div className="lbl-faint truncate text-[7px]">
          {sector} · {sectorName} CROSSING
        </div>
      </div>
      <TacticalSwitch
        on={raised}
        onLabel="RAISE"
        offLabel="LOWER"
        onTone="amber"
        offTone="dim"
        title={`${id} — ${raised ? 'LOWER SPAN' : 'RAISE SPAN'}`}
        onToggle={(next) => onSet(id, next)}
      />
    </div>
  )
}

/* ── COMMS ─────────────────────────────────────────────────────────── */

function CommsCell({ id, up, onSet }: { id: SectorId; up: boolean; onSet: (id: SectorId, on: boolean) => void }) {
  const flashEl = useValueFlash(up, (v) => (v ? 'cyan' : 'amber'))
  return (
    <button
      type="button"
      title={`${id} COMMS — ${up ? 'SUPPRESS' : 'RESTORE'}`}
      onClick={() => {
        uiClick()
        onSet(id, !up)
      }}
      className={`relative flex min-h-[34px] flex-col items-center justify-center gap-0.5 border transition-all duration-150 ease-tac active:scale-[0.97] ${
        up
          ? 'border-accent/50 bg-accent/[0.07] shadow-[inset_0_0_10px_rgba(34,211,238,0.06)] hover:bg-accent/[0.14]'
          : 'border-red/60 bg-red/[0.06] hover:bg-red/[0.12]'
      }`}
    >
      {flashEl}
      <span className="num text-[10px] leading-3" style={{ color: up ? 'var(--accent)' : 'var(--text-dim)' }}>
        {id.replace('SECTOR-', 'S-')}
      </span>
      {up ? (
        <span className="lbl text-[7px] leading-[9px] text-accent/70">MESH UP</span>
      ) : (
        <StateTag text="SUPPRESSED" tone="red" />
      )}
    </button>
  )
}

/* ── WATER (passive telemetry — no switch affordance) ──────────────── */

function WaterCell({ id, reduced }: { id: SectorId; reduced: boolean }) {
  const flashEl = useValueFlash(reduced, (r) => (r ? 'amber' : 'cyan'))
  const col = reduced ? 'var(--accent-amber)' : 'var(--accent-green)'
  return (
    <div className="relative flex min-h-[26px] cursor-default items-center justify-between border border-line/60 bg-panel2/40 px-1.5">
      {flashEl}
      <span className="num text-[9px] text-dim">{id.replace('SECTOR-', 'S-')}</span>
      <span className="flex items-center gap-1">
        <span className="h-1 w-1 rounded-full" style={{ background: col }} aria-hidden />
        <span className="lbl text-[7px]" style={{ color: col }}>
          {reduced ? 'REDUCED' : 'NOMINAL'}
        </span>
      </span>
    </div>
  )
}

/* ── module root ───────────────────────────────────────────────────── */

export default function InfrastructureControl() {
  const infra = useSim((s) => s.infra)
  const setPower = useSim((s) => s.setPower)
  const setTraffic = useSim((s) => s.setTraffic)
  const setTransit = useSim((s) => s.setTransit)
  const setComms = useSim((s) => s.setComms)
  const setBridge = useSim((s) => s.setBridge)
  const stats = useLiveStats()

  /* static world geometry — computed once */
  const districts = useMemo(() => getWorld().city.districts.map((d) => ({ id: d.id, name: d.name })), [])
  const bridges = useMemo(() => {
    const city = getWorld().city
    return city.bridges.map((b) => {
      const sector = sectorAt(city.districts, b.pos)
      const district = city.districts.find((d) => d.id === sector)
      return { id: b.id, sector, sectorName: district?.name ?? 'UNCHARTED' }
    })
  }, [])
  const lines = Object.keys(infra.transit)

  const powered = districts.filter((d) => infra.power[d.id]).length
  const trafficNormal = districts.filter((d) => infra.traffic[d.id] === 'NORMAL').length
  const running = lines.filter((l) => infra.transit[l] === 'RUN').length
  const raisedCount = bridges.filter((b) => infra.bridgesRaised[b.id]).length
  const commsUp = districts.filter((d) => infra.comms[d.id]).length
  const waterReduced = districts.filter((d) => infra.water[d.id] === 'REDUCED' || !infra.power[d.id]).length

  return (
    <div className="flex h-full min-h-0 flex-col gap-1.5 overflow-hidden p-1.5">
      <style>{MODULE_CSS}</style>

      <SystemIntegrityBar avgCongestion={stats.avgCongestion} trend={stats.trend} />

      <div className="grid min-h-0 flex-1 grid-cols-12 gap-1.5">
        {/* POWER — tall left */}
        <Panel
          title="POWER GRID // SECTOR BREAKERS"
          live
          ledColor={powered < 9 ? 'var(--accent-red)' : 'var(--accent-green)'}
          right={
            <span className="num lbl-faint" style={powered < 9 ? { color: 'var(--accent-red)' } : undefined}>
              {powered}/9 ENERGIZED
            </span>
          }
          className="col-span-4 min-h-0"
          bodyClassName="flex min-h-0 flex-col overflow-y-auto"
        >
          {districts.map((d) => {
            const i = sIdx(d.id)
            return (
              <SectorCard
                key={d.id}
                id={d.id}
                name={d.name}
                on={infra.power[d.id]}
                congestion={stats.congestion[i]}
                camsOnline={stats.camsOnline[i]}
                camsTotal={stats.camsTotal[i]}
                incidents={stats.incidents[i]}
                onSet={setPower}
              />
            )
          })}
        </Panel>

        {/* TRAFFIC — tall middle */}
        <Panel
          title="TRAFFIC CONTROL // SIGNAL GRID"
          live
          ledColor={trafficNormal < 9 ? 'var(--accent-amber)' : 'var(--accent-green)'}
          right={<span className="num lbl-faint">AVG FLOW {Math.round(stats.avgCongestion)}%</span>}
          className="col-span-4 min-h-0"
          bodyClassName="flex min-h-0 flex-col overflow-y-auto"
        >
          {districts.map((d) => (
            <TrafficRow
              key={d.id}
              id={d.id}
              name={d.name}
              mode={infra.traffic[d.id]}
              congestion={stats.congestion[sIdx(d.id)]}
              onMode={setTraffic}
            />
          ))}
        </Panel>

        {/* right stack: TRANSIT / BRIDGES / COMMS */}
        <div className="col-span-4 flex min-h-0 flex-col gap-1.5">
          <Panel
            title="TRANSIT AUTHORITY"
            live
            ledColor={running < lines.length ? 'var(--accent-amber)' : 'var(--accent-green)'}
            right={<span className="num lbl-faint">{running}/{lines.length} RUNNING</span>}
            className="min-h-0 flex-[10]"
            bodyClassName="flex min-h-0 flex-col overflow-y-auto"
          >
            {lines.map((line) => (
              <TransitRow key={line} line={line} mode={infra.transit[line]} onSet={setTransit} />
            ))}
          </Panel>

          <Panel
            title="BRIDGE CONTROL"
            live
            ledColor={raisedCount > 0 ? 'var(--accent-amber)' : 'var(--accent)'}
            right={
              <span className="num lbl-faint" style={raisedCount > 0 ? { color: 'var(--accent-amber)' } : undefined}>
                {raisedCount} RAISED
              </span>
            }
            className="min-h-0 flex-[9]"
            bodyClassName="flex min-h-0 flex-col overflow-y-auto"
          >
            {bridges.map((b) => (
              <BridgeRow
                key={b.id}
                id={b.id}
                sector={b.sector}
                sectorName={b.sectorName}
                raised={infra.bridgesRaised[b.id]}
                onSet={setBridge}
              />
            ))}
          </Panel>

          <Panel
            title="COMMS MESH"
            live
            ledColor={commsUp < 9 ? 'var(--accent-red)' : 'var(--accent)'}
            right={
              <span className="num lbl-faint" style={commsUp < 9 ? { color: 'var(--accent-red)' } : undefined}>
                {commsUp}/9 UP
              </span>
            }
            className="min-h-0 flex-[11]"
            bodyClassName="grid grid-cols-3 gap-1 overflow-y-auto p-1"
          >
            {districts.map((d) => (
              <CommsCell key={d.id} id={d.id} up={infra.comms[d.id]} onSet={setComms} />
            ))}
          </Panel>
        </div>
      </div>

      {/* WATER / UTILITIES — passive telemetry strip */}
      <Panel
        title="WATER / UTILITIES // PASSIVE TELEMETRY"
        live
        ledColor={waterReduced > 0 ? 'var(--accent-amber)' : 'var(--accent-green)'}
        right={
          <span className="num lbl-faint" style={waterReduced > 0 ? { color: 'var(--accent-amber)' } : undefined}>
            {waterReduced} REDUCED
          </span>
        }
        className="shrink-0"
        bodyClassName="grid grid-cols-9 gap-1 p-1"
      >
        {districts.map((d) => (
          <WaterCell key={d.id} id={d.id} reduced={infra.water[d.id] === 'REDUCED' || !infra.power[d.id]} />
        ))}
      </Panel>

      <div className="flex h-[12px] shrink-0 items-center justify-center">
        <span className="lbl-faint text-[8px] tracking-[0.25em]">
          EVERY ACTION IS SIMULATED — NOVA HARBOR IS FICTION
        </span>
      </div>
    </div>
  )
}
