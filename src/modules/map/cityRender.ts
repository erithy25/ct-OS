/**
 * TACTICAL MAP — static city painting (water, districts, blocks, roads,
 * landmarks, bridges, sector chrome) + the post-veil label pass.
 *
 * Everything geometric is flattened into typed arrays once (buildCityCache);
 * the per-frame path is allocation-free: color strings come from palettes that
 * are only rebuilt when the quantized night factor changes, and geometry is
 * AABB-culled against the viewport.
 */
import { TAU } from '../../lib/geometry'
import type { City, InfraState, Landmark, World } from '../../sim/types'
import type { MapCamera } from './camera'
import { A_AMBER, A_DIM, A_PRIM, A_RED, aIdx, COL, FONT_10, FONT_8, FONT_9 } from './colors'

export const SHADE_BUCKETS = 8

export interface CityCache {
  sectorIds: string[]
  sectorShort: string[]
  districtNames: string[]
  districtCX: Float64Array
  districtCY: Float64Array
  /** approx radius (center → farthest vertex), world units */
  districtR: Float64Array
  tintColors: string[]
  /** blocks: 4 vertices → 8 floats per block */
  blockPts: Float64Array
  /** minx,miny,maxx,maxy per block */
  blockAABB: Float64Array
  blockSector: Int16Array
  blockBuckets: number[][]
  segAX: Float64Array
  segAY: Float64Array
  segBX: Float64Array
  segBY: Float64Array
  /** non-bridge segments, split by class */
  minorSegs: number[]
  majorSegs: number[]
  /** per-sector segment groups for the traffic overlay (bridges excluded) */
  segsSectorMinor: number[][]
  segsSectorMajor: number[][]
  bridges: {
    id: string
    x1: number
    y1: number
    x2: number
    y2: number
    ux: number
    uy: number
    nx: number
    ny: number
    len: number
  }[]
  landmarks: Landmark[]
  /** night-dependent palettes (rebuilt when quantized night changes) */
  litColors: string[]
  darkColors: string[]
  veil: string
  paletteKey: number
  /** per-frame scratch: 1 = sector power is OFF */
  powerOff: Uint8Array
  /** per-frame scratch: sector congestion 0..1 */
  cong: Float64Array
}

export function sectorIndexOf(id: string): number {
  const n = parseInt(id.slice(7), 10)
  return Number.isFinite(n) && n >= 1 && n <= 9 ? n - 1 : 0
}

/* faint per-district hue identities (S5 CINDER FLATS runs warm) */
const DISTRICT_HUES = [208, 190, 226, 182, 22, 204, 146, 252, 168]

function rebuildPalette(cache: CityCache, night: number): void {
  for (let b = 0; b < SHADE_BUCKETS; b++) {
    const t = (b + 0.5) / SHADE_BUCKETS
    let r = 9 + 10 * t
    let g = 14 + 14 * t
    let bl = 21 + 20 * t
    r *= 1 - night * 0.3
    g *= 1 - night * 0.26
    bl *= 1 - night * 0.14
    cache.litColors[b] = `rgb(${r | 0},${g | 0},${bl | 0})`
    cache.darkColors[b] = `rgb(${(3 + 3 * t) | 0},${(5 + 4 * t) | 0},${(8 + 6 * t) | 0})`
  }
  cache.veil = `rgba(5,9,24,${(night * 0.25).toFixed(3)})`
}

