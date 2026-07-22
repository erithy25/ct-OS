/**
 * Pose → activity classification: synthetic skeletons through the pure rules
 * (including RUNNING vs WALKING and CROUCHING vs SITTING), plus the temporal
 * smoother's hold / commit / fast-commit (WAVING · RUNNING · CROUCHING)
 * behaviour. Everything is deterministic — time only exists in the injected
 * sample `t`s.
 */
import { describe, expect, it } from 'vitest'
import {
  ActivitySmoother,
  classifyInstant,
  LM,
  type InstantActivity,
  type PoseLandmarkLite,
  type PoseSample,
} from '../classify'

/* ── synthetic landmark builders ───────────────────────────────────── */

const N_LANDMARKS = 33

function blank(): PoseLandmarkLite[] {
  return Array.from({ length: N_LANDMARKS }, () => ({ x: 0.5, y: 0.5, visibility: 0 }))
}

function put(lm: PoseLandmarkLite[], i: number, x: number, y: number, visibility = 1): void {
  lm[i] = { x, y, visibility }
}

/** Upright standing skeleton (straight legs, wrists down); hips at x 0.5+shift. */
function standingLm(shift = 0): PoseLandmarkLite[] {
  const lm = blank()
  put(lm, LM.NOSE, 0.5 + shift, 0.2)
  put(lm, LM.L_SHOULDER, 0.45 + shift, 0.3)
  put(lm, LM.R_SHOULDER, 0.55 + shift, 0.3)
  put(lm, LM.L_WRIST, 0.42 + shift, 0.55) // below the shoulders
  put(lm, LM.R_WRIST, 0.58 + shift, 0.55)
  put(lm, LM.L_HIP, 0.46 + shift, 0.55)
  put(lm, LM.R_HIP, 0.54 + shift, 0.55)
  put(lm, LM.L_KNEE, 0.46 + shift, 0.75) // straight legs (≈180° at the knee)
  put(lm, LM.R_KNEE, 0.54 + shift, 0.75)
  put(lm, LM.L_ANKLE, 0.46 + shift, 0.95)
  put(lm, LM.R_ANKLE, 0.54 + shift, 0.95)
  return lm
}

/** Upright torso, knees pushed forward + bent (≈100° at the knee). */
function sittingLm(): PoseLandmarkLite[] {
  const lm = standingLm()
  put(lm, LM.L_KNEE, 0.66, 0.58)
  put(lm, LM.R_KNEE, 0.66, 0.58)
  put(lm, LM.L_ANKLE, 0.66, 0.83)
  put(lm, LM.R_ANKLE, 0.66, 0.83)
  return lm
}

/** Horizontal body — torso ≈ 87° off vertical. */
function lyingLm(): PoseLandmarkLite[] {
  const lm = blank()
  put(lm, LM.NOSE, 0.15, 0.6)
  put(lm, LM.L_SHOULDER, 0.25, 0.58)
  put(lm, LM.R_SHOULDER, 0.25, 0.66)
  put(lm, LM.L_HIP, 0.6, 0.6)
  put(lm, LM.R_HIP, 0.6, 0.68)
  put(lm, LM.L_KNEE, 0.75, 0.62)
  put(lm, LM.R_KNEE, 0.75, 0.7)
  put(lm, LM.L_ANKLE, 0.9, 0.62)
  put(lm, LM.R_ANKLE, 0.9, 0.7)
  return lm
}

/** Standing skeleton with the right wrist raised above its shoulder at `wristX`. */
function raisedWristLm(wristX: number): PoseLandmarkLite[] {
  const lm = standingLm()
  put(lm, LM.R_WRIST, wristX, 0.18) // shoulder is at y 0.30 → wrist is above
  return lm
}

/**
 * Deep crouch: knees folded to ≈42°, pelvis dropped below knee level and near
 * the ankles (hip→ankle 0.14 vs a ≈0.56 reconstructed standing span), torso
 * leaning ≈45° forward — more lean than SITTING tolerates (40°).
 */
function crouchLm(): PoseLandmarkLite[] {
  const lm = blank()
  put(lm, LM.NOSE, 0.74, 0.54)
  put(lm, LM.L_SHOULDER, 0.64, 0.6)
  put(lm, LM.R_SHOULDER, 0.72, 0.6)
  put(lm, LM.L_WRIST, 0.66, 0.8) // hanging low — never reads as raised
  put(lm, LM.R_WRIST, 0.7, 0.8)
  put(lm, LM.L_HIP, 0.46, 0.78)
  put(lm, LM.R_HIP, 0.54, 0.78)
  put(lm, LM.L_KNEE, 0.38, 0.72) // knees ABOVE the hips (y grows downward)
  put(lm, LM.R_KNEE, 0.62, 0.72)
  put(lm, LM.L_ANKLE, 0.42, 0.92)
  put(lm, LM.R_ANKLE, 0.58, 0.92)
  return lm
}

