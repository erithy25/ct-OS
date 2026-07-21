/**
 * HOMEWATCH store. Reactive scalars + small collections live here; fast
 * per-frame detections live in a non-reactive map read imperatively by the
 * camera overlays. The store polls the local server for camera + status, and
 * owns people/zones/events that the feature modules populate.
 */
import { create } from 'zustand'
import type { AddCameraRequest, CameraInfo, RealworldStatus } from '../realworld/contract'
import { DEFAULT_REALWORLD_ORIGIN } from '../realworld/contract'
import type {
  BrainSnapshot,
  Detection,
  FaceRead,
  HomeEvent,
  HomeEventKind,
  HomeSeverity,
  HomeStatus,
  HomeView,
  Person,
  Tile,
  TrackedBox,
  Zone,
} from './types'

const params = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : new URLSearchParams()
/** where the local HOMEWATCH server lives (override with ?api=) */
export const API_ORIGIN = params.get('api') || DEFAULT_REALWORLD_ORIGIN
export const skipBoot = params.get('boot') === 'skip'

const api = (path: string): string => `${API_ORIGIN}${path}`

/* ── non-reactive stores ───────────────────────────────────────────── */

const detections = new Map<string, Detection[]>()
const events: HomeEvent[] = []
let eventSeq = 1

export const getDetections = (cameraId: string): Detection[] => detections.get(cameraId) ?? []
export const setDetections = (cameraId: string, dets: Detection[]): void => {
  detections.set(cameraId, dets)
}
export const getHomeEvents = (): HomeEvent[] => events

/* ── non-reactive per-frame stores (overlay reads these every rAF) ─────── */

/** identity-fused tracks per camera — written by the CV scheduler's tracker */
const tracks = new Map<string, TrackedBox[]>()
export const getTracks = (cameraId: string): TrackedBox[] => tracks.get(cameraId) ?? []
export const setTracks = (cameraId: string, t: TrackedBox[]): void => {
  tracks.set(cameraId, t)
}

/** latest per-face reads (box + match) per camera — written by the face watch */
const faceReads = new Map<string, FaceRead[]>()
export const getFaceReads = (cameraId: string): FaceRead[] => faceReads.get(cameraId) ?? []
export const setFaceReads = (cameraId: string, r: FaceRead[]): void => {
  faceReads.set(cameraId, r)
}

/* ── live face readout (published by the face watch, shown in PEOPLE) ──── */

export interface FaceReadout {
  ts: number
  /** a face is visible in the operator-cam frame right now */
  present: boolean
  /** matched enrolled person id within threshold (KNOWN) or null (UNKNOWN / none) */
  personId: string | null
  /** closest enrolled person id regardless of threshold — powers "almost matched" */
  nearestId: string | null
  /** euclidean distance to the nearest enrolled sample, null if nobody enrolled */
  distance: number | null
}

/* ── local persistence — roster + zones survive reloads/HMR ────────────── */

const PEOPLE_KEY = 'homewatch.people.v1'
const ZONES_KEY = 'homewatch.zones.v1'

function loadPeople(): Person[] {
  try {
    if (typeof localStorage === 'undefined') return []
    const raw = localStorage.getItem(PEOPLE_KEY)
    if (!raw) return []
    const arr = JSON.parse(raw) as Person[]
    if (!Array.isArray(arr)) return []
    // presence is live state — never restored from disk
    return arr
      .filter((p) => p && typeof p.id === 'string' && Array.isArray(p.descriptors) && p.descriptors.length > 0)
      .map((p) => ({ ...p, present: false, lastSeen: undefined }))
  } catch {
    return []
  }
}

function loadZones(): Zone[] {
  try {
    if (typeof localStorage === 'undefined') return []
    const raw = localStorage.getItem(ZONES_KEY)
    if (!raw) return []
    const arr = JSON.parse(raw) as Zone[]
    return Array.isArray(arr) ? arr.filter((z) => z && typeof z.id === 'string' && Array.isArray(z.points)) : []
  } catch {
    return []
  }
}

let persistTimer: ReturnType<typeof setTimeout> | null = null
/** Coalesce rapid roster/zone edits (and presence churn) into one write/400ms. */
function schedulePersist(): void {
  if (persistTimer) return
  persistTimer = setTimeout(() => {
    persistTimer = null
    try {
      if (typeof localStorage === 'undefined') return
      const s = useHome.getState()
      // strip live presence — only the durable enrollment is persisted
      const roster = s.people.map(({ present: _present, lastSeen: _lastSeen, lastCameraId: _lastCameraId, ...rest }) => rest)
      localStorage.setItem(PEOPLE_KEY, JSON.stringify(roster))
      localStorage.setItem(ZONES_KEY, JSON.stringify(s.zones))
    } catch {
      /* storage unavailable / full — non-fatal, in-memory state still works */
    }
  }, 400)
}

