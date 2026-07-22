/**
 * PANOPTICON // HOMEWATCH — the SMART BRAIN.
 *
 * A ~3 Hz background loop that fuses the on-device signals this app already
 * produces — pose landmarks from the operator cam, KNOWN/UNKNOWN person
 * tracks, the face watch's presence flags — into one reactive BrainSnapshot:
 * who is home, what each person is neutrally observed to be doing (SITTING,
 * WALKING…), per-camera occupancy, live observable SITUATIONS (person at the
 * entry, at / lingering at / crouching next to a vehicle, package at the
 * entry — via the pure context engine), today's activity segments and a
 * gently learned arrival routine per person.
 *
 * Awareness, never judgement: activities are plain observations, people are
 * KNOWN or UNKNOWN, and the only "insight" wording is soft and informational.
 * Everything runs and persists locally. Every pass is guarded — a bad frame,
 * an empty track map or a missing model can never crash the loop; when the
 * pose engine is OFFLINE the brain degrades to motion-only MOVING/IDLE.
 */
import { getTracks, useHome, WEBCAM_ID, type HomeStore } from '../store'
import type {
  ActivityKind,
  ActivitySegment,
  BrainSnapshot,
  Person,
  PersonNow,
  Situation,
  SituationKind,
  TrackedBox,
  Zone,
} from '../types'
import { getFaceVideo } from '../people/faceWatch'
import { ActivitySmoother, classifyInstant, type InstantActivity, type PoseSample } from './classify'
import { createContextState, detectSituations, type ContextInput } from './context'
import { detectPose, loadPose, onPoseState, poseState } from './poseEngine'
import {
  absenceNoteDue,
  fmtMinutes,
  loadRoutines,
  minutesOfDay,
  recordArrival,
  routineLine,
  saveRoutines,
  usualArrival,
  type RoutineStore,
} from './routines'

/* ── tunables ──────────────────────────────────────────────────────── */

/** brain pass cadence */
const TICK_MS = 300
/** rolling pose history — covers the 1.2 s wave + 1 s walk windows */
const POSE_HISTORY_MS = 2500
const POSE_HISTORY_CAP = 32
/** motion fallback: |[vx,vy]| above this (units/s) reads as MOVING */
const MOVE_SPEED = 0.08
/** motion fallback commits only after this much stability */
const MOTION_HOLD_MS = 2000
/** a track not refreshed within this window is stale (tracker paused/gone) */
const TRACK_FRESH_MS = 2000
/** while the pose engine is OFFLINE, retry the model load at most this often */
const POSE_RETRY_MS = 60_000
/** snapshot heartbeat — report at least this often even with no change */
const REPORT_HEARTBEAT_MS = 1500
/** debounce for the today-segments localStorage write */
const PERSIST_DEBOUNCE_MS = 2000
/** per-person cap on today's stored segments (newest kept) */
const SEGMENT_CAP = 60

const SEGMENTS_KEY = 'homewatch.segments.v1'

const ACTIVITY_KINDS: ReadonlySet<string> = new Set<ActivityKind>([
  'STANDING',
  'SITTING',
  'WALKING',
  'RUNNING',
  'CROUCHING',
  'LYING',
  'WAVING',
  'MOVING',
  'IDLE',
])

/* ── per-person bookkeeping ────────────────────────────────────────── */

interface PersonBook {
  /** last observed present flag (for edge detection) */
  present: boolean
  /** present/away since (wall ms) */
  since: number
  /** camera the current activity was read on */
  cameraId: string | null
  activity: ActivityKind | null
  activitySince: number | null
  /** today's segments, newest last; the last one may be open (end === null) */
  segments: ActivitySegment[]
  /** low-confidence MOVING/IDLE smoother (2 s stability) */
  motion: ActivitySmoother
}

/* ── module state ──────────────────────────────────────────────────── */

let running = false
let timer: ReturnType<typeof setInterval> | null = null
let offPose: (() => void) | null = null

const book = new Map<string, PersonBook>()
let poseHistory: PoseSample[] = []
let poseSmoother = new ActivitySmoother()
let routines: RoutineStore = {}
/** segments restored from localStorage for today, consumed as people appear */
let restoredSegments: Record<string, ActivitySegment[]> = {}
/** personId → day an arrival was recorded ('YYYY-MM-DD') */
const arrivalDay = new Map<string, string>()
/** personId → day the gentle absence note went out */
const absenceNotedDay = new Map<string, string>()
let currentDay = ''

