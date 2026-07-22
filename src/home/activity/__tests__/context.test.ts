/**
 * SITUATION engine: dwell thresholds (just-below vs just-above), day vs night
 * lingering, end-grace, the AT_VEHICLE → LINGERING upgrade keeping `since`,
 * feet-in-zone against a simple square polygon, the package rule, and both
 * crouch-at-vehicle paths (activity map + aspect fallback). Every timestamp
 * is fixed and injected — the engine has no clock of its own.
 */
import { describe, expect, it } from 'vitest'
import type { ActivityKind, Situation, TrackedBox, Zone } from '../../types'
import {
  AT_ENTRY_DWELL_MS,
  AT_VEHICLE_DWELL_MS,
  createContextState,
  detectSituations,
  LINGER_DAY_MS,
  LINGER_NIGHT_MS,
  PACKAGE_DWELL_MS,
  type ContextInput,
  type ContextState,
} from '../context'

const CAM = 'CAM-A'
const T0 = 1_000_000

/** Square ENTRY zone covering x 0.1–0.9 of the lower half of the frame. */
const entryZone: Zone = {
  id: 'z-entry',
  cameraId: CAM,
  name: 'FRONT DOOR',
  kind: 'ENTRY',
  points: [
    [0.1, 0.5],
    [0.9, 0.5],
    [0.9, 1],
    [0.1, 1],
  ],
  alertOnEnter: true,
  nightOnly: false,
  color: '#00ff00',
}

function track(over: Partial<TrackedBox> & Pick<TrackedBox, 'trackId' | 'cls'>): TrackedBox {
  return {
    cameraId: CAM,
    label: over.cls,
    score: 0.9,
    box: [0.45, 0.5, 0.1, 0.4], // feet (bottom-center) at (0.5, 0.9) — inside the zone
    vel: [0, 0, 0, 0],
    updatedAt: 0,
    firstSeen: 0,
    identity: 'pending',
    personId: null,
    ...over,
  }
}

function makeInput(
  now: number,
  tracks: TrackedBox[],
  opts: { night?: boolean; activity?: Array<[string, ActivityKind | null]> } = {},
): ContextInput {
  return {
    now,
    night: opts.night ?? false,
    tracksByCamera: new Map([[CAM, tracks]]),
    zonesByCamera: new Map([[CAM, [entryZone]]]),
    activityByPerson: new Map(opts.activity ?? []),
  }
}

/** Run the engine every `stepMs` from `from` to `to` inclusive; last result. */
function hold(
  state: ContextState,
  from: number,
  to: number,
  mk: (t: number) => ContextInput,
  stepMs = 500,
): Situation[] {
  let out: Situation[] = []
  for (let t = from; t <= to; t += stepMs) out = detectSituations(state, mk(t))
  return out
}

/* ── AT_ENTRY ──────────────────────────────────────────────────────── */

describe('AT_ENTRY', () => {
  it('a still person with feet in the ENTRY zone activates only after the 4 s dwell, since = first held', () => {
    const st = createContextState()
    const mk = (t: number): ContextInput => makeInput(t, [track({ trackId: 1, cls: 'person', identity: 'unknown' })])
    hold(st, T0, T0 + 3500, mk)
    expect(detectSituations(st, mk(T0 + AT_ENTRY_DWELL_MS - 1))).toHaveLength(0) // just below
    const out = detectSituations(st, mk(T0 + AT_ENTRY_DWELL_MS)) // just above
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      id: `entry:${CAM}:1`,
      kind: 'AT_ENTRY',
      cameraId: CAM,
      personId: null,
      personLabel: 'UNKNOWN',
      since: T0,
    })
  })

  it('a moving person in the zone never dwells (speed ≥ 0.05 u/s)', () => {
    const st = createContextState()
    const mk = (t: number): ContextInput =>
      makeInput(t, [track({ trackId: 1, cls: 'person', vel: [0.06, 0, 0, 0] })])
    expect(hold(st, T0, T0 + 8000, mk)).toHaveLength(0)
  })

  it('feet outside the polygon never count, even when the box overlaps it', () => {
    const st = createContextState()
    // bottom-center (0.5, 0.3) sits above the zone's top edge (y 0.5)
    const mk = (t: number): ContextInput =>
      makeInput(t, [track({ trackId: 1, cls: 'person', box: [0.45, 0.1, 0.1, 0.2] })])
    expect(hold(st, T0, T0 + 8000, mk)).toHaveLength(0)
  })

  it('labels: known → uppercased name + personId; pending → PERSON', () => {
    const known = createContextState()
    const mkKnown = (t: number): ContextInput =>
      makeInput(t, [track({ trackId: 1, cls: 'person', identity: 'known', personId: 'p9', personName: 'Ada' })])
    const outKnown = hold(known, T0, T0 + AT_ENTRY_DWELL_MS, mkKnown)
    expect(outKnown[0]).toMatchObject({ personId: 'p9', personLabel: 'ADA' })

    const pending = createContextState()
    const mkPending = (t: number): ContextInput => makeInput(t, [track({ trackId: 2, cls: 'person' })])
    const outPending = hold(pending, T0, T0 + AT_ENTRY_DWELL_MS, mkPending)
    expect(outPending[0]).toMatchObject({ personId: null, personLabel: 'PERSON' })
  })
})

