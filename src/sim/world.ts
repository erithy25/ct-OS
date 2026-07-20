/**
 * The master 10 Hz world advance. Headless-testable: `createWorld(seed)` builds
 * the full deterministic world, `advanceWorld(world, infra, inputs)` steps it.
 * The store calls this from a 100 ms interval and syncs the returned scalars.
 *
 * Timebase: 1 real tick = 100 ms; +1 sim-minute every 6 ticks (1 real minute =
 * 10 sim minutes). Movement uses MOVE_DT sim-seconds per tick, tuned so motion
 * is clearly visible without being frantic.
 */
import { Rand } from './seed'
import { clamp, dist2, pointInAnyPolygon, TAU } from '../lib/geometry'
import { buildGraph, nearestNode, Pathfinder, type BlockedFn, type RoadGraph } from '../lib/pathfind'
import { DEFAULT_SEED, generateCity } from './cityGen'
import {
  advanceAlongPath,
  ARRIVE_DIST,
  createCameras,
  createIncident,
  createPatrols,
  createPersons,
  createVehicles,
  pickIncidentType,
  stepIncident,
  VEHICLE_COUNT,
  type IncidentCtx,
} from './entities'
import { emitEvent } from './events'
import { getDossier } from './identityFactory'
import type {
  HotspotForecast,
  Incident,
  InfraState,
  PatrolUnit,
  Person,
  SectorId,
  ThreatEntry,
  Vitals,
  World,
} from './types'

export const TICK_HZ = 10
export const TICKS_PER_SIM_MIN = 6
/** sim-seconds of movement per tick (speeds are u/s of movement time) */
const MOVE_DT = 0.15
/** organic incident spawn: base probability per tick (~1 per 55 s nominal) */
const SPAWN_P_BASE = 1 / 550

export interface WorldInputs {
  /** drained each tick — manual spawnIncident() requests (undefined = weighted random sector) */
  manualSpawns: (SectorId | undefined)[]
  cvOnline: boolean
  cvSubjects: number
  /** operator DEFCON override (wins over the derived level) */
  defconOverride: number | null
}

export interface WorldDerived {
  riskIndex: number
  systemIntegrity: number
  cascadeRisk: boolean
  defcon: 1 | 2 | 3 | 4 | 5
  vitals: Vitals
  detectionsPerMin: number
  incidentsActive: number
  camerasOnline: number
  hotspots: HotspotForecast[]
  threatBoard: ThreatEntry[]
  analystNote: string
  /** revision counters — consumers re-sync the array/string fields when these change */
  hotspotsRev: number
  threatRev: number
  noteRev: number
}

/* ── day/night + activity curves ───────────────────────────────────── */

/** 0 = full day (~14:00), 1 = deep night (~02:00) */
export function nightAt(simMinutes: number): number {
  return 0.5 - 0.5 * Math.cos((TAU * (((simMinutes % 1440) + 1440) % 1440 - 840)) / 1440)
}

/** 0..1 traffic activity: rush bumps 07–09 / 16–19, quiet nights */
export function activityAt(simMinutes: number): number {
  const h = (((simMinutes % 1440) + 1440) % 1440) / 60
  const day = 1 - nightAt(simMinutes)
  let a = 0.3 + 0.55 * day
  a += 0.28 * Math.exp(-((h - 8) * (h - 8)) / 1.8)
  a += 0.24 * Math.exp(-((h - 17.5) * (h - 17.5)) / 2.6)
  return clamp(a, 0.12, 1)
}

const sectorIdx = (s: SectorId): number => {
  const n = parseInt(s.slice(7), 10)
  return (Number.isFinite(n) && n >= 1 ? n : 1) - 1
}

/* ── engine (per-world module state, non-reactive) ─────────────────── */

interface Engine {
  rand: Rand
  graph: RoadGraph
  finder: Pathfinder
  blockedSegs: Set<number>
  blockedSig: string
  blockedFn: BlockedFn
  /** (a * 65536 + b) → segment index, both directions */
  edgeSeg: Map<number, number>
  /** sector idx → node indices */
  bySector: number[][]
  landmarkNodes: number[]
  capacity: Float64Array
  movingCount: Float64Array
  sectorW: Float64Array
  /** per-sector simMinute stamps of recent incident spawns (10 min window) */
  sectorIncidents: number[][]
  incidentSeq: number
  detTicks: number[]
  lastDetectionEventTick: number
  camOnlineCount: number
  emaCityLoad: number
  emaNetLoad: number
  emaRisk: number
  /** threshold-crossing hysteresis: candidate level must persist before committing */
  pendingDefconRaw: number
  pendingDefconSince: number
  stableDefconRaw: number
  lastEffectiveDefcon: number
  cascadeLatch: boolean
  noteDirty: boolean
  warmupUntil: number
  nextChatterTick: number
  threatPersons: Person[]
  threatNames: string[]
  threatFlags: number[]
  dispatchOrder: number[]
  ctx: IncidentCtx | null
  derived: WorldDerived
}

const engines = new WeakMap<World, Engine>()

/* ── world construction ────────────────────────────────────────────── */

