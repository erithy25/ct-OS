/**
 * PANOPTICON // HOMEWATCH — SMART BRAIN.
 *
 * The flagship "who is doing what, right now" dashboard: live per-person
 * presence with neutral activity readouts and dwell times, a 24-hour activity
 * strip per household member, per-camera occupancy and gently-learned
 * insights. Fed entirely by the on-device smart-brain engine via
 * `store.brain` — when the engine is quiet the view stands by. Awareness,
 * never judgement: activities are plain observations (SITTING, WALKING…),
 * people are KNOWN or UNKNOWN, nothing more.
 */
import { useEffect, useState } from 'react'
import Panel from '../../components/Panel'
import CornerBrackets from '../../components/CornerBrackets'
import { useHome, WEBCAM_ID } from '../store'
import type { ActivityKind, ActivitySegment, BrainSnapshot, Person, PersonNow, PoseEngineState } from '../types'

/* ── neutral activity palette ──────────────────────────────────────── */

const ACTIVITY_COLOR: Record<ActivityKind, string> = {
  STANDING: '#34D399',
  SITTING: '#22D3EE',
  WALKING: '#F5A623',
  RUNNING: '#FB923C',
  CROUCHING: '#C084FC',
  LYING: '#8B5CF6',
  WAVING: '#F472B6',
  MOVING: '#5EEAD4',
  IDLE: '#6B7C8F',
}

const DAY_MS = 24 * 60 * 60 * 1000

/* ── small time helpers ────────────────────────────────────────────── */

const p2 = (n: number) => String(n).padStart(2, '0')

function fmtHM(ts: number): string {
  const d = new Date(ts)
  return `${p2(d.getHours())}:${p2(d.getMinutes())}`
}

