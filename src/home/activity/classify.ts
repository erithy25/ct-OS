/**
 * PANOPTICON // HOMEWATCH — pose → NEUTRAL activity classification.
 *
 * Pure, deterministic geometry over MediaPipe pose landmarks. Activities are
 * plain observations of what a body is doing — STANDING / SITTING / WALKING /
 * RUNNING / CROUCHING / LYING / WAVING — never a judgement about a person. No
 * hidden clock: every function works only on the timestamps carried by its
 * input samples, so the whole file is unit-testable with synthetic skeletons.
 *
 * Landmark topology (MediaPipe Pose, 33 points): nose 0, shoulders 11/12,
 * wrists 15/16, hips 23/24, knees 25/26, ankles 27/28.
 */
import type { ActivityKind } from '../types'

/* ── landmark indices ──────────────────────────────────────────────── */

export const LM = {
  NOSE: 0,
  L_SHOULDER: 11,
  R_SHOULDER: 12,
  L_WRIST: 15,
  R_WRIST: 16,
  L_HIP: 23,
  R_HIP: 24,
  L_KNEE: 25,
  R_KNEE: 26,
  L_ANKLE: 27,
  R_ANKLE: 28,
} as const

/* ── shapes ────────────────────────────────────────────────────────── */

/** One landmark as the classifier needs it (z is optional and ignored). */
export interface PoseLandmarkLite {
  x: number
  y: number
  visibility: number
  z?: number
}

/** One timestamped pose frame. `t` is wall-clock ms (injected, never read). */
export interface PoseSample {
  t: number
  lm: PoseLandmarkLite[]
}

export interface InstantActivity {
  kind: ActivityKind
  confidence: number
}

/* ── tunables (all documented at their rule) ───────────────────────── */

/** A joint below this visibility is treated as unseen. */
export const MIN_VISIBILITY = 0.5
/** LYING: torso ≥ this many degrees off vertical (= within 35° of horizontal). */
export const LYING_FROM_VERTICAL_DEG = 55
/** SITTING: mean knee angle below this… */
export const SITTING_KNEE_DEG = 130
/** …while the torso stays within this many degrees of vertical. */
export const SITTING_TORSO_DEG = 40
/** WALKING: hip-center |dx/dt| EMA above this (normalized units / second). */
export const WALK_SPEED = 0.06
/** RUNNING: the same hip-x EMA above this (units/s) — RUNNING beats WALKING. */
export const RUN_SPEED = 0.16
/** WALKING looks at roughly the last second of history. */
export const WALK_WINDOW_MS = 1000
/** EMA weight per successive sample pair inside the walk window. */
export const WALK_EMA_ALPHA = 0.4
/** CROUCHING: mean knee angle below this (a much deeper fold than SITTING's 130°). */
export const CROUCH_KNEE_DEG = 100
/** CROUCHING: vertical hip→ankle distance below this fraction of the standing span. */
export const CROUCH_HIP_DROP_RATIO = 0.35
/** CROUCHING: torso may lean forward up to this many degrees off vertical. */
export const CROUCH_TORSO_DEG = 60
/** CROUCHING: hips may sit above knee level by at most this fraction of the standing span. */
export const CROUCH_HIP_KNEE_TOL = 0.05
/** WAVING looks at the last 1.2 s of wrist track. */
export const WAVE_WINDOW_MS = 1200
/** WAVING: at least this many direction reversals inside the window… */
export const WAVE_MIN_FLIPS = 3
/** …where each swing between reversals travels more than this in x. */
export const WAVE_AMPLITUDE = 0.04

/* ── small helpers ─────────────────────────────────────────────────── */

function joint(s: PoseSample, i: number): PoseLandmarkLite | null {
  const p = s.lm[i]
  return p !== undefined && p.visibility >= MIN_VISIBILITY ? p : null
}

function mid(a: PoseLandmarkLite, b: PoseLandmarkLite): { x: number; y: number } {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
}

const DEG = 180 / Math.PI

/**
 * Torso tilt away from vertical, in degrees. 0° = perfectly upright,
 * 90° = horizontal. Uses the shoulder-center → hip-center line.
 */
