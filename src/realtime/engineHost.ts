/**
 * EngineHost — the ONE authoritative world owner.
 *
 * Runs identically in three places: a Web Worker, the main thread (inline
 * fallback / tests), and the node server. It owns the World + InfraState +
 * WorldInputs, advances the sim, captures the events the engine emits, and
 * serialises everything into the wire protocol. It touches NO browser API,
 * so node can import it directly.
 */
import type { Histories, InfraState, PatrolUnit, RealMetrics, RealTelemetry, SectorId, World } from '../sim/types'
import { advanceWorld, createWorld, getWorldDerived, type WorldInputs } from '../sim/world'
import { DEFAULT_SEED } from '../sim/cityGen'
import { emitEvent, onEvent } from '../sim/events'
import {
  PF_MOVING,
  PF_TRACKED,
  POS_DECIMALS,
  PROTOCOL_VERSION,
  VF_PARKED,
  VF_STALLED,
  type CameraStatic,
  type DerivedWire,
  type EngineHostApi,
  type EngineHostOpts,
  type HelloMsg,
  type IncidentWire,
  type PatrolStatic,
  type PersonStatic,
  type SourceCommand,
  type TickMsg,
  type VehicleStatic,
  type WireEvent,
} from './protocol'

const SECTORS: SectorId[] = Array.from({ length: 9 }, (_, i) => `SECTOR-${i + 1}`)
const HISTORY_LEN = 150
const RECENT_EVENTS = 200
const POS_Q = Math.pow(10, POS_DECIMALS)
const round = (n: number): number => Math.round(n * POS_Q) / POS_Q
/** district index 0..8 → SectorId */
const sectorIdxOf = (s: SectorId): number => {
  const n = parseInt(s.slice(7), 10)
  return Number.isFinite(n) && n >= 1 ? n - 1 : 0
}
const PATROL_STATUS = { PATROL: 0, RESPONDING: 1, ON_SCENE: 2 } as const

export function defaultInfra(world: World): InfraState {
  return {
    power: Object.fromEntries(SECTORS.map((s) => [s, true])),
    traffic: Object.fromEntries(SECTORS.map((s) => [s, 'NORMAL' as const])),
    transit: { 'METRO-A': 'RUN', 'METRO-B': 'RUN', 'METRO-C': 'RUN' },
    comms: Object.fromEntries(SECTORS.map((s) => [s, true])),
    water: Object.fromEntries(SECTORS.map((s) => [s, 'NOMINAL' as const])),
    bridgesRaised: Object.fromEntries(world.city.bridges.map((b) => [b.id, false])),
  }
}

function emptyHistories(): Histories {
  return { riskIndex: [], incidentRate: [], detectionsPerMin: [], netLoad: [], activeUnits: [], sensorUptime: [], cityLoad: [] }
}

export class EngineHost implements EngineHostApi {
  readonly world: World
  infra: InfraState
  readonly seed: number

  private inputs: WorldInputs = { manualSpawns: [], cvOnline: false, cvSubjects: 0, defconOverride: null }
  private histories: Histories
  private recent: WireEvent[]
  private pending: WireEvent[] = []
  private infraDirty = false
  private offEvent: () => void
  private booted = false
  /** Phase 1 real telemetry, by origin */
  private metricsClient: RealMetrics | null = null
  private metricsHost: RealMetrics | null = null
  private feedEventAt = -1e9
  private feedSeen = { client: false, host: false }

  constructor(seed: number = DEFAULT_SEED, opts: EngineHostOpts = {}) {
    this.seed = seed
    this.world = createWorld(seed)
    this.infra = defaultInfra(this.world)
    this.histories = opts.seedHistories ? { ...emptyHistories(), ...structuredCloneSafe(opts.seedHistories) } : emptyHistories()
    this.recent = opts.seedEvents ? opts.seedEvents.slice(-RECENT_EVENTS) : []

    // capture engine emissions into the pending buffer, tagged with sim time
    this.offEvent = onEvent((severity, channel, message, sector, entityId) => {
      const e: WireEvent = {
        tick: this.world.tick,
        simMinutes: this.world.simMinutes,
        wall: Date.now(),
        severity,
        channel,
        sector,
        entityId,
        message,
      }
      this.pending.push(e)
      this.recent.push(e)
      if (this.recent.length > RECENT_EVENTS) this.recent.shift()
    })

    this.emitBootLines()
  }

  private emitBootLines(): void {
    if (this.booted) return
    this.booted = true
    // emitted synchronously through the bus so they land in the first hello()
    const w = this.world
    const tracks = w.persons.length + w.vehicles.length + w.patrols.length
    emitEvent('INFO', 'SYSTEM', 'PANOPTICON CORE ONLINE — NOVA HARBOR MESH SYNCHRONIZED')
    emitEvent(
      'INFO',
      'SYSTEM',
      `ROAD GRAPH ${w.city.nodes.length} NODES · ${w.city.segments.length} SEGMENTS · ${w.cameras.length} SENSORS · ${tracks} TRACKS`,
    )
  }

