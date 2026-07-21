/**
 * PANOPTICON // OS — simulation type contract.
 *
 * Every module codes against these types. The whole world is fictional and
 * procedurally generated; every identity record carries `source: 'SIMULATED'`.
 */

export interface Vec2 {
  x: number
  y: number
}

/** "SECTOR-1" .. "SECTOR-9" */
export type SectorId = string

export type ViewId = 'map' | 'grid' | 'graph' | 'infra' | 'ops'

/* ── entities ──────────────────────────────────────────────────────── */

export type EntityKind = 'person' | 'vehicle' | 'patrol' | 'incident' | 'camera'

export interface EntityBase {
  id: string
  kind: EntityKind
  /** position at the current logic tick (world units) */
  pos: Vec2
  /** position at the previous logic tick — renderers interpolate pos↔prevPos */
  prevPos: Vec2
  sector: SectorId
}

export interface Person extends EntityBase {
  kind: 'person'
  status: 'IDLE' | 'MOVING'
  /** amber-diamond person of interest */
  watchlisted: boolean
  tracked: boolean
  riskScore: number
  nodeIdx: number
  targetIdx: number
  path: number[]
  pathPos: number
  speed: number
}

export interface Vehicle extends EntityBase {
  kind: 'vehicle'
  nodeIdx: number
  targetIdx: number
  path: number[]
  pathPos: number
  speed: number
  /** true when stuck by traffic controls / blackout */
  stalled: boolean
}

export interface PatrolUnit extends EntityBase {
  kind: 'patrol'
  callsign: string
  status: 'PATROL' | 'RESPONDING' | 'ON_SCENE'
  targetIncidentId: string | null
  nodeIdx: number
  targetIdx: number
  path: number[]
  pathPos: number
  speed: number
}

export type IncidentPhase = 'SPAWNED' | 'ESCALATING' | 'RESPONDING' | 'RESOLVED'

export type IncidentType =
  | 'DISTURBANCE'
  | 'INTRUSION'
  | 'SIGNAL ANOMALY'
  | 'GRID FAULT'
  | 'PURSUIT'
  | 'STRUCTURE FIRE'
  | 'CROWD FORMATION'

export interface Incident extends EntityBase {
  kind: 'incident'
  type: IncidentType
  phase: IncidentPhase
  severity: 1 | 2 | 3 | 4 | 5
  spawnedTick: number
  /** tick at which the current phase began */
  phaseTick: number
  assignedUnitId: string | null
}

export interface Camera extends EntityBase {
  kind: 'camera'
  /** facing, radians */
  dir: number
  /** field-of-view half-angle, radians */
  fov: number
  range: number
  online: boolean
  lastDetectionTick: number
  detections: number
  label: string
}

export type SimEntity = Person | Vehicle | PatrolUnit | Incident | Camera

/* ── city ──────────────────────────────────────────────────────────── */

export interface District {
  id: SectorId
  name: string
  center: Vec2
  polygon: Vec2[]
  /** 0..1 baseline incident propensity */
  baseRisk: number
  /** 0..1 traffic/person density weighting */
  density: number
}

export interface RoadNode {
  id: number
  pos: Vec2
  neighbors: number[]
}

export interface RoadSegment {
  a: number
  b: number
  major: boolean
  /** segment crosses water via this bridge (id) — impassable when raised */
  bridgeId?: string
}

export interface CityBlock {
  poly: Vec2[]
  sector: SectorId
  /** 0..1 fill shade variation */
  shade: number
}

export interface Landmark {
  name: string
  pos: Vec2
  glyph: 'port' | 'plaza' | 'tower' | 'yard' | 'terminal' | 'exchange'
}

export interface BridgeInfo {
  id: string
  name: string
  pos: Vec2
  /** road segment index it carries */
  segmentIdx: number
}

export interface City {
  seed: number
  /** world extent, units */
  size: Vec2
  districts: District[]
  nodes: RoadNode[]
  segments: RoadSegment[]
  /** polygons of water (harbor + river) */
  water: Vec2[][]
  blocks: CityBlock[]
  landmarks: Landmark[]
  bridges: BridgeInfo[]
}

/* ── infrastructure ────────────────────────────────────────────────── */

export type TrafficMode = 'NORMAL' | 'FORCE_GREEN' | 'FORCE_RED' | 'BLACKOUT'
export type TransitMode = 'RUN' | 'HOLD'

