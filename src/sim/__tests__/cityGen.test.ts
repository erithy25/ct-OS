import { describe, expect, it } from 'vitest'
import { BRIDGE_NAMES, DEFAULT_SEED, generateCity } from '../cityGen'
import { pointInAnyPolygon } from '../../lib/geometry'
import type { City } from '../types'

const cityA = generateCity(DEFAULT_SEED)
const cityB = generateCity(DEFAULT_SEED)
const cityC = generateCity(0xbeef)

function checkBridges(city: City): void {
  expect(city.bridges.length).toBe(3)
  const names = city.bridges.map((b) => b.name)
  expect(new Set(names).size).toBe(3)
  for (const n of names) expect(BRIDGE_NAMES).toContain(n)

  for (const b of city.bridges) {
    expect(b.segmentIdx).toBeGreaterThanOrEqual(0)
    expect(b.segmentIdx).toBeLessThan(city.segments.length)
    const seg = city.segments[b.segmentIdx]
    expect(seg.bridgeId).toBe(b.id)
    expect(seg.major).toBe(true)

    const pa = city.nodes[seg.a].pos
    const pb = city.nodes[seg.b].pos
    // banks are dry…
    expect(pointInAnyPolygon(pa, city.water)).toBe(false)
    expect(pointInAnyPolygon(pb, city.water)).toBe(false)
    // …but the span actually crosses water
    let crosses = false
    for (let k = 1; k <= 9; k++) {
      const t = k / 10
      const p = { x: pa.x + (pb.x - pa.x) * t, y: pa.y + (pb.y - pa.y) * t }
      if (pointInAnyPolygon(p, city.water)) crosses = true
    }
    expect(crosses).toBe(true)
  }
}

describe('generateCity', () => {
  it('is deterministic: same seed → byte-identical city', () => {
    expect(cityB.nodes.length).toBe(cityA.nodes.length)
    expect(cityB.segments.length).toBe(cityA.segments.length)
    expect(cityB.blocks.length).toBe(cityA.blocks.length)
    expect(cityB.nodes[0].pos).toEqual(cityA.nodes[0].pos)
    expect(cityB.nodes[cityA.nodes.length - 1].pos).toEqual(cityA.nodes[cityA.nodes.length - 1].pos)
    expect(JSON.stringify(cityB)).toBe(JSON.stringify(cityA))
  })

  it('different seed → different layout', () => {
    expect(JSON.stringify(cityC)).not.toBe(JSON.stringify(cityA))
  })

  it('meets the spec ranges', () => {
    expect(cityA.size).toEqual({ x: 1600, y: 1000 })
    expect(cityA.districts.length).toBe(9)
    expect(cityA.districts.map((d) => d.id)).toEqual(Array.from({ length: 9 }, (_, i) => `SECTOR-${i + 1}`))
    for (const d of cityA.districts) {
      expect(d.baseRisk).toBeGreaterThanOrEqual(0.1)
      expect(d.baseRisk).toBeLessThanOrEqual(0.8)
      expect(d.density).toBeGreaterThanOrEqual(0.2)
      expect(d.density).toBeLessThanOrEqual(1)
    }
    expect(cityA.nodes.length).toBeGreaterThanOrEqual(350)
    expect(cityA.nodes.length).toBeLessThanOrEqual(600)
    expect(cityA.segments.length).toBeGreaterThanOrEqual(500)
    expect(cityA.segments.length).toBeLessThanOrEqual(900)
    expect(cityA.blocks.length).toBeGreaterThanOrEqual(200)
    expect(cityA.water.length).toBeGreaterThanOrEqual(2) // harbor + river
    expect(cityA.landmarks.length).toBeGreaterThanOrEqual(8)
    expect(cityA.landmarks.length).toBeLessThanOrEqual(10)
  })

  it('every segment endpoint index is in range and adjacency is symmetric', () => {
    for (const s of cityA.segments) {
      expect(s.a).toBeGreaterThanOrEqual(0)
      expect(s.a).toBeLessThan(cityA.nodes.length)
      expect(s.b).toBeGreaterThanOrEqual(0)
      expect(s.b).toBeLessThan(cityA.nodes.length)
      expect(cityA.nodes[s.a].neighbors).toContain(s.b)
      expect(cityA.nodes[s.b].neighbors).toContain(s.a)
    }
  })

  it('has no road node inside water', () => {
    for (const n of cityA.nodes) {
      expect(pointInAnyPolygon(n.pos, cityA.water)).toBe(false)
    }
  })

  it('bridges reference river-crossing major segments (default seed)', () => {
    checkBridges(cityA)
  })

  it('bridges hold up on other seeds too', () => {
    checkBridges(cityC)
  })

  it('places 24 cameras CAM-02..CAM-25 with sane optics', () => {
    const cams = cityA.cameras ?? []
    expect(cams.length).toBe(24)
    expect(cams.map((c) => c.id)).toEqual(Array.from({ length: 24 }, (_, i) => `CAM-${String(i + 2).padStart(2, '0')}`))
    for (const c of cams) {
      expect(c.range).toBeGreaterThanOrEqual(70)
      expect(c.range).toBeLessThanOrEqual(120)
      expect(c.fov).toBeGreaterThan(0.3)
      expect(c.fov).toBeLessThan(0.8)
      expect(c.label.length).toBeGreaterThan(3)
    }
  })

  it('labels each node with a sector', () => {
    expect(cityA.nodeSectors?.length).toBe(cityA.nodes.length)
    const valid = new Set(cityA.districts.map((d) => d.id))
    for (const s of cityA.nodeSectors ?? []) expect(valid.has(s)).toBe(true)
  })
})
