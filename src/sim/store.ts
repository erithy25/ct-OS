/**
 * Zustand simulation store — REAL ENGINE.
 *
 * The exported surface — `useSim`, `getWorld`, `getEvents`, `getHistories`,
 * `findEntity`, `HISTORY_LEN`, `SECTORS`, `startSimLoop` — is the stable
 * contract all modules code against.
 *
 * Discipline: the reactive store holds scalars (and small snapshot objects)
 * only; entity arrays live in the non-reactive `world` singleton and are
 * mutated in place at 10 Hz. Renderers read `getWorld()` imperatively and
 * interpolate pos↔prevPos.
 */
import { create } from 'zustand'
import type { Histories, InfraState, SectorId, SimEntity, SimEvent, SimStore, World } from './types'
import { emitEvent, onEvent } from './events'
import { advanceWorld, createWorld, type WorldInputs } from './world'
import { DEFAULT_SEED } from './cityGen'

/** `?boot=skip` jumps straight to the cockpit (dev / automation nicety). */
const skipBoot = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('boot') === 'skip'

export const HISTORY_LEN = 150

export const SECTORS: SectorId[] = Array.from({ length: 9 }, (_, i) => `SECTOR-${i + 1}`)

/** world seed — surfaced in the LeftRail badge (SEED 0x2F7A) */
export const SIM_SEED = DEFAULT_SEED

/* ── non-reactive singletons (read imperatively from render loops) ─── */

const world: World = createWorld(SIM_SEED)

const inputs: WorldInputs = {
  manualSpawns: [],
  cvOnline: false,
  cvSubjects: 0,
  defconOverride: null,
}

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

/* ── store ─────────────────────────────────────────────────────────── */

export const useSim = create<SimStore>((set, get) => {
  const emit: SimStore['emit'] = (severity, channel, message, sector, entityId) =>
    emitEvent(severity, channel, message, sector, entityId)

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
      emit(on ? 'NOTICE' : 'INFO', 'COMMAND', `${on ? 'TRACK DESIGNATED' : 'TRACK RELEASED'} · ${id}`, undefined, id)
    },
    toggleOverlay: (k) => set((s) => ({ overlays: { ...s.overlays, [k]: !s.overlays[k] } })),
    setPower: (sector, on) => {
      set((s) => ({ infra: { ...s.infra, power: { ...s.infra.power, [sector]: on } } }))
      emit(on ? 'NOTICE' : 'WARN', 'INFRA', `${sector} POWER ${on ? 'RESTORED' : 'CUT — GRID DARK'}`, sector)
    },
    setTraffic: (sector, mode) => {
      set((s) => ({ infra: { ...s.infra, traffic: { ...s.infra.traffic, [sector]: mode } } }))
      emit('NOTICE', 'INFRA', `${sector} TRAFFIC CONTROL → ${mode.replace('_', '-')}`, sector)
    },
    setTransit: (line, mode) => {
      set((s) => ({ infra: { ...s.infra, transit: { ...s.infra.transit, [line]: mode } } }))
      emit('NOTICE', 'INFRA', `${line} ${mode === 'RUN' ? 'RESUMED' : 'HELD AT PLATFORM'}`)
    },
    setComms: (sector, on) => {
      set((s) => ({ infra: { ...s.infra, comms: { ...s.infra.comms, [sector]: on } } }))
      emit(on ? 'NOTICE' : 'WARN', 'INFRA', `${sector} COMMS ${on ? 'ONLINE' : 'SUPPRESSED'}`, sector)
    },
    setBridge: (id, raised) => {
      set((s) => ({ infra: { ...s.infra, bridgesRaised: { ...s.infra.bridgesRaised, [id]: raised } } }))
      emit('NOTICE', 'INFRA', `${id} ${raised ? 'RAISED — SPAN OPEN' : 'LOWERED — SPAN CLOSED'}`)
    },
    autoRestore: () => {
      set({ infra: emptyInfra() })
      emit('NOTICE', 'INFRA', 'AUTO-RESTORE COMPLETE — ALL SYSTEMS NOMINAL')
    },
    spawnIncident: (sector) => {
      inputs.manualSpawns.push(sector)
      emit('NOTICE', 'COMMAND', `MANUAL INCIDENT INJECTION AUTHORIZED · ${sector ?? 'AUTO-SELECT SECTOR'}`, sector)
    },
    setDefconOverride: (level) => {
      inputs.defconOverride = level
      set({ defconOverride: level })
      emit('WARN', 'COMMAND', level ? `THREATCON OVERRIDE → DEFCON ${level}` : 'THREATCON OVERRIDE CLEARED')
    },
    reportCv: (online, subjects, _labels) => {
      inputs.cvOnline = online
      inputs.cvSubjects = subjects
      const s = get()
      if (s.cvOnline !== online || s.cvSubjects !== subjects) set({ cvOnline: online, cvSubjects: subjects })
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

/* event bus → ring buffer (cap 500) + eventsVersion bump */
const offEvent = onEvent((severity, channel, message, sector, entityId) => {
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
})

/* ── 10 Hz sim loop ────────────────────────────────────────────────── */

let loopStarted = false
let lastHotspotsRev = 0
let lastThreatRev = 0
let lastNoteRev = 0

export function startSimLoop(): void {
  if (loopStarted) return
  loopStarted = true

  const boot = useSim.getState()
  boot.emit('INFO', 'SYSTEM', 'PANOPTICON CORE ONLINE — NOVA HARBOR MESH SYNCHRONIZED')
  boot.emit(
    'INFO',
    'SYSTEM',
    `ROAD GRAPH ${world.city.nodes.length} NODES · ${world.city.segments.length} SEGMENTS · ${world.cameras.length} SENSORS · ${world.persons.length + world.vehicles.length + world.patrols.length} TRACKS`,
  )

  const id = setInterval(() => {
    const s = useSim.getState()
    inputs.defconOverride = s.defconOverride
    const d = advanceWorld(world, s.infra, inputs)

    const patch: Partial<SimStore> = {
      tick: world.tick,
      simMinutes: world.simMinutes,
      vitals: { ...d.vitals },
      riskIndex: d.riskIndex,
      defcon: d.defcon,
      systemIntegrity: d.systemIntegrity,
      cascadeRisk: d.cascadeRisk,
      detectionsPerMin: d.detectionsPerMin,
      incidentsActive: d.incidentsActive,
      camerasOnline: d.camerasOnline,
    }

    if (world.tick % 5 === 0) {
      pushHistory('cityLoad', d.vitals.cityLoad)
      pushHistory('netLoad', d.vitals.netLoad)
      pushHistory('sensorUptime', d.vitals.sensorUptime)
      pushHistory('activeUnits', d.vitals.activeUnits)
      pushHistory('riskIndex', d.riskIndex)
      pushHistory('incidentRate', d.incidentsActive)
      pushHistory('detectionsPerMin', d.detectionsPerMin)
      patch.vitalsVersion = s.vitalsVersion + 1
    }
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
  }, 100)

  if (import.meta.hot) {
    import.meta.hot.dispose(() => {
      clearInterval(id)
      loopStarted = false
    })
  }
}

/* HMR: drop this module instance's bus subscription so a reloaded store
   doesn't leave a stale sink pushing into a dead ring buffer. */
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    offEvent()
  })
}
