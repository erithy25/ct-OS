/** Seeded PRNG (mulberry32) + helpers. Deterministic across reloads. */

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** FNV-1a 32-bit string hash — stable entity-id → seed mapping. */
export function hashString(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** Convenience wrapper with distribution helpers. */
export class Rand {
  private fn: () => number

  constructor(seed: number | string) {
    this.fn = mulberry32(typeof seed === 'string' ? hashString(seed) : seed)
  }

  next(): number {
    return this.fn()
  }

  range(a: number, b: number): number {
    return a + (b - a) * this.fn()
  }

  int(a: number, b: number): number {
    return Math.floor(this.range(a, b + 1))
  }

  chance(p: number): boolean {
    return this.fn() < p
  }

  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.fn() * arr.length)]
  }

  /** biased toward low values; exponent > 1 pushes mass to 0 */
  low(exp = 2): number {
    return Math.pow(this.fn(), exp)
  }

  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.fn() * (i + 1))
      ;[arr[i], arr[j]] = [arr[j], arr[i]]
    }
    return arr
  }
}