export function buildCityCache(city: City): CityCache {
  const nd = city.districts.length
  const districtCX = new Float64Array(nd)
  const districtCY = new Float64Array(nd)
  const districtR = new Float64Array(nd)
  const tintColors: string[] = []
  city.districts.forEach((d, i) => {
    districtCX[i] = d.center.x
    districtCY[i] = d.center.y
    let r2max = 0
    for (const p of d.polygon) {
      const dx = p.x - d.center.x
      const dy = p.y - d.center.y
      const r2 = dx * dx + dy * dy
      if (r2 > r2max) r2max = r2
    }
    districtR[i] = Math.sqrt(r2max)
    tintColors.push(`hsla(${DISTRICT_HUES[i % DISTRICT_HUES.length]}, 42%, 45%, 0.04)`)
  })

  const nb = city.blocks.length
  const blockPts = new Float64Array(nb * 8)
  const blockAABB = new Float64Array(nb * 4)
  const blockSector = new Int16Array(nb)
  const blockBuckets: number[][] = Array.from({ length: SHADE_BUCKETS }, () => [])
  for (let i = 0; i < nb; i++) {
    const blk = city.blocks[i]
    let minx = Infinity
    let miny = Infinity
    let maxx = -Infinity
    let maxy = -Infinity
    for (let k = 0; k < 4; k++) {
      const p = blk.poly[Math.min(k, blk.poly.length - 1)]
      blockPts[i * 8 + k * 2] = p.x
      blockPts[i * 8 + k * 2 + 1] = p.y
      if (p.x < minx) minx = p.x
      if (p.x > maxx) maxx = p.x
      if (p.y < miny) miny = p.y
      if (p.y > maxy) maxy = p.y
    }
    blockAABB[i * 4] = minx
    blockAABB[i * 4 + 1] = miny
    blockAABB[i * 4 + 2] = maxx
    blockAABB[i * 4 + 3] = maxy
    blockSector[i] = sectorIndexOf(blk.sector)
    const bucket = Math.min(SHADE_BUCKETS - 1, Math.floor(blk.shade * SHADE_BUCKETS))
    blockBuckets[bucket].push(i)
  }

  const ns = city.segments.length
  const segAX = new Float64Array(ns)
  const segAY = new Float64Array(ns)
  const segBX = new Float64Array(ns)
  const segBY = new Float64Array(ns)
  const minorSegs: number[] = []
  const majorSegs: number[] = []
  const segsSectorMinor: number[][] = Array.from({ length: nd }, () => [])
  const segsSectorMajor: number[][] = Array.from({ length: nd }, () => [])
  const nodeSectors = city.nodeSectors ?? []
  for (let i = 0; i < ns; i++) {
    const s = city.segments[i]
    const a = city.nodes[s.a].pos
    const b = city.nodes[s.b].pos
    segAX[i] = a.x
    segAY[i] = a.y
    segBX[i] = b.x
    segBY[i] = b.y
    if (s.bridgeId !== undefined) continue // bridge deck drawn by the bridge layer
    if (s.major) majorSegs.push(i)
    else minorSegs.push(i)
    const si = sectorIndexOf(nodeSectors[s.a] ?? 'SECTOR-1')
    if (s.major) segsSectorMajor[si].push(i)
    else segsSectorMinor[si].push(i)
  }

  const bridges = city.bridges.map((b) => {
    const seg = city.segments[b.segmentIdx]
    const p1 = city.nodes[seg.a].pos
    const p2 = city.nodes[seg.b].pos
    const dx = p2.x - p1.x
    const dy = p2.y - p1.y
    const len = Math.sqrt(dx * dx + dy * dy) || 1
    const ux = dx / len
    const uy = dy / len
    return { id: b.id, x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, ux, uy, nx: -uy, ny: ux, len }
  })

  const cache: CityCache = {
    sectorIds: city.districts.map((d) => d.id),
    sectorShort: city.districts.map((d) => `S${sectorIndexOf(d.id) + 1}`),
    districtNames: city.districts.map((d) => d.name),
    districtCX,
    districtCY,
    districtR,
    tintColors,
    blockPts,
    blockAABB,
    blockSector,
    blockBuckets,
    segAX,
    segAY,
    segBX,
    segBY,
    minorSegs,
    majorSegs,
    segsSectorMinor,
    segsSectorMajor,
    bridges,
    landmarks: city.landmarks,
    litColors: new Array(SHADE_BUCKETS).fill(''),
    darkColors: new Array(SHADE_BUCKETS).fill(''),
    veil: 'rgba(5,9,24,0)',
    paletteKey: -1,
    powerOff: new Uint8Array(nd),
    cong: new Float64Array(nd),
  }
  rebuildPalette(cache, 0)
  cache.paletteKey = 0
  return cache
}

/* module-level singleton (world/city are singletons too) */
let cachedFor: City | null = null
let cached: CityCache | null = null

export function getCityCache(city: City): CityCache {
  if (!cached || cachedFor !== city) {
    cached = buildCityCache(city)
    cachedFor = city
  }
  return cached
}

/* ── block pass helper (lit and dark share the path builder) ───────── */

