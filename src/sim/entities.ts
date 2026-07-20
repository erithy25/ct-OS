/**
 * Entity factories + shared movement + the incident state machine.
 * Everything here is pure and deterministic given an injected Rand, so the
 * FSM and factories are unit-testable without a running world.
 */
import { Rand } from './seed'
import { getDossier, personIdFromIndex, PERSON_POOL } from './identityFactory'
import type { RoadGraph } from '../lib/pathfind'
import type {
  Camera,
  City,
  District,
  Incident,
  IncidentType,
  PatrolUnit,
  Person,
  SectorId,
  Vec2,
  Vehicle,
} from './types'

export const VEHICLE_COUNT = 150
export const PATROL_COUNT = 12

/** RESOLVED incidents linger this many ticks before being culled (8 s @ 10 Hz) */
export const INCIDENT_LINGER_TICKS = 80
/** a responding unit counts as arrived within this distance (world units) */
export const ARRIVE_DIST = 12

/**
 * Minimal random surface the FSM and factories need — `Rand` satisfies it, and
 * tests can inject scripted implementations.
 */
export interface RandLike {
  next(): number
  range(a: number, b: number): number
  int(a: number, b: number): number
  chance(p: number): boolean
}

/* ── placement helpers ─────────────────────────────────────────────── */

/** node indices grouped by sector, in node order (deterministic) */
export function nodesBySector(city: City): Map<SectorId, number[]> {
  const map = new Map<SectorId, number[]>()
  for (const d of city.districts) map.set(d.id, [])
  const sectors = city.nodeSectors ?? []
  for (let i = 0; i < city.nodes.length; i++) {
    const s = sectors[i]
    const arr = map.get(s)
    if (arr) arr.push(i)
    else map.set(s, [i])
  }
  return map
}

function pickWeightedDistrict(r: RandLike, districts: District[], weightOf: (d: District) => number): District {
  let total = 0
  for (const d of districts) total += weightOf(d)
  let roll = r.next() * total
  for (const d of districts) {
    roll -= weightOf(d)
    if (roll <= 0) return d
  }
  return districts[districts.length - 1]
}

function pickNodeIn(r: RandLike, bySector: Map<SectorId, number[]>, sector: SectorId, fallbackCount: number): number {
  const arr = bySector.get(sector)
  if (arr && arr.length > 0) return arr[r.int(0, arr.length - 1)]
  return r.int(0, fallbackCount - 1)
}

/* ── factories ─────────────────────────────────────────────────────── */

export function createPersons(city: City, seed: number): Person[] {
  const r = new Rand(`ent:${seed}:persons`)
  const bySector = nodesBySector(city)
  const sectors = city.nodeSectors ?? []
  const out: Person[] = []
  for (let i = 0; i < PERSON_POOL; i++) {
    const id = personIdFromIndex(i)
    const dossier = getDossier(id)
    const home = pickWeightedDistrict(r, city.districts, (d) => d.density)
    const nodeIdx = pickNodeIn(r, bySector, home.id, city.nodes.length)
    const pos = city.nodes[nodeIdx].pos
    out.push({
      id,
      kind: 'person',
      pos: { x: pos.x, y: pos.y },
      prevPos: { x: pos.x, y: pos.y },
      sector: sectors[nodeIdx] ?? home.id,
      status: 'IDLE',
      watchlisted: dossier.status === 'FLAGGED',
      tracked: false,
      riskScore: dossier.risk,
      nodeIdx,
      targetIdx: nodeIdx,
      path: [],
      pathPos: 0,
      speed: r.range(4, 7),
      homeNode: nodeIdx,
      dwell: r.int(0, 120),
    })
  }
  return out
}

export function createVehicles(city: City, seed: number): Vehicle[] {
  const r = new Rand(`ent:${seed}:vehicles`)
  const bySector = nodesBySector(city)
  const sectors = city.nodeSectors ?? []
  const out: Vehicle[] = []
  for (let i = 0; i < VEHICLE_COUNT; i++) {
    const home = pickWeightedDistrict(r, city.districts, (d) => d.density)
    const nodeIdx = pickNodeIn(r, bySector, home.id, city.nodes.length)
    const pos = city.nodes[nodeIdx].pos
    out.push({
      id: `V-${1001 + i}`,
      kind: 'vehicle',
      pos: { x: pos.x, y: pos.y },
      prevPos: { x: pos.x, y: pos.y },
      sector: sectors[nodeIdx] ?? home.id,
      nodeIdx,
      targetIdx: nodeIdx,
      path: [],
      pathPos: 0,
      speed: r.range(24, 46),
      stalled: false,
      actKey: r.next(),
      parked: false,
    })
  }
  return out
}

