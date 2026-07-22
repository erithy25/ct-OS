/**
 * Detection scheduler — drives the shared on-device detector across every
 * registered camera tile, one inference at a time, then fuses each frame
 * through the tracker (stable ids + KNOWN/UNKNOWN identity) for the overlay
 * and the zone watch. All local; nothing ever leaves the machine.
 *
 * Cadence: the operator webcam (CAM-01) is paced off its own inference cost
 * (target ≈ 2 × last duration, clamped 120–480 ms) so the overlay tracks with
 * effectively no lag; bridged cameras round-robin at ~420 ms. A light ~70 ms
 * loop always runs the most-overdue due camera (webcam wins ties).
 */
import { getFaceReads, getTracks, setDetections, setFaceReads, setTracks, useHome, WEBCAM_ID } from '../store'
import type { DetClass, Detection, FaceRead, TrackedBox } from '../types'
import { computeFaces, faceState, MATCH_THRESHOLD, nearest } from '../people/faceEngine'
import { cvState, detect, loadDetector, onCvState, type DetectSource } from './detector'
import { stepTracks } from './tracker'

type SourceGetter = () => DetectSource | null

/* ── tunables ──────────────────────────────────────────────────────── */

/** scheduler heartbeat while the detector is ready */
const LOOP_MS = 70
/** heartbeat while the model is still loading / offline */
const LOOP_IDLE_MS = 600
/** webcam target interval = clamp(1.3 × last inference ms, MIN..MAX) */
const WEBCAM_MIN_MS = 90
const WEBCAM_MAX_MS = 360
/** bridged cameras round-robin at this interval */
const BRIDGED_MS = 420
/** a registered tile with no live frames yet is re-checked after this */
const NO_SOURCE_BACKOFF_MS = 300
/** bridged-camera face reads refresh once the newest read is older than this */
const RCAM_FACE_STALE_MS = 1500

/* ── registered sources + per-camera pacing ────────────────────────── */

const sources = new Map<string, SourceGetter>()
const order: string[] = []
/** wall-clock ms at/after which a camera is due for its next inference */
const nextDue = new Map<string, number>()
/** last inference duration per camera (ms) — paces the webcam */
const lastDur = new Map<string, number>()

/** rolling detection timestamps for detections/min */
const detTimes: number[] = []
/** per-camera last-seen time per class, for debounced appearance events */
const lastSeen = new Map<string, Map<DetClass, number>>()

const APPEAR_GAP_MS = 9000
const CLASS_LABEL: Record<DetClass, string> = {
  person: 'PERSON',
  vehicle: 'VEHICLE',
  animal: 'ANIMAL',
  package: 'PACKAGE',
  other: 'OBJECT',
}
const CLASS_SEV: Record<DetClass, 'INFO' | 'NOTICE'> = {
  person: 'NOTICE',
  vehicle: 'NOTICE',
  animal: 'INFO',
  package: 'NOTICE',
  other: 'INFO',
}

/** Whether some component currently feeds this camera's frames to detection. */
export function hasSource(cameraId: string): boolean {
  return sources.has(cameraId)
}

export function registerSource(cameraId: string, getter: SourceGetter): () => void {
  sources.set(cameraId, getter)
  if (!order.includes(cameraId)) order.push(cameraId)
  nextDue.set(cameraId, 0) // due immediately
  return () => {
    sources.delete(cameraId)
    const i = order.indexOf(cameraId)
    if (i >= 0) order.splice(i, 1)
    nextDue.delete(cameraId)
    lastDur.delete(cameraId)
    setDetections(cameraId, [])
    setTracks(cameraId, [])
  }
}

function nameFor(cameraId: string): string {
  const s = useHome.getState()
  if (cameraId === WEBCAM_ID) return 'OPERATOR CAM'
  return s.serverCameras.find((c) => c.id === cameraId)?.name ?? cameraId
}

function processEvents(cameraId: string, dets: Detection[]): void {
  const now = Date.now()
  const seen = lastSeen.get(cameraId) ?? new Map<DetClass, number>()
  const classes = new Set(dets.map((d) => d.cls))
  for (const cls of classes) {
    const last = seen.get(cls) ?? 0
    if (now - last > APPEAR_GAP_MS) {
      const count = dets.filter((d) => d.cls === cls).length
      const emit = useHome.getState().emit
      emit(CLASS_SEV[cls], cls === 'person' ? 'PERSON' : 'DETECTION', `${CLASS_LABEL[cls]}${count > 1 ? ` ×${count}` : ''} DETECTED · ${nameFor(cameraId)}`, {
        cameraId,
      })
    }
    seen.set(cls, now)
  }
  lastSeen.set(cameraId, seen)
}

/* ── cadence ───────────────────────────────────────────────────────── */

function intervalFor(cameraId: string): number {
  if (cameraId === WEBCAM_ID) {
    const dur = lastDur.get(cameraId) ?? WEBCAM_MIN_MS
    return Math.max(WEBCAM_MIN_MS, Math.min(WEBCAM_MAX_MS, 1.3 * dur))
  }
  return BRIDGED_MS
}

const sameBox = (a: [number, number, number, number], b: [number, number, number, number]): boolean =>
  a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3]

/* ── bridged-camera face reads (identity on IP cameras too) ────────── */

let faceJobBusy = false
const lastFaceAttempt = new Map<string, number>()

