/**
 * PANOPTICON // HOMEWATCH — ACTIVITY.
 *
 * The center-stage "what has been happening" module: a dense, filterable
 * timeline of home events (newest-first, sectioned TODAY / EARLIER, windowed for
 * smoothness), a per-person presence summary and per-camera detection
 * sparklines, and an honest LEARNED-ROUTINES view — a 24-hour frequency
 * histogram of activity with a plain-language note. Everything derives from the
 * local event ring buffer via pure helpers in ../activity/rollup.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import Panel from '../../components/Panel'
import Sparkline from '../../components/Sparkline'
import { getHomeEvents, useHome, WEBCAM_ID } from '../store'
import type { HomeEvent, HomeEventKind, HomeSeverity } from '../types'
import { fmtLocal } from '../../lib/format'
import {
  bucketByHour,
  isActivityEvent,
  rollingPerMinute,
  rollupByPerson,
  startOfDay,
  summarizeRoutine,
} from '../activity/rollup'

/* ── palette ───────────────────────────────────────────────────────── */

const SEV_COLOR: Record<HomeSeverity, string> = {
  INFO: 'var(--text-dim)',
  NOTICE: 'var(--accent)',
  WARN: 'var(--accent-amber)',
  CRIT: 'var(--accent-red)',
}

const KIND_COLOR: Record<HomeEventKind, string> = {
  SYSTEM: 'var(--text-dim)',
  CAMERA: 'var(--accent-violet)',
  DETECTION: 'var(--accent)',
  PERSON: 'var(--accent-green)',
  ZONE: 'var(--accent-amber)',
  ACTIVITY: 'var(--accent)',
  ALERT: 'var(--accent-red)',
}

const ACCENT_HEX = '#22D3EE'
const SEVERITIES: HomeSeverity[] = ['INFO', 'NOTICE', 'WARN', 'CRIT']
/** kinds surfaced as filter chips — the security-relevant ones lead */
const FILTER_KINDS: HomeEventKind[] = ['PERSON', 'DETECTION', 'ZONE', 'ALERT', 'ACTIVITY', 'SYSTEM', 'CAMERA']

const ROW_H = 24
const OVERSCAN = 8
const TIMELINE_CAP = 300
const GRID = 'grid grid-cols-[62px_50px_72px_86px_minmax(0,1fr)] items-center gap-1.5 px-2'

/* ── module ────────────────────────────────────────────────────────── */

export default function Activity() {
  const eventsVersion = useHome((s) => s.eventsVersion)
  const people = useHome((s) => s.people)
  const serverCameras = useHome((s) => s.serverCameras)
  const webcamStatus = useHome((s) => s.webcamStatus)
  const select = useHome((s) => s.select)

  // one slow clock for the whole module: slides trailing windows + presence
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 5000)
    return () => clearInterval(id)
  }, [])

  const presence = useMemo(
    () => rollupByPerson(getHomeEvents(), people, now),
    [eventsVersion, people, now],
  )
  const hist = useMemo(() => bucketByHour(getHomeEvents()), [eventsVersion])
  const routine = useMemo(() => summarizeRoutine(hist), [hist])

  const cameras = useMemo(() => {
    const webcam = { id: 'CAM-01', name: 'OPERATOR CAM · THIS MAC', live: webcamStatus === 'live' }
    return [webcam, ...serverCameras.map((c) => ({ id: c.id, name: c.name, live: c.status === 'live' }))]
  }, [serverCameras, webcamStatus])

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-2">
      <NowStrip now={now} />

      <div className="flex min-h-0 flex-1 gap-2">
        <Timeline eventsVersion={eventsVersion} onSelect={select} className="min-h-0 flex-[1.5]" />

        <div className="flex min-h-0 w-[304px] shrink-0 flex-col gap-2">
          <Panel
            title="HOUSEHOLD PRESENCE · TODAY"
            className="min-h-0 flex-1"
            bodyClassName="overflow-y-auto"
            right={<span className="num lbl-faint">{presence.filter((p) => p.presentNow).length}/{presence.length} IN</span>}
          >
            <PresenceList presence={presence} people={people} onSelect={select} />
          </Panel>

          <Panel
            title="PER-CAMERA DETECTIONS · 30M"
            className="min-h-0 flex-1"
            bodyClassName="overflow-y-auto"
            right={<span className="num lbl-faint">{cameras.length} CAM</span>}
          >
            <CameraList cameras={cameras} eventsVersion={eventsVersion} now={now} onSelect={select} />
          </Panel>

          <Panel title="TYPICAL ACTIVITY" brackets className="shrink-0" bodyClassName="p-2">
            <RoutineChart hist={hist} note={routine.note} total={routine.total} now={now} />
          </Panel>
        </div>
      </div>
    </div>
  )
}

