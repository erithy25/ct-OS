/**
 * CAM-01 pipeline singletons — webcam MediaStream + COCO-SSD detector.
 *
 * Everything here is module-level so that switching views never re-prompts
 * for camera permission and never re-downloads a model. Tracks are NEVER
 * stopped on unmount; components merely pause processing (they unregister
 * their frame callback). All frames are processed locally in-browser —
 * nothing is uploaded anywhere.
 *
 * A tiny external-store bus (`cvSubscribe`/`cvVersion`) lets components
 * react to status changes via useSyncExternalStore.
 */

import type { DetectedObject, ObjectDetection } from '@tensorflow-models/coco-ssd'

export type WebcamStatus = 'idle' | 'requesting' | 'live' | 'denied'
export type ModelStatus = 'idle' | 'loading' | 'ready' | 'failed'

/* ── change bus (shared with faceMesh.ts) ──────────────────────────── */

let version = 0
const listeners = new Set<() => void>()

export function cvSubscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

export const cvVersion = (): number => version

export function cvNotify(): void {
  version++
  for (const fn of listeners) fn()
}

/* ── webcam stream singleton ───────────────────────────────────────── */

let stream: MediaStream | null = null
let webcamStatus: WebcamStatus = 'idle'
let webcamError = ''
let streamPromise: Promise<MediaStream | null> | null = null

export const getWebcamStatus = (): WebcamStatus => webcamStatus
export const getWebcamError = (): string => webcamError
export const getWebcamStream = (): MediaStream | null => stream

function watchTrackEnd(s: MediaStream): void {
  for (const track of s.getVideoTracks()) {
    track.addEventListener('ended', () => {
      if (stream !== s) return
      stream = null
      streamPromise = null
      webcamStatus = 'denied'
      webcamError = 'VIDEO TRACK TERMINATED'
      cvNotify()
    })
  }
}

/** Acquire (or return the already-acquired) webcam stream. Never throws. */
export function ensureWebcam(): Promise<MediaStream | null> {
  if (stream && webcamStatus === 'live') return Promise.resolve(stream)
  if (streamPromise) return streamPromise

  webcamStatus = 'requesting'
  webcamError = ''
  cvNotify()

  streamPromise = (async () => {
    try {
      if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
        throw new Error('MEDIA DEVICES UNAVAILABLE')
      }
      const s = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 } },
        audio: false,
      })
      stream = s
      webcamStatus = 'live'
      webcamError = ''
      watchTrackEnd(s)
      cvNotify()
      return s
    } catch (err) {
      stream = null
      streamPromise = null
      webcamStatus = 'denied'
      webcamError = err instanceof Error ? err.name.replace(/Error$/, '').toUpperCase() || 'DENIED' : 'DENIED'
      cvNotify()
      return null
    }
  })()

  return streamPromise
}

/** RETRY button — clears the denied state and re-calls getUserMedia. */
export function retryWebcam(): Promise<MediaStream | null> {
  if (webcamStatus === 'live' && stream) return Promise.resolve(stream)
  if (webcamStatus === 'requesting' && streamPromise) return streamPromise
  streamPromise = null
  webcamStatus = 'idle'
  return ensureWebcam()
}

/* ── COCO-SSD detector singleton ───────────────────────────────────── */

let detector: ObjectDetection | null = null
let detectorStatus: ModelStatus = 'idle'
let detectorPromise: Promise<ObjectDetection | null> | null = null

export const getDetectorStatus = (): ModelStatus => detectorStatus
export const getDetector = (): ObjectDetection | null => detector

/**
 * Load TFJS + COCO-SSD (code-split via dynamic import; model weights are
 * fetched from the TFJS model CDN at runtime). Never throws — a failure
 * parks the status at 'failed' so the tile can show a persistent
 * CV OFFLINE badge while still rendering raw video.
 */
export function ensureDetector(): Promise<ObjectDetection | null> {
  if (detector) return Promise.resolve(detector)
  if (detectorPromise) return detectorPromise

  detectorStatus = 'loading'
  cvNotify()

  detectorPromise = (async () => {
    try {
      const tf = await import('@tensorflow/tfjs')
      await tf.ready()
      const coco = await import('@tensorflow-models/coco-ssd')
      const model = await coco.load({ base: 'lite_mobilenet_v2' })
      detector = model
      detectorStatus = 'ready'
      cvNotify()
      return model
    } catch {
      detector = null
      detectorPromise = null
      detectorStatus = 'failed'
      cvNotify()
      return null
    }
  })()

  return detectorPromise
}

/* ── tracked-box smoothing (ease-follow so boxes don't jitter) ─────── */

export interface TrackedBox {
  /** smoothed, in source-video pixel space */
  x: number
  y: number
  w: number
  h: number
  cls: string
  score: number
  lastSeen: number
}

const LERP = 0.4
const TRACK_TTL_MS = 420

/**
 * Merge fresh detections into the persistent track list: matched tracks lerp
 * previous→new (~0.4), unmatched fresh detections spawn tracks, stale tracks
 * (unseen > TTL) drop. Mutates + returns `tracks`.
 */
export function mergeDetections(tracks: TrackedBox[], dets: DetectedObject[], now: number): TrackedBox[] {
  const claimed = new Set<TrackedBox>()
  for (const d of dets) {
    const [dx, dy, dw, dh] = d.bbox
    const cx = dx + dw / 2
    const cy = dy + dh / 2
    let best: TrackedBox | null = null
    let bestDist = Infinity
    for (const t of tracks) {
      if (claimed.has(t) || t.cls !== d.class) continue
      const dist = Math.hypot(t.x + t.w / 2 - cx, t.y + t.h / 2 - cy)
      if (dist < bestDist) {
        bestDist = dist
        best = t
      }
    }
    if (best && bestDist < Math.max(dw, dh) * 1.2) {
      best.x += (dx - best.x) * LERP
      best.y += (dy - best.y) * LERP
      best.w += (dw - best.w) * LERP
      best.h += (dh - best.h) * LERP
      best.score += (d.score - best.score) * LERP
      best.lastSeen = now
      claimed.add(best)
    } else {
      const t: TrackedBox = { x: dx, y: dy, w: dw, h: dh, cls: d.class, score: d.score, lastSeen: now }
      tracks.push(t)
      claimed.add(t)
    }
  }
  for (let i = tracks.length - 1; i >= 0; i--) {
    if (now - tracks[i].lastSeen > TRACK_TTL_MS) tracks.splice(i, 1)
  }
  return tracks
}