function pathBlocks(
  ctx: CanvasRenderingContext2D,
  cache: CityCache,
  list: number[],
  wantDark: 0 | 1,
  sc: number,
  ox: number,
  oy: number,
  wx0: number,
  wy0: number,
  wx1: number,
  wy1: number,
): number {
  const pts = cache.blockPts
  const ab = cache.blockAABB
  const sec = cache.blockSector
  const off = cache.powerOff
  let n = 0
  for (let k = 0; k < list.length; k++) {
    const i = list[k]
    if (off[sec[i]] !== wantDark) continue
    const a4 = i * 4
    if (ab[a4] > wx1 || ab[a4 + 2] < wx0 || ab[a4 + 1] > wy1 || ab[a4 + 3] < wy0) continue
    const p8 = i * 8
    ctx.moveTo(pts[p8] * sc + ox, pts[p8 + 1] * sc + oy)
    ctx.lineTo(pts[p8 + 2] * sc + ox, pts[p8 + 3] * sc + oy)
    ctx.lineTo(pts[p8 + 4] * sc + ox, pts[p8 + 5] * sc + oy)
    ctx.lineTo(pts[p8 + 6] * sc + ox, pts[p8 + 7] * sc + oy)
    ctx.closePath()
    n++
  }
  return n
}

function strokeSegList(
  ctx: CanvasRenderingContext2D,
  cache: CityCache,
  list: number[],
  sc: number,
  ox: number,
  oy: number,
  wx0: number,
  wy0: number,
  wx1: number,
  wy1: number,
): number {
  const ax = cache.segAX
  const ay = cache.segAY
  const bx = cache.segBX
  const by = cache.segBY
  let n = 0
  for (let k = 0; k < list.length; k++) {
    const i = list[k]
    const x1 = ax[i]
    const x2 = bx[i]
    const y1 = ay[i]
    const y2 = by[i]
    if ((x1 < wx0 && x2 < wx0) || (x1 > wx1 && x2 > wx1) || (y1 < wy0 && y2 < wy0) || (y1 > wy1 && y2 > wy1)) continue
    ctx.moveTo(x1 * sc + ox, y1 * sc + oy)
    ctx.lineTo(x2 * sc + ox, y2 * sc + oy)
    n++
  }
  return n
}

export { strokeSegList }

/* ── landmark glyphs ───────────────────────────────────────────────── */

function pathLandmarkGlyph(ctx: CanvasRenderingContext2D, glyph: Landmark['glyph'], x: number, y: number): void {
  const s = 4
  switch (glyph) {
    case 'plaza':
      ctx.moveTo(x, y - s)
      ctx.lineTo(x + s, y)
      ctx.lineTo(x, y + s)
      ctx.lineTo(x - s, y)
      ctx.closePath()
      break
    case 'tower':
      ctx.moveTo(x, y - s)
      ctx.lineTo(x + s * 0.9, y + s * 0.8)
      ctx.lineTo(x - s * 0.9, y + s * 0.8)
      ctx.closePath()
      break
    case 'yard':
      ctx.moveTo(x - s + 1, y - s + 1)
      ctx.lineTo(x + s - 1, y - s + 1)
      ctx.lineTo(x + s - 1, y + s - 1)
      ctx.lineTo(x - s + 1, y + s - 1)
      ctx.closePath()
      break
    case 'port':
      ctx.moveTo(x + s - 1, y)
      ctx.arc(x, y, s - 1, 0, TAU)
      ctx.moveTo(x - s, y)
      ctx.lineTo(x + s, y)
      break
    case 'terminal':
      ctx.moveTo(x - s - 1, y - 2)
      ctx.lineTo(x + s + 1, y - 2)
      ctx.lineTo(x + s + 1, y + 2.5)
      ctx.lineTo(x - s - 1, y + 2.5)
      ctx.closePath()
      ctx.moveTo(x, y - 2)
      ctx.lineTo(x, y + 2.5)
      break
    case 'exchange':
      ctx.moveTo(x - s + 1, y - s + 1)
      ctx.lineTo(x + s - 1, y + s - 1)
      ctx.moveTo(x + s - 1, y - s + 1)
      ctx.lineTo(x - s + 1, y + s - 1)
      break
  }
}

/* ── main city pass (pre-veil) ─────────────────────────────────────── */