export interface InfraState {
  power: Record<SectorId, boolean>
  traffic: Record<SectorId, TrafficMode>
  transit: Record<string, TransitMode>
  comms: Record<SectorId, boolean>
  water: Record<SectorId, 'NOMINAL' | 'REDUCED'>
  bridgesRaised: Record<string, boolean>
}

/* ── events ────────────────────────────────────────────────────────── */

export type Severity = 'INFO' | 'NOTICE' | 'WARN' | 'CRIT'

export type EventChannel =
  | 'SYSTEM'
  | 'INCIDENT'
  | 'DETECTION'
  | 'INFRA'
  | 'UNIT'
  | 'COMMAND'
  | 'CV'
  | 'PREDICT'
  | 'FEED'

export interface SimEvent {
  id: number
  tick: number
  /** sim clock, minutes since day 0 00:00 */
  simMinutes: number
  /** wall-clock ms at emit (for relative display only) */
  wall: number
  severity: Severity
  channel: EventChannel
  sector?: SectorId
  entityId?: string
  message: string
}

/* ── identity / link analysis (all fictional) ──────────────────────── */

export type NodeType = 'person' | 'phone' | 'vehicle' | 'account' | 'location'

export interface GraphNode {
  id: string
  type: NodeType
  label: string
  sub?: string
  risk?: number
}

export type EdgeType = 'ASSOCIATE' | 'CO-LOCATED' | 'CALLED' | 'OWNS' | 'TRANSACTED'

export interface GraphEdge {
  id: string
  source: string
  target: string
  type: EdgeType
  weight: number
}

export interface LinkNetwork {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

export interface TimelineEntry {
  simMinutes: number
  label: string
  sector: SectorId
}

export interface Dossier {
  id: string
  name: string
  alias: string
  dob: string
  risk: number
  status: 'NOMINAL' | 'WATCH' | 'FLAGGED'
  lastSeenSector: SectorId
  devices: string[]
  flags: string[]
  timeline: TimelineEntry[]
  /** always present, always 'SIMULATED' — rendered wherever identities appear */
  source: 'SIMULATED'
}

/* ── real-data feed (Phase 1: the first real signals into the world) ── */

/** A snapshot of real telemetry from an operator node (browser) or the host
 *  machine (server). All values are genuine, sampled locally, never invented.
 *  `source` distinguishes the operator's browser from the server host. */
export interface RealMetrics {
  source: 'client' | 'host'
  label: string
  /** real CPU utilisation %, 0..100 (host: system load; client: derived proxy) */
  cpuPct?: number
  /** real memory utilisation %, 0..100 */
  memPct?: number
  /** real network throughput, KB/s */
  netKBps?: number
  /** real round-trip / connection latency, ms */
  rttMs?: number
  /** real render frame rate (client) */
  fps?: number
  /** logical CPU cores */
  cores?: number
  /** device memory, GB (client: navigator.deviceMemory; host: total RAM) */
  deviceMemGB?: number
  /** network reachability */
  online?: boolean
  /** wall-clock ms of the sample */
  ts: number
}

/** Latest real telemetry by origin; both present in remote mode. */
export interface RealTelemetry {
  client?: RealMetrics
  host?: RealMetrics
}

/* ── analytics ─────────────────────────────────────────────────────── */

export interface Vitals {
  /** aggregate "CPU of the city", % */
  cityLoad: number
  activeUnits: number
  /** % of cameras online */
  sensorUptime: number
  /** network load, % */
  netLoad: number
}

export interface HotspotForecast {
  sector: SectorId
  probability: number
  confidence: number
  driver: string
}

export interface ThreatEntry {
  id: string
  name: string
  risk: number
  sector: SectorId
  flags: number
  tracked: boolean
}

/** rolling series for charts; fixed-length ring buffers, newest last */
export interface Histories {
  riskIndex: number[]
  incidentRate: number[]
  detectionsPerMin: number[]
  netLoad: number[]
  activeUnits: number[]
  sensorUptime: number[]
  cityLoad: number[]
}

/* ── world (non-reactive, mutated in place at tick rate) ───────────── */

export interface World {
  city: City
  persons: Person[]
  vehicles: Vehicle[]
  patrols: PatrolUnit[]
  incidents: Incident[]
  cameras: Camera[]
  /** per-sector road congestion 0..1 */
  congestion: Record<SectorId, number>
  /** 0..1 operator-caused destabilization */
  instability: number
  /** sim minutes since day 0 00:00 */
  simMinutes: number
  /** 0..1 darkness factor from day/night cycle (0 = noon, 1 = deep night) */
  night: number
  tick: number
}

export interface Overlays {
  heatmap: boolean
  traffic: boolean
  power: boolean
  fov: boolean
  units: boolean
}

/* ── store ─────────────────────────────────────────────────────────── */

export interface SimStore {
  booted: boolean
  view: ViewId
  muted: boolean
  tick: number
  simMinutes: number
  defcon: 1 | 2 | 3 | 4 | 5
  defconOverride: number | null
  riskIndex: number
  /** 0-100, 100 = fully nominal */
  systemIntegrity: number
  cascadeRisk: boolean
  vitals: Vitals
  /** bumped whenever history ring buffers mutate (subscribe for imperative reads) */
  vitalsVersion: number
  /** bumped whenever the event log gains entries */
  eventsVersion: number
  selectedId: string | null
  trackedIds: string[]
  overlays: Overlays
  infra: InfraState
  camerasOnline: number
  camerasTotal: number
  detectionsPerMin: number
  incidentsActive: number
  /** webcam CV pipeline state */
  cvOnline: boolean
  cvSubjects: number
  terminalOpen: boolean
  expandedCam: string | null
  /** increment = request surveillance module to enter biometric mode */
  biometricRequest: number
  /** map focus request; n increments each time */
  focusRequest: { id: string; n: number } | null
  hotspots: HotspotForecast[]
  analystNote: string
  threatBoard: ThreatEntry[]
  /** realtime link state (Phase 0 client/server split): is the world source connected */
  linkUp: boolean
  /** where the authoritative world runs: 'sim' = local worker/inline, 'remote' = node server */
  linkMode: 'sim' | 'remote'
  /** Phase 1 real-data feed: latest genuine telemetry overlaid onto the world */
  realTelemetry: RealTelemetry

