/**
 * PANOPTICON // HOMEWATCH — the SITUATION engine (context fusion).
 *
 * Pure, deterministic detection of observable SITUATIONS by fusing person
 * tracks, object tracks and drawn zones: a person waiting at the ENTRY (may
 * be ringing the bell), a person at / lingering at / crouching next to a
 * detected vehicle, a package resting at the entry. Situations state WHAT IS
 * OBSERVABLE — never intent and never judgement: the only identity claim is
 * KNOWN vs UNKNOWN, and the wording downstream stays factual and calm.
 *
 * Everything is injected: time arrives via `ContextInput.now`, tracks and
 * zones via maps, committed activities via the brain. No Date.now(), no
 * store reads — the whole engine is unit-testable with synthetic fixtures.
 *
 * DWELL MODEL. Every candidate condition is tracked in a ContextState entry
 * keyed by a stable id (`entry:${cam}:${trackId}`,
 * `vehicle:${cam}:${personTrackId}:${vehicleTrackId}`, …). A condition is
 * treated as holding CONTINUOUSLY while the gaps between passes where it
 * holds stay ≤ END_GRACE_MS — the same grace both keeps an active situation
 * alive through per-frame flicker and stops a pending dwell from resetting
 * on one jittery pass; a gap > END_GRACE_MS ends the episode (active
 * situations end, pending dwells start over). `since` is always the time
 * the condition FIRST held in the current episode; the AT_VEHICLE →
 * LINGERING_AT_VEHICLE upgrade keeps the same id and the original `since`
 * (the lingering read is latched so a day/night threshold flip can never
 * downgrade it).
 */
import type { ActivityKind, Situation, SituationKind, TrackedBox, Zone } from '../types'
import { boxBottomCenter, pointInPolygon } from '../zones/geometry'

/* ── tunables ──────────────────────────────────────────────────────── */

/** AT_ENTRY: person speed |[vx,vy]| must stay below this (units/s). */
export const ENTRY_STILL_SPEED = 0.05
/** AT_ENTRY: feet-in-zone + still must hold continuously this long. */
export const AT_ENTRY_DWELL_MS = 4000
/** AT_VEHICLE: person/vehicle pairing must hold continuously this long. */
export const AT_VEHICLE_DWELL_MS = 3000
/** AT_VEHICLE: boxes pair when IoU exceeds this… */
export const AT_VEHICLE_IOU = 0.04
/** …or center distance is below this fraction of the mean box diagonal. */
export const AT_VEHICLE_DIST_FACTOR = 0.6
/** LINGERING_AT_VEHICLE: pairing persisting this long by day… */
export const LINGER_DAY_MS = 25_000
/** …or this long at night (21:00–06:59) upgrades the situation. */
export const LINGER_NIGHT_MS = 12_000
/** PACKAGE_AT_ENTRY: package center inside an ENTRY zone this long. */
export const PACKAGE_DWELL_MS = 2000
/** A condition may lapse up to this long without ending its situation. */
export const END_GRACE_MS = 2500
/**
 * CROUCHING_AT_VEHICLE aspect fallback for identity-less tracks: a body box
 * with normalized height/width below this reads as crouched (a standing
 * person's box is far taller than wide; a crouched one approaches square).
 */
export const CROUCH_ASPECT_MAX = 1.1

/* ── shapes ────────────────────────────────────────────────────────── */

export interface ContextInput {
  now: number
  night: boolean
  /** per camera: fresh person + object tracks (caller filters staleness) */
  tracksByCamera: Map<string, TrackedBox[]>
  zonesByCamera: Map<string, Zone[]>
  /** committed current activity per personId (from the brain) */
  activityByPerson: Map<string, ActivityKind | null>
}

type Family = 'entry' | 'vehicle' | 'crouch' | 'package'

interface DwellEntry {
  family: Family
  /** when the condition first held in the current continuous episode */
  firstHeld: number
  /** last pass at which the condition held */
  lastHeld: number
  /** ms the condition must hold before the situation goes live */
  dwellMs: number
  /** vehicle pairs only: latched true once the linger threshold is crossed */
  lingering: boolean
  /** situation fields, refreshed on every held pass (identity may resolve mid-dwell) */
  cameraId: string
  personId: string | null
  personLabel: string
}