export function createWorld(seed: number = DEFAULT_SEED): World {
  const city = generateCity(seed)
  const world: World = {
    city,
    persons: createPersons(city, seed),
    vehicles: createVehicles(city, seed),
    patrols: createPatrols(city, seed),
    incidents: [],
    cameras: createCameras(city),
    congestion: {},
    instability: 0,
    simMinutes: 7 * 60 + 35, // 07:35 — morning rush imminent
    night: 0,
    tick: 0,
  }
  for (const d of city.districts) world.congestion[d.id] = 0.1 + 0.08 * d.density
  world.night = nightAt(world.simMinutes)
  return world
}

function getEngine(world: World): Engine {
  const existing = engines.get(world)
  if (existing) return existing
  const city = world.city
  const graph = buildGraph(city.nodes, city.segments)
  const nodeSectors = city.nodeSectors ?? []
  const bySector: number[][] = city.districts.map(() => [])
  for (let i = 0; i < city.nodes.length; i++) {
    const si = sectorIdx(nodeSectors[i] ?? 'SECTOR-1')
    if (bySector[si]) bySector[si].push(i)
  }
  const edgeSeg = new Map<number, number>()
  for (let si = 0; si < city.segments.length; si++) {
    const s = city.segments[si]
    edgeSeg.set(s.a * 65536 + s.b, si)
    edgeSeg.set(s.b * 65536 + s.a, si)
  }
  const totalDensity = city.districts.reduce((acc, d) => acc + d.density, 0) || 1
  const capacity = new Float64Array(9)
  city.districts.forEach((d, i) => {
    capacity[i] = Math.max(5, VEHICLE_COUNT * (d.density / totalDensity) * 1.8)
  })

  // static top-8 persons by risk (identity risk never changes; live fields refresh per cycle)
  const ranked = world.persons
    .map((p, i) => i)
    .sort((a, b) => world.persons[b].riskScore - world.persons[a].riskScore || a - b)
    .slice(0, 8)

  const eng: Engine = {
    rand: new Rand(`world:${city.seed}:runtime`),
    graph,
    finder: new Pathfinder(graph),
    blockedSegs: new Set(),
    blockedSig: '',
    blockedFn: () => false,
    edgeSeg,
    bySector,
    landmarkNodes: city.landmarks.map((lm) => nearestNode(graph, lm.pos.x, lm.pos.y)),
    capacity,
    movingCount: new Float64Array(9),
    sectorW: new Float64Array(9),
    sectorIncidents: city.districts.map(() => []),
    incidentSeq: 0,
    detTicks: [],
    lastDetectionEventTick: -100,
    camOnlineCount: world.cameras.length,
    emaCityLoad: 26,
    emaNetLoad: 18,
    emaRisk: 16,
    pendingDefconRaw: 5,
    pendingDefconSince: 0,
    stableDefconRaw: 5,
    lastEffectiveDefcon: 5,
    cascadeLatch: false,
    noteDirty: false,
    warmupUntil: 300,
    nextChatterTick: 300,
    threatPersons: ranked.map((i) => world.persons[i]),
    threatNames: [],
    threatFlags: [],
    dispatchOrder: [],
    ctx: null,
    derived: {
      riskIndex: 16,
      systemIntegrity: 100,
      cascadeRisk: false,
      defcon: 5,
      vitals: { cityLoad: 26, activeUnits: 0, sensorUptime: 100, netLoad: 18 },
      detectionsPerMin: 0,
      incidentsActive: 0,
      camerasOnline: world.cameras.length,
      hotspots: [],
      threatBoard: [],
      analystNote: 'GRID NOMINAL; PATROL COVERAGE OPTIMAL; MAINTAIN POSTURE.',
      hotspotsRev: 0,
      threatRev: 0,
      noteRev: 0,
    },
  }
  eng.blockedFn = (segI: number) => eng.blockedSegs.has(segI)
  for (const p of eng.threatPersons) {
    const dossier = getDossierCached(p.id)
    eng.threatNames.push(dossier.name)
    eng.threatFlags.push(dossier.flags.length)
  }
  engines.set(world, eng)
  return eng
}

// getDossier is deterministic; tiny cache avoids re-deriving repeatedly
const dossierNameCache = new Map<string, ReturnType<typeof getDossier>>()
function getDossierCached(id: string): ReturnType<typeof getDossier> {
  let d = dossierNameCache.get(id)
  if (!d) {
    d = getDossier(id)
    dossierNameCache.set(id, d)
  }
  return d
}

/** road graph for the current world (map renderer / modules) */
export function getRoadGraph(world: World): RoadGraph {
  return getEngine(world).graph
}

/** current derived analytics without advancing (modules may read imperatively) */
export function getWorldDerived(world: World): WorldDerived {
  return getEngine(world).derived
}

/* ── infra sync (bridges / camera power) ───────────────────────────── */

interface MoverLike {
  path: number[]
  pathPos: number
}

function truncatePathAtBlocked(e: MoverLike, eng: Engine): void {
  const path = e.path
  if (path.length < 2) return
  const i = Math.floor(e.pathPos)
  const frac = e.pathPos - i
  for (let k = i; k < path.length - 1; k++) {
    const seg = eng.edgeSeg.get(path[k] * 65536 + path[k + 1])
    if (seg !== undefined && eng.blockedSegs.has(seg)) {
      // allow finishing the leg the entity is already on (mid-span when raised)
      const cut = k === i && frac > 1e-4 ? k + 2 : k + 1
      if (cut < path.length) path.length = Math.max(cut, i + 1)
      return
    }
  }
}