const CALLSIGN_LETTERS = 'ABCDEHKLMNRSTVWXZ'

export function createPatrols(city: City, seed: number): PatrolUnit[] {
  const r = new Rand(`ent:${seed}:patrols`)
  const bySector = nodesBySector(city)
  const sectors = city.nodeSectors ?? []
  const used = new Set<string>()
  const out: PatrolUnit[] = []
  for (let i = 0; i < PATROL_COUNT; i++) {
    let callsign = ''
    do {
      callsign = `UNIT-${r.int(2, 9)}${CALLSIGN_LETTERS[r.int(0, CALLSIGN_LETTERS.length - 1)]}`
    } while (used.has(callsign))
    used.add(callsign)
    const sector = city.districts[i % city.districts.length].id
    const nodeIdx = pickNodeIn(r, bySector, sector, city.nodes.length)
    const pos = city.nodes[nodeIdx].pos
    out.push({
      id: `U-${String(i + 1).padStart(2, '0')}`,
      kind: 'patrol',
      pos: { x: pos.x, y: pos.y },
      prevPos: { x: pos.x, y: pos.y },
      sector: sectors[nodeIdx] ?? sector,
      callsign,
      status: 'PATROL',
      targetIncidentId: null,
      nodeIdx,
      targetIdx: nodeIdx,
      path: [],
      pathPos: 0,
      speed: r.range(30, 55),
    })
  }
  return out
}

export function createCameras(city: City): Camera[] {
  const specs = city.cameras ?? []
  return specs.map((spec) => ({
    id: spec.id,
    kind: 'camera' as const,
    pos: { x: spec.pos.x, y: spec.pos.y },
    prevPos: { x: spec.pos.x, y: spec.pos.y },
    sector: spec.sector,
    dir: spec.dir,
    fov: spec.fov,
    range: spec.range,
    online: true,
    lastDetectionTick: -10_000,
    detections: 0,
    label: spec.label,
  }))
}

/* ── movement ──────────────────────────────────────────────────────── */

interface Mover {
  pos: Vec2
  nodeIdx: number
  path: number[]
  pathPos: number
}

/**
 * Advance a mover `d` units along its node path. `pathPos` is a fractional
 * index into `path` (floor = current leg, frac = progress along it).
 * Returns true when the path is finished (or empty). Allocation-free.
 */
export function advanceAlongPath(e: Mover, g: RoadGraph, d: number): boolean {
  const path = e.path
  if (path.length < 2) {
    if (path.length === 1) e.nodeIdx = path[0]
    return true
  }
  let i = Math.floor(e.pathPos)
  let frac = e.pathPos - i
  while (d > 0 && i < path.length - 1) {
    const a = path[i]
    const b = path[i + 1]
    const dx = g.xs[b] - g.xs[a]
    const dy = g.ys[b] - g.ys[a]
    const segLen = Math.sqrt(dx * dx + dy * dy) || 0.001
    const remain = (1 - frac) * segLen
    if (d < remain) {
      frac += d / segLen
      d = 0
    } else {
      d -= remain
      i++
      frac = 0
      e.nodeIdx = path[i]
    }
  }
  if (i >= path.length - 1) {
    const last = path[path.length - 1]
    e.pos.x = g.xs[last]
    e.pos.y = g.ys[last]
    e.nodeIdx = last
    e.pathPos = path.length - 1
    return true
  }
  const a = path[i]
  const b = path[i + 1]
  e.pos.x = g.xs[a] + (g.xs[b] - g.xs[a]) * frac
  e.pos.y = g.ys[a] + (g.ys[b] - g.ys[a]) * frac
  e.pathPos = i + frac
  return false
}

/* ── incidents ─────────────────────────────────────────────────────── */

const INCIDENT_TYPES: { type: IncidentType; weight: number }[] = [
  { type: 'DISTURBANCE', weight: 3.0 },
  { type: 'INTRUSION', weight: 2.0 },
  { type: 'SIGNAL ANOMALY', weight: 1.5 },
  { type: 'GRID FAULT', weight: 1.0 },
  { type: 'PURSUIT', weight: 1.2 },
  { type: 'STRUCTURE FIRE', weight: 0.8 },
  { type: 'CROWD FORMATION', weight: 1.4 },
]

