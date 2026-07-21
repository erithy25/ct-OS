/**
 * PHASE 0 — realtime wire protocol.
 *
 * ONE protocol, three transports:
 *   · SimSource(worker)  — EngineHost inside a Web Worker, postMessage
 *   · SimSource(inline)  — EngineHost on the main thread (tests, single-file build)
 *   · RemoteSource       — EngineHost inside the node server, WebSocket JSON
 *
 * Every type here MUST stay JSON-safe (no typed arrays, Maps, Dates, class
 * instances) so the exact same messages flow over postMessage and WS.
 *
 * The producer (EngineHost) owns the authoritative World + InfraState +
 * WorldInputs. The client keeps a mirror World (the store singleton) that is
 * mutated only by applyHello/applyTick. Client-side store actions do an
 * optimistic reactive update + local event echo, then forward the command to
 * the producer, whose next TickMsg is authoritative.
 */
import type {
  City,
  HotspotForecast,
  Histories,
  InfraState,
  IncidentPhase,
  IncidentType,
  SectorId,
  Severity,
  EventChannel,
  ThreatEntry,
  TrafficMode,
  TransitMode,
  Vitals,
} from '../sim/types'

/* ── constants ─────────────────────────────────────────────────────── */

export const PROTOCOL_VERSION = 1
export const DEFAULT_WS_PORT = 8787
export const DEFAULT_WS_PATH = '/ws'
export const DEFAULT_WS_URL = `ws://127.0.0.1:${DEFAULT_WS_PORT}${DEFAULT_WS_PATH}`
/** positions are rounded to this many decimals on the wire */
export const POS_DECIMALS = 2

/* ── events on the wire (producer-stamped, client assigns local ids) ── */

export interface WireEvent {
  tick: number
  simMinutes: number
  wall: number
  severity: Severity
  channel: EventChannel
  sector?: SectorId
  entityId?: string
  message: string
}

/* ── static entity snapshots (sent once in hello) ──────────────────── */

export interface PersonStatic {
  id: string
  watchlisted: boolean
  riskScore: number
}

export interface VehicleStatic {
  id: string
}

export interface PatrolStatic {
  id: string
  callsign: string
}

export interface CameraStatic {
  id: string
  label: string
  x: number
  y: number
  dir: number
  fov: number
  range: number
  /** district index 0..8 */
  sector: number
}

/* ── per-tick dynamic state ────────────────────────────────────────── */

/** person flag bits */
export const PF_MOVING = 1
export const PF_TRACKED = 2
/** vehicle flag bits */
export const VF_STALLED = 1
export const VF_PARKED = 2

export interface IncidentWire {
  id: string
  type: IncidentType
  phase: IncidentPhase
  severity: 1 | 2 | 3 | 4 | 5
  x: number
  y: number
  /** district index 0..8 */
  sector: number
  spawnedTick: number
  phaseTick: number
  assignedUnitId: string | null
}

/** WorldDerived, wire-shaped (identical fields; JSON-safe already) */
export interface DerivedWire {
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
  hotspotsRev: number
  threatRev: number
  noteRev: number
}

/* ── messages: producer → client ───────────────────────────────────── */

export interface HelloMsg {
  t: 'hello'
  v: number
  seed: number
  tick: number
  simMinutes: number
  city: City
  persons: PersonStatic[]
  vehicles: VehicleStatic[]
  patrols: PatrolStatic[]
  cameras: CameraStatic[]
  infra: InfraState
  /** rolling series to seed the client charts (server: persisted across restarts) */
  histories: Histories
  /** recent ring-buffer tail to seed the alert feed / event log */
  recentEvents: WireEvent[]
  derived: DerivedWire
}