function syncInfra(world: World, eng: Engine, infra: InfraState): void {
  const bridges = world.city.bridges
  let sig = ''
  for (const b of bridges) sig += infra.bridgesRaised[b.id] ? '1' : '0'
  if (sig !== eng.blockedSig) {
    eng.blockedSig = sig
    eng.blockedSegs.clear()
    for (const b of bridges) {
      if (infra.bridgesRaised[b.id]) eng.blockedSegs.add(b.segmentIdx)
    }
    if (eng.blockedSegs.size > 0) {
      for (const p of world.persons) truncatePathAtBlocked(p, eng)
      for (const v of world.vehicles) truncatePathAtBlocked(v, eng)
      for (const u of world.patrols) truncatePathAtBlocked(u, eng)
    }
  }

  let online = 0
  for (const cam of world.cameras) {
    cam.online = infra.power[cam.sector] !== false
    if (cam.online) online++
  }
  eng.camOnlineCount = online
}

/* ── movement ──────────────────────────────────────────────────────── */

function incidentById(world: World, id: string | null): Incident | undefined {
  if (id === null) return undefined
  for (const inc of world.incidents) if (inc.id === id) return inc
  return undefined
}

function patrolById(world: World, id: string | null): PatrolUnit | undefined {
  if (id === null) return undefined
  for (const u of world.patrols) if (u.id === id) return u
  return undefined
}

function pickNodeInSector(eng: Engine, si: number): number {
  const arr = eng.bySector[si]
  if (arr && arr.length > 0) return arr[eng.rand.int(0, arr.length - 1)]
  return eng.rand.int(0, eng.graph.count - 1)
}

function pickPersonTarget(p: Person, world: World, eng: Engine): void {
  const r = eng.rand
  let target: number
  let homebound = false
  if (world.night > 0.55 && r.chance(world.night * 0.5)) {
    target = p.homeNode ?? p.nodeIdx
    homebound = true
  } else {
    const roll = r.next()
    if (roll < 0.55) {
      const homeSector = world.city.nodeSectors?.[p.homeNode ?? p.nodeIdx] ?? p.sector
      target = pickNodeInSector(eng, sectorIdx(homeSector))
    } else if (roll < 0.75 && eng.landmarkNodes.length > 0) {
      target = eng.landmarkNodes[r.int(0, eng.landmarkNodes.length - 1)]
    } else {
      target = r.int(0, eng.graph.count - 1)
    }
  }
  if (target === p.nodeIdx) {
    p.dwell = r.int(20, 120)
    p.status = 'IDLE'
    return
  }
  if (eng.finder.findPathInto(p.nodeIdx, target, p.path, eng.blockedFn)) {
    p.pathPos = 0
    p.targetIdx = target
    p.status = 'MOVING'
    if (homebound) p.dwell = 0
  } else {
    p.path.length = 0
    p.pathPos = 0
    p.dwell = 60
    p.status = 'IDLE'
  }
}

function pickVehicleTarget(v: { nodeIdx: number; targetIdx: number; path: number[]; pathPos: number; sector: SectorId }, world: World, eng: Engine): boolean {
  const r = eng.rand
  const districts = world.city.districts
  let total = 0
  for (const d of districts) total += d.density
  let roll = r.next() * total
  let si = 0
  for (let i = 0; i < districts.length; i++) {
    roll -= districts[i].density
    if (roll <= 0) {
      si = i
      break
    }
  }
  let target = pickNodeInSector(eng, si)
  if (target === v.nodeIdx) return false
  if (!eng.finder.findPathInto(v.nodeIdx, target, v.path, eng.blockedFn)) {
    // cross-river unreachable (bridges up) — fall back to a local trip
    target = pickNodeInSector(eng, sectorIdx(v.sector))
    if (target === v.nodeIdx || !eng.finder.findPathInto(v.nodeIdx, target, v.path, eng.blockedFn)) {
      v.path.length = 0
      v.pathPos = 0
      return false
    }
  }
  v.pathPos = 0
  v.targetIdx = target
  return true
}

function pickPatrolTarget(u: PatrolUnit, world: World, eng: Engine): void {
  const r = eng.rand
  const districts = world.city.districts
  let total = 0
  for (const d of districts) total += 0.35 + d.baseRisk
  let roll = r.next() * total
  let si = 0
  for (let i = 0; i < districts.length; i++) {
    roll -= 0.35 + districts[i].baseRisk
    if (roll <= 0) {
      si = i
      break
    }
  }
  const target = pickNodeInSector(eng, si)
  if (target !== u.nodeIdx && eng.finder.findPathInto(u.nodeIdx, target, u.path, eng.blockedFn)) {
    u.pathPos = 0
    u.targetIdx = target
  } else {
    u.path.length = 0
    u.pathPos = 0
  }
}