/* ── webcam tile (browser-local; never server-bridged) ─────────────── */

export const WEBCAM_ID = 'CAM-01'
function webcamInfo(status: CameraInfo['status'], error?: string): CameraInfo {
  return {
    id: WEBCAM_ID,
    name: 'OPERATOR CAM · THIS MAC',
    url: 'webcam',
    displayUrl: 'getUserMedia (local)',
    kind: 'webcam',
    status,
    error,
    serverBridged: false,
    addedAt: 0,
  }
}

/* ── store ─────────────────────────────────────────────────────────── */

export interface HomeStore {
  booted: boolean
  view: HomeView
  muted: boolean
  terminalOpen: boolean
  /** local server reachable */
  serverOnline: boolean
  status: RealworldStatus | null
  /** server-bridged cameras (excludes the webcam) */
  serverCameras: CameraInfo[]
  webcamStatus: CameraInfo['status']
  webcamError?: string
  selectedId: string | null
  expandedId: string | null
  people: Person[]
  zones: Zone[]
  /** most recent operator-cam face read (KNOWN/UNKNOWN + distance), live */
  lastFace: FaceReadout | null
  /** smart-brain snapshot — presence, activities, occupancy, insights */
  brain: BrainSnapshot | null
  eventsVersion: number
  homeStatus: HomeStatus
  detectionsPerMin: number
  cvOnline: boolean
  /** request the surveillance/webcam pipeline to (re)start */
  webcamRequest: number

  setBooted(b: boolean): void
  setView(v: HomeView): void
  setMuted(m: boolean): void
  setTerminalOpen(b: boolean): void
  select(id: string | null): void
  setExpanded(id: string | null): void
  setWebcamStatus(status: CameraInfo['status'], error?: string): void
  requestWebcam(): void
  addCamera(req: AddCameraRequest): Promise<{ ok: boolean; error?: string }>
  removeCamera(id: string): Promise<void>
  setPeople(p: Person[]): void
  upsertPerson(p: Person): void
  removePerson(id: string): void
  setZones(z: Zone[]): void
  upsertZone(z: Zone): void
  removeZone(id: string): void
  reportCv(online: boolean, perMin: number): void
  reportFace(r: FaceReadout | null): void
  reportBrain(b: BrainSnapshot | null): void
  emit(severity: HomeSeverity, kind: HomeEventKind, message: string, opts?: { cameraId?: string; personId?: string; snapshot?: string }): void
  /** all tiles: webcam first, then server cameras */
  tiles(): Tile[]
}

