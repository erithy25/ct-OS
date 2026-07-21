/**
 * PANOPTICON // HOMEWATCH — ACTIVITY rollups.
 *
 * Pure, allocation-light functions that fold the flat HomeEvent ring buffer
 * into the shapes the ACTIVITY module renders: an hour-of-day activity
 * histogram, per-person presence summaries, rolling per-minute detection counts
 * for camera sparklines, and a plain-language "routine" note.
 *
 * Everything here is deterministic given its inputs — the only clock is the
 * optional `now` argument, never a hidden Date.now() — so each function reads
 * correctly in your head and would test cleanly. No store access, no side
 * effects. It's an honest frequency model, not a predictor.
 */
import type { HomeEvent, HomeEventKind, Person } from '../types'

const MINUTE = 60_000

/** Event kinds that reflect real-world activity (not link / camera plumbing). */
export const ACTIVITY_KINDS: readonly HomeEventKind[] = ['DETECTION', 'PERSON', 'ZONE', 'ACTIVITY', 'ALERT']
const ACTIVITY_KIND_SET: ReadonlySet<HomeEventKind> = new Set(ACTIVITY_KINDS)

/** Kinds that stand in for a "detection" when we synthesize per-camera counts. */
export const DETECTION_KINDS: readonly HomeEventKind[] = ['PERSON', 'DETECTION']
const DETECTION_KIND_SET: ReadonlySet<HomeEventKind> = new Set(DETECTION_KINDS)

/** True for events that reflect activity in / around the home. */
export const isActivityEvent = (e: HomeEvent): boolean => ACTIVITY_KIND_SET.has(e.kind)

