/**
 * BIOMETRIC subsystem — MediaPipe FaceLandmarker singleton.
 *
 * The wasm runtime loads from the tasks-vision CDN and the .task model from
 * the MediaPipe model zoo; the model fetch goes through the Cache API
 * ('panopticon-cv') when available so repeat sessions don't re-download.
 * Everything is guarded — any failure parks status at 'failed' and the tile
 * shows BIOMETRIC OFFLINE while staying in COCO-SSD detection mode.
 *
 * All landmark processing is local; frames never leave the browser.
 */

import type { FaceLandmarker, NormalizedLandmark } from '@mediapipe/tasks-vision'
import { cvNotify, type ModelStatus } from './webcamCV'

export type { NormalizedLandmark }

/** structural stand-in for mediapipe's non-exported Connection interface */
export interface MeshConnection {
  start: number
  end: number
}

const WASM_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm'
export const FACE_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task'
const CACHE_NAME = 'panopticon-cv'

let landmarker: FaceLandmarker | null = null
let status: ModelStatus = 'idle'
let loadPromise: Promise<FaceLandmarker | null> | null = null
let tesselation: MeshConnection[] = []
let contours: MeshConnection[] = []

export const getFaceStatus = (): ModelStatus => status
export const getFaceLandmarker = (): FaceLandmarker | null => landmarker
export const getTesselation = (): MeshConnection[] => tesselation
export const getContours = (): MeshConnection[] => contours

/** Fetch the .task model bytes, Cache API first (best-effort at every step). */
async function fetchModelBytes(): Promise<Uint8Array | null> {
  try {
    if (typeof caches !== 'undefined') {
      const cache = await caches.open(CACHE_NAME)
      const hit = await cache.match(FACE_MODEL_URL)
      if (hit?.ok) return new Uint8Array(await hit.arrayBuffer())
      const res = await fetch(FACE_MODEL_URL)
      if (!res.ok) return null
      await cache.put(FACE_MODEL_URL, res.clone()).catch(() => undefined)
      return new Uint8Array(await res.arrayBuffer())
    }
    const res = await fetch(FACE_MODEL_URL)
    if (!res.ok) return null
    return new Uint8Array(await res.arrayBuffer())
  } catch {
    return null
  }
}

/**
 * Load (or return) the FaceLandmarker. Tries GPU delegate first, falls back
 * to CPU; tries cached model bytes first, falls back to a direct
 * modelAssetPath fetch by the wasm runtime. Never throws.
 */
export function ensureFaceLandmarker(): Promise<FaceLandmarker | null> {
  if (landmarker) return Promise.resolve(landmarker)
  if (loadPromise) return loadPromise

  status = 'loading'
  cvNotify()

  loadPromise = (async () => {
    try {
      const vision = await import('@mediapipe/tasks-vision')
      const fileset = await vision.FilesetResolver.forVisionTasks(WASM_BASE)
      const bytes = await fetchModelBytes()

      const create = (delegate: 'GPU' | 'CPU') =>
        vision.FaceLandmarker.createFromOptions(fileset, {
          baseOptions: bytes
            ? { modelAssetBuffer: bytes, delegate }
            : { modelAssetPath: FACE_MODEL_URL, delegate },
          runningMode: 'VIDEO',
          numFaces: 1,
        })

      let lm: FaceLandmarker
      try {
        lm = await create('GPU')
      } catch {
        lm = await create('CPU')
      }

      landmarker = lm
      tesselation = vision.FaceLandmarker.FACE_LANDMARKS_TESSELATION as MeshConnection[]
      contours = vision.FaceLandmarker.FACE_LANDMARKS_CONTOURS as MeshConnection[]
      status = 'ready'
      cvNotify()
      return lm
    } catch {
      landmarker = null
      loadPromise = null
      status = 'failed'
      cvNotify()
      return null
    }
  })()

  return loadPromise
}

/** Manual re-attempt after a failure (BIOMETRIC button pressed again). */
export function retryFaceLandmarker(): Promise<FaceLandmarker | null> {
  if (status === 'failed') {
    loadPromise = null
    status = 'idle'
  }
  return ensureFaceLandmarker()
}