export function drawCity(
  ctx: CanvasRenderingContext2D,
  cam: MapCamera,
  world: World,
  infra: InfraState,
  cache: CityCache,
  now: number,
): void {
  const city = world.city
  const sc = cam.scale
  const ox = cam.viewW / 2 - cam.cx * sc
  const oy = cam.viewH / 2 - cam.cy * sc
  const vw = cam.viewW
  const vh = cam.viewH
  const wx0 = cam.wx(0)
  const wy0 = cam.wy(0)
  const wx1 = cam.wx(vw)
  const wy1 = cam.wy(vh)

  /* palettes track the quantized night factor */
  const pk = (world.night * 40) | 0
  if (pk !== cache.paletteKey) {
    cache.paletteKey = pk
    rebuildPalette(cache, world.night)
  }

  /* per-frame sector power scratch */
  for (let i = 0; i < cache.sectorIds.length; i++) {
    cache.powerOff[i] = infra.power[cache.sectorIds[i]] === false ? 1 : 0
  }

  /* world-locked engineering grid over the void */
  ctx.strokeStyle = 'rgba(201,214,228,0.022)'
  ctx.lineWidth = 1
  ctx.beginPath()
  const gStep = 64
  for (let gx = Math.floor(wx0 / gStep) * gStep; gx <= wx1; gx += gStep) {
    const x = gx * sc + ox
    ctx.moveTo(x, 0)
    ctx.lineTo(x, vh)
  }
  for (let gy = Math.floor(wy0 / gStep) * gStep; gy <= wy1; gy += gStep) {
    const y = gy * sc + oy
    ctx.moveTo(0, y)
    ctx.lineTo(vw, y)
  }
  ctx.stroke()

  /* water + slow shimmer */
  ctx.beginPath()
  for (let w = 0; w < city.water.length; w++) {
    const poly = city.water[w]
    ctx.moveTo(poly[0].x * sc + ox, poly[0].y * sc + oy)
    for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i].x * sc + ox, poly[i].y * sc + oy)
    ctx.closePath()
  }
  ctx.fillStyle = COL.water
  ctx.fill()
  ctx.strokeStyle = 'rgba(38,56,74,0.5)'
  ctx.lineWidth = 1
  ctx.stroke()
  ctx.save()
  ctx.clip()
  ctx.fillStyle = 'rgba(96,148,196,0.035)'
  const bandY0 = vh * 0.28 + Math.sin(now * 0.00021) * vh * 0.2
  const bandY1 = vh * 0.62 + Math.sin(now * 0.00017 + 2.6) * vh * 0.22
  ctx.fillRect(0, bandY0, vw, 16)
  ctx.fillRect(0, bandY1, vw, 26)
  ctx.restore()

  /* district tints (very faint, distinguishable) */
  for (let i = 0; i < city.districts.length; i++) {
    const poly = city.districts[i].polygon
    ctx.fillStyle = cache.tintColors[i]
    ctx.beginPath()
    ctx.moveTo(poly[0].x * sc + ox, poly[0].y * sc + oy)
    for (let k = 1; k < poly.length; k++) ctx.lineTo(poly[k].x * sc + ox, poly[k].y * sc + oy)
    ctx.closePath()
    ctx.fill()
  }

  /* city blocks — batched by shade bucket × power state */
  for (let b = 0; b < SHADE_BUCKETS; b++) {
    const list = cache.blockBuckets[b]
    ctx.fillStyle = cache.litColors[b]
    ctx.beginPath()
    if (pathBlocks(ctx, cache, list, 0, sc, ox, oy, wx0, wy0, wx1, wy1) > 0) ctx.fill()
    ctx.fillStyle = cache.darkColors[b]
    ctx.beginPath()
    if (pathBlocks(ctx, cache, list, 1, sc, ox, oy, wx0, wy0, wx1, wy1) > 0) ctx.fill()
  }

  /* roads — minor then major, two batched strokes */
  ctx.strokeStyle = COL.line
  ctx.lineWidth = 1
  ctx.beginPath()
  if (strokeSegList(ctx, cache, cache.minorSegs, sc, ox, oy, wx0, wy0, wx1, wy1) > 0) ctx.stroke()
  ctx.strokeStyle = COL.lineBright
  ctx.lineWidth = 1.5
  ctx.beginPath()
  if (strokeSegList(ctx, cache, cache.majorSegs, sc, ox, oy, wx0, wy0, wx1, wy1) > 0) ctx.stroke()

  /* bridges */
  for (let i = 0; i < cache.bridges.length; i++) {
    const br = cache.bridges[i]
    const x1 = br.x1 * sc + ox
    const y1 = br.y1 * sc + oy
    const x2 = br.x2 * sc + ox
    const y2 = br.y2 * sc + oy
    if ((x1 < -60 && x2 < -60) || (x1 > vw + 60 && x2 > vw + 60) || (y1 < -60 && y2 < -60) || (y1 > vh + 60 && y2 > vh + 60)) continue
    const raised = infra.bridgesRaised[br.id] === true
    const hl = Math.min(6, Math.max(2.5, 2 * sc))

    if (!raised) {
      ctx.strokeStyle = '#31465c'
      ctx.lineWidth = 2.5
      ctx.beginPath()
      ctx.moveTo(x1, y1)
      ctx.lineTo(x2, y2)
      ctx.stroke()
      /* crossing tick marks */
      ctx.strokeStyle = 'rgba(88,120,152,0.85)'
      ctx.lineWidth = 1
      ctx.beginPath()
      const n = Math.max(4, Math.min(16, Math.round((br.len * sc) / 9)))
      for (let k = 1; k < n; k++) {
        const t = k / n
        const px = x1 + (x2 - x1) * t
        const py = y1 + (y2 - y1) * t
        ctx.moveTo(px - br.nx * hl, py - br.ny * hl)
        ctx.lineTo(px + br.nx * hl, py + br.ny * hl)
      }
      ctx.stroke()
    } else {
      /* stub decks with an open span gap */
      ctx.strokeStyle = '#31465c'
      ctx.lineWidth = 2.5
      ctx.beginPath()
      ctx.moveTo(x1, y1)
      ctx.lineTo(x1 + (x2 - x1) * 0.3, y1 + (y2 - y1) * 0.3)
      ctx.moveTo(x1 + (x2 - x1) * 0.7, y1 + (y2 - y1) * 0.7)
      ctx.lineTo(x2, y2)
      ctx.stroke()
      /* amber hazard chevrons at the gap edges */
      const pulse = 0.55 + 0.35 * Math.sin(now * 0.008 + i)
      ctx.strokeStyle = A_AMBER[aIdx(pulse)]
      ctx.lineWidth = 1.5
      ctx.beginPath()
      for (let e = 0; e < 2; e++) {
        const t = e === 0 ? 0.3 : 0.7
        const dir = e === 0 ? 1 : -1
        const px = x1 + (x2 - x1) * t
        const py = y1 + (y2 - y1) * t
        const cs = 5
        ctx.moveTo(px - br.nx * cs, py - br.ny * cs)
        ctx.lineTo(px + br.ux * cs * dir, py + br.uy * cs * dir)
        ctx.lineTo(px + br.nx * cs, py + br.ny * cs)
      }
      ctx.stroke()
    }
  }

  /* landmarks — glyph always, label at zoom ≥ 1.2 */
  ctx.strokeStyle = 'rgba(107,124,143,0.75)'
  ctx.lineWidth = 1
  const lmLabelA = Math.min(1, Math.max(0, (cam.zoom - 1.2) * 2.5))
  for (let i = 0; i < cache.landmarks.length; i++) {
    const lm = cache.landmarks[i]
    if (lm.pos.x < wx0 - 30 || lm.pos.x > wx1 + 30 || lm.pos.y < wy0 - 30 || lm.pos.y > wy1 + 30) continue
    const x = lm.pos.x * sc + ox
    const y = lm.pos.y * sc + oy
    ctx.beginPath()
    pathLandmarkGlyph(ctx, lm.glyph, x, y)
    ctx.stroke()
    if (lmLabelA > 0) {
      ctx.font = FONT_8
      ctx.textAlign = 'center'
      ctx.textBaseline = 'alphabetic'
      ctx.fillStyle = A_DIM[aIdx(0.9 * lmLabelA)]
      ctx.fillText(lm.name, x, y - 8)
    }
  }

  /* sector boundary hairlines */
  ctx.strokeStyle = 'rgba(38,56,74,0.32)'
  ctx.lineWidth = 1
  ctx.beginPath()
  for (let i = 0; i < city.districts.length; i++) {
    const poly = city.districts[i].polygon
    ctx.moveTo(poly[0].x * sc + ox, poly[0].y * sc + oy)
    for (let k = 1; k < poly.length; k++) ctx.lineTo(poly[k].x * sc + ox, poly[k].y * sc + oy)
    ctx.closePath()
  }
  ctx.stroke()
}