/** Dwell bookkeeping keyed by stable situation id — opaque to callers. */
export interface ContextState {
  entries: Map<string, DwellEntry>
}

export function createContextState(): ContextState {
  return { entries: new Map() }
}

/** One condition observed holding on this pass. */
interface Candidate {
  id: string
  family: Family
  dwellMs: number
  cameraId: string
  personId: string | null
  personLabel: string
}

/* ── small pure helpers ────────────────────────────────────────────── */

type Box = readonly [number, number, number, number]

function iou(a: Box, b: Box): number {
  const ix = Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0])
  const iy = Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1])
  if (ix <= 0 || iy <= 0) return 0
  const inter = ix * iy
  const union = a[2] * a[3] + b[2] * b[3] - inter
  return union > 0 ? inter / union : 0
}

function center(b: Box): [number, number] {
  return [b[0] + b[2] / 2, b[1] + b[3] / 2]
}

/** Person "at" a vehicle: box overlap OR centers within 0.6 × mean diagonal. */
function nearVehicle(person: Box, vehicle: Box): boolean {
  if (iou(person, vehicle) > AT_VEHICLE_IOU) return true
  const [px, py] = center(person)
  const [vx, vy] = center(vehicle)
  const meanDiag = (Math.hypot(person[2], person[3]) + Math.hypot(vehicle[2], vehicle[3])) / 2
  return Math.hypot(px - vx, py - vy) < AT_VEHICLE_DIST_FACTOR * meanDiag
}

/** KNOWN → enrolled name (uppercased); resolved-unknown → UNKNOWN; else PERSON. */
function labelOf(t: TrackedBox): { personId: string | null; personLabel: string } {
  if (t.identity === 'known' && t.personId !== null) {
    return { personId: t.personId, personLabel: (t.personName ?? 'PERSON').toUpperCase() }
  }
  return { personId: null, personLabel: t.identity === 'unknown' ? 'UNKNOWN' : 'PERSON' }
}

/**
 * Crouch signal for a person track at a vehicle. With a resolved personId the
 * brain's committed activity map is authoritative (=== 'CROUCHING'). Without
 * one there is no activity stream to consult, so the track's own body box
 * stands in: normalized height/width < CROUCH_ASPECT_MAX reads as crouched.
 * The fallback applies ONLY to identity-less tracks — a known person is never
 * called crouching from box shape alone.
 */
function crouchSignal(t: TrackedBox, activityByPerson: Map<string, ActivityKind | null>): boolean {
  if (t.personId !== null) return activityByPerson.get(t.personId) === 'CROUCHING'
  const w = t.box[2]
  const h = t.box[3]
  return w > 0 && h / w < CROUCH_ASPECT_MAX
}

/* ── the engine ────────────────────────────────────────────────────── */

/**
 * One evaluation pass: observe which conditions hold right now, advance the
 * dwell bookkeeping in `state`, and return the situations whose dwell has
 * been met (including ones inside their end-grace window).
 */