function torsoFromVerticalDeg(s: PoseSample): number | null {
  const ls = joint(s, LM.L_SHOULDER)
  const rs = joint(s, LM.R_SHOULDER)
  const lh = joint(s, LM.L_HIP)
  const rh = joint(s, LM.R_HIP)
  if (!ls || !rs || !lh || !rh) return null
  const sc = mid(ls, rs)
  const hc = mid(lh, rh)
  const dx = Math.abs(sc.x - hc.x)
  const dy = Math.abs(sc.y - hc.y)
  if (dx === 0 && dy === 0) return null
  return Math.atan2(dx, dy) * DEG
}

/** Interior angle at a knee (hip–knee–ankle), degrees. 180° = straight leg. */
function angleAt(hip: PoseLandmarkLite, knee: PoseLandmarkLite, ankle: PoseLandmarkLite): number {
  const v1x = hip.x - knee.x
  const v1y = hip.y - knee.y
  const v2x = ankle.x - knee.x
  const v2y = ankle.y - knee.y
  const n1 = Math.hypot(v1x, v1y)
  const n2 = Math.hypot(v2x, v2y)
  if (n1 === 0 || n2 === 0) return 180
  const cos = Math.min(1, Math.max(-1, (v1x * v2x + v1y * v2y) / (n1 * n2)))
  return Math.acos(cos) * DEG
}

/** Mean knee angle over the legs whose hip+knee+ankle are all visible. */
function kneeAngleDeg(s: PoseSample): number | null {
  const legs: Array<[number, number, number]> = [
    [LM.L_HIP, LM.L_KNEE, LM.L_ANKLE],
    [LM.R_HIP, LM.R_KNEE, LM.R_ANKLE],
  ]
  let sum = 0
  let n = 0
  for (const [h, k, a] of legs) {
    const hip = joint(s, h)
    const knee = joint(s, k)
    const ankle = joint(s, a)
    if (!hip || !knee || !ankle) continue
    sum += angleAt(hip, knee, ankle)
    n++
  }
  return n > 0 ? sum / n : null
}

interface CrouchMetrics {
  /** vertical hip-center → ankle-center distance (normalized units) */
  hipDrop: number
  /** hipCenter.y − kneeCenter.y — positive = hips BELOW the knees (y grows down) */
  hipBelowKnee: number
  /** the STANDING shoulder→ankle span, reconstructed from this same sample */
  standingSpan: number
}

/**
 * Crouch geometry for one sample. The "standing shoulder→ankle span" is
 * reconstructed pose-invariantly from the SAME sample as the sum of segment
 * lengths |shoulderC−hipC| + mean over fully-visible legs of
 * (|hip−knee| + |knee−ankle|) — limb lengths don't change when the body
 * folds, so this measures what the span WOULD be standing, without needing
 * any earlier upright frame. Null when the hips or every leg are unseen.
 */
function crouchMetrics(s: PoseSample): CrouchMetrics | null {
  const ls = joint(s, LM.L_SHOULDER)
  const rs = joint(s, LM.R_SHOULDER)
  const lh = joint(s, LM.L_HIP)
  const rh = joint(s, LM.R_HIP)
  if (!ls || !rs || !lh || !rh) return null
  const shoulderC = mid(ls, rs)
  const hipC = mid(lh, rh)

  const legs: Array<[number, number, number]> = [
    [LM.L_HIP, LM.L_KNEE, LM.L_ANKLE],
    [LM.R_HIP, LM.R_KNEE, LM.R_ANKLE],
  ]
  let legLenSum = 0
  let kneeY = 0
  let ankleY = 0
  let n = 0
  for (const [h, k, a] of legs) {
    const hip = joint(s, h)
    const knee = joint(s, k)
    const ankle = joint(s, a)
    if (!hip || !knee || !ankle) continue
    legLenSum += Math.hypot(hip.x - knee.x, hip.y - knee.y) + Math.hypot(knee.x - ankle.x, knee.y - ankle.y)
    kneeY += knee.y
    ankleY += ankle.y
    n++
  }
  if (n === 0) return null
  const kneeCy = kneeY / n
  const ankleCy = ankleY / n
  return {
    hipDrop: Math.abs(ankleCy - hipC.y),
    hipBelowKnee: hipC.y - kneeCy,
    standingSpan: Math.hypot(shoulderC.x - hipC.x, shoulderC.y - hipC.y) + legLenSum / n,
  }
}