/* ── label pass (post-veil so text stays legible at deep night) ────── */

export function drawMapLabels(
  ctx: CanvasRenderingContext2D,
  cam: MapCamera,
  world: World,
  infra: InfraState,
  cache: CityCache,
  now: number,
): void {
  const sc = cam.scale
  const ox = cam.viewW / 2 - cam.cx * sc
  const oy = cam.viewH / 2 - cam.cy * sc

  ctx.textAlign = 'center'
  ctx.textBaseline = 'alphabetic'

  /* sector ids + district names at low zoom */
  const fade = Math.min(1, Math.max(0, (1.7 - cam.zoom) * 2))
  if (fade > 0.02) {
    for (let i = 0; i < cache.sectorIds.length; i++) {
      const x = cache.districtCX[i] * sc + ox
      const y = cache.districtCY[i] * sc + oy
      ctx.font = FONT_10
      ctx.fillStyle = A_PRIM[aIdx(0.34 * fade)]
      ctx.fillText(cache.sectorShort[i], x, y - 3)
      ctx.font = FONT_8
      ctx.fillStyle = A_PRIM[aIdx(0.18 * fade)]
      ctx.fillText(cache.districtNames[i], x, y + 8)
    }
  }

  /* GRID DARK — always-on infra consequence for unpowered sectors */
  const pulse = 0.34 + 0.14 * Math.sin(now * 0.004)
  ctx.font = FONT_9
  for (let i = 0; i < cache.sectorIds.length; i++) {
    if (infra.power[cache.sectorIds[i]] !== false) continue
    const x = cache.districtCX[i] * sc + ox
    const y = cache.districtCY[i] * sc + oy
    ctx.fillStyle = A_RED[aIdx(pulse)]
    ctx.fillText('GRID DARK', x, y + 22)
  }
}

