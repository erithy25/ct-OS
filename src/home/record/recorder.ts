/**
 * PANOPTICON // HOMEWATCH — EVENT RECORDER.
 *
 * Watches every camera (~2 Hz) and records ONLY while a trigger holds — an
 * unknown person in view, a WARN-grade vehicle situation, or (on bridged
 * cameras while the face engine can't judge) any unverified person. When the
 * scene stays clear for a grace period the clip is finalized into IndexedDB
 * where the ALERTS view lists it for playback / download / delete.
 *
 * Sources:
 *   · operator webcam → the face watch's shared getUserMedia stream;
 *   · bridged cameras → a hidden always-on <img> per camera (its own MJPEG
 *     connection) pumped into a canvas → canvas.captureStream().
 * The hidden elements double as DETECTION sources whenever the Live Wall is
 * not mounted, so detection — and therefore triggering — keeps running on
 * every view, not just the wall.
 *
 * Everything is local: MediaRecorder output never leaves the browser. Every
 * path is guarded; an unsupported MediaRecorder degrades to one WARN event.
 */
import { API_ORIGIN, getTracks, useHome, WEBCAM_ID } from '../store'
import { cameraStreamUrl } from '../../realworld/contract'
import type { ClipMeta } from '../types'
import { faceState } from '../people/faceEngine'
import { getFaceStream, getFaceVideo } from '../people/faceWatch'
import { hasSource, registerSource } from '../cv/scheduler'
import { addClip } from './clipStore'
import { recordTrigger } from './trigger'

/* ── tunables ──────────────────────────────────────────────────────── */

/** watch cadence */
const LOOP_MS = 500
/** keep recording this long after the last trigger before finalizing */
const STOP_GRACE_MS = 8000
/** hard clip cap — if still triggered, the next loop starts a fresh clip */
const MAX_CLIP_MS = 180_000
/** MediaRecorder chunk cadence */
const TIMESLICE_MS = 1000
/** canvas pump rate for bridged cameras */
const PUMP_FPS = 8
/** clips shorter than this with almost no data are discarded as false starts */
const MIN_KEEP_MS = 1500
const MIN_KEEP_BYTES = 50 * 1024

const MIME_CANDIDATES = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4']

/* ── per-camera machinery ──────────────────────────────────────────── */

interface HiddenFeed {
  img: HTMLImageElement
  canvas: HTMLCanvasElement
  ctx: CanvasRenderingContext2D | null
  stream: MediaStream | null
  pump: ReturnType<typeof setInterval> | null
  unregister: (() => void) | null
  lastErrorAt: number
}

interface RecState {
  recorder: MediaRecorder
  chunks: Blob[]
  startedAt: number
  trigger: string
  lastDangerAt: number
  cameraName: string
  thumb?: string
  /** guards double-finalize (onstop vs explicit stop) */
  finalized: boolean
}

const feeds = new Map<string, HiddenFeed>()
const recs = new Map<string, RecState>()
let webcamUnregister: (() => void) | null = null

let running = false
let timer: ReturnType<typeof setTimeout> | null = null
let mime: string | null | undefined // undefined = not probed yet
let warnedUnsupported = false

/* ── helpers ───────────────────────────────────────────────────────── */

function pickMime(): string | null {
  if (mime !== undefined) return mime
  mime = null
  try {
    if (typeof MediaRecorder !== 'undefined') {
      for (const m of MIME_CANDIDATES) {
        if (MediaRecorder.isTypeSupported(m)) {
          mime = m
          break
        }
      }
    }
  } catch {
    mime = null
  }
  return mime
}

function cameraName(cameraId: string): string {
  if (cameraId === WEBCAM_ID) return 'OPERATOR CAM'
  return useHome.getState().serverCameras.find((c) => c.id === cameraId)?.name ?? cameraId
}

/** Small jpeg poster grabbed from the live source at record start. Guarded. */
function grabThumb(el: HTMLVideoElement | HTMLImageElement): string | undefined {
  try {
    const w = 160
    const sw = el instanceof HTMLVideoElement ? el.videoWidth : el.naturalWidth
    const sh = el instanceof HTMLVideoElement ? el.videoHeight : el.naturalHeight
    if (!sw || !sh) return undefined
    const c = document.createElement('canvas')
    c.width = w
    c.height = Math.round((w * sh) / sw)
    c.getContext('2d')?.drawImage(el, 0, 0, c.width, c.height)
    return c.toDataURL('image/jpeg', 0.6)
  } catch {
    return undefined
  }
}

/* ── hidden always-on feeds for bridged cameras ────────────────────── */