function moveAll(world: World, eng: Engine, infra: InfraState): void {
  const graph = eng.graph
  const nodeSectors = world.city.nodeSectors ?? []
  const activity = activityAt(world.simMinutes)
  eng.movingCount.fill(0)

  for (const p of world.persons) {
    p.prevPos.x = p.pos.x
    p.prevPos.y = p.pos.y
    if ((p.dwell ?? 0) > 0) {
      p.dwell = (p.dwell ?? 0) - 1
      p.status = 'IDLE'
      continue
    }
    if (p.path.length > 1 && p.pathPos < p.path.length - 1) {
      p.status = 'MOVING'
      const arrived = advanceAlongPath(p, graph, p.speed * MOVE_DT)
      p.sector = nodeSectors[p.nodeIdx] ?? p.sector
      if (arrived) {
        p.path.length = 0
        p.pathPos = 0
        p.dwell = world.night > 0.55 ? eng.rand.int(120, 900) : eng.rand.int(30, 260)
        p.status = 'IDLE'
      }
    } else {
      pickPersonTarget(p, world, eng)
    }
  }

  for (const v of world.vehicles) {
    v.prevPos.x = v.pos.x
    v.prevPos.y = v.pos.y
    const si = sectorIdx(v.sector)
    if (v.parked) {
      v.stalled = false
      if ((v.actKey ?? 0) <= activity - 0.05) v.parked = false
      else continue
    }
    if (v.path.length > 1 && v.pathPos < v.path.length - 1) {
      const dark = infra.power[v.sector] === false
      const tmode = infra.traffic[v.sector]
      let mod = 1
      if (dark || tmode === 'FORCE_RED' || tmode === 'BLACKOUT') {
        mod = 0.15
        v.stalled = true
      } else {
        v.stalled = false
        if (tmode === 'FORCE_GREEN') mod = 1.4
      }
      mod *= 1 - 0.45 * (world.congestion[v.sector] ?? 0)
      eng.movingCount[si] += v.stalled ? 1.7 : 1
      const arrived = advanceAlongPath(v, graph, v.speed * mod * MOVE_DT)
      v.sector = nodeSectors[v.nodeIdx] ?? v.sector
      if (arrived) {
        v.path.length = 0
        v.pathPos = 0
      }
    } else {
      v.stalled = false
      if ((v.actKey ?? 0) > activity) {
        v.parked = true
        continue
      }
      pickVehicleTarget(v, world, eng)
    }
  }

  for (let ui = 0; ui < world.patrols.length; ui++) {
    const u = world.patrols[ui]
    u.prevPos.x = u.pos.x
    u.prevPos.y = u.pos.y
    if (u.status === 'ON_SCENE') continue

    if (u.path.length > 1 && u.pathPos < u.path.length - 1) {
      const dark = infra.power[u.sector] === false
      const tmode = infra.traffic[u.sector]
      let mod = dark || tmode === 'FORCE_RED' || tmode === 'BLACKOUT' ? 0.8 : tmode === 'FORCE_GREEN' ? 1.15 : 1
      mod *= 1 - 0.25 * (world.congestion[u.sector] ?? 0)
      const arrived = advanceAlongPath(u, graph, u.speed * mod * MOVE_DT)
      u.sector = nodeSectors[u.nodeIdx] ?? u.sector
      if (arrived) {
        u.path.length = 0
        u.pathPos = 0
      }
    } else if (u.status === 'RESPONDING') {
      // lost/parked path while responding (e.g. bridge raised) — re-path periodically
      const inc = incidentById(world, u.targetIncidentId)
      if (!inc || inc.phase === 'RESOLVED') {
        u.status = 'PATROL'
        u.targetIncidentId = null
      } else if (world.tick % 20 === ui % 20 && inc.nodeIdx !== undefined) {
        if (eng.finder.findPathInto(u.nodeIdx, inc.nodeIdx, u.path, eng.blockedFn)) {
          u.pathPos = 0
          u.targetIdx = inc.nodeIdx
        }
      }
    } else {
      pickPatrolTarget(u, world, eng)
    }

    if (u.status === 'RESPONDING') {
      const inc = incidentById(world, u.targetIncidentId)
      if (inc && dist2(u.pos, inc.pos) < ARRIVE_DIST * ARRIVE_DIST) {
        u.status = 'ON_SCENE'
        u.path.length = 0
        u.pathPos = 0
        emitEvent('NOTICE', 'UNIT', `${u.callsign} ON SCENE · ${inc.id}`, inc.sector, u.id)
      }
    }
  }
}

/* ── cameras ───────────────────────────────────────────────────────── */