/* ── minimap base (rendered once per mount) ────────────────────────── */

export function renderMinimapBase(city: City, w: number, h: number, dpr: number): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.round(w * dpr))
  c.height = Math.max(1, Math.round(h * dpr))
  const ctx = c.getContext('2d')
  if (!ctx) return c
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.fillStyle = '#070b11'
  ctx.fillRect(0, 0, w, h)
  const s = Math.min(w / city.size.x, h / city.size.y)
  const ox = (w - city.size.x * s) / 2
  const oy = (h - city.size.y * s) / 2

  /* water */
  ctx.beginPath()
  for (const poly of city.water) {
    ctx.moveTo(poly[0].x * s + ox, poly[0].y * s + oy)
    for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i].x * s + ox, poly[i].y * s + oy)
    ctx.closePath()
  }
  ctx.fillStyle = '#0a1420'
  ctx.fill()

  /* blocks (single faint mass) */
  ctx.beginPath()
  for (const blk of city.blocks) {
    const poly = blk.poly
    ctx.moveTo(poly[0].x * s + ox, poly[0].y * s + oy)
    for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i].x * s + ox, poly[i].y * s + oy)
    ctx.closePath()
  }
  ctx.fillStyle = 'rgba(21,30,43,0.85)'
  ctx.fill()

  /* district bounds */
  ctx.beginPath()
  for (const d of city.districts) {
    const poly = d.polygon
    ctx.moveTo(poly[0].x * s + ox, poly[0].y * s + oy)
    for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i].x * s + ox, poly[i].y * s + oy)
    ctx.closePath()
  }
  ctx.strokeStyle = 'rgba(38,56,74,0.55)'
  ctx.lineWidth = 1
  ctx.stroke()

  /* major roads */
  ctx.beginPath()
  for (const seg of city.segments) {
    if (!seg.major) continue
    const a = city.nodes[seg.a].pos
    const b = city.nodes[seg.b].pos
    ctx.moveTo(a.x * s + ox, a.y * s + oy)
    ctx.lineTo(b.x * s + ox, b.y * s + oy)
  }
  ctx.strokeStyle = 'rgba(58,84,110,0.9)'
  ctx.lineWidth = 1
  ctx.stroke()

  return c
}
