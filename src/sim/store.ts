/**
 * Zustand simulation store — STUB IMPLEMENTATION.
 *
 * Keeps the cockpit shell alive with plausible motion until the full engine
 * (cityGen / entities / world tick) replaces the internals of this file.
 * The exported surface — `useSim`, `getWorld`, `getEvents`, `getHistories`,
 * `HISTORY_LEN` — is the stable contract all modules code against.
 */

import { create } from 'zustand'
import type { Histories, InfraState, SectorId, SimEntity, SimEvent, SimStore, World } from './types'

/** `?boot=skip` jumps straight to the cockpit (dev / automation nicety). */
const skipBoot = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('boot') === 'skip'

export const HISTORY_LEN = 150

export const SECTORS: SectorId[] = Array.from({ length: 9 }, (_, i) => `SECTOR-${i + 1}`)

const emptyInfra = (): InfraState => ({
  power: Object.fromEntries(SECTORS.map((s) => [s, true])),
  traffic: Object.fromEntries(SECTORS.map((s) => [s, 'NORMAL' as const])),
  transit: { 'METRO-A': 'RUN', 'METRO-B': 'RUN', 'METRO-C': 'RUN' },
  comms: Object.fromEntries(SECTORS.map((s) => [s, true])),
  water: Object.fromEntries(SECTORS.map((s) => [s, 'NOMINAL' as const])),
  bridgesRaised: {},
})

/* ── non-reactive stores (read imperatively from render loops) ─────── */

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

const world: World = {
  city: { seed: 0, size: { x: 1600, y: 1000 }, districts: [], nodes: [], segments: [], water: [], blocks: [], landmarks: [], bridges: [] },
  persons: [],
  vehicles: [],
  patrols: [],
  incidents: [],
  cameras: [],
  congestion: Object.fromEntries(SECTORS.map((s) => [s, 0.2])),
  instability: 0,
  simMinutes: 7 * 60,
  night: 0.2,
  tick: 0,
}

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
  const emit: SimStore['emit'] = (severity, channel, message, sector, entityId) => {
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
    set((s) => ({ eventsVersion: s.eventsVersion + 1 }))
  }

  return {
    booted: skipBoot,
    view: 'map',
    muted: false,
    tick: 0,
    simMinutes: world.simMinutes,
    defcon: 5,
    defconOverride: null,
    riskIndex: 24,
    systemIntegrity: 100,
    cascadeRisk: false,
    vitals: { cityLoad: 31, activeUnits: 12, sensorUptime: 99.2, netLoad: 22 },
    vitalsVersion: 0,
    eventsVersion: 0,
    selectedId: null,
    trackedIds: [],
    overlays: { heatmap: false, traffic: false, power: false, fov: true, units: true },
    infra: emptyInfra(),
    camerasOnline: 24,
    camerasTotal: 24,
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
    setTracked: (id, on) =>
      set((s) => ({
        trackedIds: on ? [...new Set([...s.trackedIds, id])] : s.trackedIds.filter((t) => t !== id),
      })),
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
      emit('WARN', 'INCIDENT', `MANUAL INCIDENT INJECTED ${sector ?? ''}`.trim(), sector)
    },
    setDefconOverride: (level) => {
      set({ defconOverride: level })
      emit('WARN', 'COMMAND', level ? `THREATCON OVERRIDE → DEFCON ${level}` : 'THREATCON OVERRIDE CLEARED')
    },
    reportCv: (online, subjects, _labels) => set({ cvOnline: online, cvSubjects: subjects }),
    setTerminalOpen: (b) => set({ terminalOpen: b }),
    setExpandedCam: (id) => set({ expandedCam: id }),
    requestBiometric: () => set((s) => ({ biometricRequest: s.biometricRequest + 1, view: 'grid' })),
    locate: (id) => {
      set((s) => ({ selectedId: id, view: 'map', focusRequest: { id, n: (s.focusRequest?.n ?? 0) + 1 } }))
      return true
    },
    emit,
  }
})

/* ── stub tick loop (replaced by the real world tick) ──────────────── */

const SYSTEM_CHATTER = [
  'SENSOR MESH SYNC COMPLETE',
  'UPLINK STABLE // 99.97%',
  'PERIMETER SWEEP NOMINAL',
  'ARCHIVE COMPACTION FINISHED',
  'NODE HEALTH CHECK PASSED 24/24',
  'CLOCK DRIFT +0.0021s CORRECTED',
]

let loopStarted = false
export function startSimLoop(): void {
  if (loopStarted) return
  loopStarted = true

  const s = useSim.getState()
  s.emit('INFO', 'SYSTEM', 'PANOPTICON CORE ONLINE — STUB WORLD (ENGINE PENDING)')

  let chatterIn = 30
  const id = setInterval(() => {
    world.tick += 1
    world.simMinutes += 1 / 6 // 10× time compression at 10Hz
    world.night = 0.5 + 0.5 * Math.cos(((world.simMinutes % 1440) / 1440) * Math.PI * 2)

    const st = useSim.getState()
    const v = st.vitals
    const wander = (x: number, amt: number, lo: number, hi: number) =>
      Math.min(hi, Math.max(lo, x + (Math.random() - 0.5) * amt))

    const vitals = {
      cityLoad: wander(v.cityLoad, 3, 18, 78),
      activeUnits: 12,
      sensorUptime: wander(v.sensorUptime, 0.15, 97.5, 100),
      netLoad: wander(v.netLoad, 4, 10, 88),
    }
    const riskIndex = wander(st.riskIndex, 1.2, 12, 46)

    if (world.tick % 5 === 0) {
      pushHistory('cityLoad', vitals.cityLoad)
      pushHistory('netLoad', vitals.netLoad)
      pushHistory('sensorUptime', vitals.sensorUptime)
      pushHistory('activeUnits', vitals.activeUnits)
      pushHistory('riskIndex', riskIndex)
      pushHistory('incidentRate', 0)
      pushHistory('detectionsPerMin', st.detectionsPerMin)
      useSim.setState((p) => ({ vitalsVersion: p.vitalsVersion + 1 }))
    }

    if (--chatterIn <= 0) {
      chatterIn = 40 + Math.floor(Math.random() * 80)
      st.emit('INFO', 'SYSTEM', SYSTEM_CHATTER[Math.floor(Math.random() * SYSTEM_CHATTER.length)])
    }

    const derived = riskIndex > 62 ? 3 : riskIndex > 38 ? 4 : 5
    const defcon = (st.defconOverride ?? derived) as SimStore['defcon']

    useSim.setState({
      tick: world.tick,
      simMinutes: world.simMinutes,
      vitals,
      riskIndex,
      defcon,
    })
  }, 100)

  if (import.meta.hot) {
    import.meta.hot.dispose(() => {
      clearInterval(id)
      loopStarted = false
    })
  }
}
