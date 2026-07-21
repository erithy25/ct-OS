/**
 * ZONE WATCH — the real alerting loop behind drawn zones.
 *
 * A small background poller (~4 Hz) that reads the on-device detector's latest
 * boxes for every camera that has armed zones, and raises a LOCAL alert when a
 * PERSON's feet fall inside a zone polygon. It never talks to the network and
 * never uploads anything — it only reads `getDetections()` (populated by the CV
 * scheduler) and calls the store's `emit()`.
 *
 * Debounced to one breach per zone per ~12 s so a person lingering in-frame
 * doesn't spam the alert feed. Respects each zone's `alertOnEnter` and
 * `nightOnly` flags, and downgrades a *known household* person (matched
 * `personId`) from a WARN breach to a NOTICE entry.
 *
 * Detections come from a model that only runs on a real machine with the model
 * present; in the sandbox the detection map is simply empty and this loop is a
 * quiet no-op — but the logic below is correct against the `Detection` shape.
 */
import { getDetections, useHome, WEBCAM_ID } from '../store'
import type { Detection, Zone } from '../types'
import { boxBottomCenter, pointInPolygon } from './geometry'

/** poll cadence — ~4 Hz, matching the ask; cheap because it only reads memory */
const TICK_MS = 250
/** at most one breach event per zone per this window */
const BREACH_DEBOUNCE_MS = 12_000

/** zoneId -> last breach emit timestamp (ms) */
const lastBreach = new Map<string, number>()

let timer: ReturnType<typeof setInterval> | null = null
let running = false

/** Simple night test: local hour before 07:00 or after 20:00 (i.e. 21:00–06:59). */
function isNight(now: Date = new Date()): boolean {
  const hr = now.getHours()
  return hr < 7 || hr > 20
}

function cameraName(cameraId: string): string {
  if (cameraId === WEBCAM_ID) return 'OPERATOR CAM'
  const s = useHome.getState()
  return s.serverCameras.find((c) => c.id === cameraId)?.name ?? cameraId
}

function personName(personId: string): string {
  const p = useHome.getState().people.find((x) => x.id === personId)
  return p?.name ?? personId
}

/**
 * One evaluation pass. Fully guarded — a throw here must never kill the
 * interval, so the whole body is wrapped and per-camera reads are defensive.
 */
function tick(): void {
  try {
    const state = useHome.getState()
    const zones = state.zones
    if (zones.length === 0) return

    const now = Date.now()
    const night = isNight()

    // group the *eligible* zones (armed, schedule-active, valid ring) by camera
    const byCamera = new Map<string, Zone[]>()
    for (const z of zones) {
      if (!z.alertOnEnter) continue
      if (z.nightOnly && !night) continue
      if (!Array.isArray(z.points) || z.points.length < 3) continue
      const arr = byCamera.get(z.cameraId)
      if (arr) arr.push(z)
      else byCamera.set(z.cameraId, [z])
    }
    if (byCamera.size === 0) return

    for (const [cameraId, camZones] of byCamera) {
      let dets: Detection[]
      try {
        dets = getDetections(cameraId)
      } catch {
        continue
      }
      if (!dets || dets.length === 0) continue

      const persons = dets.filter((d) => d.cls === 'person')
      if (persons.length === 0) continue

      for (const zone of camZones) {
        // debounce per zone
        const last = lastBreach.get(zone.id) ?? 0
        if (now - last < BREACH_DEBOUNCE_MS) continue

        // who is standing inside this zone right now?
        let unknownInside = false
        let knownId: string | null = null
        for (const p of persons) {
          const feet = boxBottomCenter(p.box)
          if (pointInPolygon(feet, zone.points)) {
            if (p.personId) knownId = knownId ?? p.personId
            else unknownInside = true
          }
        }
        if (!unknownInside && !knownId) continue

        lastBreach.set(zone.id, now)
        const emit = useHome.getState().emit
        const cam = cameraName(cameraId)

        if (unknownInside) {
          // an unknown person outweighs a known one — raise the breach
          emit('WARN', 'ZONE', `ZONE BREACH · PERSON IN "${zone.name}" · ${cam}`, { cameraId })
        } else if (knownId) {
          const name = personName(knownId)
          emit('NOTICE', 'ZONE', `${name} ENTERED "${zone.name}" · ${cam}`, { cameraId, personId: knownId })
        }
      }
    }
  } catch {
    /* swallow — the watch loop must survive any single bad pass */
  }
}

/** Start the zone watch loop. Idempotent — a second call is a no-op. */
export function startZoneWatch(): void {
  if (running) return
  running = true
  timer = setInterval(tick, TICK_MS)
  // clean restart across Vite HMR so we never stack intervals
  if (import.meta.hot) {
    import.meta.hot.dispose(() => stopZoneWatch())
  }
}

/** Stop the loop and clear debounce state. */
export function stopZoneWatch(): void {
  running = false
  if (timer !== null) {
    clearInterval(timer)
    timer = null
  }
  lastBreach.clear()
}