export function detectSituations(state: ContextState, input: ContextInput): Situation[] {
  const now = input.now
  const candidates: Candidate[] = []

  for (const [cameraId, tracks] of input.tracksByCamera) {
    const zones = input.zonesByCamera.get(cameraId) ?? []
    const entryZones = zones.filter((z) => z.kind === 'ENTRY' && Array.isArray(z.points) && z.points.length >= 3)
    const persons = tracks.filter((t) => t.cls === 'person')
    const vehicles = tracks.filter((t) => t.cls === 'vehicle')

    if (entryZones.length > 0) {
      // AT_ENTRY — a person's FEET (bottom-center of the raw box) inside an
      // ENTRY zone while the track is essentially still.
      for (const p of persons) {
        if (Math.hypot(p.vel[0], p.vel[1]) >= ENTRY_STILL_SPEED) continue
        const feet = boxBottomCenter(p.box)
        if (!entryZones.some((z) => pointInPolygon(feet, z.points))) continue
        candidates.push({
          id: `entry:${cameraId}:${p.trackId}`,
          family: 'entry',
          dwellMs: AT_ENTRY_DWELL_MS,
          cameraId,
          ...labelOf(p),
        })
      }

      // PACKAGE_AT_ENTRY — a package's CENTER inside an ENTRY zone (packages
      // have no meaningful feet).
      for (const t of tracks) {
        if (t.cls !== 'package') continue
        if (!entryZones.some((z) => pointInPolygon(center(t.box), z.points))) continue
        candidates.push({
          id: `package:${cameraId}:${t.trackId}`,
          family: 'package',
          dwellMs: PACKAGE_DWELL_MS,
          cameraId,
          personId: null,
          personLabel: 'PACKAGE',
        })
      }
    }

    // AT_VEHICLE pairs (+ crouching next to one, once the pair is live).
    for (const p of persons) {
      for (const v of vehicles) {
        if (!nearVehicle(p.box, v.box)) continue
        const pairId = `vehicle:${cameraId}:${p.trackId}:${v.trackId}`
        candidates.push({
          id: pairId,
          family: 'vehicle',
          dwellMs: AT_VEHICLE_DWELL_MS,
          cameraId,
          ...labelOf(p),
        })
        // CROUCHING_AT_VEHICLE rides on an ACTIVE pair (dwell met, not
        // lapsed) — it coexists with the pair situation rather than
        // replacing it, and needs no dwell of its own beyond the pair's.
        const pair = state.entries.get(pairId)
        if (
          pair !== undefined &&
          now - pair.lastHeld <= END_GRACE_MS &&
          now - pair.firstHeld >= AT_VEHICLE_DWELL_MS &&
          crouchSignal(p, input.activityByPerson)
        ) {
          candidates.push({
            id: `vehicle-crouch:${cameraId}:${p.trackId}:${v.trackId}`,
            family: 'crouch',
            dwellMs: 0,
            cameraId,
            ...labelOf(p),
          })
        }
      }
    }
  }

  // Advance dwell state: refresh held entries (a lapse beyond the grace
  // starts a fresh episode), then expire entries whose condition has now
  // been gone for longer than the grace.
  const heldIds = new Set<string>()
  for (const c of candidates) {
    heldIds.add(c.id)
    const e = state.entries.get(c.id)
    if (e === undefined || now - e.lastHeld > END_GRACE_MS) {
      state.entries.set(c.id, {
        family: c.family,
        firstHeld: now,
        lastHeld: now,
        dwellMs: c.dwellMs,
        lingering: false,
        cameraId: c.cameraId,
        personId: c.personId,
        personLabel: c.personLabel,
      })
    } else {
      e.lastHeld = now
      e.personId = c.personId
      e.personLabel = c.personLabel
    }
  }
  for (const [id, e] of state.entries) {
    if (!heldIds.has(id) && now - e.lastHeld > END_GRACE_MS) state.entries.delete(id)
  }

  // Emit every entry whose dwell has been met. `since` = first held.
  const out: Situation[] = []
  const lingerMs = input.night ? LINGER_NIGHT_MS : LINGER_DAY_MS
  for (const [id, e] of state.entries) {
    if (now - e.firstHeld < e.dwellMs) continue
    if (e.family === 'vehicle' && !e.lingering && now - e.firstHeld >= lingerMs) e.lingering = true
    const kind: SituationKind =
      e.family === 'entry'
        ? 'AT_ENTRY'
        : e.family === 'package'
          ? 'PACKAGE_AT_ENTRY'
          : e.family === 'crouch'
            ? 'CROUCHING_AT_VEHICLE'
            : e.lingering
              ? 'LINGERING_AT_VEHICLE'
              : 'AT_VEHICLE'
    out.push({ id, kind, cameraId: e.cameraId, personId: e.personId, personLabel: e.personLabel, since: e.firstHeld })
  }
  return out
}