function scanCameras(world: World, eng: Engine): void {
  const tick = world.tick
  for (let ci = 0; ci < world.cameras.length; ci++) {
    const cam = world.cameras[ci]
    if (!cam.online) continue
    const limit = 74 + ((ci * 13) % 30) // ~7.4–10.4 s per-camera rate limit
    if (tick - cam.lastDetectionTick < limit) continue
    if (tick - eng.lastDetectionEventTick < 25) continue // global feed damping (≤24 events/min)

    const r2 = cam.range * cam.range
    let best: Person | null = null
    let bestScore = 0
    for (const p of world.persons) {
      const dx = p.pos.x - cam.pos.x
      const dy = p.pos.y - cam.pos.y
      if (dx * dx + dy * dy > r2) continue
      let diff = Math.atan2(dy, dx) - cam.dir
      diff = ((diff % TAU) + TAU) % TAU
      if (diff > Math.PI) diff -= TAU
      if (Math.abs(diff) > cam.fov) continue
      const score = p.tracked ? 3 : p.watchlisted ? 2 : 1
      if (score > bestScore) {
        best = p
        bestScore = score
        if (score === 3) break
      }
    }
    let contactId: string | null = best ? best.id : null
    if (contactId === null) {
      for (const v of world.vehicles) {
        if (v.parked) continue
        const dx = v.pos.x - cam.pos.x
        const dy = v.pos.y - cam.pos.y
        if (dx * dx + dy * dy > r2) continue
        let diff = Math.atan2(dy, dx) - cam.dir
        diff = ((diff % TAU) + TAU) % TAU
        if (diff > Math.PI) diff -= TAU
        if (Math.abs(diff) > cam.fov) continue
        contactId = v.id
        break
      }
    }
    if (contactId !== null) {
      cam.detections++
      cam.lastDetectionTick = tick
      eng.lastDetectionEventTick = tick
      eng.detTicks.push(tick)
      const priority = bestScore >= 2
      emitEvent(
        priority ? 'WARN' : 'INFO',
        'DETECTION',
        `${cam.id} // ${cam.label}: ${priority ? 'PRIORITY CONTACT' : 'CONTACT'} ${contactId}`,
        cam.sector,
        contactId,
      )
    }
  }
}

/* ── incidents ─────────────────────────────────────────────────────── */

function spawnIncidentAt(world: World, eng: Engine, infra: InfraState, si: number): void {
  const city = world.city
  const district = city.districts[si]
  const nodeIdx = pickNodeInSector(eng, si)
  const nodePos = city.nodes[nodeIdx].pos
  let pos = { x: nodePos.x + eng.rand.range(-9, 9), y: nodePos.y + eng.rand.range(-9, 9) }
  if (pointInAnyPolygon(pos, city.water)) pos = { x: nodePos.x, y: nodePos.y }
  const dark = infra.power[district.id] === false
  const type = pickIncidentType(eng.rand, { density: district.density, baseRisk: district.baseRisk, dark, night: world.night })
  const inc = createIncident(++eng.incidentSeq, type, district.id, pos, nodeIdx, world.tick, eng.rand)
  world.incidents.push(inc)
  const stamps = eng.sectorIncidents[si]
  stamps.push(world.simMinutes)
  emitEvent('WARN', 'INCIDENT', `INCIDENT ${inc.id} · ${inc.type} @ ${district.id}`, district.id, inc.id)
}

/** per-sector spawn weights → total; also updates eng.sectorW */
function computeSpawnWeights(world: World, eng: Engine, infra: InfraState): number {
  const districts = world.city.districts
  let sum = 0
  for (let i = 0; i < districts.length; i++) {
    const d = districts[i]
    const dark = infra.power[d.id] === false
    const w = d.baseRisk * (dark ? 3 : 1) * (1 + (world.congestion[d.id] ?? 0) * 0.4)
    eng.sectorW[i] = w
    sum += w
  }
  return sum
}

function weightedSector(eng: Engine, total: number): number {
  let roll = eng.rand.next() * total
  for (let i = 0; i < 9; i++) {
    roll -= eng.sectorW[i]
    if (roll <= 0) return i
  }
  return 8
}

function spawnIncidents(world: World, eng: Engine, infra: InfraState, inputs: WorldInputs): void {
  const totalW = computeSpawnWeights(world, eng, infra)
  const baseW = world.city.districts.reduce((acc, d) => acc + d.baseRisk, 0) || 1
  let p = SPAWN_P_BASE * (1 + world.night * 0.6) * (1 + world.instability * 2.5) * (totalW / baseW)
  if (world.tick < eng.warmupUntil) p *= 2.5
  if (eng.rand.chance(Math.min(p, 0.05))) spawnIncidentAt(world, eng, infra, weightedSector(eng, totalW))

  while (inputs.manualSpawns.length > 0) {
    const req = inputs.manualSpawns.shift()
    const si = req !== undefined ? sectorIdx(req) : weightedSector(eng, totalW)
    spawnIncidentAt(world, eng, infra, clamp(si, 0, 8))
  }
}

function makeIncidentCtx(world: World, eng: Engine): IncidentCtx {
  return {
    tick: 0,
    rand: eng.rand,
    dispatch: (inc) => {
      const order = eng.dispatchOrder
      order.length = 0
      for (let i = 0; i < world.patrols.length; i++) {
        if (world.patrols[i].status === 'PATROL') order.push(i)
      }
      if (order.length === 0) return null
      order.sort((a, b) => dist2(world.patrols[a].pos, inc.pos) - dist2(world.patrols[b].pos, inc.pos))
      const target = inc.nodeIdx ?? nearestNode(eng.graph, inc.pos.x, inc.pos.y)
      for (const i of order) {
        const u = world.patrols[i]
        if (eng.finder.findPathInto(u.nodeIdx, target, u.path, eng.blockedFn)) {
          u.pathPos = 0
          u.targetIdx = target
          u.status = 'RESPONDING'
          u.targetIncidentId = inc.id
          emitEvent('NOTICE', 'UNIT', `${u.callsign} RESPONDING · ${inc.id} @ ${inc.sector}`, inc.sector, u.id)
          return u.id
        }
        u.path.length = 0
        u.pathPos = 0
      }
      return null
    },
    unitArrived: (inc) => patrolById(world, inc.assignedUnitId)?.status === 'ON_SCENE',
    onEscalate: (inc) => {
      emitEvent(
        inc.severity >= 4 ? 'CRIT' : 'WARN',
        'INCIDENT',
        `${inc.id} ESCALATED → CLASS-${inc.severity} · ${inc.type} @ ${inc.sector}`,
        inc.sector,
        inc.id,
      )
    },
    onResolve: (inc) => {
      const u = patrolById(world, inc.assignedUnitId)
      if (u) {
        u.status = 'PATROL'
        u.targetIncidentId = null
        u.path.length = 0
        u.pathPos = 0
      }
      emitEvent('NOTICE', 'INCIDENT', `INCIDENT ${inc.id} RESOLVED · ${inc.sector}${u ? ` — ${u.callsign} CLEAR` : ''}`, inc.sector, inc.id)
    },
  }
}