/** incident type weighted by district character + live conditions */
export function pickIncidentType(r: RandLike, opts: { density: number; baseRisk: number; dark: boolean; night: number }): IncidentType {
  let total = 0
  const weights: number[] = []
  for (const t of INCIDENT_TYPES) {
    let w = t.weight
    if (t.type === 'CROWD FORMATION' || t.type === 'DISTURBANCE') w *= 0.6 + opts.density
    if (t.type === 'INTRUSION' || t.type === 'PURSUIT') w *= 0.6 + opts.baseRisk * 1.4
    if (opts.dark && (t.type === 'INTRUSION' || t.type === 'GRID FAULT')) w *= 2.2
    if (opts.night > 0.6 && t.type === 'INTRUSION') w *= 1.4
    if (opts.night > 0.6 && t.type === 'CROWD FORMATION') w *= 0.5
    weights.push(w)
    total += w
  }
  let roll = r.next() * total
  for (let i = 0; i < INCIDENT_TYPES.length; i++) {
    roll -= weights[i]
    if (roll <= 0) return INCIDENT_TYPES[i].type
  }
  return 'DISTURBANCE'
}

export function createIncident(
  seq: number,
  type: IncidentType,
  sector: SectorId,
  pos: Vec2,
  nodeIdx: number,
  tick: number,
  r: RandLike,
): Incident {
  const severity = Math.min(5, 1 + (r.chance(0.35) ? 1 : 0) + (r.chance(0.12) ? 1 : 0)) as Incident['severity']
  return {
    id: `INC-${String(seq).padStart(4, '0')}`,
    kind: 'incident',
    pos: { x: pos.x, y: pos.y },
    prevPos: { x: pos.x, y: pos.y },
    sector,
    type,
    phase: 'SPAWNED',
    severity,
    spawnedTick: tick,
    phaseTick: tick,
    assignedUnitId: null,
    nodeIdx,
    phaseDur: r.int(80, 200), // SPAWNED for 8–20 s
    nextEscalateTick: 0,
    dispatchAtTick: 0,
  }
}

export interface IncidentCtx {
  tick: number
  rand: RandLike
  /** try to dispatch the nearest available unit; return its id, or null if none */
  dispatch(inc: Incident): string | null
  /** true once the assigned unit is on scene (dist < ARRIVE_DIST) */
  unitArrived(inc: Incident): boolean
  onEscalate?(inc: Incident): void
  onResolve?(inc: Incident): void
}

export type IncidentStep = 'active' | 'cull'

/**
 * SPAWNED → ESCALATING → RESPONDING → RESOLVED, then culled after a linger.
 * Pure: all randomness and world queries are injected via ctx.
 */
export function stepIncident(inc: Incident, ctx: IncidentCtx): IncidentStep {
  switch (inc.phase) {
    case 'SPAWNED': {
      if (ctx.tick - inc.phaseTick >= (inc.phaseDur ?? 120)) {
        inc.phase = 'ESCALATING'
        inc.phaseTick = ctx.tick
        inc.nextEscalateTick = ctx.tick + ctx.rand.int(60, 140)
        inc.dispatchAtTick = ctx.tick + ctx.rand.int(20, 60)
      }
      break
    }
    case 'ESCALATING': {
      if (ctx.tick >= (inc.nextEscalateTick ?? 0)) {
        inc.nextEscalateTick = ctx.tick + ctx.rand.int(60, 140)
        if (inc.severity < 5 && ctx.rand.chance(0.55)) {
          inc.severity = Math.min(5, inc.severity + 1) as Incident['severity']
          ctx.onEscalate?.(inc)
        }
      }
      if (ctx.tick >= (inc.dispatchAtTick ?? 0)) {
        const unitId = ctx.dispatch(inc)
        if (unitId !== null) {
          inc.assignedUnitId = unitId
          inc.phase = 'RESPONDING'
          inc.phaseTick = ctx.tick
        } else {
          inc.dispatchAtTick = ctx.tick + 25 // retry in 2.5 s
        }
      }
      break
    }
    case 'RESPONDING': {
      if (inc.onSceneTick === undefined) {
        if (ctx.unitArrived(inc)) {
          inc.onSceneTick = ctx.tick
          inc.phaseDur = ctx.rand.int(150, 400) // 15–40 s on scene
        }
      } else if (ctx.tick - inc.onSceneTick >= (inc.phaseDur ?? 250)) {
        inc.phase = 'RESOLVED'
        inc.phaseTick = ctx.tick
        ctx.onResolve?.(inc)
      }
      break
    }
    case 'RESOLVED': {
      if (ctx.tick - inc.phaseTick >= INCIDENT_LINGER_TICKS) return 'cull'
      break
    }
  }
  return 'active'
}
