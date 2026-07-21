/**
 * Zustand simulation store — REAL ENGINE, now source-driven (Phase 0).
 *
 * The authoritative world runs inside a WorldSource — a Web Worker, an inline
 * main-thread host, or the node server over WebSocket (see src/realtime/). This
 * store holds a *mirror* World that the renderers read imperatively; it is
 * mutated ONLY by applyHello/applyTick from the source. Store actions do an
 * optimistic reactive update + local event echo, then forward a command to the
 * source, whose next tick is authoritative.
 *
 * The exported surface — `useSim`, `getWorld`, `getEvents`, `getHistories`,
 * `findEntity`, `HISTORY_LEN`, `SECTORS`, `SIM_SEED`, `startSimLoop` — is the
 * stable contract all modules code against and is unchanged.
 */
import { create } from 'zustand'
import type {
  EventChannel,
  Histories,
  InfraState,
  SectorId,
  Severity,
  SimEntity,
  SimEvent,
  SimStore,
  World,
} from './types'
import { createWorld, nightAt } from './world'
import { DEFAULT_SEED } from './cityGen'
import {
  PF_MOVING,
  PF_TRACKED,
  VF_PARKED,
  VF_STALLED,
  type HelloMsg,
  type SourceCommand,
  type SourceSink,
  type TickMsg,
  type WireEvent,
  type WorldSource,
} from '../realtime/protocol'
import { readConfig } from '../realtime/config'
import { createSource } from '../realtime/sources'
import { startClientFeed, type FeedHandle } from '../realtime/dataFeed'

/** `?boot=skip` jumps straight to the cockpit (dev / automation nicety). */
const skipBoot = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('boot') === 'skip'

export const HISTORY_LEN = 150

export const SECTORS: SectorId[] = Array.from({ length: 9 }, (_, i) => `SECTOR-${i + 1}`)

/** world seed — surfaced in the LeftRail badge (SEED 0x2F7A) */
export const SIM_SEED = DEFAULT_SEED

const sectorOf = (idx: number): SectorId => `SECTOR-${idx + 1}`
const PATROL_STATUS = ['PATROL', 'RESPONDING', 'ON_SCENE'] as const

/* ── non-reactive singletons (read imperatively from render loops) ─── */

/** mirror world — built locally so modules/tests have full geometry + entities
 *  immediately, then kept in sync by the source. Never advanced here. */
const world: World = createWorld(SIM_SEED)

const emptyInfra = (): InfraState => ({
  power: Object.fromEntries(SECTORS.map((s) => [s, true])),
  traffic: Object.fromEntries(SECTORS.map((s) => [s, 'NORMAL' as const])),
  transit: { 'METRO-A': 'RUN', 'METRO-B': 'RUN', 'METRO-C': 'RUN' },
  comms: Object.fromEntries(SECTORS.map((s) => [s, true])),
  water: Object.fromEntries(SECTORS.map((s) => [s, 'NOMINAL' as const])),
  bridgesRaised: Object.fromEntries(world.city.bridges.map((b) => [b.id, false])),
})

const histories: Histories = {
  riskIndex: [],
  incidentRate: [],
  detectionsPerMin: [],
  netLoad: [],
  activeUnits: [],
  sensorUptime: [],
  cityLoad: [],
}

const events: SimEvent[] = []
let eventSeq = 1

export const getWorld = (): World => world
export const getEvents = (): SimEvent[] => events
export const getHistories = (): Histories => histories

/** Entity lookup across all world pools. */
export function findEntity(id: string): SimEntity | undefined {
  return (
    world.persons.find((e) => e.id === id) ??
    world.vehicles.find((e) => e.id === id) ??
    world.patrols.find((e) => e.id === id) ??
    world.incidents.find((e) => e.id === id) ??
    world.cameras.find((e) => e.id === id)
  )
}

const pushHistory = (key: keyof Histories, v: number) => {
  const arr = histories[key]
  arr.push(v)
  if (arr.length > HISTORY_LEN) arr.shift()
}

/* ── event ingestion (local echoes + engine events, no bus) ────────── */

function ingestWireEvent(we: WireEvent): void {
  events.push({
    id: eventSeq++,
    tick: we.tick,
    simMinutes: we.simMinutes,
    wall: we.wall,
    severity: we.severity,
    channel: we.channel,
    sector: we.sector,
    entityId: we.entityId,
    message: we.message,
  })
  if (events.length > 500) events.splice(0, events.length - 500)
}

/** optimistic local echo, stamped with the current mirror clock */
function echo(severity: Severity, channel: EventChannel, message: string, sector?: SectorId, entityId?: string): void {
  events.push({
    id: eventSeq++,
    tick: world.tick,
    simMinutes: world.simMinutes,
    wall: Date.now(),
    severity,
    channel,
    sector,
    entityId,
    message,
  })
  if (events.length > 500) events.splice(0, events.length - 500)
  useSim.setState((s) => ({ eventsVersion: s.eventsVersion + 1 }))
}