/**
 * Deep-bent chair sit: knees ≈87° (below the crouch gate's 100°) under a
 * perfectly upright torso — but the pelvis stays HIGH above the ankles
 * (hip→ankle 0.27 vs a ≈0.66 standing span → ratio 0.41 > 0.35).
 */
function deepSitLm(): PoseLandmarkLite[] {
  const lm = standingLm()
  put(lm, LM.L_KNEE, 0.66, 0.58)
  put(lm, LM.R_KNEE, 0.66, 0.58)
  put(lm, LM.L_ANKLE, 0.6, 0.82) // feet tucked slightly under the seat
  put(lm, LM.R_ANKLE, 0.6, 0.82)
  return lm
}

const sample = (t: number, lm: PoseLandmarkLite[]): PoseSample => ({ t, lm })

/** ±0.05 square wave around 0.58, period 400 ms — a clear wave gesture. */
const waveX = (t: number): number => 0.58 + (Math.floor(t / 200) % 2 === 0 ? -0.05 : 0.05)

/* ── classifyInstant ───────────────────────────────────────────────── */

describe('classifyInstant', () => {
  it('reads an upright, still, straight-legged body as STANDING', () => {
    const r = classifyInstant([sample(0, standingLm())])
    expect(r).not.toBeNull()
    expect(r?.kind).toBe('STANDING')
    expect(r?.confidence).toBeGreaterThanOrEqual(0.5)
    expect(r?.confidence).toBeLessThanOrEqual(1)
  })

  it('reads bent knees under an upright torso as SITTING', () => {
    const r = classifyInstant([sample(0, sittingLm())])
    expect(r?.kind).toBe('SITTING')
    expect(r?.confidence).toBeGreaterThan(0.5)
  })

  it('reads a horizontal torso as LYING', () => {
    const r = classifyInstant([sample(0, lyingLm())])
    expect(r?.kind).toBe('LYING')
    expect(r?.confidence).toBeGreaterThan(0.5)
  })

  it('reads sustained lateral hip motion as WALKING', () => {
    // hip-center moves 0.011 units per 100 ms → 0.11 units/s (> 0.06)
    const history: PoseSample[] = []
    for (let i = 0; i < 10; i++) history.push(sample(i * 100, standingLm(0.011 * i)))
    const r = classifyInstant(history)
    expect(r?.kind).toBe('WALKING')
    expect(r?.confidence).toBeGreaterThan(0.5)
  })

  it('reads FAST hip translation as RUNNING, beating WALKING', () => {
    // hip-center moves 0.02 units per 100 ms → 0.20 units/s (> 0.16)
    const history: PoseSample[] = []
    for (let i = 0; i < 10; i++) history.push(sample(i * 100, standingLm(0.02 * i)))
    const r = classifyInstant(history)
    expect(r?.kind).toBe('RUNNING')
    expect(r?.confidence).toBeGreaterThan(0.5)
  })

  it('brisk-but-not-fast hip motion stays WALKING (below the RUNNING split)', () => {
    // 0.014 units per 100 ms → 0.14 units/s: above 0.06, below 0.16
    const history: PoseSample[] = []
    for (let i = 0; i < 10; i++) history.push(sample(i * 100, standingLm(0.014 * i)))
    expect(classifyInstant(history)?.kind).toBe('WALKING')
  })

  it('reads deep knees + hips at ankle height + forward torso as CROUCHING', () => {
    const r = classifyInstant([sample(0, crouchLm())])
    expect(r?.kind).toBe('CROUCHING')
    expect(r?.confidence).toBeGreaterThan(0.5)
  })

  it('crouch vs sit: deeply bent knees with the pelvis still high reads SITTING', () => {
    // knees ≈87° would pass the crouch knee gate, but the hip→ankle drop
    // (0.41 of the standing span) fails the ≤0.35 pelvis-drop rule
    expect(classifyInstant([sample(0, deepSitLm())])?.kind).toBe('SITTING')
  })

  it('reads a raised, oscillating wrist as WAVING (overriding STANDING)', () => {
    const history: PoseSample[] = []
    for (let t = 0; t <= 1100; t += 100) history.push(sample(t, raisedWristLm(waveX(t))))
    const r = classifyInstant(history)
    expect(r?.kind).toBe('WAVING')
    expect(r?.confidence).toBeGreaterThan(0.5)
  })

  it('a raised wrist WITHOUT oscillation is not WAVING', () => {
    const history: PoseSample[] = []
    for (let t = 0; t <= 1100; t += 100) history.push(sample(t, raisedWristLm(0.58)))
    expect(classifyInstant(history)?.kind).toBe('STANDING')
  })

  it('WAVING never overrides LYING', () => {
    const history: PoseSample[] = []
    for (let t = 0; t <= 1100; t += 100) {
      const lm = lyingLm()
      // left wrist raised above its shoulder (y 0.4 < 0.58) and oscillating
      put(lm, LM.L_WRIST, waveX(t), 0.4)
      history.push(sample(t, lm))
    }
    expect(classifyInstant(history)?.kind).toBe('LYING')
  })

  it('returns null when a required torso joint is not confidently visible', () => {
    const lm = standingLm()
    put(lm, LM.L_HIP, 0.46, 0.55, 0.3) // below the 0.5 visibility gate
    expect(classifyInstant([sample(0, lm)])).toBeNull()
  })

  it('returns null on an empty history', () => {
    expect(classifyInstant([])).toBeNull()
  })
})

