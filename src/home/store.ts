/**
 * HOMEWATCH store. Reactive scalars + small collections live here; fast
 * per-frame detections live in a non-reactive map read imperatively by the
 * camera overlays. The store polls the local server for camera + status, and
 * owns people/zones/events that the feature modules populate.
 */
import { create } from 'zustand'
import type { AddCameraRequest, CameraInfo, RealworldStatus } from '../realworld/contract'
import { DEFAULT_REALWORLD_ORIGIN } from '../realworld/contract'
import type { Detection, HomeEvent, HomeEventKind, HomeSeverity, HomeStatus, HomeView, Person, Tile, Zone } from './types'

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
    people: [],
    zones: [],
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
        await refresh()
      } catch {
        /* ignore */
      }
    },
    setPeople: (people) => set({ people }),
    upsertPerson: (p) =>
      set((s) => ({ people: [...s.people.filter((x) => x.id !== p.id), p].sort((a, b) => a.addedAt - b.addedAt) })),
    removePerson: (id) => set((s) => ({ people: s.people.filter((p) => p.id !== id) })),
    setZones: (zones) => set({ zones }),
    upsertZone: (z) => set((s) => ({ zones: [...s.zones.filter((x) => x.id !== z.id), z] })),
    removeZone: (id) => set((s) => ({ zones: s.zones.filter((z) => z.id !== id) })),
    reportCv: (online, perMin) => set({ cvOnline: online, detectionsPerMin: perMin }),
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
