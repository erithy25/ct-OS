/**
 * PANOPTICON // HOMEWATCH — client domain types.
 *
 * A private, local home-awareness system: your real cameras + Mac webcam, with
 * on-device detection, property zones, household face enrollment (consented),
 * activity timelines and alerts. Everything runs locally; nothing is uploaded.
 *
 * Honesty & safety baked in: people are classified KNOWN (enrolled household,
 * with consent) vs UNKNOWN — never judged as "criminal". Real map/data is
 * observe-only. Control is limited to your own devices.
 */
import type { CameraInfo } from '../realworld/contract'

export type HomeView = 'wall' | 'people' | 'zones' | 'activity' | 'alerts' | 'brain'

export type HomeSeverity = 'INFO' | 'NOTICE' | 'WARN' | 'CRIT'

export type HomeEventKind =
  | 'SYSTEM'
  | 'CAMERA'
  | 'DETECTION'
  | 'PERSON'
  | 'ZONE'
  | 'ACTIVITY'
  | 'ALERT'

export interface HomeEvent {
  id: number
  ts: number
  severity: HomeSeverity
  kind: HomeEventKind
  cameraId?: string
  personId?: string
  message: string
  /** optional jpeg data-url snapshot captured at the moment (client-side) */
  snapshot?: string
}

/** Overall home posture, derived from live alerts. */
export type HomeStatus = 'SECURE' | 'MONITOR' | 'ELEVATED' | 'ALERT'

/** A detected object on a camera (on-device CV). */
export type DetClass = 'person' | 'vehicle' | 'animal' | 'package' | 'other'

export interface Detection {
  cameraId: string
  cls: DetClass
  label: string
  score: number
  /** normalized 0..1 box [x, y, w, h] */
  box: [number, number, number, number]
  /** matched household person id, or null if unknown/none */
  personId: string | null
  ts: number
}

/** An enrolled household member (consented; face descriptor stored locally). */
export interface Person {
  id: string
  name: string
  role: 'HOUSEHOLD' | 'GUEST'
  /** face embedding(s) — local only, never uploaded */
  descriptors: number[][]
  color: string
  addedAt: number
  /** presence */
  present: boolean
  lastSeen?: number
  lastCameraId?: string
}

/* ── tracked boxes (precision overlay) ─────────────────────────────── */

/** Identity resolution of a tracked PERSON box. `pending` = face not yet read. */
export type TrackIdentity = 'pending' | 'known' | 'unknown'

/**
 * A detector box with temporal identity: stable trackId across frames, a
 * velocity estimate for zero-lag prediction, and a KNOWN/UNKNOWN resolution
 * fused from the on-device face engine. Lives in a non-reactive store map —
 * the overlay reads it every animation frame.
 */
export interface TrackedBox {
  trackId: number
  cameraId: string
  cls: DetClass
  label: string
  score: number
  /** latest raw detector target box, normalized [x, y, w, h] */
  box: [number, number, number, number]
  /** velocity of [x, y, w, h] in normalized units/second (for prediction) */
  vel: [number, number, number, number]
  /** wall-clock ms of the detection that set `box` */
  updatedAt: number
  firstSeen: number
  /** person boxes only — identity via face fusion; others stay 'pending' */
  identity: TrackIdentity
  personId: string | null
  personName?: string
  personRole?: 'HOUSEHOLD' | 'GUEST'
  faceDistance?: number
}

/** One face found in a frame, matched against the enrolled roster. */
export interface FaceRead {
  /** face box normalized 0..1 to the frame [x, y, w, h] */
  box: [number, number, number, number]
  /** enrolled person matched within threshold, else null */
  personId: string | null
  /** distance to the nearest enrolled sample (null if nobody enrolled) */
  distance: number | null
  ts: number
}

/* ── activity + smart brain ────────────────────────────────────────── */

/**
 * Neutral, observable activities only — what a body is doing, never a
 * judgement. MOVING/IDLE are the low-confidence motion-only fallbacks used
 * when the pose engine is unavailable.
 */
export type ActivityKind = 'STANDING' | 'SITTING' | 'WALKING' | 'LYING' | 'WAVING' | 'MOVING' | 'IDLE'

export interface ActivitySegment {
  kind: ActivityKind
  start: number
  /** null while the segment is still running */
  end: number | null
  cameraId: string
}

/** Live per-person picture assembled by the smart brain. */
export interface PersonNow {
  personId: string
  name: string
  role: 'HOUSEHOLD' | 'GUEST'
  color: string
  present: boolean
  /** present/away since (wall ms) */
  since: number
  cameraId: string | null
  activity: ActivityKind | null
  activitySince: number | null
  todaySegments: ActivitySegment[]
  /** gentle learned-routine line, e.g. "USUALLY HOME BY ~17:40" */
  routine?: string
}

export type PoseEngineState = 'idle' | 'loading' | 'ready' | 'offline'

/** The smart brain's reactive snapshot — awareness, never judgement. */
export interface BrainSnapshot {
  ts: number
  pose: PoseEngineState
  people: PersonNow[]
  /** an UNKNOWN person track is currently visible somewhere */
  unknownActive: boolean
  occupancy: { cameraId: string; persons: number; labels: string[] }[]
  insights: string[]
}

/** A drawn region on a camera view (property boundary / entry / driveway…). */
export interface Zone {
  id: string
  cameraId: string
  name: string
  kind: 'PROPERTY' | 'ENTRY' | 'DRIVEWAY' | 'RESTRICTED' | 'IGNORE'
  /** polygon in normalized 0..1 camera coords */
  points: [number, number][]
  /** alert when a person enters (respecting schedule) */
  alertOnEnter: boolean
  /** only at night, or always */
  nightOnly: boolean
  color: string
}

/** A tile in the Live Wall — a server-bridged camera or the browser webcam. */
export interface Tile {
  info: CameraInfo
  /** true for the Mac webcam (browser getUserMedia, never server-bridged) */
  isWebcam: boolean
}

export interface HomeVitals {
  camerasOnline: number
  camerasTotal: number
  detectionsPerMin: number
  peoplePresent: number
  cvOnline: boolean
}