/* ── ActivitySmoother ──────────────────────────────────────────────── */

const STAND: InstantActivity = { kind: 'STANDING', confidence: 0.8 }
const SIT: InstantActivity = { kind: 'SITTING', confidence: 0.8 }
const WAVE: InstantActivity = { kind: 'WAVING', confidence: 0.9 }
const RUN: InstantActivity = { kind: 'RUNNING', confidence: 0.8 }
const CROUCH: InstantActivity = { kind: 'CROUCHING', confidence: 0.8 }

/** Push `result` every 300 ms over [from, to] inclusive. */
function feed(s: ActivitySmoother, from: number, to: number, result: InstantActivity | null): void {
  for (let t = from; t <= to; t += 300) s.push(t, result)
}

describe('ActivitySmoother', () => {
  it('holds — no commit before the majority has persisted 2.5 s', () => {
    const s = new ActivitySmoother()
    feed(s, 0, 2400, STAND)
    expect(s.current()).toBeNull()
    // majority formed at t=1200 (5th sample); 3600−1200 < 2500 → still held
    feed(s, 2700, 3600, STAND)
    expect(s.current()).toBeNull()
  })

  it('commits once the majority persists, and changes only after a new one persists', () => {
    const s = new ActivitySmoother()
    feed(s, 0, 3900, STAND)
    expect(s.current()).toBe('STANDING') // 3900−1200 ≥ 2500
    // switch to sitting: majority flips at t=5400 (5 of the last 8)
    feed(s, 4200, 7800, SIT)
    expect(s.current()).toBe('STANDING') // 7800−5400 < 2500 → still standing
    s.push(8100, SIT)
    expect(s.current()).toBe('SITTING') // 8100−5400 ≥ 2500 → committed
  })

  it('WAVING fast-commits after 1.0 s of majority', () => {
    const s = new ActivitySmoother()
    feed(s, 0, 2100, WAVE)
    expect(s.current()).toBeNull() // majority at 1200; 2100−1200 < 1000
    s.push(2400, WAVE)
    expect(s.current()).toBe('WAVING') // 2400−1200 ≥ 1000
  })

  it('RUNNING fast-commits after 1.2 s of majority (not the 2.5 s hold)', () => {
    const s = new ActivitySmoother()
    feed(s, 0, 2100, RUN)
    expect(s.current()).toBeNull() // majority at 1200; 2100−1200 = 900 < 1200
    s.push(2400, RUN)
    expect(s.current()).toBe('RUNNING') // 2400−1200 = 1200 ≥ 1200
  })

  it('CROUCHING fast-commits after 1.2 s of majority (not the 2.5 s hold)', () => {
    const s = new ActivitySmoother()
    feed(s, 0, 2100, CROUCH)
    expect(s.current()).toBeNull() // majority at 1200; 2100−1200 = 900 < 1200
    s.push(2400, CROUCH)
    expect(s.current()).toBe('CROUCHING') // 2400−1200 = 1200 ≥ 1200
  })

  it('committed WAVING auto-expires after 4 s back to the runner-up', () => {
    const s = new ActivitySmoother()
    feed(s, 0, 2400, WAVE) // commits WAVING at t=2400
    feed(s, 2700, 6300, STAND)
    expect(s.current()).toBe('WAVING') // 6300−2400 < 4000 → not yet expired
    s.push(6600, STAND)
    expect(s.current()).toBe('STANDING') // expired → runner-up in the window
  })

  it('committed WAVING auto-expires to null when nothing else was seen', () => {
    const s = new ActivitySmoother()
    feed(s, 0, 2400, WAVE) // commits WAVING at t=2400
    feed(s, 2700, 6300, null)
    expect(s.current()).toBe('WAVING')
    s.push(6600, null) // 6600−2400 ≥ 4000, window has no non-WAVING kinds
    expect(s.current()).toBeNull()
  })
})
