/**
 * PANOPTICON // HOMEWATCH — background FACE WATCH.
 *
 * Runs a low-rate (~2Hz) loop over the Mac webcam, matching visible faces
 * against ENROLLED household members and maintaining a simple presence model:
 *
 *   • KNOWN face matched  → mark that person PRESENT + lastSeen, and emit a
 *     debounced NOTICE "<NAME> AT HOME · OPERATOR CAM" (≤ once / 30s / person).
 *   • face present, no match → emit a debounced WARN "UNKNOWN PERSON ·
 *     OPERATOR CAM" (≤ once / 20s). Never anything more specific than UNKNOWN.
 *   • no match for ~60s     → presence decays back to AWAY.
 *
 * Everything is local. The loop is fully guarded — a failure in any tick is
 * swallowed so the watch (and the app) never crash. If the face engine is
 * OFFLINE the loop simply idles (still decaying presence) until it recovers.
 */
import { useHome, WEBCAM_ID } from '../store'
import { computeDescriptor, faceState, loadFace, MATCH_THRESHOLD, nearest, onFaceState } from './faceEngine'

/* ── tunables ──────────────────────────────────────────────────────── */

const TICK_READY_MS = 500 // ~2Hz while the engine is ready
const TICK_IDLE_MS = 1500 // slower poll while engine loading/offline
const PRESENT_EVENT_MS = 30_000 // debounce: "<name> at home" per person
const UNKNOWN_EVENT_MS = 20_000 // debounce: "unknown person"
const PRESENCE_DECAY_MS = 60_000 // no match for this long → AWAY

/* ── shared webcam singleton (browser-local; never uploaded) ───────── */

let stream: MediaStream | null = null
let streamPromise: Promise<MediaStream> | null = null
let video: HTMLVideoElement | null = null

/**
 * Acquire (once) the shared getUserMedia stream. De-duped so the People view's
 * preview and this watch loop share ONE camera track. Rejects if the webcam is
 * unavailable / denied — callers handle their own fallback UI.
 */
export function getFaceStream(): Promise<MediaStream> {
  if (stream) return Promise.resolve(stream)
  if (streamPromise) return streamPromise
  streamPromise = navigator.mediaDevices
    .getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 480 } }, audio: false })
    .then((s) => {
      stream = s
      streamPromise = null
      return s
    })
    .catch((e) => {
      streamPromise = null
      throw e
    })
  return streamPromise
}

/** A hidden, offscreen <video> the watch loop reads frames from. */
function ensureVideo(): HTMLVideoElement {
  if (video) return video
  const el = document.createElement('video')
  el.muted = true
  el.playsInline = true
  el.setAttribute('playsinline', '')
  el.setAttribute('aria-hidden', 'true')
  el.style.cssText =
    'position:fixed;left:-9999px;top:-9999px;width:2px;height:2px;opacity:0;pointer-events:none;'
  document.body.appendChild(el)
  video = el
  return el
}

async function initWebcam(): Promise<void> {
  try {
    const s = await getFaceStream()
    const el = ensureVideo()
    if (el.srcObject !== s) el.srcObject = s
    await el.play().catch(() => undefined)
  } catch {
    /* webcam unavailable — the loop idles; the People view shows its own state */
  }
}

/* ── presence + event debouncing ───────────────────────────────────── */

const lastKnownEvent = new Map<string, number>()
let lastUnknownEvent = 0

function markPresent(personId: string): void {
  const st = useHome.getState()
  const p = st.people.find((x) => x.id === personId)
  if (!p) return
  const now = Date.now()
  st.upsertPerson({ ...p, present: true, lastSeen: now, lastCameraId: WEBCAM_ID })

  const last = lastKnownEvent.get(personId) ?? 0
  if (now - last > PRESENT_EVENT_MS) {
    lastKnownEvent.set(personId, now)
    st.emit('NOTICE', 'PERSON', `${p.name.toUpperCase()} AT HOME · OPERATOR CAM`, { personId })
  }
}

function emitUnknown(): void {
  const now = Date.now()
  if (now - lastUnknownEvent < UNKNOWN_EVENT_MS) return
  lastUnknownEvent = now
  // KNOWN-vs-UNKNOWN only — never any stronger label than "unknown person".
  useHome.getState().emit('WARN', 'PERSON', 'UNKNOWN PERSON · OPERATOR CAM')
}

function decayPresence(): void {
  const st = useHome.getState()
  const now = Date.now()
  for (const p of st.people) {
    if (p.present && (p.lastSeen === undefined || now - p.lastSeen > PRESENCE_DECAY_MS)) {
      st.upsertPerson({ ...p, present: false })
      st.emit('INFO', 'PERSON', `${p.name.toUpperCase()} LEFT · OPERATOR CAM`, { personId: p.id })
    }
  }
}

/* ── the loop ──────────────────────────────────────────────────────── */

let running = false
let timer: ReturnType<typeof setTimeout> | null = null
let offState: (() => void) | null = null

async function step(): Promise<void> {
  // presence decays regardless of engine/camera health
  decayPresence()

  const st = useHome.getState()

  if (faceState() !== 'ready') {
    st.reportFace(null)
    return
  }
  // if the hidden frame source isn't live yet, (re)acquire it — this recovers
  // the case where camera permission was granted after the watch first started.
  const v = video
  if (!v || v.readyState < 2 || v.videoWidth === 0) {
    st.reportFace(null)
    void initWebcam()
    return
  }

  const descriptor = await computeDescriptor(v)
  if (!descriptor) {
    // engine ready + camera live, but no face in the frame
    st.reportFace({ ts: Date.now(), present: false, personId: null, nearestId: null, distance: null })
    return
  }

  const people = useHome.getState().people
  const near = nearest(descriptor, people)
  const matched = near !== null && near.distance <= MATCH_THRESHOLD ? near : null

  // publish the live read so PEOPLE can SHOW recognition happening in real time
  useHome.getState().reportFace({
    ts: Date.now(),
    present: true,
    personId: matched?.personId ?? null,
    nearestId: near?.personId ?? null,
    distance: near?.distance ?? null,
  })

  if (matched) markPresent(matched.personId)
  else emitUnknown() // KNOWN-vs-UNKNOWN only — never a stronger label
}

async function tick(): Promise<void> {
  if (!running) return
  try {
    await step()
  } catch {
    /* never let a bad frame kill the watch */
  }
  if (!running) return
  const delay = faceState() === 'ready' ? TICK_READY_MS : TICK_IDLE_MS
  timer = setTimeout(() => void tick(), delay)
}

/**
 * Start the background watch: kicks off model loading + webcam acquisition and
 * begins the presence loop. Idempotent. Safe to call at app startup.
 */
export function startFaceWatch(): void {
  if (running) return
  running = true

  offState = onFaceState((s) => {
    const st = useHome.getState()
    if (s === 'ready') st.emit('NOTICE', 'SYSTEM', 'FACE ENGINE ONLINE · KNOWN VS UNKNOWN · ON-DEVICE')
    else if (s === 'offline') st.emit('WARN', 'SYSTEM', 'FACE ENGINE OFFLINE · MODEL UNAVAILABLE')
  })

  void loadFace()
  void initWebcam()
  void tick()
}

/** Stop the presence loop (leaves the shared stream intact for the UI). */
export function stopFaceWatch(): void {
  running = false
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  offState?.()
  offState = null
}

// HMR: tear the loop down cleanly so dev reloads don't stack timers.
if (import.meta.hot) {
  import.meta.hot.dispose(() => stopFaceWatch())
}