export const useHome = create<HomeStore>((set, get) => {
  const emit: HomeStore['emit'] = (severity, kind, message, opts) => {
    events.push({ id: eventSeq++, ts: Date.now(), severity, kind, message, ...opts })
    if (events.length > 800) events.splice(0, events.length - 800)
    set((s) => ({ eventsVersion: s.eventsVersion + 1, homeStatus: deriveStatus() }))
  }

  return {
    booted: skipBoot,
    view: 'wall',
    muted: false,
    terminalOpen: false,
    serverOnline: false,
    status: null,
    serverCameras: [],
    webcamStatus: 'offline',
    webcamError: undefined,
    selectedId: null,
    expandedId: null,
    people: loadPeople(),
    zones: loadZones(),
    lastFace: null,
    brain: null,
    eventsVersion: 0,
    homeStatus: 'SECURE',
    detectionsPerMin: 0,
    cvOnline: false,
    webcamRequest: 0,

    setBooted: (b) => set({ booted: b }),
    setView: (v) => set({ view: v }),
    setMuted: (m) => set({ muted: m }),
    setTerminalOpen: (b) => set({ terminalOpen: b }),
    select: (id) => set({ selectedId: id }),
    setExpanded: (id) => set({ expandedId: id }),
    setWebcamStatus: (status, error) => set({ webcamStatus: status, webcamError: error }),
    requestWebcam: () => set((s) => ({ webcamRequest: s.webcamRequest + 1 })),

    addCamera: async (req) => {
      try {
        const res = await fetch(api('/api/cameras'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(req),
        })
        const body = await res.json()
        if (!res.ok) {
          emit('WARN', 'CAMERA', `ADD CAMERA FAILED · ${body?.error ?? res.status}`)
          return { ok: false, error: body?.error ?? `HTTP ${res.status}` }
        }
        emit('NOTICE', 'CAMERA', `CAMERA ADDED · ${(body as CameraInfo).name} · ${(body as CameraInfo).displayUrl}`, { cameraId: (body as CameraInfo).id })
        await refresh()
        return { ok: true }
      } catch (e) {
        emit('WARN', 'CAMERA', 'ADD CAMERA FAILED · SERVER UNREACHABLE')
        return { ok: false, error: 'server unreachable' }
      }
    },
    removeCamera: async (id) => {
      try {
        await fetch(api(`/api/cameras/${id}`), { method: 'DELETE' })
        emit('NOTICE', 'CAMERA', `CAMERA REMOVED · ${id}`)
        detections.delete(id)
        tracks.delete(id)
        faceReads.delete(id)
        await refresh()
      } catch {
        /* ignore */
      }
    },
    setPeople: (people) => {
      set({ people })
      schedulePersist()
    },
    upsertPerson: (p) => {
      set((s) => ({ people: [...s.people.filter((x) => x.id !== p.id), p].sort((a, b) => a.addedAt - b.addedAt) }))
      schedulePersist()
    },
    removePerson: (id) => {
      set((s) => ({ people: s.people.filter((p) => p.id !== id) }))
      schedulePersist()
    },
    setZones: (zones) => {
      set({ zones })
      schedulePersist()
    },
    upsertZone: (z) => {
      set((s) => ({ zones: [...s.zones.filter((x) => x.id !== z.id), z] }))
      schedulePersist()
    },
    removeZone: (id) => {
      set((s) => ({ zones: s.zones.filter((z) => z.id !== id) }))
      schedulePersist()
    },
    reportCv: (online, perMin) => set({ cvOnline: online, detectionsPerMin: perMin }),
    reportFace: (r) => set({ lastFace: r }),
    reportBrain: (b) => set({ brain: b }),
    emit,

    tiles: () => {
      const s = get()
      const webcam: Tile = { info: webcamInfo(s.webcamStatus, s.webcamError), isWebcam: true }
      return [webcam, ...s.serverCameras.map((info) => ({ info, isWebcam: false }))]
    },
  }
})

/* ── posture derivation ────────────────────────────────────────────── */

function deriveStatus(): HomeStatus {
  // posture reflects SECURITY events only — system health (CV/link) never
  // inflates the threat level.
  const now = Date.now()
  let crit = 0
  let warn = 0
  for (let i = events.length - 1; i >= 0 && events.length - i < 60; i--) {
    const e = events[i]
    if (now - e.ts > 120_000) break
    if (e.kind === 'SYSTEM' || e.kind === 'CAMERA') continue
    if (e.severity === 'CRIT') crit++
    else if (e.severity === 'WARN') warn++
  }
  if (crit > 0) return 'ALERT'
  if (warn > 1) return 'ELEVATED'
  if (warn === 1) return 'MONITOR'
  return 'SECURE'
}

/* ── polling loop ──────────────────────────────────────────────────── */

async function refresh(): Promise<void> {
  try {
    const [statusRes, camsRes] = await Promise.all([
      fetch(api('/api/realworld/status')),
      fetch(api('/api/cameras')),
    ])
    const status = (await statusRes.json()) as RealworldStatus
    const cams = (await camsRes.json()) as { cameras: CameraInfo[] }
    const prev = useHome.getState()
    if (!prev.serverOnline) prev.emit('NOTICE', 'SYSTEM', `LINK ESTABLISHED · HOMEWATCH SERVER · ffmpeg ${status.ffmpeg ? 'READY' : 'MISSING'}`)
    useHome.setState({ serverOnline: true, status, serverCameras: cams.cameras })
  } catch {
    const prev = useHome.getState()
    if (prev.serverOnline) prev.emit('WARN', 'SYSTEM', 'LINK LOST · HOMEWATCH SERVER UNREACHABLE')
    useHome.setState({ serverOnline: false })
  }
}

let started = false
export function startHome(): void {
  if (started) return
  started = true
  useHome.getState().emit('INFO', 'SYSTEM', 'PANOPTICON // HOMEWATCH ONLINE — LOCAL PRIVATE MODE')
  void refresh()
  const id = setInterval(() => void refresh(), 1500)
  if (import.meta.hot) {
    import.meta.hot.dispose(() => {
      clearInterval(id)
      started = false
    })
  }
}

/* ── dev-only inspection hook (never in production builds) ─────────────── */

if (import.meta.env.DEV && typeof window !== 'undefined') {
  ;(window as unknown as { __hw?: unknown }).__hw = { useHome, setTracks, setDetections, setFaceReads }
}