/**
 * EMA of |d(hipCenter.x)/dt| over successive samples in the trailing walk
 * window (units/second). Null when fewer than two hip-visible samples exist.
 */
function hipSpeedEma(history: readonly PoseSample[], tEnd: number): number | null {
  let prev: { t: number; x: number } | null = null
  let ema: number | null = null
  for (const s of history) {
    if (s.t < tEnd - WALK_WINDOW_MS || s.t > tEnd) continue
    const lh = joint(s, LM.L_HIP)
    const rh = joint(s, LM.R_HIP)
    if (!lh || !rh) continue
    const x = (lh.x + rh.x) / 2
    if (prev !== null && s.t > prev.t) {
      const v = Math.abs(x - prev.x) / ((s.t - prev.t) / 1000)
      ema = ema === null ? v : WALK_EMA_ALPHA * v + (1 - WALK_EMA_ALPHA) * ema
    }
    prev = { t: s.t, x }
  }
  return ema
}

/**
 * Count direction reversals of a wrist's x track inside the wave window,
 * with amplitude hysteresis: a reversal only counts when the swing since the
 * last extremum travelled more than WAVE_AMPLITUDE (so pixel jitter never
 * "waves"). Establishing the initial direction is not a flip.
 */
function waveFlips(history: readonly PoseSample[], wristIdx: number, tEnd: number): number {
  const xs: number[] = []
  for (const s of history) {
    if (s.t < tEnd - WAVE_WINDOW_MS || s.t > tEnd) continue
    const w = joint(s, wristIdx)
    if (w) xs.push(w.x)
  }
  if (xs.length < 3) return 0
  let flips = 0
  let dir = 0
  let extremum = xs[0]
  for (let i = 1; i < xs.length; i++) {
    const x = xs[i]
    const d = x - extremum
    if (dir === 0) {
      if (Math.abs(d) > WAVE_AMPLITUDE) {
        dir = Math.sign(d)
        extremum = x
      }
    } else if (d * dir > 0) {
      extremum = x // still swinging the established way
    } else if (Math.abs(d) > WAVE_AMPLITUDE) {
      flips++
      dir = -dir
      extremum = x
    }
  }
  return flips
}

/**
 * Confidence mapping, used by every rule: confidence = 0.5 exactly at the
 * decision threshold and climbs linearly to 1.0 once the measurement clears
 * the threshold by `span` (then clamps). So `0.5 + 0.5 · margin/span`,
 * clamped into [0.5, 1] — a decision is never reported below coin-flip-plus.
 */
function conf(margin: number, span: number): number {
  return Math.min(1, Math.max(0.5, 0.5 + 0.5 * (margin / span)))
}

/* ── the instant classifier ────────────────────────────────────────── */

/**
 * Classify the NEWEST sample of `history` (older samples only feed the motion
 * rules). Returns null when the torso joints (both shoulders + both hips) are
 * not confidently visible — no guessing from half a body.
 *
 * Rule order: LYING wins outright (a raised arm while lying is not a wave),
 * then WAVING, then CROUCHING, then SITTING, then RUNNING, then WALKING,
 * else STANDING. CROUCHING outranks SITTING (it is the stricter shape) and
 * RUNNING outranks WALKING (it is the stricter speed).
 */