/* ── the world source (set by startSimLoop) ────────────────────────── */

let currentSource: WorldSource | null = null
const send = (cmd: SourceCommand): void => currentSource?.command(cmd)

/* ── store ─────────────────────────────────────────────────────────── */

export const useSim = create<SimStore>((set, get) => {
  const emit: SimStore['emit'] = (severity, channel, message, sector, entityId) =>
    echo(severity, channel, message, sector, entityId)

  return {
    booted: skipBoot,
    view: 'map',
    muted: false,
    tick: 0,
    simMinutes: world.simMinutes,
    defcon: 5,
    defconOverride: null,
    riskIndex: 16,
    systemIntegrity: 100,
    cascadeRisk: false,
    vitals: { cityLoad: 26, activeUnits: 0, sensorUptime: 100, netLoad: 18 },
    vitalsVersion: 0,
    eventsVersion: 0,
    selectedId: null,
    trackedIds: [],
    overlays: { heatmap: false, traffic: false, power: false, fov: true, units: true },
    infra: emptyInfra(),
    camerasOnline: world.cameras.length,
    camerasTotal: world.cameras.length,
    detectionsPerMin: 0,
    incidentsActive: 0,
    cvOnline: false,
    cvSubjects: 0,
    terminalOpen: false,
    expandedCam: null,
    biometricRequest: 0,
    focusRequest: null,
    hotspots: [],
    analystNote: 'ALL SYSTEMS NOMINAL. AWAITING SENSOR MESH SYNCHRONIZATION.',
    threatBoard: [],
    linkUp: false,
    linkMode: 'sim',
    realTelemetry: {},

    setBooted: (b) => set({ booted: b }),
    setView: (v) => set({ view: v }),
    setMuted: (m) => set({ muted: m }),
    select: (id) => set({ selectedId: id }),
    setTracked: (id, on) => {
      const e = findEntity(id)
      if (e && e.kind === 'person') e.tracked = on
      set((s) => ({
        trackedIds: on ? [...new Set([...s.trackedIds, id])] : s.trackedIds.filter((t) => t !== id),
      }))
      send({ k: 'track', id, on })
      emit(on ? 'NOTICE' : 'INFO', 'COMMAND', `${on ? 'TRACK DESIGNATED' : 'TRACK RELEASED'} · ${id}`, undefined, id)
    },
    toggleOverlay: (k) => set((s) => ({ overlays: { ...s.overlays, [k]: !s.overlays[k] } })),
    setPower: (sector, on) => {
      set((s) => ({ infra: { ...s.infra, power: { ...s.infra.power, [sector]: on } } }))
      send({ k: 'power', sector, on })
      emit(on ? 'NOTICE' : 'WARN', 'INFRA', `${sector} POWER ${on ? 'RESTORED' : 'CUT — GRID DARK'}`, sector)
    },
    setTraffic: (sector, mode) => {
      set((s) => ({ infra: { ...s.infra, traffic: { ...s.infra.traffic, [sector]: mode } } }))
      send({ k: 'traffic', sector, mode })
      emit('NOTICE', 'INFRA', `${sector} TRAFFIC CONTROL → ${mode.replace('_', '-')}`, sector)
    },
    setTransit: (line, mode) => {
      set((s) => ({ infra: { ...s.infra, transit: { ...s.infra.transit, [line]: mode } } }))
      send({ k: 'transit', line, mode })
      emit('NOTICE', 'INFRA', `${line} ${mode === 'RUN' ? 'RESUMED' : 'HELD AT PLATFORM'}`)
    },
    setComms: (sector, on) => {
      set((s) => ({ infra: { ...s.infra, comms: { ...s.infra.comms, [sector]: on } } }))
      send({ k: 'comms', sector, on })
      emit(on ? 'NOTICE' : 'WARN', 'INFRA', `${sector} COMMS ${on ? 'ONLINE' : 'SUPPRESSED'}`, sector)
    },
    setBridge: (id, raised) => {
      set((s) => ({ infra: { ...s.infra, bridgesRaised: { ...s.infra.bridgesRaised, [id]: raised } } }))
      send({ k: 'bridge', id, raised })
      emit('NOTICE', 'INFRA', `${id} ${raised ? 'RAISED — SPAN OPEN' : 'LOWERED — SPAN CLOSED'}`)
    },
    autoRestore: () => {
      set({ infra: emptyInfra() })
      send({ k: 'autoRestore' })
      emit('NOTICE', 'INFRA', 'AUTO-RESTORE COMPLETE — ALL SYSTEMS NOMINAL')
    },
    spawnIncident: (sector) => {
      send({ k: 'spawn', sector })
      emit('NOTICE', 'COMMAND', `MANUAL INCIDENT INJECTION AUTHORIZED · ${sector ?? 'AUTO-SELECT SECTOR'}`, sector)
    },
    setDefconOverride: (level) => {
      set({ defconOverride: level })
      send({ k: 'defcon', level })
      emit('WARN', 'COMMAND', level ? `THREATCON OVERRIDE → DEFCON ${level}` : 'THREATCON OVERRIDE CLEARED')
    },
    reportCv: (online, subjects, _labels) => {
      const s = get()
      if (s.cvOnline !== online || s.cvSubjects !== subjects) {
        set({ cvOnline: online, cvSubjects: subjects })
        send({ k: 'cv', online, subjects })
      }
    },
    setTerminalOpen: (b) => set({ terminalOpen: b }),
    setExpandedCam: (id) => set({ expandedCam: id }),
    requestBiometric: () => set((s) => ({ biometricRequest: s.biometricRequest + 1, view: 'grid' })),
    locate: (id) => {
      if (!findEntity(id)) return false
      set((s) => ({ selectedId: id, view: 'map', focusRequest: { id, n: (s.focusRequest?.n ?? 0) + 1 } }))
      return true
    },
    emit,
  }
})

