/**
 * PANOPTICON // HOMEWATCH — gently-learned ROUTINES.
 *
 * A tiny, honest frequency model of when each household member usually
 * arrives home: a rolling log of arrival times (weekday + minutes-of-day),
 * summarized by median + MAD. It produces one soft line per person
 * ("USUALLY HOME BY ~17:40") and one gentle, informational absence note —
 * never anything alarming, never a prediction dressed up as fact.
 *
 * All math is pure with time injected; only load/save touch localStorage and
 * both are guarded so a storage-less environment (tests, private mode) simply
 * runs in-memory.
 */

export const ROUTINES_KEY = 'homewatch.routines.v1'

/** How many arrivals we remember per person (newest kept). */
export const MAX_ENTRIES = 60

/** A person crossing "usually home by" + this many minutes → gentle note. */
export const ABSENCE_GRACE_MIN = 60

/** Fewest samples before we claim to know anything about a routine. */
export const MIN_SAMPLES = 3

/** One recorded homecoming. */
export interface ArrivalEntry {
  /** 0 (Sunday) … 6 (Saturday), local time */
  weekday: number
  /** minutes since local midnight, 0..1439 */
  minutesOfDay: number
}

/** personId → newest-last arrival log. */
export type RoutineStore = Record<string, ArrivalEntry[]>

/* ── persistence (guarded — never throws, never required) ──────────── */

export function loadRoutines(): RoutineStore {
  try {
    if (typeof localStorage === 'undefined') return {}
    const raw = localStorage.getItem(ROUTINES_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as RoutineStore
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: RoutineStore = {}
    for (const [id, entries] of Object.entries(parsed)) {
      if (!Array.isArray(entries)) continue
      out[id] = entries.filter(
        (e): e is ArrivalEntry =>
          !!e &&
          typeof e.weekday === 'number' &&
          e.weekday >= 0 &&
          e.weekday <= 6 &&
          typeof e.minutesOfDay === 'number' &&
          e.minutesOfDay >= 0 &&
          e.minutesOfDay < 24 * 60,
      )
    }
    return out
  } catch {
    return {}
  }
}

export function saveRoutines(store: RoutineStore): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(ROUTINES_KEY, JSON.stringify(store))
  } catch {
    /* storage unavailable / full — the in-memory log still works */
  }
}

/* ── pure helpers ──────────────────────────────────────────────────── */

/** Minutes since local midnight for a wall-clock ms timestamp. */
export function minutesOfDay(ts: number): number {
  const d = new Date(ts)
  return d.getHours() * 60 + d.getMinutes()
}

/**
 * Log one arrival for `personId` at wall-clock `ts` (local weekday + minutes
 * derived here). Mutates and returns `store`, keeping only the newest
 * MAX_ENTRIES per person. The caller decides what counts as an "arrival"
 * (the brain records the first homecoming per person per day).
 */
export function recordArrival(store: RoutineStore, personId: string, ts: number): RoutineStore {
  const entry: ArrivalEntry = { weekday: new Date(ts).getDay(), minutesOfDay: minutesOfDay(ts) }
  const entries = store[personId] ?? []
  entries.push(entry)
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES)
  store[personId] = entries
  return store
}

/** Median of a non-empty numeric list (mean of the middle two when even). */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

export interface UsualArrival {
  /** median arrival, minutes since local midnight */
  minutes: number
  /** median absolute deviation — how settled the routine is */
  madMinutes: number
}

/**
 * Median minutes-of-day + MAD over the arrival log. Needs ≥3 samples, else
 * null (no claims from thin evidence). When `now` is given and the log holds
 * ≥3 samples for today's weekday, only those are used — a weekday-aware
 * routine once enough evidence exists, the overall one before that.
 */
export function usualArrival(entries: readonly ArrivalEntry[], now?: number): UsualArrival | null {
  if (entries.length < MIN_SAMPLES) return null
  let pool: readonly ArrivalEntry[] = entries
  if (now !== undefined) {
    const wd = new Date(now).getDay()
    const sameDay = entries.filter((e) => e.weekday === wd)
    if (sameDay.length >= MIN_SAMPLES) pool = sameDay
  }
  const mins = pool.map((e) => e.minutesOfDay)
  const med = median(mins)
  const mad = median(mins.map((m) => Math.abs(m - med)))
  return { minutes: med, madMinutes: mad }
}

/** 1060 → "17:40" (24 h clock, zero-padded, wraps defensively). */
export function fmtMinutes(minutes: number): string {
  const total = ((Math.round(minutes) % (24 * 60)) + 24 * 60) % (24 * 60)
  const h = Math.floor(total / 60)
  const m = total % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

/** The soft routine line, e.g. "USUALLY HOME BY ~17:40". Null without one. */
export function routineLine(usual: UsualArrival | null): string | null {
  if (usual === null) return null
  return `USUALLY HOME BY ~${fmtMinutes(usual.minutes)}`
}

/**
 * Is a gentle "not seen yet today" note due? True only once the clock is more
 * than ABSENCE_GRACE_MIN past the usual arrival and no note went out today.
 * Purely informational — the wording upstream stays soft by design.
 */
export function absenceNoteDue(usual: UsualArrival, nowMinutes: number, alreadyNotedToday: boolean): boolean {
  if (alreadyNotedToday) return false
  return nowMinutes > usual.minutes + ABSENCE_GRACE_MIN
}