/** Local midnight for the day containing `now`. */
export function startOfDay(now: number = Date.now()): number {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/**
 * 24-bin hour-of-day histogram (local hours) of activity events. Bin `i` is the
 * count of activity events whose local hour === i, aggregated across every day
 * in the buffer. System / camera plumbing is ignored. Pure.
 */
export function bucketByHour(events: readonly HomeEvent[]): number[] {
  const bins = new Array<number>(24).fill(0)
  for (const e of events) {
    if (!ACTIVITY_KIND_SET.has(e.kind)) continue
    bins[new Date(e.ts).getHours()]++
  }
  return bins
}

export interface RollingOpts {
  /** window end (defaults to Date.now()) */
  now?: number
  /** number of 1-minute bins (defaults to 30) */
  minutes?: number
  /** restrict to one camera */
  cameraId?: string
  /** restrict to one person */
  personId?: string
  /** which kinds count (defaults to PERSON + DETECTION — i.e. "detections") */
  kinds?: readonly HomeEventKind[]
}

/**
 * Per-minute event counts over the trailing `minutes` window, oldest→newest.
 * The result length is always `minutes`; the final bin is the current (partial)
 * minute. This synthesizes a smooth detections sparkline out of discrete events.
 * Pure given `now`.
 */
export function rollingPerMinute(events: readonly HomeEvent[], opts: RollingOpts = {}): number[] {
  const now = opts.now ?? Date.now()
  const minutes = Math.max(1, Math.floor(opts.minutes ?? 30))
  const kinds = opts.kinds ? new Set(opts.kinds) : DETECTION_KIND_SET
  const bins = new Array<number>(minutes).fill(0)
  const start = now - minutes * MINUTE
  for (const e of events) {
    if (e.ts <= start || e.ts > now) continue
    if (opts.cameraId !== undefined && e.cameraId !== opts.cameraId) continue
    if (opts.personId !== undefined && e.personId !== opts.personId) continue
    if (!kinds.has(e.kind)) continue
    const idx = Math.floor((e.ts - start) / MINUTE)
    if (idx >= 0 && idx < minutes) bins[idx]++
  }
  return bins
}

export interface PersonPresence {
  id: string
  /** live presence, straight from the authoritative Person.present flag */
  presentNow: boolean
  /** first activity attributed to this person today (personId), or null */
  firstSeen: number | null
  /** most recent activity today — event-derived, else the store's lastSeen */
  lastSeen: number | null
  /** gap-separated appearance clusters today */
  sessions: number
  /** activity events attributed to this person today */
  todayCount: number
}

/** Two appearances more than this apart count as separate sessions. */
export const SESSION_GAP_MS = 5 * MINUTE

/**
 * Per-person presence summary for "today" (since local midnight). Presence-now
 * is taken from the authoritative `Person.present` flag; first / last-seen and
 * the session count are derived from events tagged with that person's id. When
 * no such events exist yet (face-matching not wired for a given person) the row
 * falls back to the store's `lastSeen` so it stays truthful rather than blank.
 * Pure given `now`. Assumes events are in ascending-ts order (the ring buffer
 * is append-only), and sorts defensively if not.
 */
export function rollupByPerson(
  events: readonly HomeEvent[],
  people: readonly Person[],
  now: number = Date.now(),
): PersonPresence[] {
  const dayStart = startOfDay(now)
  const byPerson = new Map<string, number[]>()
  for (const e of events) {
    if (e.personId === undefined) continue
    if (e.ts < dayStart) continue
    if (!ACTIVITY_KIND_SET.has(e.kind)) continue
    const arr = byPerson.get(e.personId)
    if (arr) arr.push(e.ts)
    else byPerson.set(e.personId, [e.ts])
  }

  return people.map((p) => {
    const ts = byPerson.get(p.id)
    if (!ts || ts.length === 0) {
      const fallbackLast = p.lastSeen !== undefined && p.lastSeen >= dayStart ? p.lastSeen : null
      return {
        id: p.id,
        presentNow: p.present,
        firstSeen: null,
        lastSeen: fallbackLast,
        sessions: p.present ? 1 : 0,
        todayCount: 0,
      }
    }
    ts.sort((a, b) => a - b)
    let sessions = 1
    for (let i = 1; i < ts.length; i++) {
      if (ts[i] - ts[i - 1] > SESSION_GAP_MS) sessions++
    }
    return {
      id: p.id,
      presentNow: p.present,
      firstSeen: ts[0],
      lastSeen: ts[ts.length - 1],
      sessions,
      todayCount: ts.length,
    }
  })
}

export interface RoutineSummary {
  /** total activity events counted across the histogram */
  total: number
  /** up to two busiest contiguous hour ranges, [startHour, endHourExclusive) */
  peaks: Array<[number, number]>
  /** the longest quiet (zero-activity) contiguous hour range, if any */
  quiet: [number, number] | null
  /** plain-language, honest one-liner */
  note: string
}

/**
 * Reduce a 24-bin hour histogram to a plain-language routine note. Deliberately
 * simple and honest: "busy" hours are those above the daily mean; "quiet" is the
 * longest unbroken run of hours with zero activity. It summarizes what already
 * happened this session — it does not predict.
 */
export function summarizeRoutine(hist: readonly number[]): RoutineSummary {
  const at = (i: number): number => hist[i] ?? 0
  let total = 0
  for (let i = 0; i < 24; i++) total += at(i)

  if (total === 0) {
    return {
      total: 0,
      peaks: [],
      quiet: null,
      note: 'NOT ENOUGH ACTIVITY YET — YOUR TYPICAL PATTERN WILL EMERGE AS EVENTS ACCUMULATE',
    }
  }

  const mean = total / 24

  // contiguous runs of above-mean hours → candidate peaks, ranked by volume
  const runs: Array<{ start: number; end: number; sum: number }> = []
  for (let i = 0; i < 24; ) {
    if (at(i) > mean) {
      let j = i
      let sum = 0
      while (j < 24 && at(j) > mean) sum += at(j++)
      runs.push({ start: i, end: j, sum })
      i = j
    } else i++
  }
  const peaks = runs
    .sort((a, b) => b.sum - a.sum)
    .slice(0, 2)
    .map((r): [number, number] => [r.start, r.end])
    .sort((a, b) => a[0] - b[0])

  // longest run of exactly-zero hours → quiet window
  let quiet: [number, number] | null = null
  let bestLen = 0
  for (let i = 0; i < 24; ) {
    if (at(i) === 0) {
      let j = i
      while (j < 24 && at(j) === 0) j++
      if (j - i > bestLen) {
        bestLen = j - i
        quiet = [i, j]
      }
      i = j
    } else i++
  }

  const parts: string[] = []
  if (peaks.length > 0) parts.push(`MOST ACTIVITY ${peaks.map(fmtHourRange).join(' AND ')}`)
  if (quiet && bestLen >= 2) parts.push(`QUIET ${fmtHourRange(quiet)}`)
  const note = parts.length > 0 ? parts.join(' · ') : 'ACTIVITY SPREAD EVENLY ACROSS THE DAY'
  return { total, peaks, quiet, note }
}

/** [7, 9) → "07:00–09:00" (end exclusive; wraps 24 → 00). */
export function fmtHourRange([start, end]: [number, number]): string {
  const h = (n: number): string => `${String(n % 24).padStart(2, '0')}:00`
  return `${h(start)}–${h(end)}`
}