/* ── live NOW strip (smart brain) ──────────────────────────────────── */

/**
 * One-line "who is doing what right now" readout fed by the smart brain:
 * a chip per present household member (neutral activity + dwell) plus
 * compact per-camera occupancy counts. Quietly reads BRAIN STANDBY until
 * the engine publishes its first snapshot.
 */
function NowStrip({ now }: { now: number }) {
  const brain = useHome((s) => s.brain)
  const serverCameras = useHome((s) => s.serverCameras)

  if (!brain) {
    return (
      <div className="flex shrink-0 flex-wrap items-center gap-1.5">
        <span className="lbl text-prim/80">NOW</span>
        <span className="lbl border border-line px-1.5 py-0.5 text-faint">BRAIN STANDBY</span>
      </div>
    )
  }

  const present = (brain.people ?? []).filter((p) => p.present)
  const camLabel = (id: string): string => {
    if (id === WEBCAM_ID) return 'OPERATOR CAM'
    const name = serverCameras.find((c) => c.id === id)?.name
    return name ? name.split('·')[0].trim() : id
  }
  const occ = (brain.occupancy ?? []).map((o) => `${camLabel(o.cameraId)} ${o.persons}`).join(' · ')

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1.5">
      <span className="lbl text-prim/80">NOW</span>
      {present.map((p) => {
        const dwellM = p.activitySince != null ? Math.max(0, Math.floor((now - p.activitySince) / 60_000)) : null
        return (
          <span key={p.personId} className="lbl flex items-center gap-1.5 border border-line bg-panel2/60 px-1.5 py-0.5 text-prim/85">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: p.color, boxShadow: `0 0 5px ${p.color}` }} />
            {p.name.toUpperCase()} · {p.activity ? `${p.activity}${dwellM != null ? ` · ${dwellM}m` : ''}` : 'PRESENT'}
          </span>
        )
      })}
      {present.length === 0 && <span className="lbl-faint">NO ONE ON CAMERA</span>}
      <span className="flex-1" />
      {occ && <span className="num lbl-faint">{occ}</span>}
    </div>
  )
}

/* ── timeline ──────────────────────────────────────────────────────── */