let lastFingerprint = ''
let lastReportAt = 0
let persistTimer: ReturnType<typeof setTimeout> | null = null

/** situation-engine dwell bookkeeping (context.ts), reset on startBrain */
let contextState = createContextState()
/** situation id → last kind an event was emitted for (start / upgrade dedupe) */
const seenSituations = new Map<string, SituationKind>()
/** last time an OFFLINE pose engine was asked to retry its model load */
let lastPoseRetryAt = 0

/* ── small helpers ─────────────────────────────────────────────────── */

/** Local calendar day, 'YYYY-MM-DD'. */
function dayKey(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function startOfDayMs(ts: number): number {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function cameraName(st: HomeStore, cameraId: string): string {
  if (cameraId === WEBCAM_ID) return 'OPERATOR CAM'
  return st.serverCameras.find((c) => c.id === cameraId)?.name ?? cameraId
}

/** Simple night test matching zoneWatch: local hour 21:00–06:59. */
function isNight(ts: number): boolean {
  const hr = new Date(ts).getHours()
  return hr < 7 || hr > 20
}

function allCameraIds(st: HomeStore): string[] {
  return [WEBCAM_ID, ...st.serverCameras.map((c) => c.id)]
}

function ensureBook(p: Person, now: number): PersonBook {
  let b = book.get(p.id)
  if (!b) {
    b = {
      present: p.present,
      since: p.lastSeen ?? now,
      cameraId: p.lastCameraId ?? null,
      activity: null,
      activitySince: null,
      segments: restoredSegments[p.id]?.slice() ?? [],
      motion: new ActivitySmoother({ holdMs: MOTION_HOLD_MS }),
    }
    book.set(p.id, b)
  }
  return b
}

/* ── segments: change + persistence ────────────────────────────────── */

/**
 * Commit an activity change for one person: close the running segment, open a
 * new one, emit EXACTLY ONE neutral event, schedule the debounced persist.
 * A repeat of the current kind is a no-op (the segment simply continues).
 */
function setActivity(st: HomeStore, personId: string, kind: ActivityKind, cameraId: string, now: number): void {
  const p = st.people.find((x) => x.id === personId)
  if (!p) return
  const b = ensureBook(p, now)
  if (b.activity === kind) {
    b.cameraId = cameraId
    return
  }
  const open = b.segments[b.segments.length - 1]
  if (open !== undefined && open.end === null) open.end = now
  b.segments.push({ kind, start: now, end: null, cameraId })
  if (b.segments.length > SEGMENT_CAP) b.segments.splice(0, b.segments.length - SEGMENT_CAP)
  b.activity = kind
  b.activitySince = now
  b.cameraId = cameraId
  scheduleSegmentPersist()
  st.emit('INFO', 'ACTIVITY', `${p.name.toUpperCase()} NOW ${kind} · ${cameraName(st, cameraId)}`, {
    personId,
    cameraId,
  })
}

interface StoredSegments {
  date: string
  byPerson: Record<string, ActivitySegment[]>
}

/** Write today's segments (open segment closed at save time). Guarded. */
function persistSegmentsNow(now: number): void {
  try {
    if (typeof localStorage === 'undefined') return
    const byPerson: Record<string, ActivitySegment[]> = {}
    for (const [id, b] of book) {
      if (b.segments.length === 0) continue
      byPerson[id] = b.segments.map((s) => (s.end === null ? { ...s, end: now } : s))
    }
    const payload: StoredSegments = { date: dayKey(now), byPerson }
    localStorage.setItem(SEGMENTS_KEY, JSON.stringify(payload))
  } catch {
    /* storage unavailable / full — in-memory segments still work */
  }
}

function scheduleSegmentPersist(): void {
  if (persistTimer !== null) return
  persistTimer = setTimeout(() => {
    persistTimer = null
    persistSegmentsNow(Date.now())
  }, PERSIST_DEBOUNCE_MS)
}

/** Restore today's stored segments (stale dates ignored). Guarded. */
function restoreSegments(now: number): Record<string, ActivitySegment[]> {
  try {
    if (typeof localStorage === 'undefined') return {}
    const raw = localStorage.getItem(SEGMENTS_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as StoredSegments
    if (!parsed || parsed.date !== dayKey(now) || parsed.byPerson === null || typeof parsed.byPerson !== 'object') {
      return {}
    }
    const out: Record<string, ActivitySegment[]> = {}
    for (const [id, segs] of Object.entries(parsed.byPerson)) {
      if (!Array.isArray(segs)) continue
      const valid: ActivitySegment[] = []
      for (const s of segs) {
        if (!s || typeof s.start !== 'number' || typeof s.cameraId !== 'string') continue
        if (typeof s.kind !== 'string' || !ACTIVITY_KINDS.has(s.kind)) continue
        // restored segments are always closed — live activity restarts fresh
        valid.push({ kind: s.kind, start: s.start, end: typeof s.end === 'number' ? s.end : s.start, cameraId: s.cameraId })
      }
      if (valid.length > 0) out[id] = valid.slice(-SEGMENT_CAP)
    }
    return out
  } catch {
    return {}
  }
}

/* ── pass stages ───────────────────────────────────────────────────── */

/** Local-midnight rollover: today's strips restart, running activity re-opens. */
function rolloverDay(now: number): void {
  const today = dayKey(now)
  if (today === currentDay) return
  currentDay = today
  restoredSegments = {}
  for (const b of book.values()) {
    b.segments = []
    if (b.activity !== null) {
      b.segments.push({ kind: b.activity, start: now, end: null, cameraId: b.cameraId ?? WEBCAM_ID })
    }
  }
  scheduleSegmentPersist()
}

/** Keep the book in lockstep with the enrolled roster. */
function syncRoster(st: HomeStore, now: number): void {
  for (const p of st.people) ensureBook(p, now)
  for (const id of [...book.keys()]) {
    if (!st.people.some((p) => p.id === id)) book.delete(id)
  }
}

/**
 * POSE → ACTIVITY. Runs the landmarker on the shared operator-cam frame,
 * classifies into the rolling history, and attributes the SMOOTHED activity:
 * to the face-matched person, else — when exactly one enrolled person is
 * present — to them, else to nobody. Returns the covered person's id.
 */
function runPose(st: HomeStore, now: number): string | null {
  if (poseState() !== 'ready') {
    poseSmoother.push(now, null)
    return null
  }
  const video = getFaceVideo()
  if (video === null) {
    poseSmoother.push(now, null)
    return null
  }
  const pts = detectPose(video, now)
  let instant: InstantActivity | null = null
  if (pts !== null) {
    poseHistory.push({ t: now, lm: pts })
    while (poseHistory.length > 0 && now - poseHistory[0].t > POSE_HISTORY_MS) poseHistory.shift()
    if (poseHistory.length > POSE_HISTORY_CAP) poseHistory.splice(0, poseHistory.length - POSE_HISTORY_CAP)
    instant = classifyInstant(poseHistory)
  }
  const committed = poseSmoother.push(now, instant)

  let targetId: string | null = st.lastFace?.personId ?? null
  if (targetId === null) {
    const present = st.people.filter((p) => p.present)
    if (present.length === 1) targetId = present[0].id
  }
  if (targetId === null || committed === null) return null
  setActivity(st, targetId, committed, WEBCAM_ID, now)
  return targetId
}

/** Freshest KNOWN person track for `personId` across all cameras, if any. */
function findKnownTrack(st: HomeStore, personId: string, now: number): TrackedBox | null {
  let best: TrackedBox | null = null
  for (const cameraId of allCameraIds(st)) {
    let tracks: TrackedBox[]
    try {
      tracks = getTracks(cameraId)
    } catch {
      continue
    }
    for (const t of tracks) {
      if (t.cls !== 'person' || t.identity !== 'known' || t.personId !== personId) continue
      if (now - t.updatedAt > TRACK_FRESH_MS) continue
      if (best === null || t.updatedAt > best.updatedAt) best = t
    }
  }
  return best
}

/**
 * MOTION FALLBACK — for present people the pose pass doesn't cover: their
 * KNOWN track's speed reads as MOVING (>0.08 units/s) or IDLE, smoothed to
 * 2 s stability before committing. Low-confidence by design.
 */
function runMotionFallback(st: HomeStore, now: number, poseCoveredId: string | null): void {
  for (const p of st.people) {
    if (!p.present || p.id === poseCoveredId) continue
    const b = ensureBook(p, now)
    const track = findKnownTrack(st, p.id, now)
    const instant: InstantActivity | null =
      track !== null
        ? { kind: Math.hypot(track.vel[0], track.vel[1]) > MOVE_SPEED ? 'MOVING' : 'IDLE', confidence: 0.5 }
        : null
    const committed = b.motion.push(now, instant)
    if (track !== null && (committed === 'MOVING' || committed === 'IDLE')) {
      setActivity(st, p.id, committed, track.cameraId, now)
    }
  }
}

/**
 * PRESENCE → ROUTINES. Diffs present flags between passes: homecomings feed
 * the learned arrival log (first arrival per person per day), departures
 * close the running segment. Also raises the once-per-day gentle absence
 * note when someone is well past their usual arrival and unseen today.
 */
function runPresenceRoutines(st: HomeStore, now: number): void {
  const today = dayKey(now)
  const dayStart = startOfDayMs(now)
  for (const p of st.people) {
    const b = ensureBook(p, now)

    if (p.present !== b.present) {
      b.present = p.present
      b.since = now
      if (p.present) {
        if (arrivalDay.get(p.id) !== today) {
          arrivalDay.set(p.id, today)
          recordArrival(routines, p.id, now)
          saveRoutines(routines)
        }
      } else {
        // away — the activity picture is live-only; close the open segment
        const open = b.segments[b.segments.length - 1]
        if (open !== undefined && open.end === null) open.end = now
        b.activity = null
        b.activitySince = null
        scheduleSegmentPersist()
      }
    }

    // gentle absence note — once per person per day, soft wording only
    if (!p.present && absenceNotedDay.get(p.id) !== today && arrivalDay.get(p.id) !== today) {
      const seenToday = p.lastSeen !== undefined && p.lastSeen >= dayStart
      if (!seenToday) {
        const usual = usualArrival(routines[p.id] ?? [], now)
        if (usual !== null && absenceNoteDue(usual, minutesOfDay(now), false)) {
          absenceNotedDay.set(p.id, today)
          st.emit('INFO', 'PERSON', `${p.name.toUpperCase()} USUALLY HOME BY ~${fmtMinutes(usual.minutes)} — NOT SEEN YET TODAY`, {
            personId: p.id,
          })
        }
      }
    }
  }
}

/* ── situations (context engine) ───────────────────────────────────── */

/**
 * SITUATION → EVENT. Exactly one event when a situation STARTS, plus exactly
 * one more on the AT_VEHICLE → LINGERING_AT_VEHICLE upgrade. Severity is
 * calibrated to the KNOWN / UNKNOWN distinction and the wording never claims
 * more than what was observed; a still-resolving ('PERSON') identity gets the
 * neutral wording at NOTICE, never the UNKNOWN wording or WARN.
 */
function emitSituation(st: HomeStore, s: Situation, now: number): void {
  const cam = cameraName(st, s.cameraId)
  const known = s.personId !== null
  const who = s.personLabel === 'UNKNOWN' ? 'UNKNOWN PERSON' : s.personLabel
  const opts = { cameraId: s.cameraId, personId: s.personId ?? undefined }
  switch (s.kind) {
    case 'AT_ENTRY':
      if (known) st.emit('INFO', 'ZONE', `${who} AT ENTRY · ${cam}`, opts)
      else st.emit('NOTICE', 'ZONE', `${who} AT ENTRY — MAY BE RINGING · ${cam}`, opts)
      return
    case 'AT_VEHICLE':
      st.emit(known ? 'INFO' : 'NOTICE', 'ACTIVITY', `${who} AT VEHICLE · ${cam}`, opts)
      return
    case 'LINGERING_AT_VEHICLE': {
      const secs = Math.max(0, Math.round((now - s.since) / 1000))
      if (known) st.emit('INFO', 'ACTIVITY', `${who} STILL AT VEHICLE · ${cam}`, opts)
      else if (s.personLabel === 'UNKNOWN') st.emit('WARN', 'ALERT', `UNKNOWN PERSON LINGERING AT VEHICLE ${secs}s · ${cam}`, opts)
      else st.emit('NOTICE', 'ACTIVITY', `PERSON LINGERING AT VEHICLE ${secs}s · ${cam}`, opts)
      return
    }
    case 'CROUCHING_AT_VEHICLE':
      if (known) st.emit('INFO', 'ACTIVITY', `${who} CROUCHING AT VEHICLE · ${cam}`, opts)
      else if (s.personLabel === 'UNKNOWN') st.emit('WARN', 'ALERT', `UNKNOWN PERSON CROUCHING AT VEHICLE · ${cam}`, opts)
      else st.emit('NOTICE', 'ACTIVITY', `PERSON CROUCHING AT VEHICLE · ${cam}`, opts)
      return
    case 'PACKAGE_AT_ENTRY':
      st.emit('NOTICE', 'DETECTION', `PACKAGE AT ENTRY · ${cam}`, opts)
      return
  }
}

/** Diff live situations against the emitted set: starts + upgrades only. */
function emitSituationEvents(st: HomeStore, situations: Situation[], now: number): void {
  const live = new Set<string>()
  for (const s of situations) {
    live.add(s.id)
    const prev = seenSituations.get(s.id)
    if (prev === s.kind) continue
    if (prev === undefined || (prev === 'AT_VEHICLE' && s.kind === 'LINGERING_AT_VEHICLE')) {
      emitSituation(st, s, now)
    }
    seenSituations.set(s.id, s.kind)
  }
  for (const id of [...seenSituations.keys()]) {
    if (!live.has(id)) seenSituations.delete(id)
  }
}

/**
 * SITUATIONS — fuse fresh tracks, the drawn zones and each person's committed
 * activity through the deterministic context engine, then mirror situation
 * starts/upgrades into the event feed. Fully guarded: a bad pass returns the
 * empty list and can never take the loop down.
 */
function runSituations(st: HomeStore, now: number): Situation[] {
  try {
    const tracksByCamera = new Map<string, TrackedBox[]>()
    for (const cameraId of allCameraIds(st)) {
      let tracks: TrackedBox[]
      try {
        tracks = getTracks(cameraId)
      } catch {
        continue
      }
      const fresh = tracks.filter((t) => now - t.updatedAt <= TRACK_FRESH_MS)
      if (fresh.length > 0) tracksByCamera.set(cameraId, fresh)
    }
    const zonesByCamera = new Map<string, Zone[]>()
    for (const z of st.zones) {
      const arr = zonesByCamera.get(z.cameraId)
      if (arr) arr.push(z)
      else zonesByCamera.set(z.cameraId, [z])
    }
    const activityByPerson = new Map<string, ActivityKind | null>()
    for (const [personId, b] of book) activityByPerson.set(personId, b.activity)

    const input: ContextInput = { now, night: isNight(now), tracksByCamera, zonesByCamera, activityByPerson }
    const situations = detectSituations(contextState, input)
    emitSituationEvents(st, situations, now)
    return situations
  } catch {
    return []
  }
}

/* ── snapshot assembly ─────────────────────────────────────────────── */

function buildOccupancy(st: HomeStore, now: number): { occupancy: BrainSnapshot['occupancy']; unknownActive: boolean } {
  const occupancy: BrainSnapshot['occupancy'] = []
  let unknownActive = false
  for (const cameraId of allCameraIds(st)) {
    let tracks: TrackedBox[]
    try {
      tracks = getTracks(cameraId)
    } catch {
      tracks = []
    }
    const persons = tracks.filter((t) => t.cls === 'person' && now - t.updatedAt <= TRACK_FRESH_MS)
    const labels = persons.map((t) => {
      if (t.identity === 'known') {
        const name = t.personName ?? st.people.find((p) => p.id === t.personId)?.name
        return (name ?? 'KNOWN').toUpperCase()
      }
      // KNOWN vs UNKNOWN vs still-resolving — never any stronger label
      return t.identity === 'unknown' ? 'UNKNOWN' : 'PERSON'
    })
    if (persons.some((t) => t.identity === 'unknown')) unknownActive = true
    occupancy.push({ cameraId, persons: persons.length, labels })
  }
  return { occupancy, unknownActive }
}

function buildInsights(st: HomeStore, now: number): string[] {
  const today = dayKey(now)
  const out: string[] = []
  for (const p of st.people) {
    if (absenceNotedDay.get(p.id) !== today) continue
    if (p.present || arrivalDay.get(p.id) === today) continue // arrived since — note is stale
    const usual = usualArrival(routines[p.id] ?? [], now)
    if (usual === null) continue
    out.push(`${p.name.toUpperCase()} USUALLY HOME BY ~${fmtMinutes(usual.minutes)} — NOT SEEN YET TODAY`)
  }
  if (st.people.length > 0 && st.people.every((p) => p.present)) {
    out.push('EVERYONE ENROLLED IS HOME')
  }
  return out
}

function buildSnapshot(st: HomeStore, now: number, situations: Situation[]): BrainSnapshot {
  const { occupancy, unknownActive } = buildOccupancy(st, now)
  const people: PersonNow[] = st.people.map((p) => {
    const b = ensureBook(p, now)
    return {
      personId: p.id,
      name: p.name,
      role: p.role,
      color: p.color,
      present: p.present,
      since: b.since,
      cameraId: p.present ? (b.cameraId ?? p.lastCameraId ?? null) : null,
      activity: b.activity,
      activitySince: b.activitySince,
      todaySegments: b.segments.slice(),
      routine: routineLine(usualArrival(routines[p.id] ?? [], now)) ?? undefined,
    }
  })
  return { ts: now, pose: poseState(), people, unknownActive, occupancy, situations, insights: buildInsights(st, now) }
}

/**
 * Report only when something MATERIAL changed — pose state, a present flag or
 * activity, an occupancy count, unknownActive, a situation starting / being
 * upgraded / ending, the insight count — or on the 1.5 s heartbeat. Never
 * every pass.
 */
function fingerprint(snap: BrainSnapshot): string {
  const ppl = snap.people.map((p) => `${p.personId}:${p.present ? 1 : 0}:${p.activity ?? '-'}`).join(',')
  const occ = snap.occupancy.map((o) => `${o.cameraId}:${o.persons}`).join(',')
  const sit = snap.situations.map((s) => `${s.id}:${s.kind}`).join(',')
  return `${snap.pose}|${snap.unknownActive ? 1 : 0}|${snap.insights.length}|${ppl}|${occ}|${sit}`
}

function maybeReport(st: HomeStore, snap: BrainSnapshot, now: number): void {
  const fp = fingerprint(snap)
  if (fp === lastFingerprint && now - lastReportAt < REPORT_HEARTBEAT_MS) return
  lastFingerprint = fp
  lastReportAt = now
  st.reportBrain(snap)
}

/* ── the loop ──────────────────────────────────────────────────────── */

function pass(now: number): void {
  const st = useHome.getState()
  rolloverDay(now)
  syncRoster(st, now)
  // pose retry — while OFFLINE, re-attempt the model load at most every 60 s
  if (poseState() === 'offline' && now - lastPoseRetryAt >= POSE_RETRY_MS) {
    lastPoseRetryAt = now
    void loadPose()
  }
  const poseCoveredId = runPose(st, now)
  runMotionFallback(st, now, poseCoveredId)
  runPresenceRoutines(st, now)
  const situations = runSituations(st, now)
  maybeReport(st, buildSnapshot(st, now, situations), now)
}

function tick(): void {
  if (!running) return
  try {
    pass(Date.now())
  } catch {
    /* the brain must survive any single bad pass */
  }
}

/**
 * Start the smart brain: kicks off the pose-model load (self-degrades to
 * OFFLINE), restores today's segments + the learned routines, and begins the
 * fusion loop. Idempotent — a second call is a no-op.
 */
export function startBrain(): void {
  if (running) return
  running = true

  const now = Date.now()
  currentDay = dayKey(now)
  routines = loadRoutines()
  restoredSegments = restoreSegments(now)
  book.clear()
  poseHistory = []
  poseSmoother = new ActivitySmoother()
  contextState = createContextState()
  seenSituations.clear()
  lastPoseRetryAt = now
  lastFingerprint = ''
  lastReportAt = 0

  offPose = onPoseState((s) => {
    const st = useHome.getState()
    if (s === 'ready') st.emit('NOTICE', 'SYSTEM', 'POSE ENGINE ONLINE · ACTIVITY SENSE · ON-DEVICE')
    else if (s === 'offline') st.emit('WARN', 'SYSTEM', 'POSE ENGINE OFFLINE · MODEL UNAVAILABLE — MOTION-ONLY ACTIVITY')
  })

  useHome.getState().emit('INFO', 'SYSTEM', 'SMART BRAIN ONLINE — NEUTRAL OBSERVATIONS · ON-DEVICE')
  void loadPose()
  timer = setInterval(tick, TICK_MS)
  // clean restart across Vite HMR so we never stack intervals
  if (import.meta.hot) {
    import.meta.hot.dispose(() => stopBrain())
  }
}

/** Stop the loop, flush any pending segment write. Idempotent. */
export function stopBrain(): void {
  running = false
  if (timer !== null) {
    clearInterval(timer)
    timer = null
  }
  if (persistTimer !== null) {
    clearTimeout(persistTimer)
    persistTimer = null
    persistSegmentsNow(Date.now())
  }
  offPose?.()
  offPose = null
}