/* ── mirror application: hello (snapshot) + tick (delta) ───────────── */

let lastHotspotsRev = -1
let lastThreatRev = -1
let lastNoteRev = -1

function applyHello(h: HelloMsg): void {
  world.city = h.city
  world.tick = h.tick
  world.simMinutes = h.simMinutes
  world.night = nightAt(h.simMinutes)

  for (let i = 0; i < h.persons.length && i < world.persons.length; i++) {
    const p = world.persons[i]
    const s = h.persons[i]
    p.watchlisted = s.watchlisted
    p.riskScore = s.riskScore
  }
  for (let i = 0; i < h.patrols.length && i < world.patrols.length; i++) {
    world.patrols[i].callsign = h.patrols[i].callsign
  }
  for (let i = 0; i < h.cameras.length && i < world.cameras.length; i++) {
    const c = world.cameras[i]
    const s = h.cameras[i]
    c.label = s.label
    c.pos = { x: s.x, y: s.y }
    c.prevPos = { x: s.x, y: s.y }
    c.dir = s.dir
    c.fov = s.fov
    c.range = s.range
    c.sector = sectorOf(s.sector)
  }

  // seed histories + events from the snapshot
  for (const k of Object.keys(histories) as (keyof Histories)[]) {
    histories[k] = (h.histories[k] ?? []).slice(-HISTORY_LEN)
  }
  events.length = 0
  eventSeq = 1
  for (const we of h.recentEvents) ingestWireEvent(we)

  const d = h.derived
  lastHotspotsRev = d.hotspotsRev
  lastThreatRev = d.threatRev
  lastNoteRev = d.noteRev
  useSim.setState((s) => ({
    infra: h.infra,
    tick: h.tick,
    simMinutes: h.simMinutes,
    vitals: { ...d.vitals },
    riskIndex: d.riskIndex,
    defcon: d.defcon,
    systemIntegrity: d.systemIntegrity,
    cascadeRisk: d.cascadeRisk,
    detectionsPerMin: d.detectionsPerMin,
    incidentsActive: d.incidentsActive,
    camerasOnline: d.camerasOnline,
    camerasTotal: h.cameras.length,
    hotspots: d.hotspots,
    threatBoard: d.threatBoard,
    analystNote: d.analystNote,
    realTelemetry: d.realTelemetry ?? {},
    vitalsVersion: s.vitalsVersion + 1,
    eventsVersion: s.eventsVersion + 1,
  }))
}