function Timeline({
  eventsVersion,
  onSelect,
  className,
}: {
  eventsVersion: number
  onSelect: (id: string) => void
  className?: string
}) {
  const [kindOn, setKindOn] = useState<Record<HomeEventKind, boolean>>(() => {
    const all = {} as Record<HomeEventKind, boolean>
    for (const k of FILTER_KINDS) all[k] = true
    return all
  })
  const [sevOn, setSevOn] = useState<Record<HomeSeverity, boolean>>({ INFO: true, NOTICE: true, WARN: true, CRIT: true })
  const [query, setQuery] = useState('')

  const scrollRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewH, setViewH] = useState(400)

  const all = getHomeEvents()
  const total = all.length
  const newestId = total > 0 ? all[total - 1].id : -1

  /* newest-first, filtered, capped */
  const filtered = useMemo(() => {
    const src = getHomeEvents()
    const q = query.trim().toUpperCase()
    const out: HomeEvent[] = []
    for (let i = src.length - 1; i >= 0 && out.length < TIMELINE_CAP; i--) {
      const e = src[i]
      if (!kindOn[e.kind]) continue
      if (!sevOn[e.severity]) continue
      if (q) {
        const src2 = (e.cameraId ?? '') + ' ' + (e.personId ?? '')
        if (!e.message.toUpperCase().includes(q) && !src2.toUpperCase().includes(q)) continue
      }
      out.push(e)
    }
    return out
    // eventsVersion is the deliberate subscribe key for the mutable ring buffer
  }, [eventsVersion, kindOn, sevOn, query])

  /* flatten into fixed-height rows with TODAY / EARLIER section headers */
  const rows = useMemo(() => {
    const dayStart = startOfDay()
    const out: Array<{ type: 'header'; label: string } | { type: 'event'; e: HomeEvent }> = []
    let section: string | null = null
    for (const e of filtered) {
      const label = e.ts >= dayStart ? 'TODAY' : 'EARLIER'
      if (label !== section) {
        section = label
        out.push({ type: 'header', label })
      }
      out.push({ type: 'event', e })
    }
    return out
  }, [filtered])

  /* viewport height tracking */
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    setViewH(el.clientHeight)
    const ro = new ResizeObserver(() => setViewH(el.clientHeight))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  /* window slice */
  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN)
  const end = Math.min(rows.length, Math.ceil((scrollTop + viewH) / ROW_H) + OVERSCAN)
  const slice = rows.slice(start, end)

  const toggleKind = (k: HomeEventKind) => setKindOn((s) => ({ ...s, [k]: !s[k] }))
  const toggleSev = (sv: HomeSeverity) => setSevOn((s) => ({ ...s, [sv]: !s[sv] }))

  return (
    <Panel
      title="ACTIVITY TIMELINE"
      live
      pulseKey={eventsVersion}
      brackets
      className={className}
      bodyClassName="flex min-h-0 flex-col"
      right={<span className="num lbl-faint shrink-0">{filtered.length}/{total} EVT</span>}
    >
      {/* filters */}
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-line px-1.5 py-1">
        {FILTER_KINDS.map((k) => {
          const on = kindOn[k]
          return (
            <button
              key={k}
              type="button"
              onClick={() => toggleKind(k)}
              className={`lbl border px-1 py-px transition-colors duration-150 ease-tac ${on ? 'bg-panel2' : 'border-line text-faint hover:text-dim'}`}
              style={on ? { borderColor: KIND_COLOR[k], color: KIND_COLOR[k] } : undefined}
              title={`TOGGLE ${k}`}
            >
              {k}
            </button>
          )
        })}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-line px-1.5 py-1">
        {SEVERITIES.map((sv) => {
          const on = sevOn[sv]
          return (
            <button
              key={sv}
              type="button"
              onClick={() => toggleSev(sv)}
              className={`lbl border px-1 py-px transition-colors duration-150 ease-tac ${on ? 'bg-panel2' : 'border-line text-faint hover:text-dim'}`}
              style={on ? { borderColor: SEV_COLOR[sv], color: SEV_COLOR[sv] } : undefined}
              title={`TOGGLE ${sv}`}
            >
              {sv}
            </button>
          )
        })}
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="SEARCH MSG / SOURCE"
          spellCheck={false}
          className="num ml-auto h-[18px] w-40 border border-line bg-panel2 px-1.5 text-[10px] uppercase tracking-lbl text-prim outline-none transition-colors duration-150 ease-tac placeholder:text-faint focus:border-accent/60"
        />
      </div>

      {/* column header */}
      <div className={`${GRID} h-[18px] shrink-0 border-b border-line bg-panel2/60`}>
        <span className="lbl-faint">TIME</span>
        <span className="lbl-faint">SEV</span>
        <span className="lbl-faint">KIND</span>
        <span className="lbl-faint">SOURCE</span>
        <span className="lbl-faint">MESSAGE</span>
      </div>

      {/* windowed body */}
      <div
        ref={scrollRef}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden"
      >
        <div style={{ height: start * ROW_H }} aria-hidden />
        {slice.map((r, i) =>
          r.type === 'header' ? (
            <div
              key={`h-${start + i}-${r.label}`}
              className="flex items-center gap-2 border-b border-line/60 bg-panel2/40 px-2"
              style={{ height: ROW_H }}
            >
              <span className="lbl text-accent/80">{r.label}</span>
              <span className="h-px flex-1 bg-line" />
            </div>
          ) : (
            <TimelineRow key={r.e.id} e={r.e} newest={r.e.id === newestId} onSelect={onSelect} />
          ),
        )}
        <div style={{ height: (rows.length - end) * ROW_H }} aria-hidden />
        {rows.length === 0 && <div className="lbl-faint px-2 py-6 text-center">NO EVENTS MATCH FILTER</div>}
      </div>
    </Panel>
  )
}

