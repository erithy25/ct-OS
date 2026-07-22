import { describe, expect, it } from 'vitest'
import { iou, stepTracks, VEL_EMA, type Box } from '../tracker'
import type { Detection, FaceRead, Person, TrackedBox } from '../../types'

/* ── fixture builders (fixed timestamps everywhere — no Date.now()) ── */

const CAM = 'CAM-01'

function det(box: Box, over: Partial<Detection> = {}): Detection {
  return { cameraId: CAM, cls: 'person', label: 'PERSON', score: 0.9, box, personId: null, ts: 0, ...over }
}

function face(box: Box, personId: string | null, ts: number, distance: number | null = personId ? 0.42 : 0.85): FaceRead {
  return { box, personId, distance, ts }
}

function person(id: string, name: string, role: 'HOUSEHOLD' | 'GUEST' = 'HOUSEHOLD'): Person {
  return { id, name, role, descriptors: [[0, 0, 0]], color: '#34D399', addedAt: 0, present: false }
}

const ERIK = person('p1', 'Erik', 'HOUSEHOLD')
const MAJA = person('p2', 'Maja', 'GUEST')
const PEOPLE = [ERIK, MAJA]

function opts(now: number, faceEngineReady = true) {
  return { now, faceEngineReady, cameraId: CAM }
}

/** step with no faces / default roster */
function step(prev: TrackedBox[], dets: Detection[], now: number, faces: FaceRead[] = [], ready = true): TrackedBox[] {
  return stepTracks(prev, dets, faces, PEOPLE, opts(now, ready))
}

const BODY: Box = [0.4, 0.2, 0.2, 0.6]
/** face box whose CENTER sits inside BODY */
const FACE_IN_BODY: Box = [0.45, 0.25, 0.08, 0.1]

/* ── iou ───────────────────────────────────────────────────────────── */

describe('iou', () => {
  it('is 1 for identical boxes and 0 for disjoint boxes', () => {
    expect(iou([0.1, 0.1, 0.3, 0.4], [0.1, 0.1, 0.3, 0.4])).toBeCloseTo(1, 6)
    expect(iou([0, 0, 0.2, 0.2], [0.5, 0.5, 0.2, 0.2])).toBe(0)
    expect(iou([0, 0, 0.2, 0.2], [0.2, 0, 0.2, 0.2])).toBe(0) // touching edges only
  })

  it('computes partial overlap and containment correctly', () => {
    // half-shifted unit boxes: inter 0.5, union 1.5 → 1/3
    expect(iou([0, 0, 1, 1], [0.5, 0, 1, 1])).toBeCloseTo(1 / 3, 6)
    // contained quarter-area box: inter 0.25, union 1 → 0.25
    expect(iou([0, 0, 1, 1], [0.25, 0.25, 0.5, 0.5])).toBeCloseTo(0.25, 6)
  })

  it('is 0 for degenerate zero-area boxes', () => {
    expect(iou([0.2, 0.2, 0, 0], [0.1, 0.1, 0.5, 0.5])).toBe(0)
  })
})

/* ── track continuity + lifecycle ──────────────────────────────────── */

describe('track lifecycle', () => {
  it('keeps the same trackId across overlapping steps and updates the box', () => {
    const t1 = step([], [det(BODY)], 1000)
    expect(t1).toHaveLength(1)
    expect(t1[0].identity).toBe('pending')
    expect(t1[0].firstSeen).toBe(1000)
    expect(t1[0].vel).toEqual([0, 0, 0, 0])

    const moved: Box = [0.42, 0.2, 0.2, 0.6]
    const t2 = step(t1, [det(moved)], 1200)
    expect(t2).toHaveLength(1)
    expect(t2[0].trackId).toBe(t1[0].trackId)
    expect(t2[0].firstSeen).toBe(1000)
    expect(t2[0].updatedAt).toBe(1200)
    expect(t2[0].box).toEqual(moved)
  })

  it('spawns a fresh trackId for a non-overlapping detection', () => {
    const t1 = step([], [det(BODY)], 1000)
    const t2 = step(t1, [det(BODY), det([0.05, 0.05, 0.1, 0.2])], 1200)
    expect(t2).toHaveLength(2)
    const fresh = t2.find((t) => t.trackId !== t1[0].trackId)
    expect(fresh).toBeDefined()
    expect(fresh!.firstSeen).toBe(1200)
    expect(fresh!.vel).toEqual([0, 0, 0, 0])
  })

  it('keeps an unmatched track as a ghost through the grace window, then drops it', () => {
    const t1 = step([], [det(BODY)], 1000)
    const ghost = step(t1, [], 1600) // 600ms unseen ≤ 700 → kept
    expect(ghost).toHaveLength(1)
    expect(ghost[0].updatedAt).toBe(1000) // ghost box frozen
    const gone = step(ghost, [], 1800) // 800ms unseen > 700 → dropped
    expect(gone).toHaveLength(0)
  })

  it('never matches across classes', () => {
    const t1 = step([], [det(BODY)], 1000)
    const t2 = step(t1, [det(BODY, { cls: 'vehicle', label: 'CAR' })], 1200)
    // person track ghosts, vehicle spawns fresh — same box, different class
    expect(t2).toHaveLength(2)
    const vehicle = t2.find((t) => t.cls === 'vehicle')!
    expect(vehicle.trackId).not.toBe(t1[0].trackId)
    expect(vehicle.firstSeen).toBe(1200)
  })
})