  private realTelemetry(): RealTelemetry {
    const rt: RealTelemetry = {}
    if (this.metricsClient) rt.client = this.metricsClient
    if (this.metricsHost) rt.host = this.metricsHost
    return rt
  }

  private toDerivedWire(): DerivedWire {
    const d = getWorldDerived(this.world)
    const vitals = { ...d.vitals }
    // real CPU genuinely feeds the city's "CPU load" — prefer the host machine
    const realCpu = this.metricsHost?.cpuPct ?? this.metricsClient?.cpuPct
    if (typeof realCpu === 'number') vitals.cityLoad = vitals.cityLoad * 0.7 + realCpu * 0.3
    return {
      riskIndex: d.riskIndex,
      systemIntegrity: d.systemIntegrity,
      cascadeRisk: d.cascadeRisk,
      defcon: d.defcon,
      vitals,
      detectionsPerMin: d.detectionsPerMin,
      incidentsActive: d.incidentsActive,
      camerasOnline: d.camerasOnline,
      hotspots: d.hotspots,
      threatBoard: d.threatBoard,
      analystNote: d.analystNote,
      hotspotsRev: d.hotspotsRev,
      threatRev: d.threatRev,
      noteRev: d.noteRev,
      realTelemetry: this.realTelemetry(),
    }
  }

  /** full snapshot for a connecting / reconnecting client */
  hello(): HelloMsg {
    const w = this.world
    const persons: PersonStatic[] = w.persons.map((p) => ({ id: p.id, watchlisted: p.watchlisted, riskScore: p.riskScore }))
    const vehicles: VehicleStatic[] = w.vehicles.map((v) => ({ id: v.id }))
    const patrols: PatrolStatic[] = w.patrols.map((u) => ({ id: u.id, callsign: u.callsign }))
    const cameras: CameraStatic[] = w.cameras.map((c) => ({
      id: c.id,
      label: c.label,
      x: round(c.pos.x),
      y: round(c.pos.y),
      dir: c.dir,
      fov: c.fov,
      range: c.range,
      sector: sectorIdxOf(c.sector),
    }))
    const hello: HelloMsg = {
      t: 'hello',
      v: PROTOCOL_VERSION,
      seed: this.seed,
      tick: w.tick,
      simMinutes: w.simMinutes,
      city: w.city,
      persons,
      vehicles,
      patrols,
      cameras,
      infra: cloneInfra(this.infra),
      histories: structuredCloneSafe(this.histories),
      recentEvents: this.recent.slice(),
      derived: this.toDerivedWire(),
    }
    // the snapshot's recentEvents already covers everything so far; drop the
    // pending buffer so the next tick doesn't re-deliver pre-hello events.
    this.pending = []
    return hello
  }

  /** advance one 100 ms step and serialise the result */
  tick(): TickMsg {
    this.inputs.defconOverride = this.inputs.defconOverride ?? null
    advanceWorld(this.world, this.infra, this.inputs)
    const w = this.world

    const nP = w.persons.length
    const personPos = new Array<number>(nP * 2)
    const personSector = new Array<number>(nP)
    const personFlags = new Array<number>(nP)
    for (let i = 0; i < nP; i++) {
      const p = w.persons[i]
      personPos[i * 2] = round(p.pos.x)
      personPos[i * 2 + 1] = round(p.pos.y)
      personSector[i] = sectorIdxOf(p.sector)
      personFlags[i] = (p.status === 'MOVING' ? PF_MOVING : 0) | (p.tracked ? PF_TRACKED : 0)
    }

    const nV = w.vehicles.length
    const vehiclePos = new Array<number>(nV * 2)
    const vehicleSector = new Array<number>(nV)
    const vehicleFlags = new Array<number>(nV)
    for (let i = 0; i < nV; i++) {
      const v = w.vehicles[i]
      vehiclePos[i * 2] = round(v.pos.x)
      vehiclePos[i * 2 + 1] = round(v.pos.y)
      vehicleSector[i] = sectorIdxOf(v.sector)
      vehicleFlags[i] = (v.stalled ? VF_STALLED : 0) | ((v as { parked?: boolean }).parked ? VF_PARKED : 0)
    }

    const nU = w.patrols.length
    const patrolPos = new Array<number>(nU * 2)
    const patrolSector = new Array<number>(nU)
    const patrolStatus = new Array<number>(nU)
    const patrolTarget = new Array<string | null>(nU)
    for (let i = 0; i < nU; i++) {
      const u: PatrolUnit = w.patrols[i]
      patrolPos[i * 2] = round(u.pos.x)
      patrolPos[i * 2 + 1] = round(u.pos.y)
      patrolSector[i] = sectorIdxOf(u.sector)
      patrolStatus[i] = PATROL_STATUS[u.status]
      patrolTarget[i] = u.targetIncidentId
    }

    const incidents: IncidentWire[] = w.incidents.map((inc) => ({
      id: inc.id,
      type: inc.type,
      phase: inc.phase,
      severity: inc.severity,
      x: round(inc.pos.x),
      y: round(inc.pos.y),
      sector: sectorIdxOf(inc.sector),
      spawnedTick: inc.spawnedTick,
      phaseTick: inc.phaseTick,
      assignedUnitId: inc.assignedUnitId,
    }))

    const cameraOnline = w.cameras.map((c) => c.online)
    const cameraDetections = w.cameras.map((c) => c.detections)
    const cameraLastDetection = w.cameras.map((c) => c.lastDetectionTick)
    const congestion = SECTORS.map((s) => w.congestion[s] ?? 0)

    const derived = this.toDerivedWire()
    if (w.tick % 5 === 0) this.pushHistories(derived)

    const events = this.pending
    this.pending = []

    const msg: TickMsg = {
      t: 'tick',
      tick: w.tick,
      simMinutes: w.simMinutes,
      personPos,
      vehiclePos,
      patrolPos,
      personSector,
      vehicleSector,
      patrolSector,
      personFlags,
      vehicleFlags,
      patrolStatus,
      patrolTarget,
      incidents,
      cameraOnline,
      cameraDetections,
      cameraLastDetection,
      congestion,
      instability: w.instability,
      derived,
      events,
    }
    if (this.infraDirty) {
      msg.infra = cloneInfra(this.infra)
      this.infraDirty = false
    }
    return msg
  }

