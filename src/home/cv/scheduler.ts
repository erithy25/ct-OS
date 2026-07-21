/**
 * Detection scheduler — round-robins the shared detector across every
 * registered camera tile (~one inference at a time so many cameras don't melt
 * the CPU), stores results per camera, and raises debounced events. All local.
 */
import { setDetections, useHome } from '../store'
import type { DetClass, Detection } from '../types'
import { cvState, detect, loadDetector, onCvState, type DetectSource } from './detector'

type SourceGetter = () => DetectSource | null

const sources = new Map<string, SourceGetter>()
const order: string[] = []
let cursor = 0

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

export function registerSource(cameraId: string, getter: SourceGetter): () => void {
  sources.set(cameraId, getter)
  if (!order.includes(cameraId)) order.push(cameraId)
  return () => {
    sources.delete(cameraId)
    const i = order.indexOf(cameraId)
    if (i >= 0) order.splice(i, 1)
    setDetections(cameraId, [])
  }
}

function nameFor(cameraId: string): string {
  const s = useHome.getState()
  if (cameraId === 'CAM-01') return 'OPERATOR CAM'
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

let running = false
let timer: ReturnType<typeof setTimeout> | null = null
let offState: (() => void) | null = null

async function tick(): Promise<void> {
  if (!running) return
  if (cvState() === 'ready' && order.length > 0) {
    // pick the next source that currently has a live element
    for (let n = 0; n < order.length; n++) {
      cursor = (cursor + 1) % order.length
      const id = order[cursor]
      const src = sources.get(id)?.()
      if (!src) continue
      const dets = await detect(id, src)
      setDetections(id, dets)
      if (dets.length > 0) {
        const now = Date.now()
        for (let i = 0; i < dets.length; i++) detTimes.push(now)
        processEvents(id, dets)
      }
      break
    }
  }
  // metrics: detections in the last 60s → per-minute
  const cutoff = Date.now() - 60_000
  while (detTimes.length && detTimes[0] < cutoff) detTimes.shift()
  useHome.getState().reportCv(cvState() === 'ready', detTimes.length)

  timer = setTimeout(() => void tick(), cvState() === 'ready' ? 320 : 1200)
}

export function startDetection(): void {
  if (running) return
  running = true
  offState = onCvState((s) => {
    const st = useHome.getState()
    if (s === 'ready') st.emit('NOTICE', 'SYSTEM', 'DETECTION ONLINE · ON-DEVICE CV ACTIVE')
    else if (s === 'offline') st.emit('WARN', 'SYSTEM', 'DETECTION OFFLINE · CV MODEL UNAVAILABLE')
    st.reportCv(s === 'ready', detTimes.length)
  })
  void loadDetector()
  void tick()
}

export function stopDetection(): void {
  running = false
  if (timer) clearTimeout(timer)
  offState?.()
  offState = null
}