function maybeBridgedFaces(cameraId: string, src: DetectSource, tracks: TrackedBox[]): void {
  if (cameraId === WEBCAM_ID) return // the face watch owns the webcam
  if (faceJobBusy || faceState() !== 'ready') return
  if (!tracks.some((t) => t.cls === 'person')) return
  const now = Date.now()
  let newest = 0
  for (const r of getFaceReads(cameraId)) if (r.ts > newest) newest = r.ts
  if (now - newest <= RCAM_FACE_STALE_MS) return
  if (now - (lastFaceAttempt.get(cameraId) ?? 0) <= RCAM_FACE_STALE_MS) return
  lastFaceAttempt.set(cameraId, now)
  faceJobBusy = true
  void (async () => {
    try {
      const faces = await computeFaces(src.el)
      const ts = Date.now()
      const people = useHome.getState().people
      const reads: FaceRead[] = faces.map((f) => {
        const near = nearest(f.descriptor, people)
        return {
          box: f.box,
          personId: near !== null && near.distance <= MATCH_THRESHOLD ? near.personId : null,
          distance: near !== null ? near.distance : null,
          ts,
        }
      })
      setFaceReads(cameraId, reads)
    } catch {
      /* best-effort — a face hiccup must never disturb detection */
    } finally {
      faceJobBusy = false
    }
  })()
}

/* ── per-camera inference + fusion ─────────────────────────────────── */

async function runCamera(cameraId: string, src: DetectSource): Promise<void> {
  // stamp the frame at CAPTURE time — the box the model returns describes the
  // world as of now, not as of when inference finishes. Tracks carrying the
  // capture timestamp let the overlay's velocity prediction cover the full
  // model latency, which is what makes the box stick to a moving person.
  const captureTs = Date.now()
  const t0 = performance.now()
  const dets = await detect(cameraId, src)
  lastDur.set(cameraId, Math.max(1, performance.now() - t0))
  const done = Date.now()
  nextDue.set(cameraId, done + intervalFor(cameraId))

  // temporal tracking + identity fusion → the overlay's data
  const tracks = stepTracks(getTracks(cameraId), dets, getFaceReads(cameraId), useHome.getState().people, {
    now: captureTs,
    faceEngineReady: faceState() === 'ready',
    cameraId,
  })
  setTracks(cameraId, tracks)

  // fused raw detections → the zone watch's data: attach the KNOWN person of
  // the track each raw det landed on (matched tracks carry the det's exact
  // box this frame), so a known-household breach downgrades correctly.
  const fused = dets.map((d) => {
    if (d.cls !== 'person') return d
    const t = tracks.find(
      (tr) => tr.cls === 'person' && tr.updatedAt === captureTs && tr.identity === 'known' && sameBox(tr.box, d.box),
    )
    return t !== undefined && t.personId !== null ? { ...d, personId: t.personId } : d
  })
  setDetections(cameraId, fused)

  if (dets.length > 0) {
    for (let i = 0; i < dets.length; i++) detTimes.push(done)
    processEvents(cameraId, dets)
  }

  maybeBridgedFaces(cameraId, src, tracks)
}

/* ── metrics ───────────────────────────────────────────────────────── */

let lastReportOnline: boolean | null = null
let lastReportPerMin = -1

function reportMetrics(): void {
  const cutoff = Date.now() - 60_000
  while (detTimes.length && detTimes[0] < cutoff) detTimes.shift()
  const online = cvState() === 'ready'
  const perMin = detTimes.length
  if (online === lastReportOnline && perMin === lastReportPerMin) return
  lastReportOnline = online
  lastReportPerMin = perMin
  useHome.getState().reportCv(online, perMin)
}

/* ── the loop ──────────────────────────────────────────────────────── */

let running = false
let timer: ReturnType<typeof setTimeout> | null = null
let offState: (() => void) | null = null

async function tick(): Promise<void> {
  if (!running) return
  try {
    if (cvState() === 'ready' && order.length > 0) {
      const now = Date.now()
      // most-overdue due camera with a live source; the webcam wins ties
      let pickId: string | null = null
      let pickSrc: DetectSource | null = null
      let pickOver = -1
      for (const id of order) {
        const over = now - (nextDue.get(id) ?? 0)
        if (over < 0) continue
        const src = sources.get(id)?.() ?? null
        if (!src) {
          nextDue.set(id, now + NO_SOURCE_BACKOFF_MS)
          continue
        }
        if (over > pickOver || (over === pickOver && id === WEBCAM_ID)) {
          pickId = id
          pickSrc = src
          pickOver = over
        }
      }
      // one inference at a time — the loop awaits before rescheduling
      if (pickId !== null && pickSrc !== null) await runCamera(pickId, pickSrc)
    }
    reportMetrics()
  } catch {
    /* no throw may escape the loop */
  }
  if (!running) return
  timer = setTimeout(() => void tick(), cvState() === 'ready' ? LOOP_MS : LOOP_IDLE_MS)
}

export function startDetection(): void {
  if (running) return
  running = true
  offState = onCvState((s) => {
    const st = useHome.getState()
    if (s === 'ready') st.emit('NOTICE', 'SYSTEM', 'DETECTION ONLINE · ON-DEVICE CV ACTIVE')
    else if (s === 'offline') st.emit('WARN', 'SYSTEM', 'DETECTION OFFLINE · CV MODEL UNAVAILABLE')
    lastReportOnline = null // force a fresh report on state change
    st.reportCv(s === 'ready', detTimes.length)
  })
  void loadDetector()
  void tick()
}

export function stopDetection(): void {
  running = false
  if (timer) clearTimeout(timer)
  timer = null
  offState?.()
  offState = null
}

// HMR: never stack loops across dev reloads.
if (import.meta.hot) {
  import.meta.hot.dispose(() => stopDetection())
}