  private pushHistories(d: DerivedWire): void {
    const push = (k: keyof Histories, v: number) => {
      const arr = this.histories[k]
      arr.push(v)
      if (arr.length > HISTORY_LEN) arr.shift()
    }
    push('cityLoad', d.vitals.cityLoad)
    push('netLoad', d.vitals.netLoad)
    push('sensorUptime', d.vitals.sensorUptime)
    push('activeUnits', d.vitals.activeUnits)
    push('riskIndex', d.riskIndex)
    push('incidentRate', d.incidentsActive)
    push('detectionsPerMin', d.detectionsPerMin)
  }

  /** authoritative state mutation from a client command (no log echo — the
   *  client echoes optimistically, matching the original store semantics) */
  command(cmd: SourceCommand): void {
    switch (cmd.k) {
      case 'power':
        this.infra.power[cmd.sector] = cmd.on
        this.infraDirty = true
        break
      case 'traffic':
        this.infra.traffic[cmd.sector] = cmd.mode
        this.infraDirty = true
        break
      case 'transit':
        this.infra.transit[cmd.line] = cmd.mode
        this.infraDirty = true
        break
      case 'bridge':
        this.infra.bridgesRaised[cmd.id] = cmd.raised
        this.infraDirty = true
        break
      case 'comms':
        this.infra.comms[cmd.sector] = cmd.on
        this.infraDirty = true
        break
      case 'autoRestore':
        this.infra = defaultInfra(this.world)
        this.infraDirty = true
        break
      case 'spawn':
        this.inputs.manualSpawns.push(cmd.sector)
        break
      case 'defcon':
        this.inputs.defconOverride = cmd.level
        break
      case 'track': {
        const p = this.world.persons.find((e) => e.id === cmd.id)
        if (p) p.tracked = cmd.on
        break
      }
      case 'cv':
        this.inputs.cvOnline = cmd.online
        this.inputs.cvSubjects = cmd.subjects
        break
      case 'feed':
        this.ingestFeed(cmd.metrics)
        break
    }
  }

  /** accept a real telemetry sample; announce first contact per origin */
  private ingestFeed(m: RealMetrics): void {
    if (m.source === 'host') this.metricsHost = m
    else this.metricsClient = m
    if (!this.feedSeen[m.source]) {
      this.feedSeen[m.source] = true
      const parts: string[] = []
      if (typeof m.cpuPct === 'number') parts.push(`CPU ${Math.round(m.cpuPct)}%`)
      if (typeof m.memPct === 'number') parts.push(`MEM ${Math.round(m.memPct)}%`)
      if (typeof m.cores === 'number') parts.push(`${m.cores} CORES`)
      emitEvent('NOTICE', 'FEED', `REAL FEED ONLINE · ${m.label}${parts.length ? ' · ' + parts.join(' · ') : ''}`)
      this.feedEventAt = this.world.tick
    }
  }

  /** current persisted state for the server snapshot writer */
  snapshot(): { histories: Histories; recent: WireEvent[] } {
    return { histories: structuredCloneSafe(this.histories), recent: this.recent.slice() }
  }

  dispose(): void {
    this.offEvent()
  }
}

function cloneInfra(infra: InfraState): InfraState {
  return {
    power: { ...infra.power },
    traffic: { ...infra.traffic },
    transit: { ...infra.transit },
    comms: { ...infra.comms },
    water: { ...infra.water },
    bridgesRaised: { ...infra.bridgesRaised },
  }
}

/** JSON round-trip clone — safe in node and browser, keeps things wire-shaped */
function structuredCloneSafe<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T
}