function applyTick(t: TickMsg): void {
  const persons = world.persons
  for (let i = 0; i < persons.length; i++) {
    const p = persons[i]
    p.prevPos.x = p.pos.x
    p.prevPos.y = p.pos.y
    p.pos.x = t.personPos[i * 2]
    p.pos.y = t.personPos[i * 2 + 1]
    p.sector = sectorOf(t.personSector[i])
    const f = t.personFlags[i]
    p.status = f & PF_MOVING ? 'MOVING' : 'IDLE'
    p.tracked = (f & PF_TRACKED) !== 0
  }

  const vehicles = world.vehicles
  for (let i = 0; i < vehicles.length; i++) {
    const v = vehicles[i]
    v.prevPos.x = v.pos.x
    v.prevPos.y = v.pos.y
    v.pos.x = t.vehiclePos[i * 2]
    v.pos.y = t.vehiclePos[i * 2 + 1]
    v.sector = sectorOf(t.vehicleSector[i])
    const f = t.vehicleFlags[i]
    v.stalled = (f & VF_STALLED) !== 0
    v.parked = (f & VF_PARKED) !== 0
  }

  const patrols = world.patrols
  for (let i = 0; i < patrols.length; i++) {
    const u = patrols[i]
    u.prevPos.x = u.pos.x
    u.prevPos.y = u.pos.y
    u.pos.x = t.patrolPos[i * 2]
    u.pos.y = t.patrolPos[i * 2 + 1]
    u.sector = sectorOf(t.patrolSector[i])
    u.status = PATROL_STATUS[t.patrolStatus[i]] ?? 'PATROL'
    u.targetIncidentId = t.patrolTarget[i]
  }

  // incidents: authoritative full list each tick (small)
  world.incidents = t.incidents.map((inc) => ({
    id: inc.id,
    kind: 'incident' as const,
    pos: { x: inc.x, y: inc.y },
    prevPos: { x: inc.x, y: inc.y },
    sector: sectorOf(inc.sector),
    type: inc.type,
    phase: inc.phase,
    severity: inc.severity,
    spawnedTick: inc.spawnedTick,
    phaseTick: inc.phaseTick,
    assignedUnitId: inc.assignedUnitId,
  }))

  const cams = world.cameras
  for (let i = 0; i < cams.length; i++) {
    cams[i].online = t.cameraOnline[i]
    cams[i].detections = t.cameraDetections[i]
    cams[i].lastDetectionTick = t.cameraLastDetection[i]
  }

  for (let i = 0; i < t.congestion.length; i++) world.congestion[sectorOf(i)] = t.congestion[i]
  world.instability = t.instability
  world.tick = t.tick
  world.simMinutes = t.simMinutes
  world.night = nightAt(t.simMinutes)

  // client-side history append mirrors the host cadence
  if (t.tick % 5 === 0) {
    const d = t.derived
    pushHistory('cityLoad', d.vitals.cityLoad)
    pushHistory('netLoad', d.vitals.netLoad)
    pushHistory('sensorUptime', d.vitals.sensorUptime)
    pushHistory('activeUnits', d.vitals.activeUnits)
    pushHistory('riskIndex', d.riskIndex)
    pushHistory('incidentRate', d.incidentsActive)
    pushHistory('detectionsPerMin', d.detectionsPerMin)
  }

  for (const we of t.events) ingestWireEvent(we)

  const d = t.derived
  const patch: Partial<SimStore> = {
    tick: t.tick,
    simMinutes: t.simMinutes,
    vitals: { ...d.vitals },
    riskIndex: d.riskIndex,
    defcon: d.defcon,
    systemIntegrity: d.systemIntegrity,
    cascadeRisk: d.cascadeRisk,
    detectionsPerMin: d.detectionsPerMin,
    incidentsActive: d.incidentsActive,
    camerasOnline: d.camerasOnline,
  }
  if (t.tick % 5 === 0) {
    patch.vitalsVersion = useSim.getState().vitalsVersion + 1
    patch.realTelemetry = d.realTelemetry ?? {}
  }
  if (t.events.length > 0) patch.eventsVersion = useSim.getState().eventsVersion + 1
  if (t.infra) patch.infra = t.infra
  if (d.hotspotsRev !== lastHotspotsRev) {
    lastHotspotsRev = d.hotspotsRev
    patch.hotspots = d.hotspots
  }
  if (d.threatRev !== lastThreatRev) {
    lastThreatRev = d.threatRev
    patch.threatBoard = d.threatBoard
  }
  if (d.noteRev !== lastNoteRev) {
    lastNoteRev = d.noteRev
    patch.analystNote = d.analystNote
  }
  useSim.setState(patch)
}

const sink: SourceSink = {
  onHello: applyHello,
  onTick: applyTick,
  onLink: (up) => useSim.setState({ linkUp: up, linkMode: currentSource?.mode ?? 'sim' }),
}

/* ── start: attach a world source (worker / inline / remote) ───────── */

let started = false
let clientFeed: FeedHandle | null = null

export function startSimLoop(): void {
  if (started) return
  started = true
  const cfg = readConfig()
  currentSource = createSource(cfg)
  useSim.setState({ linkMode: currentSource.mode })
  currentSource.start(sink)

  // Phase 1: push real operator-node telemetry into whatever source is running
  clientFeed = startClientFeed((metrics) => currentSource?.command({ k: 'feed', metrics }))

  if (import.meta.hot) {
    import.meta.hot.dispose(() => {
      clientFeed?.stop()
      clientFeed = null
      currentSource?.dispose()
      currentSource = null
      started = false
    })
  }
}