export function classifyInstant(history: PoseSample[]): InstantActivity | null {
  if (history.length === 0) return null
  const now = history[history.length - 1]

  for (const i of [LM.L_SHOULDER, LM.R_SHOULDER, LM.L_HIP, LM.R_HIP]) {
    const p = now.lm[i]
    if (p === undefined || p.visibility < MIN_VISIBILITY) return null
  }

  const torso = torsoFromVerticalDeg(now)
  if (torso === null) return null

  // LYING — torso within 35° of horizontal. Nothing overrides it.
  if (torso >= LYING_FROM_VERTICAL_DEG) {
    return { kind: 'LYING', confidence: conf(torso - LYING_FROM_VERTICAL_DEG, 90 - LYING_FROM_VERTICAL_DEG) }
  }

  // WAVING — a wrist raised above its shoulder whose x oscillates.
  const sides: Array<[number, number]> = [
    [LM.L_WRIST, LM.L_SHOULDER],
    [LM.R_WRIST, LM.R_SHOULDER],
  ]
  let bestFlips = 0
  for (const [w, sh] of sides) {
    const wrist = joint(now, w)
    const shoulder = joint(now, sh)
    if (!wrist || !shoulder) continue
    if (wrist.y >= shoulder.y) continue // not raised (y grows downward)
    const flips = waveFlips(history, w, now.t)
    if (flips > bestFlips) bestFlips = flips
  }
  if (bestFlips >= WAVE_MIN_FLIPS) {
    return { kind: 'WAVING', confidence: conf(bestFlips - WAVE_MIN_FLIPS, WAVE_MIN_FLIPS) }
  }

  // CROUCHING vs SITTING — both bend the knees under a not-horizontal torso.
  // Exact discriminator: CROUCHING requires ALL of
  //   (a) mean knee angle < 100° (SITTING accepts anything < 130°),
  //   (b) the pelvis dropped to the feet — vertical hip→ankle distance
  //       < 0.35 × the standing shoulder→ankle span (reconstructed from the
  //       same sample, see crouchMetrics; a seated pelvis rests ~0.4–0.6 of
  //       the span above the ankles),
  //   (c) hips at or BELOW knee level, allowing at most 0.05 × span above it
  //       (hipC.y ≥ kneeC.y − 0.05·span; y grows downward), and
  //   (d) torso ≤ 60° off vertical — a crouch may lean well forward, which
  //       SITTING (≤ 40°) rejects.
  // A chair sit fails (b) — and usually (a) — so it falls through to SITTING.
  const knee = kneeAngleDeg(now)
  if (knee !== null && knee < CROUCH_KNEE_DEG && torso <= CROUCH_TORSO_DEG) {
    const m = crouchMetrics(now)
    if (
      m !== null &&
      m.standingSpan > 0 &&
      m.hipDrop < CROUCH_HIP_DROP_RATIO * m.standingSpan &&
      m.hipBelowKnee >= -CROUCH_HIP_KNEE_TOL * m.standingSpan
    ) {
      return { kind: 'CROUCHING', confidence: conf(CROUCH_KNEE_DEG - knee, 40) }
    }
  }

  // SITTING — bent knees under an upright torso.
  if (knee !== null && knee < SITTING_KNEE_DEG && torso <= SITTING_TORSO_DEG) {
    return { kind: 'SITTING', confidence: conf(SITTING_KNEE_DEG - knee, 60) }
  }

  // RUNNING / WALKING — sustained lateral hip motion while upright, one
  // speed metric split at RUN_SPEED: the faster read wins.
  const speed = hipSpeedEma(history, now.t)
  if (speed !== null && speed > RUN_SPEED) {
    return { kind: 'RUNNING', confidence: conf(speed - RUN_SPEED, RUN_SPEED) }
  }
  if (speed !== null && speed > WALK_SPEED) {
    return { kind: 'WALKING', confidence: conf(speed - WALK_SPEED, WALK_SPEED) }
  }

  // STANDING — the default. Its confidence is the distance to the NEAREST
  // competing threshold (normalized per rule), through the same 0.5..1 map:
  // deep inside "clearly standing" → 1, right at a rival's boundary → 0.5.
  let margin = (LYING_FROM_VERTICAL_DEG - torso) / LYING_FROM_VERTICAL_DEG
  if (knee !== null) margin = Math.min(margin, Math.max(0, knee - SITTING_KNEE_DEG) / 50)
  if (speed !== null) margin = Math.min(margin, Math.max(0, WALK_SPEED - speed) / WALK_SPEED)
  return { kind: 'STANDING', confidence: conf(margin, 1) }
}

/* ── temporal smoothing ────────────────────────────────────────────── */

export interface SmootherOptions {
  /** ms a majority must persist before a regular commit (default 2500) */
  holdMs?: number
  /** ms a WAVING majority must persist before committing (default 1000) */
  wavingHoldMs?: number
  /** ms a RUNNING/CROUCHING majority must persist before committing (default 1200) */
  fastHoldMs?: number
  /** ms after which a committed WAVING auto-expires (default 4000) */
  wavingExpireMs?: number
  /** how many trailing non-null samples the majority looks at (default 8) */
  windowSamples?: number
  /** samples older than this fall out of the window entirely (default 4000) */
  windowMs?: number
  /** votes needed inside the window to be the majority (default 5) */
  majority?: number
}

