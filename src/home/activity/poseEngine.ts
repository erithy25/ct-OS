/**
 * PANOPTICON // HOMEWATCH — on-device POSE ENGINE.
 *
 * Loads the MediaPipe PoseLandmarker (lite) and reads 33 normalized body
 * landmarks from the operator-cam frame ENTIRELY in the browser. No frame and
 * no landmark ever leaves this machine. The engine feeds the smart brain's
 * NEUTRAL activity observations (sitting / standing / walking…) — it never
 * judges a person, and there is no "threat" concept anywhere downstream.
 *
 * Every entry point is guarded: if the wasm runtime or the model can't load
 * (e.g. the CDN is unreachable in a sandbox) the engine parks in a persistent
 * OFFLINE state and every detect call safely returns null. Nothing throws to
 * the caller. A GPU delegate is attempted first and falls back to CPU.
 */
import type { PoseEngineState } from '../types'

/** Lazily-loaded module type — importing defers the wasm-backed bundle. */
type Vision = typeof import('@mediapipe/tasks-vision')
type PoseLandmarkerInstance = import('@mediapipe/tasks-vision').PoseLandmarker

/** Where the wasm runtime lives (blocked in this sandbox → OFFLINE). */
const WASM_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21/wasm'
/** The lite pose model — smallest download, plenty for coarse activities. */
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task'

let landmarker: PoseLandmarkerInstance | null = null
let state: PoseEngineState = 'idle'
let loadPromise: Promise<boolean> | null = null
const listeners = new Set<(s: PoseEngineState) => void>()

/**
 * MediaPipe VIDEO mode requires STRICTLY increasing timestamps — a repeated or
 * backwards timestamp throws deep inside the wasm task. We clamp forward.
 */
let lastVideoTs = -1

export function poseState(): PoseEngineState {
  return state
}

/** Subscribe to engine-state transitions. Returns an unsubscribe fn. */
export function onPoseState(fn: (s: PoseEngineState) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function setState(s: PoseEngineState): void {
  if (s === state) return
  state = s
  for (const l of listeners) {
    try {
      l(s)
    } catch {
      /* a listener must never break the engine */
    }
  }
}

/**
 * Load the wasm fileset + pose model. Idempotent and de-duped: concurrent
 * callers share one in-flight attempt. Resolves `true` when READY, `false`
 * when parked OFFLINE. Calling again after an OFFLINE result starts a fresh
 * attempt (this is the retry).
 */
export function loadPose(): Promise<boolean> {
  if (state === 'ready') return Promise.resolve(true)
  if (state === 'loading' && loadPromise) return loadPromise

  setState('loading')
  loadPromise = (async () => {
    try {
      const vision: Vision = await import('@mediapipe/tasks-vision')
      const fileset = await vision.FilesetResolver.forVisionTasks(WASM_URL)
      let lm: PoseLandmarkerInstance
      try {
        lm = await vision.PoseLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
          runningMode: 'VIDEO',
          numPoses: 1,
        })
      } catch {
        // GPU delegate unavailable (headless / driverless) — retry on CPU
        lm = await vision.PoseLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: MODEL_URL, delegate: 'CPU' },
          runningMode: 'VIDEO',
          numPoses: 1,
        })
      }
      landmarker = lm
      lastVideoTs = -1
      setState('ready')
      return true
    } catch {
      landmarker = null
      setState('offline')
      return false
    }
  })()
  return loadPromise
}

/** Explicit retry alias for the UI — re-attempts a fresh model load. */
export function retryPose(): Promise<boolean> {
  return loadPose()
}

/** One normalized pose landmark (0..1 image coords; y grows downward). */
export interface PosePoint {
  x: number
  y: number
  z: number
  visibility: number
}

/**
 * Read the first pose's normalized landmarks from a live video frame, or null
 * when the engine isn't ready, the frame has no pixels yet, or no person is in
 * view. Fully guarded — never throws. `tsMs` is clamped to stay strictly
 * increasing (VIDEO-mode requirement); two calls in the same millisecond both
 * run, the second one nudged forward by 1ms.
 */
export function detectPose(video: HTMLVideoElement, tsMs: number): PosePoint[] | null {
  const lm = landmarker
  if (!lm || state !== 'ready') return null
  try {
    if (video.readyState < 2 || video.videoWidth === 0 || video.videoHeight === 0) return null
    const ts = tsMs > lastVideoTs ? tsMs : lastVideoTs + 1
    lastVideoTs = ts
    const result = lm.detectForVideo(video, ts)
    const first = result.landmarks?.[0]
    if (!first || first.length === 0) return null
    return first.map((p) => ({ x: p.x, y: p.y, z: p.z, visibility: p.visibility }))
  } catch {
    return null
  }
}