function TimelineRow({ e, newest, onSelect }: { e: HomeEvent; newest: boolean; onSelect: (id: string) => void }) {
  const c = SEV_COLOR[e.severity]
  const source = e.personId ?? e.cameraId
  const clickable = source !== undefined
  return (
    <div
      className={`${GRID} border-b border-line/50 transition-colors duration-150 ease-tac ${clickable ? 'cursor-pointer hover:bg-panel2' : 'hover:bg-panel2/40'} ${newest ? 'rise-in' : ''}`}
      style={{ height: ROW_H }}
      onClick={clickable ? () => onSelect(source) : undefined}
    >
      <span className="num text-[10px] text-dim">{fmtLocal(new Date(e.ts))}</span>
      <span className="min-w-0">
        <span className="lbl border px-1 py-px" style={{ borderColor: c, color: c }}>
          {e.severity}
        </span>
      </span>
      <span className="lbl truncate" style={{ color: KIND_COLOR[e.kind] }}>
        {e.kind}
      </span>
      <span className={`num truncate text-[10px] ${clickable ? 'text-accent/80' : 'text-faint'}`}>{source ?? '—'}</span>
      <span className="num truncate text-[11px] text-prim/85">{e.message}</span>
    </div>
  )
}

/* ── presence ──────────────────────────────────────────────────────── */

function PresenceList({
  presence,
  people,
  onSelect,
}: {
  presence: ReturnType<typeof rollupByPerson>
  people: ReturnType<typeof useHome.getState>['people']
  onSelect: (id: string) => void
}) {
  if (people.length === 0) {
    return (
      <div className="lbl-faint px-2 py-6 text-center leading-5">
        NO HOUSEHOLD ENROLLED
        <br />
        ADD FACES IN THE PEOPLE MODULE
      </div>
    )
  }
  const byId = new Map(people.map((p) => [p.id, p]))
  return (
    <ul className="flex flex-col">
      {presence.map((pr) => {
        const p = byId.get(pr.id)
        if (!p) return null
        return (
          <li
            key={pr.id}
            className="cursor-pointer border-b border-line/50 px-2 py-1.5 transition-colors hover:bg-panel2"
            onClick={() => onSelect(pr.id)}
          >
            <div className="flex items-center gap-1.5">
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: p.color, boxShadow: `0 0 5px ${p.color}` }} />
              <span className="truncate text-[12px] text-prim/90">{p.name}</span>
              <span className="lbl-faint">{p.role}</span>
              <span className="flex-1" />
              <span
                className="lbl border px-1 py-px"
                style={{
                  borderColor: pr.presentNow ? 'var(--accent-green)' : 'var(--text-faint)',
                  color: pr.presentNow ? 'var(--accent-green)' : 'var(--text-faint)',
                }}
              >
                {pr.presentNow ? 'PRESENT' : 'AWAY'}
              </span>
            </div>
            <div className="num lbl-faint mt-1 flex flex-wrap gap-x-2.5">
              <span>FIRST {pr.firstSeen !== null ? fmtLocal(new Date(pr.firstSeen)) : '—'}</span>
              <span>LAST {pr.lastSeen !== null ? fmtLocal(new Date(pr.lastSeen)) : '—'}</span>
              <span>{pr.sessions} SESS</span>
            </div>
          </li>
        )
      })}
    </ul>
  )
}

