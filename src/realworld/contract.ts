/**
 * REAL-WORLD contract (Phase 3) — the shared types + REST shapes for the
 * genuinely-real, server-backed features that sit ALONGSIDE the NOVA HARBOR
 * simulation:
 *
 *   · CAMERAS  — the operator's Mac webcam (browser-local) + real IP cameras
 *                bridged by the server (ffmpeg: rtsp/http/file/test → MJPEG)
 *   · GEO      — a real OpenStreetMap basemap + real public data feeds
 *                (earthquakes, weather, air quality) — OBSERVE ONLY
 *   · DEVICES  — the operator's OWN smart-home devices (MQTT / Home Assistant)
 *
 * Honesty & safety, encoded in the types:
 *   - Real map data is read-only situational awareness. There is no control
 *     surface over public infrastructure — only over devices the operator owns.
 *   - Everything real is explicitly labelled; the simulation stays separate.
 *
 * All types are JSON-safe. The server exposes these under `/api/*`; the client
 * fetches/polls them. Real-world features require the local server to be
 * running — the client probes `/api/realworld/status` and degrades to a clear
 * "START THE SERVER" state otherwise.
 */

export const REALWORLD_API_BASE = '/api'

/* ── status ────────────────────────────────────────────────────────── */

export interface RealworldStatus {
  ok: true
  /** ffmpeg binary resolved on the server (cameras need it) */
  ffmpeg: boolean
  ffmpegVersion?: string
  cameras: number
  /** device backend state */
  devices: { backend: 'mqtt' | 'homeassistant' | 'none'; connected: boolean; count: number }
  geo: { defaultCity: string; feeds: boolean }
  uptime: number
}

/* ── cameras ───────────────────────────────────────────────────────── */

export type CameraKind = 'webcam' | 'rtsp' | 'http' | 'file' | 'test'
export type CameraStatus = 'connecting' | 'live' | 'error' | 'offline'

export interface CameraInfo {
  id: string
  name: string
  /** source URL as entered (rtsp://…, http://…, file://…, or "test") — redacted
   *  of any password for display via `displayUrl` */
  url: string
  displayUrl: string
  kind: CameraKind
  status: CameraStatus
  error?: string
  /** browser-side webcam tiles are not server-bridged */
  serverBridged: boolean
  addedAt: number
  /** last successful frame wall-clock ms (server bridge) */
  lastFrame?: number
  width?: number
  height?: number
  fps?: number
}

export interface AddCameraRequest {
  name?: string
  /** rtsp://…, http(s)://… (mjpeg/hls/mp4), file://…, or "test" for a pattern */
  url: string
}

/** Camera REST:
 *   GET    /api/cameras            → { cameras: CameraInfo[] }
 *   POST   /api/cameras            (AddCameraRequest) → CameraInfo
 *   DELETE /api/cameras/:id        → { ok: true }
 *   GET    /api/cameras/:id/stream → multipart/x-mixed-replace MJPEG (live)
 *   GET    /api/cameras/:id/snapshot → image/jpeg (single frame)
 */
export const cameraStreamUrl = (base: string, id: string): string => `${base}/api/cameras/${id}/stream`
export const cameraSnapshotUrl = (base: string, id: string): string => `${base}/api/cameras/${id}/snapshot`

/* ── geo: real map + feeds ─────────────────────────────────────────── */

/** [lng, lat] — GeoJSON order */
export type LngLat = [number, number]

export interface GeoRoad {
  major: boolean
  pts: LngLat[]
}

export interface GeoCity {
  name: string
  /** [south, west, north, east] */
  bbox: [number, number, number, number]
  center: LngLat
  roads: GeoRoad[]
  water: LngLat[][]
  /** count summary for the HUD */
  stats: { roads: number; waterBodies: number }
  /** where the geometry came from */
  source: 'overpass' | 'bundled'
  fetchedAt: number
}

export interface QuakeFeature {
  mag: number
  place: string
  lat: number
  lng: number
  depthKm: number
  time: number
}

export interface WeatherNow {
  tempC: number
  windKph: number
  code: number
  label: string
}

export interface AirNow {
  pm25: number
  pm10: number
  aqi: number
  label: string
}

export interface GeoFeeds {
  center: LngLat
  quakes: QuakeFeature[]
  weather?: WeatherNow
  air?: AirNow
  ts: number
}

/** A named place the LIVE MAP can jump to (curated defaults + geocode). */
export interface GeoPlace {
  name: string
  center: LngLat
  bbox: [number, number, number, number]
}

/** Geo REST:
 *   GET /api/geo/places                 → { places: GeoPlace[] }   (curated)
 *   GET /api/geo/city?place=<name>      → GeoCity                  (bundled default has no params)
 *   GET /api/geo/city?bbox=s,w,n,e      → GeoCity
 *   GET /api/geo/feeds?lat=&lon=        → GeoFeeds
 */

/* ── devices: the operator's own smart-home ────────────────────────── */

export type DeviceKind = 'switch' | 'light' | 'sensor' | 'climate' | 'lock'
export type DeviceValue = boolean | number | string

export interface DeviceInfo {
  id: string
  name: string
  kind: DeviceKind
  /** current state; boolean for switches/lights, number/string for sensors */
  state: DeviceValue
  unit?: string
  /** can the operator change it (switches/lights) vs read-only (sensors) */
  controllable: boolean
  backend: 'mqtt' | 'homeassistant'
  /** grouping label (room / area) */
  area?: string
  updated: number
  online: boolean
}

export interface SetDeviceRequest {
  state: DeviceValue
}

/** Device REST:
 *   GET  /api/devices              → { devices: DeviceInfo[], backend, connected }
 *   POST /api/devices/:id/set      (SetDeviceRequest) → DeviceInfo
 *   (client polls GET /api/devices ~1 Hz; toggles are infrequent)
 */
export interface DevicesResponse {
  devices: DeviceInfo[]
  backend: 'mqtt' | 'homeassistant' | 'none'
  connected: boolean
}

/* ── client helpers ────────────────────────────────────────────────── */

/** Where the real-world server lives. Defaults to the sim server origin. */
export const DEFAULT_REALWORLD_ORIGIN = 'http://127.0.0.1:8787'