function stepAllIncidents(world: World, eng: Engine): void {
  if (eng.ctx === null) eng.ctx = makeIncidentCtx(world, eng)
  eng.ctx.tick = world.tick
  for (let i = world.incidents.length - 1; i >= 0; i--) {
    if (stepIncident(world.incidents[i], eng.ctx) === 'cull') world.incidents.splice(i, 1)
  }
}

/* ── metrics / analytics ───────────────────────────────────────────── */

function updateMetrics(world: World, eng: Engine, infra: InfraState, inputs: WorldInputs): void {
  const d = eng.derived
  const districts = world.city.districts

  /* congestion EMA */
  let avgCong = 0
  for (let i = 0; i < districts.length; i++) {
    const dd = districts[i]
    const dark = infra.power[dd.id] === false
    const tmode = infra.traffic[dd.id]
    let target = clamp((eng.movingCount[i] / eng.capacity[i]) * 0.85, 0, 1)
    if (dark || tmode === 'FORCE_RED') target = clamp(target + 0.4, 0, 1)
    if (tmode === 'BLACKOUT') target = clamp(target + 0.5, 0, 1)
    if (tmode === 'FORCE_GREEN') target *= 0.4
    const cur = world.congestion[dd.id] ?? 0
    const next = cur + (target - cur) * 0.03
    world.congestion[dd.id] = next
    avgCong += next
  }
  avgCong /= districts.length

  /* instability ← active destabilizations */
  let destab = 0
  let darkCount = 0
  let commsDown = 0
  for (const dd of districts) {
    if (infra.power[dd.id] === false) {
      destab += 0.14
      darkCount++
    }
    const tmode = infra.traffic[dd.id]
    if (tmode === 'FORCE_RED') destab += 0.06
    if (tmode === 'BLACKOUT') destab += 0.09
    if (infra.comms[dd.id] === false) {
      destab += 0.08
      commsDown++
    }
    if (infra.water[dd.id] === 'REDUCED') destab += 0.03
  }
  let bridgesUp = 0
  for (const b of world.city.bridges) if (infra.bridgesRaised[b.id]) bridgesUp++
  destab += bridgesUp * 0.07
  for (const line of Object.keys(infra.transit)) if (infra.transit[line] === 'HOLD') destab += 0.05
  const instTarget = clamp(destab, 0, 1)
  world.instability += (instTarget - world.instability) * (instTarget > world.instability ? 0.035 : 0.012)
  if (world.instability < 0.0005 && instTarget === 0) world.instability = 0

  /* integrity / cascade */
  let pressure = 0
  let active = 0
  for (const inc of world.incidents) {
    if (inc.phase !== 'RESOLVED') {
      active++
      pressure += inc.severity
    }
  }
  const integrity = clamp(100 - world.instability * 58 - pressure * 2.4, 5, 100)
  const cascade = integrity < 45
  if (cascade && !eng.cascadeLatch) {
    emitEvent('CRIT', 'SYSTEM', 'GRID INSTABILITY — CASCADE RISK')
    eng.cascadeLatch = true
    eng.noteDirty = true
  } else if (!cascade && eng.cascadeLatch && integrity > 52) {
    eng.cascadeLatch = false
    eng.noteDirty = true
  }

  /* detections/min (rolling 60 s) + CV feed */
  const detTicks = eng.detTicks
  while (detTicks.length > 0 && detTicks[0] < world.tick - 600) detTicks.shift()
  if (inputs.cvOnline && inputs.cvSubjects > 0 && world.tick % 70 === 0) detTicks.push(world.tick)
  const dpm = detTicks.length

  /* risk index (smoothed) */
  const rawRisk = clamp(6 + pressure * 1.8 + world.instability * 38 + world.night * 9 + avgCong * 16 + dpm * 0.2, 0, 100)
  eng.emaRisk += (rawRisk - eng.emaRisk) * 0.04

  /* DEFCON — risk thresholds with a 3-point deadband + 3 s persistence, then hard caps */
  let dcRaw: number = eng.emaRisk > 85 ? 1 : eng.emaRisk > 68 ? 2 : eng.emaRisk > 50 ? 3 : eng.emaRisk > 30 ? 4 : 5
  if (dcRaw > eng.stableDefconRaw) {
    // easing: risk must clear the current level's entry boundary by 3 points
    const boundary = eng.stableDefconRaw === 1 ? 85 : eng.stableDefconRaw === 2 ? 68 : eng.stableDefconRaw === 3 ? 50 : eng.stableDefconRaw === 4 ? 30 : -1
    if (boundary >= 0 && eng.emaRisk > boundary - 3) dcRaw = eng.stableDefconRaw
  }
  if (dcRaw !== eng.pendingDefconRaw) {
    eng.pendingDefconRaw = dcRaw
    eng.pendingDefconSince = world.tick
  }
  if (world.tick - eng.pendingDefconSince >= 30) eng.stableDefconRaw = eng.pendingDefconRaw
  let dc = eng.stableDefconRaw
  if (darkCount > 0) dc = Math.min(dc, 3)
  if (cascade) dc = Math.min(dc, 2)
  const effective = clamp(inputs.defconOverride ?? dc, 1, 5)
  if (effective !== eng.lastEffectiveDefcon) {
    if (inputs.defconOverride === null) {
      if (effective < eng.lastEffectiveDefcon) emitEvent('WARN', 'SYSTEM', `THREATCON RAISED → DEFCON ${effective}`)
      else emitEvent('NOTICE', 'SYSTEM', `THREATCON EASED → DEFCON ${effective}`)
      eng.noteDirty = true
    }
    eng.lastEffectiveDefcon = effective
  }

  /* vitals */
  const activity = activityAt(world.simMinutes)
  let activeUnits = 0
  for (const u of world.patrols) if (u.status !== 'PATROL') activeUnits++
  const cityTarget = 16 + activity * 26 + active * 3 + world.instability * 30 + (inputs.cvOnline ? 3 : 0) + eng.rand.range(-1.5, 1.5)
  eng.emaCityLoad = clamp(eng.emaCityLoad + (cityTarget - eng.emaCityLoad) * 0.05, 4, 98)
  const netTarget =
    15 +
    8 * Math.sin(world.tick / 227) +
    dpm * 0.6 +
    commsDown * 7 +
    world.instability * 8 +
    (inputs.cvOnline ? 3 + inputs.cvSubjects * 1.2 : 0) +
    eng.rand.range(-1.2, 1.2)
  eng.emaNetLoad = clamp(eng.emaNetLoad + (netTarget - eng.emaNetLoad) * 0.08, 4, 97)

  d.vitals.cityLoad = eng.emaCityLoad
  d.vitals.activeUnits = activeUnits
  d.vitals.sensorUptime = world.cameras.length > 0 ? (100 * eng.camOnlineCount) / world.cameras.length : 100
  d.vitals.netLoad = eng.emaNetLoad
  d.riskIndex = eng.emaRisk
  d.systemIntegrity = integrity
  d.cascadeRisk = cascade
  d.defcon = effective as WorldDerived['defcon']
  d.detectionsPerMin = dpm
  d.incidentsActive = active
  d.camerasOnline = eng.camOnlineCount
}