/* ── velocity ──────────────────────────────────────────────────────── */

describe('velocity', () => {
  it('EMA(VEL_EMA)-follows the instantaneous velocity with the right direction', () => {
    const a = VEL_EMA
    const t1 = step([], [det(BODY)], 1000)
    // +0.1 x over 100ms → inst 1.0/s → EMA from 0: a·1.0
    const t2 = step(t1, [det([0.5, 0.2, 0.2, 0.6])], 1100)
    expect(t2[0].vel[0]).toBeCloseTo(a * 1.0, 6)
    expect(t2[0].vel[1]).toBeCloseTo(0, 6)
    expect(t2[0].vel[2]).toBeCloseTo(0, 6)
    // again +0.1 x over 100ms → EMA: (1−a)·(a·1.0) + a·1.0
    const v2 = (1 - a) * (a * 1.0) + a * 1.0
    const t3 = step(t2, [det([0.6, 0.2, 0.2, 0.6])], 1200)
    expect(t3[0].vel[0]).toBeCloseTo(v2, 6)
    // reverse direction: −0.1 x over 100ms → (1−a)·v2 + a·(−1)
    const t4 = step(t3, [det([0.5, 0.2, 0.2, 0.6])], 1300)
    expect(t4[0].vel[0]).toBeCloseTo((1 - a) * v2 + a * -1, 6)
  })

  it('clamps each component to ±2.5 units/second', () => {
    const wide: Box = [0.1, 0.1, 0.6, 0.8]
    const t1 = step([], [det(wide)], 1000)
    // +0.3 x over 50ms → inst 6/s → EMA 3 → clamped to 2.5
    const t2 = step(t1, [det([0.4, 0.1, 0.6, 0.8])], 1050)
    expect(t2[0].vel[0]).toBe(2.5)
  })
})

/* ── identity fusion ───────────────────────────────────────────────── */