/* ── end grace ─────────────────────────────────────────────────────── */

describe('end grace', () => {
  it('an active situation survives a lapse ≤ 2.5 s and ends after > 2.5 s', () => {
    const st = createContextState()
    const mk = (t: number): ContextInput => makeInput(t, [track({ trackId: 1, cls: 'person' })])
    const gone = (t: number): ContextInput => makeInput(t, [])
    hold(st, T0, T0 + AT_ENTRY_DWELL_MS, mk) // active; lastHeld = T0+4000
    expect(detectSituations(st, gone(T0 + 5000))).toHaveLength(1) // 1.0 s lapse — still live
    expect(detectSituations(st, gone(T0 + 6400))).toHaveLength(1) // 2.4 s lapse — still live
    expect(detectSituations(st, gone(T0 + 6600))).toHaveLength(0) // 2.6 s lapse — ended
  })

  it('a flicker shorter than the grace neither ends the situation nor resets since', () => {
    const st = createContextState()
    const mk = (t: number): ContextInput => makeInput(t, [track({ trackId: 1, cls: 'person' })])
    hold(st, T0, T0 + AT_ENTRY_DWELL_MS, mk)
    detectSituations(st, makeInput(T0 + 5000, [])) // 1 s dropout
    const out = hold(st, T0 + 6000, T0 + 8000, mk) // re-held within the grace
    expect(out).toHaveLength(1)
    expect(out[0].since).toBe(T0)
  })
})

/* ── AT_VEHICLE / LINGERING_AT_VEHICLE ─────────────────────────────── */

/** Person box overlapping the vehicle box (IoU = 0.2). */
const P_OVERLAP: [number, number, number, number] = [0.4, 0.4, 0.1, 0.3]
const V_BOX: [number, number, number, number] = [0.35, 0.55, 0.3, 0.2]

function pairInput(t: number, opts: { night?: boolean; personBox?: [number, number, number, number] } = {}): ContextInput {
  return makeInput(
    t,
    [
      track({ trackId: 2, cls: 'person', identity: 'unknown', box: opts.personBox ?? P_OVERLAP, vel: [0.2, 0, 0, 0] }),
      track({ trackId: 3, cls: 'vehicle', box: V_BOX }),
    ],
    { night: opts.night },
  )
}

describe('AT_VEHICLE and LINGERING_AT_VEHICLE', () => {
  it('an overlapping person + vehicle pair activates only after the 3 s dwell', () => {
    const st = createContextState()
    hold(st, T0, T0 + 2500, pairInput)
    expect(detectSituations(st, pairInput(T0 + AT_VEHICLE_DWELL_MS - 1))).toHaveLength(0)
    const out = detectSituations(st, pairInput(T0 + AT_VEHICLE_DWELL_MS))
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ id: `vehicle:${CAM}:2:3`, kind: 'AT_VEHICLE', personLabel: 'UNKNOWN', since: T0 })
  })

  it('pairs on center proximity even without meaningful box overlap', () => {
    // IoU ≈ 0.023 (< 0.04) but center distance 0.196 < 0.6 × mean diagonal 0.338
    const st = createContextState()
    const mk = (t: number): ContextInput => pairInput(t, { personBox: [0.33, 0.4, 0.1, 0.3] })
    expect(hold(st, T0, T0 + AT_VEHICLE_DWELL_MS, mk)[0]?.kind).toBe('AT_VEHICLE')
  })

  it('a distant person and vehicle never pair', () => {
    const st = createContextState()
    const mk = (t: number): ContextInput => pairInput(t, { personBox: [0.05, 0.1, 0.1, 0.3] })
    expect(hold(st, T0, T0 + 8000, mk)).toHaveLength(0)
  })

  it('by day the pair upgrades to LINGERING at 25 s — same id, original since', () => {
    const st = createContextState()
    hold(st, T0, T0 + 24_500, pairInput)
    expect(detectSituations(st, pairInput(T0 + LINGER_DAY_MS - 1))[0]?.kind).toBe('AT_VEHICLE')
    const out = detectSituations(st, pairInput(T0 + LINGER_DAY_MS))
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ id: `vehicle:${CAM}:2:3`, kind: 'LINGERING_AT_VEHICLE', since: T0 })
  })

  it('by night the upgrade already lands at 12 s', () => {
    const st = createContextState()
    const mk = (t: number): ContextInput => pairInput(t, { night: true })
    hold(st, T0, T0 + 11_500, mk)
    expect(detectSituations(st, mk(T0 + LINGER_NIGHT_MS - 1))[0]?.kind).toBe('AT_VEHICLE')
    expect(detectSituations(st, mk(T0 + LINGER_NIGHT_MS))[0]?.kind).toBe('LINGERING_AT_VEHICLE')
  })

  it('by day 12 s is still just AT_VEHICLE', () => {
    const st = createContextState()
    hold(st, T0, T0 + 11_500, pairInput)
    expect(detectSituations(st, pairInput(T0 + LINGER_NIGHT_MS))[0]?.kind).toBe('AT_VEHICLE')
  })
})