function ensureFeed(cameraId: string): HiddenFeed {
  let f = feeds.get(cameraId)
  if (f) return f
  const img = document.createElement('img')
  img.crossOrigin = 'anonymous'
  img.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:2px;height:2px;'
  img.setAttribute('aria-hidden', 'true')
  img.src = cameraStreamUrl(API_ORIGIN, cameraId)
  document.body.appendChild(img)
  const canvas = document.createElement('canvas')
  f = { img, canvas, ctx: canvas.getContext('2d'), stream: null, pump: null, unregister: null, lastErrorAt: 0 }
  img.onerror = () => {
    if (!f) return
    f.lastErrorAt = Date.now()
  }
  feeds.set(cameraId, f)
  return f
}

function dropFeed(cameraId: string): void {
  const f = feeds.get(cameraId)
  if (!f) return
  if (f.pump) clearInterval(f.pump)
  f.stream?.getTracks().forEach((t) => t.stop())
  f.unregister?.()
  try {
    f.img.src = ''
    f.img.remove()
  } catch {
    /* ignore */
  }
  feeds.delete(cameraId)
}

/** Keep detection fed on EVERY view: register hidden elements when needed. */
function ensureDetectionSources(): void {
  // webcam: the face watch's hidden <video> works as a COCO source too
  if (!hasSource(WEBCAM_ID)) {
    webcamUnregister = registerSource(WEBCAM_ID, () => {
      const v = getFaceVideo()
      if (!v || v.readyState < 2 || v.videoWidth === 0) return null
      return { el: v, w: v.videoWidth, h: v.videoHeight }
    })
  }
  for (const cam of useHome.getState().serverCameras) {
    if (cam.status !== 'live') continue
    const f = ensureFeed(cam.id)
    if (!hasSource(cam.id)) {
      f.unregister = registerSource(cam.id, () => {
        const el = f.img
        if (!el.complete || el.naturalWidth === 0) return null
        return { el, w: el.naturalWidth, h: el.naturalHeight }
      })
    }
    // MJPEG <img> occasionally dies — nudge it back after errors
    if (f.lastErrorAt && Date.now() - f.lastErrorAt > 5000) {
      f.lastErrorAt = 0
      f.img.src = cameraStreamUrl(API_ORIGIN, cam.id)
    }
  }
  // drop feeds of removed cameras
  const liveIds = new Set(useHome.getState().serverCameras.map((c) => c.id))
  for (const id of [...feeds.keys()]) if (!liveIds.has(id)) dropFeed(id)
}

/* ── capture streams ───────────────────────────────────────────────── */

async function streamFor(cameraId: string): Promise<MediaStream | null> {
  try {
    if (cameraId === WEBCAM_ID) return await getFaceStream()
    const f = ensureFeed(cameraId)
    if (!f.ctx || !f.img.complete || f.img.naturalWidth === 0) return null
    if (!f.stream) {
      f.canvas.width = Math.min(960, f.img.naturalWidth)
      f.canvas.height = Math.round((f.canvas.width * f.img.naturalHeight) / f.img.naturalWidth)
      f.pump = setInterval(() => {
        try {
          if (f.img.complete && f.img.naturalWidth > 0) f.ctx?.drawImage(f.img, 0, 0, f.canvas.width, f.canvas.height)
        } catch {
          /* a bad frame must not kill the pump */
        }
      }, Math.round(1000 / PUMP_FPS))
      f.stream = f.canvas.captureStream(PUMP_FPS)
    }
    return f.stream
  } catch {
    return null
  }
}

function sourceEl(cameraId: string): HTMLVideoElement | HTMLImageElement | null {
  if (cameraId === WEBCAM_ID) return getFaceVideo()
  return feeds.get(cameraId)?.img ?? null
}

/* ── record lifecycle ──────────────────────────────────────────────── */