describe('identity fusion', () => {
  it('assigns a face by center-in-box and becomes KNOWN with name/role/distance', () => {
    const t1 = step([], [det(BODY)], 1000)
    const t2 = step(t1, [det(BODY)], 1200, [face(FACE_IN_BODY, 'p1', 1100)])
    expect(t2[0].identity).toBe('known')
    expect(t2[0].personId).toBe('p1')
    expect(t2[0].personName).toBe('Erik')
    expect(t2[0].personRole).toBe('HOUSEHOLD')
    expect(t2[0].faceDistance).toBeCloseTo(0.42, 6)
  })

  it('assigns the face to the track that contains its center, not a neighbor', () => {
    const other: Box = [0.05, 0.2, 0.2, 0.6]
    const t1 = step([], [det(BODY), det(other)], 1000)
    const t2 = step(t1, [det(BODY), det(other)], 1200, [face(FACE_IN_BODY, 'p1', 1100)])
    const inBody = t2.find((t) => t.box[0] === BODY[0])!
    const neighbor = t2.find((t) => t.box[0] === other[0])!
    expect(inBody.identity).toBe('known')
    expect(neighbor.identity).toBe('pending')
  })

  it('ignores stale face reads (≥ 1600ms old)', () => {
    const t1 = step([], [det(BODY)], 1000)
    const t2 = step(t1, [det(BODY)], 3000, [face(FACE_IN_BODY, 'p1', 1200)]) // 1800ms old
    expect(t2[0].identity).toBe('pending')
  })

  it('stays KNOWN after the face disappears, even across null-id reads', () => {
    const t1 = step([], [det(BODY)], 1000)
    let t = step(t1, [det(BODY)], 1200, [face(FACE_IN_BODY, 'p1', 1100)])
    // face vanished (turned away) for many steps
    t = step(t, [det(BODY)], 1500)
    t = step(t, [det(BODY)], 1800)
    expect(t[0].identity).toBe('known')
    expect(t[0].personId).toBe('p1')
    // even a face that matches nobody does not demote a KNOWN track
    t = step(t, [det(BODY)], 2000, [face(FACE_IN_BODY, null, 1950)])
    t = step(t, [det(BODY)], 2200, [face(FACE_IN_BODY, null, 2150)])
    expect(t[0].identity).toBe('known')
    expect(t[0].personId).toBe('p1')
  })

  it('switches person only after 2 consecutive different-id claims', () => {
    const t1 = step([], [det(BODY)], 1000)
    let t = step(t1, [det(BODY)], 1200, [face(FACE_IN_BODY, 'p1', 1100)])
    // first p2 claim → still p1
    t = step(t, [det(BODY)], 1400, [face(FACE_IN_BODY, 'p2', 1350)])
    expect(t[0].personId).toBe('p1')
    // second consecutive p2 claim → switch, with name/role refreshed
    t = step(t, [det(BODY)], 1600, [face(FACE_IN_BODY, 'p2', 1550)])
    expect(t[0].identity).toBe('known')
    expect(t[0].personId).toBe('p2')
    expect(t[0].personName).toBe('Maja')
    expect(t[0].personRole).toBe('GUEST')
  })

  it('an interrupted different-id claim streak resets and does not switch', () => {
    const t1 = step([], [det(BODY)], 1000)
    let t = step(t1, [det(BODY)], 1200, [face(FACE_IN_BODY, 'p1', 1100)])
    t = step(t, [det(BODY)], 1400, [face(FACE_IN_BODY, 'p2', 1350)]) // p2 ×1
    t = step(t, [det(BODY)], 1600, [face(FACE_IN_BODY, 'p1', 1550)]) // p1 reconfirms → reset
    t = step(t, [det(BODY)], 1800, [face(FACE_IN_BODY, 'p2', 1750)]) // p2 ×1 again
    expect(t[0].personId).toBe('p1')
  })

  it('goes UNKNOWN after 2 consecutive unmatched-face reads (engine ready)', () => {
    const t1 = step([], [det(BODY)], 1000)
    const t2 = step(t1, [det(BODY)], 1200, [face(FACE_IN_BODY, null, 1100)])
    expect(t2[0].identity).toBe('pending') // streak 1 — not judged yet
    const t3 = step(t2, [det(BODY)], 1400, [face(FACE_IN_BODY, null, 1350)])
    expect(t3[0].identity).toBe('unknown')
    expect(t3[0].personId).toBeNull()
  })

  it('stays PENDING when the face engine is not ready — we cannot honestly judge', () => {
    const t1 = step([], [det(BODY)], 1000, [], false)
    let t = step(t1, [det(BODY)], 1200, [face(FACE_IN_BODY, null, 1100)], false)
    t = step(t, [det(BODY)], 1400, [face(FACE_IN_BODY, null, 1350)], false)
    expect(t[0].identity).toBe('pending')
    // even an old track stays pending while the engine cannot judge
    t = step(t, [det(BODY)], 4000, [], false)
    expect(t[0].identity).toBe('pending')
  })

  it('an aged track (> 2500ms) with no known match ever goes UNKNOWN', () => {
    let t = step([], [det(BODY)], 1000)
    for (let now = 1500; now <= 4000; now += 500) {
      const aged = now - 1000 > 2500
      t = step(t, [det(BODY)], now)
      expect(t[0].identity).toBe(aged ? 'unknown' : 'pending')
    }
    expect(t[0].identity).toBe('unknown')
  })

  it('never gives non-person classes an identity, even with a face inside', () => {
    const t1 = step([], [det(BODY, { cls: 'vehicle', label: 'CAR', score: 0.8 })], 1000)
    const t2 = step(t1, [det(BODY, { cls: 'vehicle', label: 'CAR', score: 0.8 })], 1200, [face(FACE_IN_BODY, 'p1', 1100)])
    expect(t2[0].identity).toBe('pending')
    expect(t2[0].personId).toBeNull()
    // and the age rule never applies to non-person tracks
    let t = t2
    for (let now = 1600; now <= 4200; now += 400) t = step(t, [det(BODY, { cls: 'vehicle', label: 'CAR', score: 0.8 })], now)
    expect(t[0].identity).toBe('pending')
  })
})
