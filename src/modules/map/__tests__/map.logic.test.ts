/**
 * Tactical map logic tests — the DOM-free parts that the 60 fps loop relies
 * on: the tactical ease curve, viewport camera math, and the flattened city
 * render cache. (Canvas painting itself is exercised in the browser.)
 */
import { describe, expect, it } from 'vitest'
import { generateCity, WORLD_H, WORLD_W } from '../../../sim/cityGen'
import { easeTac, MapCamera, MAX_ZOOM, MIN_ZOOM } from '../camera'
import { buildCityCache, sectorIndexOf, SHADE_BUCKETS } from '../cityRender'

describe('easeTac (cubic-bezier 0.2, 0.8, 0.2, 1)', () => {
  it('pins endpoints', () => {
    expect(easeTac(0)).toBe(0)
    expect(easeTac(1)).toBe(1)
  })

  it('is fast-out and monotone', () => {
    const mid = easeTac(0.5)
    expect(mid).toBeGreaterThan(0.75)
    expect(mid).toBeLessThan(0.99)
    let prev = 0
    for (let i = 1; i <= 100; i++) {
      const v = easeTac(i / 100)
      expect(v).toBeGreaterThanOrEqual(prev - 1e-6)
      prev = v
    }
  })
})

describe('MapCamera', () => {
  const makeCam = (): MapCamera => {
    const cam = new MapCamera(WORLD_W, WORLD_H)
    cam.setViewport(900, 620)
    return cam
  }

  it('starts centered at fit zoom and round-trips world↔screen', () => {
    const cam = makeCam()
    expect(cam.cx).toBeCloseTo(WORLD_W / 2, 6)
    expect(cam.cy).toBeCloseTo(WORLD_H / 2, 6)
    expect(cam.wx(cam.sx(1234.5))).toBeCloseTo(1234.5, 6)
    expect(cam.wy(cam.sy(678.9))).toBeCloseTo(678.9, 6)
  })

  it('anchors wheel zoom at the cursor and clamps 0.5×–6×', () => {
    const cam = makeCam()
    const ax = cam.wx(300)
    const ay = cam.wy(200)
    cam.zoomAt(300, 200, 2)
    expect(cam.sx(ax)).toBeCloseTo(300, 5)
    expect(cam.sy(ay)).toBeCloseTo(200, 5)
    cam.zoomAt(300, 200, 1e9)
    expect(cam.zoom).toBe(MAX_ZOOM)
    cam.zoomAt(300, 200, 1e-9)
    expect(cam.zoom).toBe(MIN_ZOOM)
  })

  it('flies to a target in ~350 ms and clears the target id', () => {
    const cam = makeCam()
    cam.zoomAt(450, 310, 4)
    cam.flyToEntity('P-0001', 700, 480, 2.6, 1000)
    cam.update(1175)
    expect(cam.isFlying).toBe(true)
    cam.update(1351)
    expect(cam.isFlying).toBe(false)
    expect(cam.flyTargetId).toBeNull()
    expect(cam.cx).toBeCloseTo(700, 0)
    expect(cam.cy).toBeCloseTo(480, 0)
    expect(cam.zoom).toBeCloseTo(2.6, 5)
  })

  it('clamps the center inside the world (+slack)', () => {
    const cam = makeCam()
    cam.zoomAt(450, 310, 4)
    cam.centerOn(-5000, -5000)
    expect(cam.cx).toBeGreaterThan(-200)
    expect(cam.cy).toBeGreaterThan(-200)
    cam.centerOn(50000, 50000)
    expect(cam.cx).toBeLessThan(WORLD_W + 200)
    expect(cam.cy).toBeLessThan(WORLD_H + 200)
  })
})

describe('city render cache', () => {
  const city = generateCity()
  const cache = buildCityCache(city)

  it('maps sector ids to indices', () => {
    expect(sectorIndexOf('SECTOR-1')).toBe(0)
    expect(sectorIndexOf('SECTOR-9')).toBe(8)
    expect(cache.sectorIds).toHaveLength(9)
    expect(cache.sectorShort[4]).toBe('S5')
  })

  it('buckets every block and keeps AABBs sane', () => {
    let total = 0
    for (let b = 0; b < SHADE_BUCKETS; b++) total += cache.blockBuckets[b].length
    expect(total).toBe(city.blocks.length)
    for (let i = 0; i < city.blocks.length; i++) {
      expect(cache.blockAABB[i * 4]).toBeLessThanOrEqual(cache.blockAABB[i * 4 + 2])
      expect(cache.blockAABB[i * 4 + 1]).toBeLessThanOrEqual(cache.blockAABB[i * 4 + 3])
    }
  })

  it('splits roads into minor/major minus bridge decks, grouped per sector', () => {
    const roadTotal = cache.minorSegs.length + cache.majorSegs.length
    expect(roadTotal).toBe(city.segments.length - city.bridges.length)
    let grouped = 0
    for (let i = 0; i < 9; i++) grouped += cache.segsSectorMinor[i].length + cache.segsSectorMajor[i].length
    expect(grouped).toBe(roadTotal)
  })

  it('caches the three bridge spans with unit direction vectors', () => {
    expect(cache.bridges).toHaveLength(3)
    for (const br of cache.bridges) {
      expect(Math.hypot(br.ux, br.uy)).toBeCloseTo(1, 9)
      expect(Math.hypot(br.nx, br.ny)).toBeCloseTo(1, 9)
    }
  })

  it('prebuilds night palettes as rgb strings', () => {
    expect(cache.litColors).toHaveLength(SHADE_BUCKETS)
    for (const c of cache.litColors) expect(c).toMatch(/^rgb\(/)
    for (const c of cache.darkColors) expect(c).toMatch(/^rgb\(/)
  })
})