const HOTSPOT_WINDOW_MIN = 10

function computeHotspots(world: World, eng: Engine, infra: InfraState): void {
  const d = eng.derived
  const districts = world.city.districts
  const windowIdx = Math.floor(world.tick / 50)
  const scored: { si: number; score: number; driver: string }[] = []
  for (let i = 0; i < districts.length; i++) {
    const dd = districts[i]
    const stamps = eng.sectorIncidents[i]
    while (stamps.length > 0 && stamps[0] < world.simMinutes - HOTSPOT_WINDOW_MIN) stamps.shift()
    const dark = infra.power[dd.id] === false
    const baseTerm = dd.baseRisk * (0.5 + world.night)
    const congTerm = (world.congestion[dd.id] ?? 0) * 0.5
    const incTerm = stamps.length * 0.8
    const darkTerm = dark ? 0.9 : 0
    const instTerm = world.instability
    const score = baseTerm + congTerm + incTerm + darkTerm + instTerm
    let driver = world.night > 0.5 ? 'NIGHT ACTIVITY' : 'BASELINE PATTERN'
    let max = baseTerm
    if (congTerm > max) {
      max = congTerm
      driver = 'CONGESTION'
    }
    if (incTerm > max) {
      max = incTerm
      driver = 'INCIDENT CLUSTER'
    }
    if (darkTerm > max) {
      max = darkTerm
      driver = 'POWER LOSS'
    }
    if (instTerm > max) {
      max = instTerm
      driver = 'GRID INSTABILITY'
    }
    scored.push({ si: i, score, driver })
  }
  scored.sort((a, b) => b.score - a.score || a.si - b.si)
  const out: HotspotForecast[] = []
  for (let k = 0; k < 4 && k < scored.length; k++) {
    const s = scored[k]
    const conf = new Rand(`hs:${world.city.seed}:${s.si}:${windowIdx}`)
    out.push({
      sector: districts[s.si].id,
      probability: clamp(0.05 + s.score / 2.8, 0.05, 0.97),
      confidence: 0.55 + 0.38 * conf.next(),
      driver: s.driver,
    })
  }
  d.hotspots = out
  d.hotspotsRev++
}

function computeThreatBoard(world: World, eng: Engine, trackedIds?: readonly string[]): void {
  const d = eng.derived
  const out: ThreatEntry[] = []
  for (let i = 0; i < eng.threatPersons.length; i++) {
    const p = eng.threatPersons[i]
    out.push({
      id: p.id,
      name: eng.threatNames[i],
      risk: p.riskScore,
      sector: p.sector,
      flags: eng.threatFlags[i],
      tracked: p.tracked || (trackedIds?.includes(p.id) ?? false),
    })
  }
  d.threatBoard = out
  d.threatRev++
}

