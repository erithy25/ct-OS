/**
 * PANOPTICON // HOMEWATCH — on-device FACE ENGINE.
 *
 * Loads @vladmandic/face-api (tfjs) and computes 128-d face descriptors
 * ENTIRELY in the browser. Nothing — no frame, no descriptor — ever leaves
 * this machine. The engine only ever answers ONE question: does a face match
 * an ENROLLED, CONSENTED household member (KNOWN, by name) or not (UNKNOWN).
 * It never scores, ranks, or judges a person. There is no "threat" concept.
 *
 * Every entry point is guarded: if the models can't load (e.g. the CDN is
 * unreachable) the engine parks in a persistent OFFLINE state and every
 * compute call safely returns null. Nothing throws to the caller.
 */
import type { Person } from '../types'

/** Lazily-loaded module type — importing defers the heavy tfjs bundle. */
type FaceApi = typeof import('@vladmandic/face-api')

export type FaceState = 'idle' | 'loading' | 'ready' | 'offline'

/** Where the pretrained weights live (blocked in this sandbox → OFFLINE). */
const MODEL_URL = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model'

/**
 * Euclidean distance in the 128-d descriptor space below which two faces are
 * treated as the same person. 0.5 is the community-standard operating point
 * for face-api descriptors — low false-accept, forgiving of lighting/pose.
 */
export const MATCH_THRESHOLD = 0.5

/** Detector tuning — modest input size keeps the ~2Hz watch loop light. */
const DETECT_INPUT_SIZE = 320
const DETECT_SCORE = 0.4

let faceapi: FaceApi | null = null
let state: FaceState = 'idle'
let loadPromise: Promise<boolean> | null = null
const listeners = new Set<(s: FaceState) => void>()

export function faceState(): FaceState {
  return state
}

/** Subscribe to engine-state transitions. Returns an unsubscribe fn. */
export function onFaceState(fn: (s: FaceState) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function setState(s: FaceState): void {
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
 * Load the three nets (tiny detector + 68 landmarks + recognition). Idempotent
 * and de-duped: concurrent callers share one in-flight attempt. Resolves to
 * `true` when the engine is ready, `false` when it has parked OFFLINE. Calling
 * again after an OFFLINE result starts a fresh attempt (this is the retry).
 */
export function loadFace(): Promise<boolean> {
  if (state === 'ready') return Promise.resolve(true)
  if (state === 'loading' && loadPromise) return loadPromise

  setState('loading')
  loadPromise = (async () => {
    try {
      const api = await import('@vladmandic/face-api')
      await Promise.all([
        api.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
        api.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
        api.nets.faceRecognitionNet.loadFromUri(MODEL_URL),
      ])
      // sanity: all three must report loaded
      const ok =
        api.nets.tinyFaceDetector.isLoaded &&
        api.nets.faceLandmark68Net.isLoaded &&
        api.nets.faceRecognitionNet.isLoaded
      if (!ok) throw new Error('nets did not load')
      faceapi = api
      setState('ready')
      return true
    } catch {
      faceapi = null
      setState('offline')
      return false
    }
  })()
  return loadPromise
}

/** Explicit retry alias for the UI — re-attempts a fresh model load. */
export function retryFace(): Promise<boolean> {
  return loadFace()
}

/**
 * Detect the single LARGEST face in a frame and return its 128-d descriptor,
 * or null if there is no usable face / the engine isn't ready. A non-null
 * result means "a face is present"; the caller decides KNOWN vs UNKNOWN.
 * Fully guarded — never throws.
 */
export async function computeDescriptor(
  input: HTMLVideoElement | HTMLImageElement | HTMLCanvasElement,
): Promise<Float32Array | null> {
  const api = faceapi
  if (!api || state !== 'ready') return null
  try {
    // frame must actually have pixels
    if (input instanceof HTMLVideoElement) {
      if (input.readyState < 2 || input.videoWidth === 0 || input.videoHeight === 0) return null
    } else if (input instanceof HTMLImageElement) {
      if (!input.complete || input.naturalWidth === 0) return null
    }

    const options = new api.TinyFaceDetectorOptions({
      inputSize: DETECT_INPUT_SIZE,
      scoreThreshold: DETECT_SCORE,
    })
    const results = await api.detectAllFaces(input, options).withFaceLandmarks().withFaceDescriptors()
    if (!results.length) return null

    let largest = results[0]
    for (const r of results) {
      if (r.detection.box.area > largest.detection.box.area) largest = r
    }
    return largest.descriptor
  } catch {
    return null
  }
}

export interface MatchResult {
  personId: string
  distance: number
}

/**
 * Nearest enrolled person to a descriptor by Euclidean distance across ALL of
 * that person's stored samples. Returns null when the best distance exceeds
 * the threshold (→ UNKNOWN) or nobody is enrolled. Pure + synchronous.
 */
export function bestMatch(
  descriptor: Float32Array | number[],
  people: Person[],
  threshold: number = MATCH_THRESHOLD,
): MatchResult | null {
  let best: MatchResult | null = null
  for (const p of people) {
    for (const sample of p.descriptors) {
      if (!sample || sample.length !== descriptor.length) continue
      const dist = euclidean(descriptor, sample)
      if (best === null || dist < best.distance) best = { personId: p.id, distance: dist }
    }
  }
  if (best === null || best.distance > threshold) return null
  return best
}

/** Euclidean distance between two equal-length numeric vectors. */
export function euclidean(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let sum = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const d = a[i] - b[i]
    sum += d * d
  }
  return Math.sqrt(sum)
}

/** Convert a live descriptor to the plain-number form stored on a Person. */
export function toStored(descriptor: Float32Array): number[] {
  return Array.from(descriptor)
}
