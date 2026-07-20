/**
 * NOVA HARBOR — deterministic procedural city generator.
 * Same seed → byte-identical city (no Math.random, no Date, fixed iteration
 * order). World is 1600×1000 units: a harbor along the east edge, a river
 * snaking from the north edge down to the harbor, 9 districts on a jittered
 * 3×3 partition, a major/minor road lattice carved around the water, three
 * named bridges, city blocks, landmarks and 24 camera placements.
 */
import { Rand } from './seed'
import { clamp, dist2, lerp, pointInPolygon, pointInAnyPolygon, polygonCentroid, TAU } from '../lib/geometry'
import type {
  BridgeInfo,
  CameraSpec,
  City,
  CityBlock,
  District,
  Landmark,
  RoadNode,
  RoadSegment,
  SectorId,
  Vec2,
} from './types'

export const DEFAULT_SEED = 0x2f7a
export const WORLD_W = 1600
export const WORLD_H = 1000

export const BRIDGE_NAMES = ['KESSLER SPAN', 'ARDENT LIFT', 'SOUTH LOCKS BRIDGE'] as const

/** row-major (north → south): index i ⇒ SECTOR-(i+1) */
const DISTRICT_NAMES = [
  'NORTHGATE',
  'RELAY HEIGHTS',
  'VELLUM',
  'MERIDIAN',
  'CINDER FLATS',
  'HARBOR CORE',
  'GRANARY ROW',
  'THE LOCKS',
  'DRYDOCK',
] as const

/** [riskLo, riskHi, densityLo, densityHi] flavor per district */
const DISTRICT_FLAVOR: Record<string, [number, number, number, number]> = {
  NORTHGATE: [0.15, 0.35, 0.45, 0.7],
  'RELAY HEIGHTS': [0.2, 0.4, 0.5, 0.75],
  VELLUM: [0.15, 0.4, 0.45, 0.75],
  MERIDIAN: [0.25, 0.5, 0.65, 0.95],
  'CINDER FLATS': [0.55, 0.8, 0.6, 0.9],
  'HARBOR CORE': [0.35, 0.6, 0.7, 1.0],
  'GRANARY ROW': [0.2, 0.45, 0.3, 0.55],
  'THE LOCKS': [0.45, 0.7, 0.4, 0.65],
  DRYDOCK: [0.4, 0.65, 0.35, 0.6],
}

/* road lattice shape */
const NX = 27
const NY = 17
const X0 = 25
const Y0 = 22
const XSTEP = (WORLD_W - 2 * X0) / (NX - 1)
const YSTEP = (WORLD_H - 2 * Y0) / (NY - 1)
const MAJOR_COLS = [2, 7, 13, 19, 24]
const MAJOR_ROWS = [2, 6, 10, 14]

/* ── helpers ───────────────────────────────────────────────────────── */

/** sector containing p; nearest district center when p sits in water/off-grid */
export function sectorAt(districts: District[], p: Vec2): SectorId {
  for (const d of districts) if (pointInPolygon(p, d.polygon)) return d.id
  let best = districts[0]
  let bd = Infinity
  for (const d of districts) {
    const dd = dist2(d.center, p)
    if (dd < bd) {
      bd = dd
      best = d
    }
  }
  return best.id
}

function catmullRom(pts: Vec2[], sub: number): Vec2[] {
  const out: Vec2[] = []
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)]
    const p1 = pts[i]
    const p2 = pts[i + 1]
    const p3 = pts[Math.min(pts.length - 1, i + 2)]
    for (let s = 0; s < sub; s++) {
      const t = s / sub
      const t2 = t * t
      const t3 = t2 * t
      out.push({
        x: 0.5 * (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
        y: 0.5 * (2 * p1.y + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
      })
    }
  }
  out.push({ ...pts[pts.length - 1] })
  return out
}