async function startClip(cameraId: string, trigger: string): Promise<void> {
  const m = pickMime()
  if (!m) {
    if (!warnedUnsupported) {
      warnedUnsupported = true
      useHome.getState().emit('WARN', 'SYSTEM', 'AUTO-RECORD UNAVAILABLE · MediaRecorder UNSUPPORTED IN THIS BROWSER')
    }
    return
  }
  const stream = await streamFor(cameraId)
  if (!stream || recs.has(cameraId)) return
  let recorder: MediaRecorder
  try {
    recorder = new MediaRecorder(stream, { mimeType: m, videoBitsPerSecond: 2_500_000 })
  } catch {
    return
  }
  const now = Date.now()
  const st: RecState = {
    recorder,
    chunks: [],
    startedAt: now,
    trigger,
    lastDangerAt: now,
    cameraName: cameraName(cameraId),
    thumb: undefined,
    finalized: false,
  }
  const el = sourceEl(cameraId)
  if (el) st.thumb = grabThumb(el)
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) st.chunks.push(e.data)
  }
  recorder.onstop = () => void finalizeClip(cameraId, st)
  recorder.onerror = () => {
    try {
      if (recorder.state !== 'inactive') recorder.stop()
    } catch {
      void finalizeClip(cameraId, st)
    }
  }
  try {
    recorder.start(TIMESLICE_MS)
  } catch {
    return
  }
  recs.set(cameraId, st)
  const s = useHome.getState()
  s.setRecording(cameraId, true)
  s.emit('NOTICE', 'CAMERA', `⏺ AUTO-RECORDING · ${trigger} · ${st.cameraName}`, { cameraId })
}

async function finalizeClip(cameraId: string, st: RecState): Promise<void> {
  if (st.finalized) return
  st.finalized = true
  recs.delete(cameraId)
  const s = useHome.getState()
  s.setRecording(cameraId, false)
  try {
    const endedAt = Date.now()
    const durMs = endedAt - st.startedAt
    const blob = new Blob(st.chunks, { type: st.recorder.mimeType || 'video/webm' })
    if (durMs < MIN_KEEP_MS && blob.size < MIN_KEEP_BYTES) return // false start
    const meta: ClipMeta = {
      id: `CLIP-${st.startedAt.toString(36).toUpperCase()}-${cameraId}`,
      cameraId,
      cameraName: st.cameraName,
      trigger: st.trigger,
      startedAt: st.startedAt,
      endedAt,
      durMs,
      mime: blob.type,
      size: blob.size,
      thumb: st.thumb,
    }
    const ok = await addClip(meta, blob)
    if (ok) {
      s.bumpClips()
      s.emit('NOTICE', 'CAMERA', `RECORDING SAVED · ${Math.round(durMs / 1000)}s · ${st.cameraName}`, { cameraId })
    }
  } catch {
    /* saving must never crash the watch */
  }
}

function requestStop(cameraId: string): void {
  const st = recs.get(cameraId)
  if (!st) return
  try {
    if (st.recorder.state !== 'inactive') st.recorder.stop() // onstop → finalize
    else void finalizeClip(cameraId, st)
  } catch {
    void finalizeClip(cameraId, st)
  }
}

/* ── the watch loop ────────────────────────────────────────────────── */

async function tick(): Promise<void> {
  if (!running) return
  try {
    ensureDetectionSources()

    const s = useHome.getState()
    const now = Date.now()
    const engineReady = faceState() === 'ready'
    const situations = s.brain?.situations ?? []
    const cams: { id: string; isWebcam: boolean }[] = [
      { id: WEBCAM_ID, isWebcam: true },
      ...s.serverCameras.filter((c) => c.status === 'live').map((c) => ({ id: c.id, isWebcam: false })),
    ]

    for (const cam of cams) {
      const trigger = recordTrigger({
        now,
        isWebcam: cam.isWebcam,
        faceEngineReady: engineReady,
        tracks: getTracks(cam.id),
        situations: situations.filter((x) => x.cameraId === cam.id),
      })
      const st = recs.get(cam.id)
      if (!st) {
        if (trigger) await startClip(cam.id, trigger)
        continue
      }
      if (trigger) st.lastDangerAt = now
      if (now - st.startedAt > MAX_CLIP_MS) {
        requestStop(cam.id) // cap reached — next loop re-arms if still triggered
      } else if (!trigger && now - st.lastDangerAt > STOP_GRACE_MS) {
        requestStop(cam.id)
      }
    }
    // cameras that vanished while recording
    for (const id of [...recs.keys()]) {
      if (id !== WEBCAM_ID && !s.serverCameras.some((c) => c.id === id)) requestStop(id)
    }
  } catch {
    /* the watch survives any single bad pass */
  }
  if (!running) return
  timer = setTimeout(() => void tick(), LOOP_MS)
}

/* ── lifecycle ─────────────────────────────────────────────────────── */

export function startRecorder(): void {
  if (running) return
  running = true
  void tick()
}

export function stopRecorder(): void {
  running = false
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  for (const id of [...recs.keys()]) requestStop(id)
  for (const id of [...feeds.keys()]) dropFeed(id)
  webcamUnregister?.()
  webcamUnregister = null
}

// HMR: never leak recorders / hidden feeds across dev reloads.
if (import.meta.hot) {
  import.meta.hot.dispose(() => stopRecorder())
}