/* ── per-camera detections ─────────────────────────────────────────── */

function CameraList({
  cameras,
  eventsVersion,
  now,
  onSelect,
}: {
  cameras: { id: string; name: string; live: boolean }[]
  eventsVersion: number
  now: number
  onSelect: (id: string) => void
}) {
  return (
    <ul className="flex flex-col">
      {cameras.map((cam) => {
        const series = rollingPerMinute(getHomeEvents(), { cameraId: cam.id, minutes: 30, now })
        const totalDet = series.reduce((a, b) => a + b, 0)
        return (
          <li
            key={cam.id}
            className="flex cursor-pointer items-center gap-2 border-b border-line/50 px-2 py-1.5 transition-colors hover:bg-panel2"
            onClick={() => onSelect(cam.id)}
          >
            <span
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${cam.live ? 'led-pulse' : ''}`}
              style={{ background: cam.live ? 'var(--accent-green)' : 'var(--text-faint)' }}
            />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[11px] text-prim/85">{cam.name}</div>
              <div className="num lbl-faint">{cam.id}</div>
            </div>
            <div className="flex shrink-0 flex-col items-end">
              <span className="num text-[13px] leading-4" style={{ color: totalDet > 0 ? 'var(--accent)' : 'var(--text-faint)' }}>
                {totalDet}
              </span>
              <span className="lbl-faint text-[8px]">30M</span>
            </div>
            <Sparkline data={() => series} version={eventsVersion} width={64} height={20} color={ACCENT_HEX} min={0} />
          </li>
        )
      })}
      {cameras.length === 0 && <li className="lbl-faint px-2 py-6 text-center">NO CAMERAS</li>}
    </ul>
  )
}

/* ── learned routine ───────────────────────────────────────────────── */

function RoutineChart({ hist, note, total, now }: { hist: number[]; note: string; total: number; now: number }) {
  const max = Math.max(1, ...hist)
  const curHour = new Date(now).getHours()
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between">
        <span className="lbl-faint">LEARNED FROM YOUR HISTORY (THIS SESSION)</span>
        <span className="num lbl-faint">{total} EVT</span>
      </div>

      {/* 24-bar hour-of-day histogram */}
      <div className="flex h-16 items-end gap-px" title="ACTIVITY BY HOUR OF DAY">
        {hist.map((v, h) => {
          const cur = h === curHour
          return (
            <div key={h} className="flex flex-1 items-end" style={{ height: '100%' }}>
              <div
                className="w-full transition-all duration-300 ease-tac"
                style={{
                  height: `${Math.max(v > 0 ? 8 : 2, (v / max) * 100)}%`,
                  background: cur ? 'var(--accent-amber)' : v > 0 ? 'var(--accent)' : 'var(--line-bright)',
                  boxShadow: cur ? '0 0 6px rgba(245,166,35,0.5)' : v > 0 ? '0 0 4px rgba(34,211,238,0.35)' : undefined,
                  opacity: v > 0 ? 1 : 0.5,
                }}
              />
            </div>
          )
        })}
      </div>
      <div className="num lbl-faint flex justify-between">
        <span>00</span>
        <span>06</span>
        <span>12</span>
        <span>18</span>
        <span>23</span>
      </div>

      <div className="mt-0.5 border-t border-line pt-1.5 text-[11px] leading-4 text-prim/80">{note}</div>
      <div className="lbl-faint opacity-70">SIMPLE FREQUENCY MODEL · NOT PREDICTIVE · LOCAL-ONLY</div>
    </div>
  )
}
