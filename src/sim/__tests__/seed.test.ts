import { describe, expect, it } from 'vitest'
import { mulberry32, Rand } from '../seed'

describe('mulberry32', () => {
  it('same seed → identical first 32 draws', () => {
    const a = mulberry32(0x2f7a)
    const b = mulberry32(0x2f7a)
    const da = Array.from({ length: 32 }, () => a())
    const db = Array.from({ length: 32 }, () => b())
    expect(da).toEqual(db)
  })

  it('different seeds → different sequences', () => {
    const a = mulberry32(0x2f7a)
    const b = mulberry32(0x2f7b)
    const da = Array.from({ length: 32 }, () => a())
    const db = Array.from({ length: 32 }, () => b())
    expect(da).not.toEqual(db)
  })

  it('draws stay in [0, 1)', () => {
    const a = mulberry32(123456789)
    for (let i = 0; i < 1000; i++) {
      const v = a()
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })
})

describe('Rand', () => {
  it('string seeds are deterministic', () => {
    const a = new Rand('ent:12058:persons')
    const b = new Rand('ent:12058:persons')
    for (let i = 0; i < 16; i++) expect(a.next()).toBe(b.next())
  })

  it('int stays within inclusive bounds and covers them', () => {
    const r = new Rand('bounds-test')
    const seen = new Set<number>()
    for (let i = 0; i < 4000; i++) {
      const v = r.int(3, 7)
      expect(v).toBeGreaterThanOrEqual(3)
      expect(v).toBeLessThanOrEqual(7)
      expect(Number.isInteger(v)).toBe(true)
      seen.add(v)
    }
    expect(seen.size).toBe(5) // hits every value including both endpoints
  })

  it('range stays within bounds', () => {
    const r = new Rand(99)
    for (let i = 0; i < 1000; i++) {
      const v = r.range(-4, 9)
      expect(v).toBeGreaterThanOrEqual(-4)
      expect(v).toBeLessThan(9)
    }
  })
})
