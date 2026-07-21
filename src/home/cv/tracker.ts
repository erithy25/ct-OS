/**
 * PANOPTICON // HOMEWATCH — multi-object TRACKER with identity fusion.
 *
 * Pure + deterministic: `stepTracks` derives the next track set from the
 * previous tracks, the latest raw detections, the freshest face reads and the
 * enrolled roster — with `now` passed in explicitly (no Date.now() inside), so
 * the whole thing is unit-testable frame by frame.
 *
 * Identity is honest by construction: a PERSON track is 'pending' until the
 * on-device face engine has actually judged it, then KNOWN (enrolled,
 * consented household/guest — by name) or UNKNOWN (unrecognized). Nothing
 * stronger than UNKNOWN ever exists here; non-person classes never carry an
 * identity at all.
 */
import type { Detection, FaceRead, Person, TrackedBox } from '../types'

/** Normalized [x, y, w, h] box, 0..1 in frame coordinates. */
export type Box = [number, number, number, number]

/* ── tunables (exported for tests) ─────────────────────────────────── */

/** greedy association gate — a det joins a track only above this IoU */
export const MATCH_IOU = 0.25
/** unmatched tracks coast as ghosts this long before being dropped */
export const GHOST_MS = 700
/** face reads older than this are ignored by fusion */
export const FACE_FRESH_MS = 1600
/** velocity EMA weight of the newest instantaneous velocity */
export const VEL_EMA = 0.5
/** velocity clamp, normalized units / second, per component */
export const VEL_MAX = 2.5
/** consecutive null-id face reads before a pending track goes UNKNOWN */
export const UNKNOWN_STREAK = 2
/** consecutive different-id face reads before a KNOWN track switches person */
export const SWITCH_STREAK = 2
/** a person track older than this with no known match ever → UNKNOWN */
export const UNKNOWN_AGE_MS = 2500

/* ── internal per-track bookkeeping ────────────────────────────────── */

/**
 * Private-ish fusion state carried on the track objects themselves (optional
 * fields — structurally still a TrackedBox). Living inside the track keeps
 * stepTracks deterministic: state flows exclusively through prev → next.
 */
interface TrackState extends TrackedBox {
  /** candidate DIFFERENT personId currently being claimed on a known track */
  _claimId?: string
  /** consecutive fusions that claimed `_claimId` */
  _claimStreak?: number
  /** consecutive fusions whose assigned face matched nobody */
  _unknownStreak?: number
  /** this track has been KNOWN at least once (blocks the age→unknown rule) */
  _everKnown?: boolean
}

/** monotonically increasing track ids (kept above anything already in play) */
let idCounter = 1

function takeTrackId(prev: readonly TrackedBox[]): number {
  for (const t of prev) if (t.trackId >= idCounter) idCounter = t.trackId + 1
  return idCounter++
}

const clampVel = (v: number): number => Math.max(-VEL_MAX, Math.min(VEL_MAX, v))

/* ── geometry ──────────────────────────────────────────────────────── */

/** Intersection-over-union of two [x, y, w, h] boxes. 0 when disjoint/degenerate. */
export function iou(a: Box, b: Box): number {
  const ix = Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0])
  const iy = Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1])
  if (ix <= 0 || iy <= 0) return 0
  const inter = ix * iy
  const union = a[2] * a[3] + b[2] * b[3] - inter
  return union > 0 ? inter / union : 0
}

const containsPoint = (box: Box, px: number, py: number): boolean =>
  px >= box[0] && px <= box[0] + box[2] && py >= box[1] && py <= box[1] + box[3]

/* ── identity fusion helpers ───────────────────────────────────────── */

function becomeKnown(t: TrackState, personId: string, distance: number | null, people: Person[]): void {
  t.identity = 'known'
  t.personId = personId
  t._everKnown = true
  t._claimId = undefined
  t._claimStreak = 0
  t._unknownStreak = 0
  if (distance !== null) t.faceDistance = distance
  const p = people.find((x) => x.id === personId)
  if (p) {
    t.personName = p.name
    t.personRole = p.role
  }
}

/** Apply one assigned face read to one person track. Mutates the (fresh) track. */
function fuseFace(t: TrackState, face: FaceRead, people: Person[]): void {
  if (face.personId !== null) {
    if (t.identity === 'known' && t.personId !== null && t.personId !== face.personId) {
      // a DIFFERENT enrolled person is claimed — sticky: require consecutive
      // confirmations before re-labelling the track.
      if (t._claimId === face.personId) t._claimStreak = (t._claimStreak ?? 0) + 1
      else {
        t._claimId = face.personId
        t._claimStreak = 1
      }
      if ((t._claimStreak ?? 0) >= SWITCH_STREAK) becomeKnown(t, face.personId, face.distance, people)
    } else {
      // first claim, or the current person re-confirmed
      becomeKnown(t, face.personId, face.distance, people)
    }
  } else {
    // a face was read on this track but matched nobody enrolled
    t._unknownStreak = (t._unknownStreak ?? 0) + 1
    if (face.distance !== null) t.faceDistance = face.distance
    if (t.identity !== 'known' && (t._unknownStreak ?? 0) >= UNKNOWN_STREAK) t.identity = 'unknown'
    // KNOWN stays known (person may be turning away / bad angle) — only a
    // different enrolled id, seen repeatedly, can re-label the track.
  }
}