export interface TickMsg {
  t: 'tick'
  tick: number
  simMinutes: number
  /** interleaved [x0,y0,x1,y1,…] in hello order, POS_DECIMALS-rounded */
  personPos: number[]
  vehiclePos: number[]
  patrolPos: number[]
  /** district index 0..8 per entity, hello order */
  personSector: number[]
  vehicleSector: number[]
  patrolSector: number[]
  /** PF_* / VF_* bitmasks per entity, hello order */
  personFlags: number[]
  vehicleFlags: number[]
  /** 0=PATROL 1=RESPONDING 2=ON_SCENE, hello order */
  patrolStatus: number[]
  /** incident id or null per patrol, hello order */
  patrolTarget: (string | null)[]
  /** full authoritative incident list (small) */
  incidents: IncidentWire[]
  cameraOnline: boolean[]
  cameraDetections: number[]
  cameraLastDetection: number[]
  /** per-sector congestion 0..1, index 0..8 */
  congestion: number[]
  instability: number
  derived: DerivedWire
  /** events emitted by the engine during this tick */
  events: WireEvent[]
  /** present only on ticks where a command changed infra state (ack) */
  infra?: InfraState
}

export type ServerMsg = HelloMsg | TickMsg

/* ── messages: client → producer ───────────────────────────────────── */

export type SourceCommand =
  | { k: 'power'; sector: SectorId; on: boolean }
  | { k: 'traffic'; sector: SectorId; mode: TrafficMode }
  | { k: 'transit'; line: string; mode: TransitMode }
  | { k: 'bridge'; id: string; raised: boolean }
  | { k: 'comms'; sector: SectorId; on: boolean }
  | { k: 'autoRestore' }
  | { k: 'spawn'; sector?: SectorId }
  | { k: 'defcon'; level: number | null }
  | { k: 'track'; id: string; on: boolean }
  | { k: 'cv'; online: boolean; subjects: number }

export interface CommandMsg {
  t: 'cmd'
  v: number
  cmd: SourceCommand
}

export type ClientMsg = CommandMsg

/* ── type guards (hand-rolled; zod validation lives server-side) ───── */

export function isServerMsg(x: unknown): x is ServerMsg {
  return typeof x === 'object' && x !== null && ((x as { t?: string }).t === 'hello' || (x as { t?: string }).t === 'tick')
}

export function isCommandMsg(x: unknown): x is CommandMsg {
  return typeof x === 'object' && x !== null && (x as { t?: string }).t === 'cmd' && typeof (x as { cmd?: unknown }).cmd === 'object'
}

/* ── the source abstraction the store runs on ──────────────────────── */

export type SourceMode = 'sim' | 'remote'

export interface SourceSink {
  onHello(h: HelloMsg): void
  onTick(t: TickMsg): void
  /** link state changes (remote: WS up/down; sim: up once started) */
  onLink(up: boolean, detail?: string): void
}

export interface WorldSource {
  readonly mode: SourceMode
  start(sink: SourceSink): void
  command(cmd: SourceCommand): void
  dispose(): void
}

/**
 * EngineHost — the ONE authoritative world owner, used by all three
 * transports (worker / inline / node server). Implemented in
 * `src/realtime/engineHost.ts`; browser-API-free so node can import it.
 *
 *   new EngineHost(seed?, { seedHistories?, seedEvents? })
 *     .hello(): HelloMsg          — full snapshot for a (re)connecting client
 *     .tick(): TickMsg            — advance one 100ms step, collect events
 *     .command(cmd): void         — apply a SourceCommand to authoritative state
 *     .world: World               — the authoritative world (read-only use)
 *     .infra: InfraState          — authoritative infra (read-only use)
 *     .dispose(): void            — release the events-bus subscription
 */
export interface EngineHostApi {
  readonly world: import('../sim/types').World
  readonly infra: InfraState
  hello(): HelloMsg
  tick(): TickMsg
  command(cmd: SourceCommand): void
  dispose(): void
}

export interface EngineHostOpts {
  seedHistories?: Histories
  seedEvents?: WireEvent[]
}
