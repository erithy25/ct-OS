/**
 * On-device object detector (COCO-SSD / TensorFlow.js). Runs entirely in the
 * browser — no frames ever leave the machine. Loaded once, shared across every
 * camera tile. Degrades to a clear "CV OFFLINE" state if the model can't load.
 */
import '@tensorflow/tfjs'
import * as cocoSsd from '@tensorflow-models/coco-ssd'
import type { DetClass, Detection } from '../types'

export type CvState = 'idle' | 'loading' | 'ready' | 'offline'

let model: cocoSsd.ObjectDetection | null = null
let state: CvState = 'idle'
let loadPromise: Promise<void> | null = null
const listeners = new Set<(s: CvState) => void>()

export function cvState(): CvState {
  return state
}
export function onCvState(fn: (s: CvState) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
function setState(s: CvState): void {
  state = s
  for (const l of listeners) l(s)
}

export function loadDetector(): Promise<void> {
  if (loadPromise) return loadPromise
  setState('loading')
  loadPromise = cocoSsd
    .load({ base: 'lite_mobilenet_v2' })
    .then((m) => {
      model = m
      setState('ready')
    })
    .catch(() => {
      model = null
      setState('offline')
    })
  return loadPromise
}

const VEHICLES = new Set(['bicycle', 'car', 'motorcycle', 'bus', 'truck', 'train', 'boat'])
const ANIMALS = new Set(['cat', 'dog', 'bird', 'horse', 'sheep', 'cow', 'bear', 'elephant', 'zebra', 'giraffe'])
const PACKAGES = new Set(['backpack', 'handbag', 'suitcase'])

export function classOf(cocoClass: string): DetClass {
  if (cocoClass === 'person') return 'person'
  if (VEHICLES.has(cocoClass)) return 'vehicle'
  if (ANIMALS.has(cocoClass)) return 'animal'
  if (PACKAGES.has(cocoClass)) return 'package'
  return 'other'
}

export interface DetectSource {
  el: HTMLVideoElement | HTMLImageElement | HTMLCanvasElement
  w: number
  h: number
}

/** Run detection on a source, returning normalized (0..1) boxes. */
export async function detect(cameraId: string, src: DetectSource, minScore = 0.5): Promise<Detection[]> {
  if (!model || src.w === 0 || src.h === 0) return []
  let raw: cocoSsd.DetectedObject[]
  try {
    raw = await model.detect(src.el, 12)
  } catch {
    return []
  }
  const now = Date.now()
  const out: Detection[] = []
  for (const d of raw) {
    if (d.score < minScore) continue
    const cls = classOf(d.class)
    if (cls === 'other') continue
    const [x, y, w, h] = d.bbox
    out.push({
      cameraId,
      cls,
      label: d.class.toUpperCase(),
      score: d.score,
      box: [x / src.w, y / src.h, w / src.w, h / src.h],
      personId: null,
      ts: now,
    })
  }
  return out
}