/**
 * Debounces instant classifications into a stable committed activity.
 *
 * A NEW activity commits only when it is the majority (≥5 of the last 8
 * non-null samples) AND that majority has persisted continuously for the
 * kind's hold. Per-kind fast-commit: WAVING commits after 1.0 s; RUNNING and
 * CROUCHING after 1.2 s (both are transient and reaction-relevant — waiting
 * the full 2.5 s would routinely miss them); everything else holds 2.5 s.
 * WAVING is a moment, not a state: it also auto-expires 4 s after
 * committing, back to the runner-up kind in the window (most frequent
 * non-WAVING, latest-seen wins ties) or null.
 *
 * Fully deterministic — time only ever arrives through `push(t, …)`.
 */
export class ActivitySmoother {
  private readonly holdMs: number
  private readonly wavingHoldMs: number
  private readonly fastHoldMs: number
  private readonly wavingExpireMs: number
  private readonly windowSamples: number
  private readonly windowMs: number
  private readonly majority: number

  private window: Array<{ t: number; kind: ActivityKind }> = []
  private committed: ActivityKind | null = null
  private candidate: ActivityKind | null = null
  private candidateSince = 0
  private wavingCommittedAt: number | null = null

  constructor(opts: SmootherOptions = {}) {
    this.holdMs = opts.holdMs ?? 2500
    this.wavingHoldMs = opts.wavingHoldMs ?? 1000
    this.fastHoldMs = opts.fastHoldMs ?? 1200
    this.wavingExpireMs = opts.wavingExpireMs ?? 4000
    this.windowSamples = opts.windowSamples ?? 8
    this.windowMs = opts.windowMs ?? 4000
    this.majority = opts.majority ?? 5
  }

  /** Feed one tick. Null results still advance time (trim + expiry). */
  push(t: number, result: InstantActivity | null): ActivityKind | null {
    if (result !== null) {
      this.window.push({ t, kind: result.kind })
      if (this.window.length > this.windowSamples) this.window.shift()
    }
    while (this.window.length > 0 && t - this.window[0].t > this.windowMs) this.window.shift()

    // committed WAVING expires on its own — a wave is an event, not a state
    if (
      this.committed === 'WAVING' &&
      this.wavingCommittedAt !== null &&
      t - this.wavingCommittedAt >= this.wavingExpireMs
    ) {
      this.committed = this.runnerUp()
      this.wavingCommittedAt = null
      this.candidate = null
      this.candidateSince = t
    }

    const maj = this.majorityKind()
    if (maj === null || maj === this.committed) {
      // no pending change — reset the persistence clock
      if (this.candidate !== null) {
        this.candidate = null
        this.candidateSince = t
      }
      return this.committed
    }
    if (this.candidate !== maj) {
      this.candidate = maj
      this.candidateSince = t
    }
    const hold =
      maj === 'WAVING' ? this.wavingHoldMs : maj === 'RUNNING' || maj === 'CROUCHING' ? this.fastHoldMs : this.holdMs
    if (t - this.candidateSince >= hold) {
      this.committed = maj
      this.wavingCommittedAt = maj === 'WAVING' ? t : null
      this.candidate = null
      this.candidateSince = t
    }
    return this.committed
  }

  /** The stable, committed activity (null until the first commit). */
  current(): ActivityKind | null {
    return this.committed
  }

  private majorityKind(): ActivityKind | null {
    if (this.window.length === 0) return null
    const counts = new Map<ActivityKind, number>()
    for (const s of this.window) counts.set(s.kind, (counts.get(s.kind) ?? 0) + 1)
    for (const [kind, n] of counts) {
      if (n >= this.majority) return kind
    }
    return null
  }

  /** Most frequent non-WAVING kind in the window; latest occurrence breaks ties. */
  private runnerUp(): ActivityKind | null {
    const counts = new Map<ActivityKind, { n: number; last: number }>()
    for (const s of this.window) {
      if (s.kind === 'WAVING') continue
      const c = counts.get(s.kind)
      if (c) {
        c.n++
        c.last = s.t
      } else counts.set(s.kind, { n: 1, last: s.t })
    }
    let best: ActivityKind | null = null
    let bestN = 0
    let bestLast = -1
    for (const [kind, { n, last }] of counts) {
      if (n > bestN || (n === bestN && last > bestLast)) {
        best = kind
        bestN = n
        bestLast = last
      }
    }
    return best
  }
}
