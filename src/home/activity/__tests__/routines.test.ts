/**
 * Learned routines: median/MAD math, the ≥3-sample evidence gate, the soft
 * line formatting and the gentle absence threshold — plus a storage
 * round-trip through a stubbed localStorage (the node test env has none).
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  absenceNoteDue,
  fmtMinutes,
  loadRoutines,
  MAX_ENTRIES,
  recordArrival,
  ROUTINES_KEY,
  routineLine,
  saveRoutines,
  usualArrival,
  type ArrivalEntry,
  type RoutineStore,
} from '../routines'

const entry = (minutesOfDay: number, weekday = 1): ArrivalEntry => ({ weekday, minutesOfDay })

// local-time anchors (2026-07-20 is a Monday, 2026-07-21 a Tuesday)
const MONDAY_NOON = new Date(2026, 6, 20, 12, 0).getTime()
const TUESDAY_NOON = new Date(2026, 6, 21, 12, 0).getTime()

describe('usualArrival', () => {
  it('needs at least 3 samples before claiming anything', () => {
    expect(usualArrival([])).toBeNull()
    expect(usualArrival([entry(1000), entry(1010)])).toBeNull()
    expect(usualArrival([entry(1000), entry(1010), entry(1020)])).not.toBeNull()
  })

  it('computes the median and MAD (odd count)', () => {
    const u = usualArrival([entry(1050), entry(1060), entry(1035)])
    expect(u).toEqual({ minutes: 1050, madMinutes: 10 }) // deviations 0, 10, 15
  })

  it('computes the median and MAD (even count)', () => {
    const u = usualArrival([entry(1000), entry(1020), entry(1040), entry(1060)])
    expect(u).toEqual({ minutes: 1030, madMinutes: 20 }) // deviations 30,10,10,30
  })

  it('is robust to one odd outlier (median, not mean)', () => {
    const u = usualArrival([entry(1050), entry(1055), entry(1060), entry(300)])
    expect(u?.minutes).toBe(1052.5)
  })

  it('prefers same-weekday samples when `now` is given and evidence suffices', () => {
    const entries = [
      entry(600, 1),
      entry(600, 1),
      entry(600, 1),
      entry(1200, 2),
      entry(1200, 2),
      entry(1200, 2),
    ]
    expect(usualArrival(entries, MONDAY_NOON)?.minutes).toBe(600)
    expect(usualArrival(entries, TUESDAY_NOON)?.minutes).toBe(1200)
    // without `now` (or without enough same-day samples) → overall median
    expect(usualArrival(entries)?.minutes).toBe(900)
    expect(usualArrival(entries.slice(0, 4), TUESDAY_NOON)?.minutes).toBe(600)
  })
})

describe('routineLine / fmtMinutes', () => {
  it('formats the soft routine line on a padded 24h clock', () => {
    expect(routineLine({ minutes: 1060, madMinutes: 5 })).toBe('USUALLY HOME BY ~17:40')
    expect(routineLine({ minutes: 545, madMinutes: 0 })).toBe('USUALLY HOME BY ~09:05')
    expect(routineLine(null)).toBeNull()
  })

  it('pads and wraps minutes defensively', () => {
    expect(fmtMinutes(5)).toBe('00:05')
    expect(fmtMinutes(0)).toBe('00:00')
    expect(fmtMinutes(24 * 60 + 30)).toBe('00:30')
  })
})

describe('absenceNoteDue', () => {
  const usual = { minutes: 1050, madMinutes: 10 }

  it('fires only past usual + 60 minutes', () => {
    expect(absenceNoteDue(usual, 1050, false)).toBe(false)
    expect(absenceNoteDue(usual, 1110, false)).toBe(false) // exactly +60 — not yet
    expect(absenceNoteDue(usual, 1111, false)).toBe(true)
  })

  it('never fires twice in a day', () => {
    expect(absenceNoteDue(usual, 1200, true)).toBe(false)
  })
})

describe('recordArrival', () => {
  it('derives local weekday + minutes-of-day from the timestamp', () => {
    const store: RoutineStore = {}
    recordArrival(store, 'p1', new Date(2026, 6, 20, 17, 40).getTime()) // Monday 17:40
    expect(store.p1).toEqual([{ weekday: 1, minutesOfDay: 17 * 60 + 40 }])
  })

  it('keeps only the newest 60 entries per person', () => {
    const store: RoutineStore = {}
    const base = new Date(2026, 6, 20, 0, 0).getTime()
    for (let i = 0; i < 70; i++) recordArrival(store, 'p1', base + i * 60_000)
    expect(store.p1).toHaveLength(MAX_ENTRIES)
    expect(store.p1[0].minutesOfDay).toBe(10) // the first 10 were dropped
    expect(store.p1[59].minutesOfDay).toBe(69)
  })
})

describe('storage', () => {
  /** minimal in-memory localStorage stand-in for the node test env */
  class MemStorage {
    private m = new Map<string, string>()
    getItem(k: string): string | null {
      return this.m.has(k) ? (this.m.get(k) as string) : null
    }
    setItem(k: string, v: string): void {
      this.m.set(k, String(v))
    }
    removeItem(k: string): void {
      this.m.delete(k)
    }
    clear(): void {
      this.m.clear()
    }
  }

  const g = globalThis as { localStorage?: unknown }

  afterEach(() => {
    delete g.localStorage
  })

  it('is a safe no-op when localStorage does not exist', () => {
    expect(typeof localStorage).toBe('undefined')
    expect(() => saveRoutines({ p1: [entry(100)] })).not.toThrow()
    expect(loadRoutines()).toEqual({})
  })

  it('round-trips through a stubbed localStorage', () => {
    g.localStorage = new MemStorage()
    const store = recordArrival({}, 'p1', new Date(2026, 6, 20, 17, 40).getTime())
    recordArrival(store, 'p2', new Date(2026, 6, 21, 8, 5).getTime())
    saveRoutines(store)
    expect(loadRoutines()).toEqual({
      p1: [{ weekday: 1, minutesOfDay: 17 * 60 + 40 }],
      p2: [{ weekday: 2, minutesOfDay: 8 * 60 + 5 }],
    })
  })

  it('survives junk and filters malformed entries on load', () => {
    const mem = new MemStorage()
    g.localStorage = mem
    mem.setItem(ROUTINES_KEY, '{not json')
    expect(loadRoutines()).toEqual({})
    mem.setItem(ROUTINES_KEY, JSON.stringify([1, 2, 3]))
    expect(loadRoutines()).toEqual({})
    mem.setItem(
      ROUTINES_KEY,
      JSON.stringify({
        p1: [{ weekday: 99, minutesOfDay: -5 }, { weekday: 2, minutesOfDay: 30 }, null, 'x'],
        p2: 'not-an-array',
      }),
    )
    expect(loadRoutines()).toEqual({ p1: [{ weekday: 2, minutesOfDay: 30 }] })
  })
})