/** widen a centerline into a closed ribbon polygon (width lerps downstream) */
function ribbon(line: Vec2[], w0: number, w1: number): Vec2[] {
  const left: Vec2[] = []
  const right: Vec2[] = []
  for (let i = 0; i < line.length; i++) {
    const a = line[Math.max(0, i - 1)]
    const b = line[Math.min(line.length - 1, i + 1)]
    let dx = b.x - a.x
    let dy = b.y - a.y
    const len = Math.sqrt(dx * dx + dy * dy) || 1
    dx /= len
    dy /= len
    const w = lerp(w0, w1, i / (line.length - 1)) / 2
    left.push({ x: line[i].x - dy * w, y: line[i].y + dx * w })
    right.push({ x: line[i].x + dy * w, y: line[i].y - dx * w })
  }
  right.reverse()
  return left.concat(right)
}

/* ── water ─────────────────────────────────────────────────────────── */

function genHarbor(r: Rand): Vec2[] {
  const pts: Vec2[] = [
    { x: WORLD_W, y: 0 },
    { x: WORLD_W, y: WORLD_H },
  ]
  let x = 1462 + r.range(-12, 12)
  const steps = 12
  for (let i = 0; i <= steps; i++) {
    const y = WORLD_H - (WORLD_H * i) / steps
    x = clamp(x + r.range(-26, 26), 1432, 1505)
    pts.push({ x, y })
  }
  return pts
}

interface RiverGen {
  poly: Vec2[]
  line: Vec2[]
}

function genRiver(r: Rand): RiverGen {
  const c: Vec2[] = [
    { x: 615 + r.range(-35, 35), y: -30 },
    { x: 590 + r.range(-28, 28), y: 130 + r.range(-20, 20) },
    { x: 625 + r.range(-28, 28), y: 260 + r.range(-20, 20) },
    { x: 600 + r.range(-28, 28), y: 390 + r.range(-20, 20) },
    { x: 655 + r.range(-24, 24), y: 505 + r.range(-18, 18) },
    { x: 762 + r.range(-24, 24), y: 600 + r.range(-16, 16) },
    { x: 905 + r.range(-28, 28), y: 662 + r.range(-14, 14) },
    { x: 1080 + r.range(-28, 28), y: 698 + r.range(-12, 12) },
    { x: 1265 + r.range(-28, 28), y: 712 + r.range(-12, 12) },
    { x: 1545, y: 705 + r.range(-14, 14) },
  ]
  const line = catmullRom(c, 4)
  return { poly: ribbon(line, 46, 66), line }
}

/* ── districts ─────────────────────────────────────────────────────── */

function genDistricts(r: Rand): District[] {
  const bx = [0, 533, 1066, WORLD_W]
  const by = [0, 333, 666, WORLD_H]
  const corners: Vec2[][] = []
  for (let row = 0; row < 4; row++) {
    const rowPts: Vec2[] = []
    for (let col = 0; col < 4; col++) {
      const jx = col === 0 || col === 3 ? 0 : r.range(-60, 60)
      const jy = row === 0 || row === 3 ? 0 : r.range(-55, 55)
      rowPts.push({ x: bx[col] + jx, y: by[row] + jy })
    }
    corners.push(rowPts)
  }
  const out: District[] = []
  for (let i = 0; i < 9; i++) {
    const row = Math.floor(i / 3)
    const col = i % 3
    const polygon = [corners[row][col], corners[row][col + 1], corners[row + 1][col + 1], corners[row + 1][col]].map((p) => ({ ...p }))
    const name = DISTRICT_NAMES[i]
    const [rl, rh, dl, dh] = DISTRICT_FLAVOR[name]
    out.push({
      id: `SECTOR-${i + 1}`,
      name,
      center: polygonCentroid(polygon),
      polygon,
      baseRisk: r.range(rl, rh),
      density: r.range(dl, dh),
    })
  }
  return out
}

/* ── road lattice ──────────────────────────────────────────────────── */

interface RawSeg {
  a: number
  b: number
  major: boolean
  bridgeId?: string
}

interface BridgeCandidate {
  a: number
  b: number
  mid: Vec2
}

function segCrossesWater(a: Vec2, b: Vec2, polys: Vec2[][], probe: Vec2): boolean {
  for (let k = 1; k <= 3; k++) {
    const t = k / 4
    probe.x = a.x + (b.x - a.x) * t
    probe.y = a.y + (b.y - a.y) * t
    if (pointInAnyPolygon(probe, polys)) return true
  }
  return false
}