/* ── the step ──────────────────────────────────────────────────────── */

export interface StepOpts {
  now: number
  faceEngineReady: boolean
  cameraId: string
}

/**
 * Advance the track set one detector frame:
 *  1. greedy IoU association per class (best pair first, gate ≥ MATCH_IOU)
 *  2. matched tracks take the raw box + EMA velocity; unmatched dets spawn
 *     tracks; unmatched tracks coast as ghosts for GHOST_MS then drop
 *  3. fresh face reads are assigned to person tracks (face CENTER inside the
 *     track box; ties by IoU) and fused into KNOWN / UNKNOWN — sticky, and
 *     only ever 'pending' while the face engine cannot honestly judge.
 */
export function stepTracks(
  prev: TrackedBox[],
  raw: Detection[],
  faceReads: FaceRead[],
  people: Person[],
  opts: StepOpts,
): TrackedBox[] {
  const { now, faceEngineReady, cameraId } = opts
  const prevS = prev as TrackState[]

  // ── 1. association: all gated pairs, best IoU first, greedy ──
  const pairs: { pi: number; di: number; v: number }[] = []
  for (let pi = 0; pi < prevS.length; pi++) {
    for (let di = 0; di < raw.length; di++) {
      if (prevS[pi].cls !== raw[di].cls) continue
      const v = iou(prevS[pi].box, raw[di].box)
      if (v >= MATCH_IOU) pairs.push({ pi, di, v })
    }
  }
  pairs.sort((a, b) => b.v - a.v)
  const detOf = new Map<number, number>() // prev index → det index
  const usedDet = new Set<number>()
  for (const p of pairs) {
    if (detOf.has(p.pi) || usedDet.has(p.di)) continue
    detOf.set(p.pi, p.di)
    usedDet.add(p.di)
  }

  // ── 2. update / ghost / spawn ──
  const next: TrackState[] = []
  for (let pi = 0; pi < prevS.length; pi++) {
    const t = prevS[pi]
    const di = detOf.get(pi)
    if (di === undefined) {
      // unmatched: keep coasting as a ghost inside the grace window
      if (now - t.updatedAt > GHOST_MS) continue
      next.push({ ...t, cameraId })
      continue
    }
    const d = raw[di]
    const dt = (now - t.updatedAt) / 1000
    const vel: [number, number, number, number] = [t.vel[0], t.vel[1], t.vel[2], t.vel[3]]
    if (dt > 0) {
      for (let i = 0; i < 4; i++) {
        const inst = (d.box[i] - t.box[i]) / dt
        vel[i] = clampVel((1 - VEL_EMA) * t.vel[i] + VEL_EMA * inst)
      }
    }
    next.push({
      ...t,
      cameraId,
      label: d.label,
      score: d.score,
      box: [d.box[0], d.box[1], d.box[2], d.box[3]],
      vel,
      updatedAt: now,
    })
  }
  for (let di = 0; di < raw.length; di++) {
    if (usedDet.has(di)) continue
    const d = raw[di]
    next.push({
      trackId: takeTrackId(prevS),
      cameraId,
      cls: d.cls,
      label: d.label,
      score: d.score,
      box: [d.box[0], d.box[1], d.box[2], d.box[3]],
      vel: [0, 0, 0, 0],
      updatedAt: now,
      firstSeen: now,
      identity: 'pending', // non-person classes stay 'pending' forever
      personId: null,
    })
  }

  // ── 3. identity fusion (person tracks only; engine must be able to judge) ──
  if (faceEngineReady) {
    const personTracks = next.filter((t) => t.cls === 'person')
    if (personTracks.length > 0) {
      // assign each fresh face to the person track containing its center
      const assigned = new Map<TrackState, FaceRead>()
      for (const f of faceReads) {
        if (now - f.ts >= FACE_FRESH_MS) continue
        const cx = f.box[0] + f.box[2] / 2
        const cy = f.box[1] + f.box[3] / 2
        let best: TrackState | null = null
        let bestIou = -1
        for (const t of personTracks) {
          if (!containsPoint(t.box, cx, cy)) continue
          const v = iou(f.box, t.box)
          if (v > bestIou) {
            bestIou = v
            best = t
          }
        }
        if (!best) continue
        // several faces on one track → keep the face overlapping it most
        const cur = assigned.get(best)
        if (!cur || iou(f.box, best.box) > iou(cur.box, best.box)) assigned.set(best, f)
      }
      for (const [t, f] of assigned) fuseFace(t, f, people)

      // long-lived person track the engine has watched without ever matching
      // anyone enrolled → honestly UNKNOWN (never anything stronger).
      for (const t of personTracks) {
        if (t.identity === 'pending' && !t._everKnown && now - t.firstSeen > UNKNOWN_AGE_MS) {
          t.identity = 'unknown'
        }
      }
    }
  }
  // engine not ready → no identity transitions at all: 'pending' means
  // "we cannot honestly judge yet", and KNOWN stays sticky-known.

  return next
}