  setBooted(b: boolean): void
  setView(v: ViewId): void
  setMuted(m: boolean): void
  select(id: string | null): void
  setTracked(id: string, on: boolean): void
  toggleOverlay(k: keyof Overlays): void
  setPower(sector: SectorId, on: boolean): void
  setTraffic(sector: SectorId, mode: TrafficMode): void
  setTransit(line: string, mode: TransitMode): void
  setComms(sector: SectorId, on: boolean): void
  setBridge(id: string, raised: boolean): void
  autoRestore(): void
  spawnIncident(sector?: SectorId): void
  setDefconOverride(level: number | null): void
  reportCv(online: boolean, subjects: number, labels: string[]): void
  setTerminalOpen(b: boolean): void
  setExpandedCam(id: string | null): void
  requestBiometric(): void
  /** select + ask tactical map to fly to entity; false if unknown id */
  locate(id: string): boolean
  emit(severity: Severity, channel: EventChannel, message: string, sector?: SectorId, entityId?: string): void
}

/* ── engine extensions (ADDITIVE ONLY — declaration merging) ───────── */

/** Static camera placement produced by cityGen; entities.ts instantiates Camera entities from these. */
export interface CameraSpec {
  id: string
  pos: Vec2
  sector: SectorId
  /** facing, radians */
  dir: number
  /** field-of-view half-angle, radians */
  fov: number
  range: number
  label: string
}

export interface City {
  /** 24 camera placements (CAM-02..CAM-25); CAM-01 is the operator webcam */
  cameras?: CameraSpec[]
  /** sector of each road node (parallel to `nodes`) — cheap live sector attribution */
  nodeSectors?: SectorId[]
}

export interface Person {
  /** home-anchor road node — wander bias target */
  homeNode?: number
  /** ticks remaining before the next destination is chosen */
  dwell?: number
}

export interface Vehicle {
  /** stable 0..1 activity key — vehicles whose key exceeds the day-cycle activity level park */
  actKey?: number
  /** parked (off-shift): skips movement, excluded from congestion counts */
  parked?: boolean
}

export interface Incident {
  /** nearest road node — patrol dispatch target */
  nodeIdx?: number
  /** ticks the SPAWNED phase lasts / on-scene ticks until resolution */
  phaseDur?: number
  /** next tick at which severity may escalate */
  nextEscalateTick?: number
  /** next tick at which a dispatch attempt is allowed */
  dispatchAtTick?: number
  /** tick the assigned unit arrived on scene (undefined until arrival) */
  onSceneTick?: number
}