function segCrossesPoly(a: Vec2, b: Vec2, poly: Vec2[], probe: Vec2): boolean {
  for (let k = 1; k <= 6; k++) {
    const t = k / 7
    probe.x = a.x + (b.x - a.x) * t
    probe.y = a.y + (b.y - a.y) * t
    if (pointInPolygon(probe, poly)) return true
  }
  return false
}

export function generateCity(seed: number = DEFAULT_SEED): City {
  const water: Vec2[][] = []
  const harbor = genHarbor(new Rand(`nova:${seed}:harbor`))
  const river = genRiver(new Rand(`nova:${seed}:river`))
  water.push(harbor, river.poly)

  const districts = genDistricts(new Rand(`nova:${seed}:districts`))

  /* raw lattice */
  const rr = new Rand(`nova:${seed}:roads`)
  const rawPos: Vec2[] = new Array(NX * NY)
  const alive: boolean[] = new Array(NX * NY)
  const majCross: boolean[] = new Array(NX * NY)
  const majLine: boolean[] = new Array(NX * NY)
  const isMajorCol: boolean[] = new Array(NX).fill(false)
  for (const c of MAJOR_COLS) isMajorCol[c] = true
  const isMajorRow: boolean[] = new Array(NY).fill(false)
  for (const rw of MAJOR_ROWS) isMajorRow[rw] = true

  const probe: Vec2 = { x: 0, y: 0 }
  for (let j = 0; j < NY; j++) {
    for (let i = 0; i < NX; i++) {
      const idx = j * NX + i
      const jitX = isMajorCol[i] ? 5 : 16
      const jitY = isMajorRow[j] ? 5 : 16
      const p: Vec2 = {
        x: clamp(X0 + i * XSTEP + rr.range(-jitX, jitX), 8, WORLD_W - 8),
        y: clamp(Y0 + j * YSTEP + rr.range(-jitY, jitY), 8, WORLD_H - 8),
      }
      rawPos[idx] = p
      alive[idx] = !pointInAnyPolygon(p, water)
      majCross[idx] = isMajorCol[i] && isMajorRow[j]
      majLine[idx] = isMajorCol[i] || isMajorRow[j]
    }
  }

  /* candidate segments between adjacent lattice nodes (skip water) */
  const rawSegs: RawSeg[] = []
  for (let j = 0; j < NY; j++) {
    for (let i = 0; i < NX; i++) {
      const a = j * NX + i
      if (!alive[a]) continue
      if (i < NX - 1) {
        const b = a + 1
        if (alive[b] && !segCrossesWater(rawPos[a], rawPos[b], water, probe)) {
          const major = isMajorRow[j]
          if (major || !rr.chance(0.06)) rawSegs.push({ a, b, major })
        }
      }
      if (j < NY - 1) {
        const b = a + NX
        if (alive[b] && !segCrossesWater(rawPos[a], rawPos[b], water, probe)) {
          const major = isMajorCol[i]
          if (major || !rr.chance(0.06)) rawSegs.push({ a, b, major })
        }
      }
    }
  }

  /* bridge candidates: gaps along major avenues that cross the river */
  const candidates: BridgeCandidate[] = []
  const considerPair = (a: number, b: number): void => {
    if (!alive[a] || !alive[b]) return
    const pa = rawPos[a]
    const pb = rawPos[b]
    if (segCrossesPoly(pa, pb, harbor, probe)) return // never bridge the harbor
    if (!segCrossesPoly(pa, pb, river.poly, probe)) return
    candidates.push({ a, b, mid: { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 } })
  }
  for (const j of MAJOR_ROWS) {
    let prev = -1
    for (let i = 0; i < NX; i++) {
      const idx = j * NX + i
      if (!alive[idx]) continue
      if (prev >= 0) {
        const gap = i - (prev % NX)
        if (gap >= 1 && gap <= 4 && (gap > 1 || segCrossesWater(rawPos[prev], rawPos[idx], water, probe))) considerPair(prev, idx)
      }
      prev = idx
    }
  }
  for (const i of MAJOR_COLS) {
    let prev = -1
    for (let j = 0; j < NY; j++) {
      const idx = j * NX + i
      if (!alive[idx]) continue
      if (prev >= 0) {
        const gap = j - Math.floor(prev / NX)
        if (gap >= 1 && gap <= 4 && (gap > 1 || segCrossesWater(rawPos[prev], rawPos[idx], water, probe))) considerPair(prev, idx)
      }
      prev = idx
    }
  }

  /* fallback synth: guarantee ≥3 well-separated river crossings for any seed */
  const farFromAll = (p: Vec2, picks: BridgeCandidate[], minD: number): boolean =>
    picks.every((c) => dist2(c.mid, p) > minD * minD)
  if (candidates.length < 3) {
    for (const frac of [0.2, 0.5, 0.82]) {
      if (candidates.length >= 3) break
      const cp = river.line[Math.floor(frac * (river.line.length - 1))]
      let best: BridgeCandidate | null = null
      let bestLen = Infinity
      const near: number[] = []
      for (let idx = 0; idx < rawPos.length; idx++) {
        if (alive[idx] && dist2(rawPos[idx], cp) < 220 * 220) near.push(idx)
      }
      for (let u = 0; u < near.length; u++) {
        for (let v = u + 1; v < near.length; v++) {
          const a = near[u]
          const b = near[v]
          const pa = rawPos[a]
          const pb = rawPos[b]
          const len = dist2(pa, pb)
          if (len >= bestLen) continue
          if (segCrossesPoly(pa, pb, harbor, probe)) continue
          if (!segCrossesPoly(pa, pb, river.poly, probe)) continue
          best = { a, b, mid: { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 } }
          bestLen = len
        }
      }
      if (best && farFromAll(best.mid, candidates, 110)) candidates.push(best)
    }
  }

  /* pick 3 spread crossings: northmost, southmost, then max-min-distance */
  candidates.sort((c1, c2) => c1.mid.y - c2.mid.y || c1.mid.x - c2.mid.x)
  let picks: BridgeCandidate[]
  if (candidates.length <= 3) {
    picks = candidates.slice()
  } else {
    const first = candidates[0]
    const last = candidates[candidates.length - 1]
    let mid = candidates[1]
    let bestScore = -1
    for (let i = 1; i < candidates.length - 1; i++) {
      const c = candidates[i]
      const s = Math.min(dist2(c.mid, first.mid), dist2(c.mid, last.mid))
      if (s > bestScore) {
        bestScore = s
        mid = c
      }
    }
    picks = [first, mid, last]
  }
  picks.sort((c1, c2) => c1.mid.y - c2.mid.y || c1.mid.x - c2.mid.x)

  picks.forEach((c, i) => {
    rawSegs.push({ a: c.a, b: c.b, major: true, bridgeId: BRIDGE_NAMES[Math.min(i, 2)] })
  })

  /* connected components over raw graph → keep the largest */
  const adj: number[][] = rawPos.map(() => [])
  for (const s of rawSegs) {
    adj[s.a].push(s.b)
    adj[s.b].push(s.a)
  }
  const comp = new Int32Array(rawPos.length).fill(-1)
  let compCount = 0
  const queue: number[] = []
  const compSize: number[] = []
  for (let start = 0; start < rawPos.length; start++) {
    if (!alive[start] || comp[start] !== -1 || adj[start].length === 0) continue
    const id = compCount++
    compSize.push(0)
    comp[start] = id
    queue.length = 0
    queue.push(start)
    while (queue.length > 0) {
      const n = queue.pop() as number
      compSize[id]++
      for (const nb of adj[n]) {
        if (comp[nb] === -1) {
          comp[nb] = id
          queue.push(nb)
        }
      }
    }
  }
  let largest = 0
  for (let i = 1; i < compCount; i++) if (compSize[i] > compSize[largest]) largest = i

  /* compact to final node/segment arrays */
  const finalIdx = new Int32Array(rawPos.length).fill(-1)
  const nodes: RoadNode[] = []
  for (let idx = 0; idx < rawPos.length; idx++) {
    if (alive[idx] && comp[idx] === largest) {
      finalIdx[idx] = nodes.length
      nodes.push({ id: nodes.length, pos: rawPos[idx], neighbors: [] })
    }
  }
  const segments: RoadSegment[] = []
  const bridgeSegFinal = new Map<string, number>()
  for (const s of rawSegs) {
    const fa = finalIdx[s.a]
    const fb = finalIdx[s.b]
    if (fa === -1 || fb === -1) continue
    const seg: RoadSegment = { a: fa, b: fb, major: s.major }
    if (s.bridgeId !== undefined) {
      seg.bridgeId = s.bridgeId
      bridgeSegFinal.set(s.bridgeId, segments.length)
    }
    segments.push(seg)
    nodes[fa].neighbors.push(fb)
    nodes[fb].neighbors.push(fa)
  }

  const bridges: BridgeInfo[] = []
  picks.forEach((c, i) => {
    const name = BRIDGE_NAMES[Math.min(i, 2)]
    const segIdx = bridgeSegFinal.get(name)
    if (segIdx !== undefined) bridges.push({ id: name, name, pos: c.mid, segmentIdx: segIdx })
  })

  /* ── blocks (visual fill between minor streets) ──────────────────── */
  const br = new Rand(`nova:${seed}:blocks`)
  const blocks: CityBlock[] = []
  const insetQuad = (quad: Vec2[], f: number): Vec2[] => {
    const c = polygonCentroid(quad)
    return quad.map((p) => ({ x: p.x + (c.x - p.x) * f, y: p.y + (c.y - p.y) * f }))
  }
  const pushBlock = (quad: Vec2[]): void => {
    const inset = insetQuad(quad, br.range(0.14, 0.26))
    const c = polygonCentroid(inset)
    if (pointInAnyPolygon(c, water)) return
    for (const p of inset) if (pointInAnyPolygon(p, water)) return
    blocks.push({ poly: inset, sector: sectorAt(districts, c), shade: br.range(0.25, 1) })
  }
  for (let j = 0; j < NY - 1; j++) {
    for (let i = 0; i < NX - 1; i++) {
      const c00 = j * NX + i
      const c10 = c00 + 1
      const c01 = c00 + NX
      const c11 = c01 + 1
      if (!alive[c00] || !alive[c10] || !alive[c01] || !alive[c11]) continue
      if (br.chance(0.06)) continue // occasional plaza gap
      const p00 = rawPos[c00]
      const p10 = rawPos[c10]
      const p01 = rawPos[c01]
      const p11 = rawPos[c11]
      if (br.chance(0.32)) {
        const m0 = { x: (p00.x + p10.x) / 2, y: (p00.y + p10.y) / 2 }
        const m1 = { x: (p01.x + p11.x) / 2, y: (p01.y + p11.y) / 2 }
        pushBlock([p00, m0, m1, p01])
        pushBlock([m0, p10, p11, m1])
      } else {
        pushBlock([p00, p10, p11, p01])
      }
    }
  }

  /* ── landmarks ───────────────────────────────────────────────────── */
  const lr = new Rand(`nova:${seed}:landmarks`)
  const nearestNodePos = (p: Vec2): Vec2 => {
    let best = nodes[0].pos
    let bd = Infinity
    for (const n of nodes) {
      const d = dist2(n.pos, p)
      if (d < bd) {
        bd = d
        best = n.pos
      }
    }
    return best
  }
  const landmarkSpecs: { name: string; glyph: Landmark['glyph']; anchor: Vec2 }[] = [
    { name: 'PIER 4 ANNEX', glyph: 'port', anchor: { x: 1392, y: 262 } },
    { name: 'NORTH TERMINAL', glyph: 'terminal', anchor: { x: 985, y: 78 } },
    { name: 'RELAY HOUSE 12', glyph: 'tower', anchor: districts[1].center },
    { name: 'VELLUM ARCADE', glyph: 'exchange', anchor: districts[2].center },
    { name: 'MERIDIAN PLAZA', glyph: 'plaza', anchor: districts[3].center },
    { name: 'HALE STREET EXCHANGE', glyph: 'exchange', anchor: { x: districts[4].center.x + 70, y: districts[4].center.y + 40 } },
    { name: 'THE GRANARY', glyph: 'yard', anchor: districts[6].center },
    { name: 'SOUTH LOCKS', glyph: 'port', anchor: { x: 1030, y: 782 } },
    { name: 'DRYDOCK 9', glyph: 'yard', anchor: { x: districts[8].center.x + 120, y: districts[8].center.y } },
  ]
  const landmarks: Landmark[] = landmarkSpecs.map((spec) => {
    const base = nearestNodePos(spec.anchor)
    let pos: Vec2 = { x: base.x, y: base.y }
    for (let t = 0; t < 4; t++) {
      const p = { x: base.x + lr.range(-14, 14), y: base.y + lr.range(-14, 14) }
      if (!pointInAnyPolygon(p, water)) {
        pos = p
        break
      }
    }
    return { name: spec.name, pos, glyph: spec.glyph }
  })

  /* ── cameras (24 · CAM-02..CAM-25 · CAM-01 = operator webcam) ────── */
  const cr = new Rand(`nova:${seed}:cameras`)
  const crossNodes: number[] = []
  const lineNodes: number[] = []
  for (let idx = 0; idx < rawPos.length; idx++) {
    const f = finalIdx[idx]
    if (f === -1) continue
    if (majCross[idx]) crossNodes.push(f)
    else if (majLine[idx]) lineNodes.push(f)
  }
  const byYX = (a: number, b: number): number => nodes[a].pos.y - nodes[b].pos.y || nodes[a].pos.x - nodes[b].pos.x
  crossNodes.sort(byYX)
  lineNodes.sort((a, b) => nodes[b].neighbors.length - nodes[a].neighbors.length || byYX(a, b))
  const camNodes = crossNodes.concat(lineNodes).slice(0, 24)

  const LANDMARK_SHORT: Record<string, string> = {
    'PIER 4 ANNEX': 'PIER 4',
    'NORTH TERMINAL': 'TERMINAL',
    'RELAY HOUSE 12': 'RELAY 12',
    'VELLUM ARCADE': 'VELLUM',
    'MERIDIAN PLAZA': 'MERIDIAN',
    'HALE STREET EXCHANGE': 'HALE STREET',
    'THE GRANARY': 'GRANARY',
    'SOUTH LOCKS': 'SOUTH LOCKS',
    'DRYDOCK 9': 'DRYDOCK 9',
  }
  const DISTRICT_SHORT: Record<string, string> = {
    NORTHGATE: 'NORTHGATE',
    'RELAY HEIGHTS': 'RELAY',
    VELLUM: 'VELLUM',
    MERIDIAN: 'MERIDIAN',
    'CINDER FLATS': 'CINDER',
    'HARBOR CORE': 'HARBOR',
    'GRANARY ROW': 'GRANARY',
    'THE LOCKS': 'LOCKS',
    DRYDOCK: 'DRYDOCK',
  }
  const SUFFIXES = ['OVERWATCH', 'APPROACH', 'JUNCTION', 'MAINLINE', 'PERIMETER', 'CROSSING', 'GATE', 'RELAY']
  const usedLabels = new Set<string>()
  const districtById = new Map(districts.map((d) => [d.id, d]))
  const cameras: CameraSpec[] = camNodes.map((nodeI, ci) => {
    const pos = nodes[nodeI].pos
    let base: string | null = null
    let bd = 230 * 230
    for (const lm of landmarks) {
      const d = dist2(lm.pos, pos)
      if (d < bd) {
        bd = d
        base = LANDMARK_SHORT[lm.name]
      }
    }
    const sector = sectorAt(districts, pos)
    if (base === null) base = DISTRICT_SHORT[districtById.get(sector)?.name ?? 'MERIDIAN'] ?? 'GRID'
    let label = ''
    for (let s = 0; s < SUFFIXES.length; s++) {
      label = `${base} ${SUFFIXES[(ci + s) % SUFFIXES.length]}`
      if (!usedLabels.has(label)) break
    }
    usedLabels.add(label)
    return {
      id: `CAM-${String(ci + 2).padStart(2, '0')}`,
      pos: { x: pos.x, y: pos.y },
      sector,
      dir: cr.range(0, TAU),
      fov: cr.range(0.42, 0.6),
      range: cr.range(70, 120),
      label,
    }
  })

  const nodeSectors: SectorId[] = nodes.map((n) => sectorAt(districts, n.pos))

  return {
    seed,
    size: { x: WORLD_W, y: WORLD_H },
    districts,
    nodes,
    segments,
    water,
    blocks,
    landmarks,
    bridges,
    cameras,
    nodeSectors,
  }
}