function computeAnalystNote(world: World, eng: Engine, infra: InfraState): void {
  const d = eng.derived
  const districts = world.city.districts

  let darkSector: SectorId | null = null
  let darkCount = 0
  for (const dd of districts) {
    if (infra.power[dd.id] === false) {
      darkCount++
      if (darkSector === null) darkSector = dd.id
    }
  }
  let worstCong: SectorId = districts[0].id
  let worstCongV = -1
  for (const dd of districts) {
    const c = world.congestion[dd.id] ?? 0
    if (c > worstCongV) {
      worstCongV = c
      worstCong = dd.id
    }
  }
  let raisedBridge: string | null = null
  for (const b of world.city.bridges) if (infra.bridgesRaised[b.id]) raisedBridge = b.name
  const active = d.incidentsActive
  const freeUnits = world.patrols.filter((u) => u.status === 'PATROL').length
  let busiest: SectorId | null = null
  let busiestN = 0
  const perSector = new Map<SectorId, number>()
  for (const inc of world.incidents) {
    if (inc.phase === 'RESOLVED') continue
    const n = (perSector.get(inc.sector) ?? 0) + 1
    perSector.set(inc.sector, n)
    if (n > busiestN) {
      busiestN = n
      busiest = inc.sector
    }
  }

  let note: string
  if (d.cascadeRisk) {
    note = `CASCADE RISK ACTIVE — SYSTEM INTEGRITY ${d.systemIntegrity.toFixed(0)}%. ISOLATE DESTABILIZED SECTORS AND RESTORE PRIMARY POWER.`
  } else if (darkSector !== null) {
    note = `ELEVATED ACTIVITY IN ${darkSector} FOLLOWING POWER EVENT (${darkCount} SECTOR${darkCount > 1 ? 'S' : ''} DARK); RECOMMEND REALLOCATING ${Math.min(4, 1 + active)} UNITS.`
  } else if (active >= 3 && busiest !== null) {
    note = `INCIDENT CLUSTER — ${active} ACTIVE, PRIORITY ${busiest}; ${freeUnits} UNITS AVAILABLE FOR TASKING.`
  } else if (raisedBridge !== null) {
    note = `${raisedBridge} SPAN OPEN — CROSS-RIVER ROUTING DEGRADED; EXPECT CONGESTION ${(worstCongV * 100).toFixed(0)}% AT ${worstCong}.`
  } else if (worstCongV > 0.6) {
    note = `CONGESTION ${(worstCongV * 100).toFixed(0)}% IN ${worstCong}; SIGNAL TIMING ADJUSTMENT ADVISED.`
  } else if (d.riskIndex > 50) {
    note = `RISK INDEX ${d.riskIndex.toFixed(0)} AND TRENDING — POSTURE REVIEW ADVISED; ${freeUnits} UNITS IN RESERVE.`
  } else if (world.night > 0.7) {
    note = `NIGHT WATCH POSTURE — ${d.detectionsPerMin.toFixed(0)} DETECTIONS/MIN ACROSS ${d.camerasOnline} SENSORS; GRID QUIET.`
  } else {
    note = `GRID NOMINAL; PATROL COVERAGE OPTIMAL (${freeUnits}/12 FREE); MAINTAIN POSTURE. INTEGRITY ${d.systemIntegrity.toFixed(0)}%.`
  }
  if (note !== d.analystNote) {
    d.analystNote = note
    d.noteRev++
  }
}

const CHATTER = [
  'SENSOR MESH SYNC COMPLETE',
  'UPLINK STABLE // 99.97%',
  'PERIMETER SWEEP NOMINAL',
  'ARCHIVE COMPACTION FINISHED',
  'NODE HEALTH CHECK PASSED 24/24',
  'CLOCK DRIFT +0.0021s CORRECTED',
  'CIPHER ROTATION APPLIED — MESH KEYS FRESH',
  'SUBSTRATE TELEMETRY LINK VERIFIED',
]

/* ── master advance ────────────────────────────────────────────────── */

export function advanceWorld(world: World, infra: InfraState, inputs: WorldInputs): WorldDerived {
  const eng = getEngine(world)
  world.tick++
  world.simMinutes += 1 / TICKS_PER_SIM_MIN
  world.night = nightAt(world.simMinutes)

  syncInfra(world, eng, infra)
  moveAll(world, eng, infra)
  if (world.tick % 5 === 0) scanCameras(world, eng)
  spawnIncidents(world, eng, infra, inputs)
  stepAllIncidents(world, eng)
  updateMetrics(world, eng, infra, inputs)

  if (world.tick % 50 === 10) computeHotspots(world, eng, infra)
  if (world.tick % 50 === 35) computeThreatBoard(world, eng)
  if (world.tick % 150 === 20 || eng.noteDirty) {
    eng.noteDirty = false
    computeAnalystNote(world, eng, infra)
  }
  if (world.tick >= eng.nextChatterTick) {
    eng.nextChatterTick = world.tick + eng.rand.int(400, 900)
    emitEvent('INFO', 'SYSTEM', CHATTER[eng.rand.int(0, CHATTER.length - 1)])
  }
  return eng.derived
}