/* ── CROUCHING_AT_VEHICLE ──────────────────────────────────────────── */

describe('CROUCHING_AT_VEHICLE', () => {
  it('a known person committed CROUCHING while at the vehicle raises it (alongside AT_VEHICLE)', () => {
    const st = createContextState()
    const mk = (t: number): ContextInput =>
      makeInput(
        t,
        [
          // vel keeps the entry rule quiet — this test is about the vehicle pair
          track({ trackId: 2, cls: 'person', identity: 'known', personId: 'p1', personName: 'Ada', box: P_OVERLAP, vel: [0.2, 0, 0, 0] }),
          track({ trackId: 3, cls: 'vehicle', box: V_BOX }),
        ],
        { activity: [['p1', 'CROUCHING']] },
      )
    const out = hold(st, T0, T0 + AT_VEHICLE_DWELL_MS, mk)
    expect(out.map((s) => s.kind).sort()).toEqual(['AT_VEHICLE', 'CROUCHING_AT_VEHICLE'])
    const crouch = out.find((s) => s.kind === 'CROUCHING_AT_VEHICLE')
    expect(crouch).toMatchObject({ id: `vehicle-crouch:${CAM}:2:3`, personId: 'p1', personLabel: 'ADA' })
  })

  it('a known person NOT committed crouching never triggers it, whatever the box shape', () => {
    const st = createContextState()
    const mk = (t: number): ContextInput =>
      makeInput(
        t,
        [
          // squat-shaped box (h/w = 1) — but identity is resolved, so only the
          // activity map may call a crouch, and it says STANDING
          track({ trackId: 2, cls: 'person', identity: 'known', personId: 'p1', personName: 'Ada', box: [0.4, 0.55, 0.2, 0.2], vel: [0.2, 0, 0, 0] }),
          track({ trackId: 3, cls: 'vehicle', box: V_BOX }),
        ],
        { activity: [['p1', 'STANDING']] },
      )
    const out = hold(st, T0, T0 + 8000, mk)
    expect(out.map((s) => s.kind)).toEqual(['AT_VEHICLE'])
  })

  it('an identity-less person triggers via the box-aspect fallback (h/w < 1.1)', () => {
    const st = createContextState()
    const mk = (t: number): ContextInput =>
      makeInput(t, [
        track({ trackId: 2, cls: 'person', identity: 'unknown', box: [0.4, 0.55, 0.2, 0.2], vel: [0.2, 0, 0, 0] }),
        track({ trackId: 3, cls: 'vehicle', box: V_BOX }),
      ])
    const out = hold(st, T0, T0 + AT_VEHICLE_DWELL_MS, mk)
    const crouch = out.find((s) => s.kind === 'CROUCHING_AT_VEHICLE')
    expect(crouch).toMatchObject({ personId: null, personLabel: 'UNKNOWN', since: T0 + AT_VEHICLE_DWELL_MS })
  })

  it('an upright identity-less person (tall box) does not trigger the fallback', () => {
    const st = createContextState()
    const mk = (t: number): ContextInput =>
      makeInput(t, [
        track({ trackId: 2, cls: 'person', identity: 'unknown', box: P_OVERLAP, vel: [0.2, 0, 0, 0] }), // h/w = 3
        track({ trackId: 3, cls: 'vehicle', box: V_BOX }),
      ])
    const out = hold(st, T0, T0 + 8000, mk)
    expect(out.some((s) => s.kind === 'CROUCHING_AT_VEHICLE')).toBe(false)
  })
})

/* ── PACKAGE_AT_ENTRY ──────────────────────────────────────────────── */

describe('PACKAGE_AT_ENTRY', () => {
  it('a package whose CENTER rests in the ENTRY zone activates after 2 s', () => {
    const st = createContextState()
    // center (0.51, 0.73) — inside; bottom-center irrelevant for packages
    const mk = (t: number): ContextInput =>
      makeInput(t, [track({ trackId: 7, cls: 'package', box: [0.48, 0.7, 0.06, 0.06] })])
    hold(st, T0, T0 + 1500, mk)
    expect(detectSituations(st, mk(T0 + PACKAGE_DWELL_MS - 1))).toHaveLength(0)
    const out = detectSituations(st, mk(T0 + PACKAGE_DWELL_MS))
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      id: `package:${CAM}:7`,
      kind: 'PACKAGE_AT_ENTRY',
      personId: null,
      personLabel: 'PACKAGE',
      since: T0,
    })
  })

  it('a package centered outside the zone never counts', () => {
    const st = createContextState()
    // center (0.51, 0.33) — above the zone
    const mk = (t: number): ContextInput =>
      makeInput(t, [track({ trackId: 7, cls: 'package', box: [0.48, 0.3, 0.06, 0.06] })])
    expect(hold(st, T0, T0 + 6000, mk)).toHaveLength(0)
  })
})