function startOfDay(now: number): number {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** dwell string from a start ts, minute resolution — '14m' / '1h 05m' */
function dwellStr(since: number, now: number): string {
  const m = Math.max(0, Math.floor((now - since) / 60_000))
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h ${p2(m % 60)}m`
}

/** 30s clock — dwell/strip strings only need minute resolution */
function useSlowNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [])
  return now
}

/** roster fallback — skeleton cards from the enrolled roster before the engine publishes */
function skeleton(p: Person): PersonNow {
  return {
    personId: p.id,
    name: p.name,
    role: p.role,
    color: p.color,
    present: p.present,
    since: 0,
    cameraId: p.lastCameraId ?? null,
    activity: null,
    activitySince: null,
    todaySegments: [],
  }
}

/* ── root view ─────────────────────────────────────────────────────── */

export default function Brain() {
  const brain = useHome((s) => s.brain)
  const people = useHome((s) => s.people)
  const now = useSlowNow()

  const roster: PersonNow[] = brain?.people?.length ? brain.people : people.map(skeleton)
  const homeCount = roster.filter((p) => p.present).length

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-2">
      {/* toolbar */}
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <span className="lbl text-prim/80">SMART BRAIN</span>
        <span className="lbl flex items-center gap-1 border border-green/30 px-1.5 py-0.5 text-green">
          <span className="led-pulse h-1 w-1 rounded-full bg-green" />
          {homeCount} HOME
        </span>
        {brain?.unknownActive && (
          <span className="lbl flex items-center gap-1 border border-red/40 bg-red/5 px-1.5 py-0.5 text-red">
            <span className="led-pulse h-1 w-1 rounded-full bg-red" />
            UNKNOWN ON CAMERA
          </span>
        )}
        <div className="flex-1" />
        <PoseChip pose={brain?.pose ?? null} />
      </div>

      {/* main */}
      <div className="flex min-h-0 flex-1 gap-2">
        <Panel title="HOUSEHOLD NOW" live brackets className="min-h-0 flex-1" bodyClassName="min-h-0 overflow-y-auto">
          {roster.length === 0 ? (
            brain === null ? (
              <StandbyBlock />
            ) : (
              <EmptyRoster />
            )
          ) : (
            <div className="flex flex-col gap-2 p-2">
              {brain === null && <StandbyStrip />}
              <div className="grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-2" style={{ gridAutoRows: 'min-content' }}>
                {roster.map((pn) => (
                  <PersonCard key={pn.personId} pn={pn} now={now} />
                ))}
              </div>
            </div>
          )}
        </Panel>

        <div className="flex w-[300px] shrink-0 flex-col gap-2">
          <SituationsPanel brain={brain} now={now} />
          <OccupancyPanel brain={brain} />
          <InsightsPanel brain={brain} />
        </div>
      </div>

      {/* privacy footer */}
      <div className="lbl-faint shrink-0 px-1 leading-4">
        ON-DEVICE · AWARENESS, NOT JUDGEMENT · ACTIVITY IS A NEUTRAL OBSERVATION · NOTHING UPLOADED
      </div>
    </div>
  )
}

/* ── live situations (context engine) ──────────────────────────────── */

const SITUATION_TEXT: Record<string, string> = {
  AT_ENTRY: 'AT ENTRY — MAY BE RINGING',
  AT_VEHICLE: 'AT VEHICLE',
  LINGERING_AT_VEHICLE: 'LINGERING AT VEHICLE',
  CROUCHING_AT_VEHICLE: 'CROUCHING AT VEHICLE',
  PACKAGE_AT_ENTRY: 'PACKAGE AT ENTRY',
}
/** WARN-worthy kinds render red when the person is not enrolled */
const SITUATION_HOT = new Set(['LINGERING_AT_VEHICLE', 'CROUCHING_AT_VEHICLE'])

function SituationsPanel({ brain, now }: { brain: BrainSnapshot | null; now: number }) {
  const situations = brain?.situations ?? []
  if (situations.length === 0) return null // quiet by default — no empty panel noise
  return (
    <Panel title="SITUATIONS" live className="shrink-0" bodyClassName="p-1.5">
      <ul className="flex flex-col gap-1">
        {situations.map((s) => {
          const unknown = s.personId === null && s.personLabel === 'UNKNOWN'
          const hot = unknown && SITUATION_HOT.has(s.kind)
          const color = hot ? 'var(--accent-red)' : unknown ? 'var(--accent-amber)' : 'var(--accent-green)'
          return (
            <li key={s.id} className="flex items-center gap-1.5 border px-1.5 py-1" style={{ borderColor: color }}>
              <span className="led-pulse h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: color }} />
              <span className="num min-w-0 flex-1 truncate text-[10px] leading-4" style={{ color }}>
                {s.personLabel.toUpperCase()} · {SITUATION_TEXT[s.kind] ?? s.kind}
              </span>
              <span className="lbl-faint shrink-0">{dwellStr(s.since, now)}</span>
            </li>
          )
        })}
      </ul>
    </Panel>
  )
}

/* ── pose-engine chip ──────────────────────────────────────────────── */

function PoseChip({ pose }: { pose: PoseEngineState | null }) {
  const m =
    pose === 'ready'
      ? { label: 'ACTIVITY SENSE ●', color: 'var(--accent-green)', pulse: true }
      : pose === 'loading'
        ? { label: 'ACTIVITY SENSE LOADING…', color: 'var(--accent-amber)', pulse: true }
        : pose === 'offline'
          ? { label: 'ACTIVITY SENSE OFFLINE', color: 'var(--accent-red)', pulse: false }
          : { label: 'STANDBY', color: 'var(--text-faint)', pulse: false }
  return (
    <span className="lbl flex items-center gap-1.5 border px-2 py-0.5" style={{ borderColor: m.color, color: m.color }}>
      {m.pulse && <span className="led-pulse h-1.5 w-1.5 rounded-full" style={{ background: m.color }} />}
      {m.label}
    </span>
  )
}

/* ── standby / empty states ────────────────────────────────────────── */

function StandbyBlock() {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="relative px-10 py-8 text-center">
        <CornerBrackets size={10} />
        <div className="font-grotesk text-[16px] font-medium tracking-[0.26em] text-dim">SMART BRAIN STANDBY</div>
        <div className="lbl-faint mx-auto mt-3 max-w-[300px] leading-4">
          WAITING FOR SIGNALS — DETECTION, FACES AND ACTIVITY SENSE FEED THIS VIEW
        </div>
      </div>
    </div>
  )
}

/** compact standby notice shown above skeleton cards while the engine is quiet */
function StandbyStrip() {
  return (
    <div className="flex shrink-0 flex-wrap items-center justify-center gap-x-2 gap-y-0.5 border border-line bg-panel2/40 px-2 py-1.5 text-center">
      <span className="lbl text-dim">SMART BRAIN STANDBY</span>
      <span className="lbl-faint">WAITING FOR SIGNALS — DETECTION, FACES AND ACTIVITY SENSE FEED THIS VIEW</span>
    </div>
  )
}

function EmptyRoster() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1.5 p-6 text-center">
      <div className="lbl text-faint">NO ONE ENROLLED YET</div>
      <div className="lbl-faint">ENROLL IN PEOPLE (2)</div>
    </div>
  )
}

/* ── person card ───────────────────────────────────────────────────── */

function PersonCard({ pn, now }: { pn: PersonNow; now: number }) {
  const activity = pn.activity
  const activityColor = activity ? ACTIVITY_COLOR[activity] : 'var(--text-faint)'
  const sinceStr = pn.since ? ` · SINCE ${fmtHM(pn.since)}` : ''
  const segs = pn.todaySegments ?? []

  return (
    <div className="panel-surface-2 relative flex flex-col gap-1.5 border-line p-2" style={{ borderLeft: `2px solid ${pn.color}` }}>
      {/* name + role */}
      <div className="flex items-center gap-1.5">
        <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: pn.color, boxShadow: `0 0 6px ${pn.color}` }} />
        <span className="truncate text-[13px] font-medium leading-4 text-prim">{pn.name}</span>
        <div className="flex-1" />
        <span className="lbl shrink-0 border border-line px-1 py-px text-faint">{pn.role}</span>
      </div>

      {/* presence */}
      {pn.present ? (
        <div className="lbl flex items-center gap-1.5 text-green">
          <span className="led-pulse h-1 w-1 shrink-0 rounded-full bg-green" />
          <span className="num truncate">HOME{sinceStr}</span>
        </div>
      ) : (
        <div className="num lbl truncate text-faint">AWAY{sinceStr}</div>
      )}

      {/* activity — the headline readout */}
      <div className="num truncate text-[15px] font-medium leading-5 tracking-wide" style={{ color: activityColor }}>
        {activity
          ? `${activity}${pn.activitySince != null ? ` · ${dwellStr(pn.activitySince, now)}` : ''}`
          : '—'}
      </div>

      {/* TODAY — 24h activity strip */}
      <div>
        <div className="lbl-faint mb-1 flex items-baseline justify-between">
          <span>TODAY</span>
          <span className="num">00–24</span>
        </div>
        <div className="relative h-2 w-full overflow-hidden border border-line bg-void">
          {segs.map((seg, i) => (
            <SegBlock key={i} seg={seg} now={now} />
          ))}
        </div>
      </div>

      {/* learned routine */}
      {pn.routine && <div className="lbl-faint leading-4">{pn.routine}</div>}
    </div>
  )
}

function SegBlock({ seg, now }: { seg: ActivitySegment; now: number }) {
  const day0 = startOfDay(now)
  const start = Math.max(seg.start, day0)
  const end = Math.min(seg.end ?? now, day0 + DAY_MS)
  if (end < start) return null
  const left = Math.min(100, Math.max(0, ((start - day0) / DAY_MS) * 100))
  const width = Math.min(100 - left, ((end - start) / DAY_MS) * 100)
  return (
    <span
      className="absolute inset-y-0"
      style={{ left: `${left}%`, width: `${width}%`, minWidth: 1, background: ACTIVITY_COLOR[seg.kind] }}
      title={`${seg.kind} ${fmtHM(seg.start)}–${fmtHM(seg.end ?? now)}`}
    />
  )
}

/* ── camera occupancy ──────────────────────────────────────────────── */

function OccupancyPanel({ brain }: { brain: BrainSnapshot | null }) {
  const serverCameras = useHome((s) => s.serverCameras)
  const people = useHome((s) => s.people)
  const rows = brain?.occupancy ?? []
  const known = new Set(people.map((p) => p.name.toUpperCase()))

  const camName = (id: string): string => {
    if (id === WEBCAM_ID) return 'OPERATOR CAM'
    return serverCameras.find((c) => c.id === id)?.name ?? id
  }

  return (
    <Panel
      title="CAMERA OCCUPANCY"
      className="min-h-0 flex-1"
      bodyClassName="overflow-y-auto"
      right={<span className="num lbl-faint">{rows.length} CAM</span>}
    >
      <ul className="flex flex-col">
        {rows.map((o) => (
          <li key={o.cameraId} className="border-b border-line/50 px-2 py-1.5">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-[11px] text-prim/85">{camName(o.cameraId)}</span>
              <div className="flex-1" />
              <span className="num text-[13px] leading-4" style={{ color: o.persons > 0 ? 'var(--accent)' : 'var(--text-faint)' }}>
                {o.persons}
              </span>
            </div>
            {(o.labels ?? []).length > 0 && (
              <div className="mt-1 flex flex-wrap gap-1">
                {(o.labels ?? []).map((label, i) => (
                  <LabelChip key={`${label}-${i}`} label={label} known={known} />
                ))}
              </div>
            )}
          </li>
        ))}
        {rows.length === 0 && <li className="lbl-faint px-2 py-6 text-center">NO CAMERAS ACTIVE</li>}
      </ul>
    </Panel>
  )
}

/** KNOWN name → green · UNKNOWN → red · generic PERSON → cyan */
function LabelChip({ label, known }: { label: string; known: Set<string> }) {
  const u = label.toUpperCase()
  const color = known.has(u)
    ? 'var(--accent-green)'
    : u === 'UNKNOWN'
      ? 'var(--accent-red)'
      : u === 'PERSON'
        ? 'var(--accent)'
        : 'var(--text-dim)'
  return (
    <span className="lbl border px-1 py-px" style={{ borderColor: color, color }}>
      {u}
    </span>
  )
}

/* ── insights ──────────────────────────────────────────────────────── */

function InsightsPanel({ brain }: { brain: BrainSnapshot | null }) {
  const insights = brain?.insights ?? []
  return (
    <Panel
      title="INSIGHTS"
      className="min-h-0 flex-1"
      bodyClassName="overflow-y-auto"
      right={<span className="num lbl-faint">{insights.length}</span>}
    >
      {insights.length === 0 ? (
        <div className="lbl-faint px-3 py-6 text-center leading-4">
          LEARNING YOUR HOUSEHOLD&apos;S RHYTHM — INSIGHTS APPEAR AFTER A FEW DAYS
        </div>
      ) : (
        <ul className="flex flex-col">
          {insights.map((line, i) => (
            <li key={i} className="lbl border-b border-line/50 px-2 py-1.5 leading-4 text-prim/85">
              {line}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}
