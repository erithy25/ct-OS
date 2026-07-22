import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { API_ORIGIN, useHome, WEBCAM_ID } from '../store'
import { cameraSnapshotUrl, cameraStreamUrl } from '../../realworld/contract'
import type { CameraStatus } from '../../realworld/contract'
import type { Zone } from '../types'
import { lineBothPolygons, lineSidePolygon, pointInPolygon, polygonCentroid } from './geometry'
import { getFaceStream } from '../people/faceWatch'
import CornerBrackets from '../../components/CornerBrackets'
import { uiClick } from '../../lib/audio'

/**
 * ZONES — draw your property boundary as a LINE (then pick which side is
 * yours) or classic area zones, directly over the LIVE camera image. The
 * alerting itself lives in ./zoneWatch; boundary lines are closed into normal
 * polygons via geometry.lineSidePolygon so every watcher keeps working.
 *
 * Coordinates are stored normalized 0..1 in UNMIRRORED image space — the same
 * space Detection.box lives in. The operator webcam is DISPLAYED mirrored
 * (like the Live Wall), so this view flips x on input and output for it.
 */

type Kind = Zone['kind']
type DrawMode = 'line' | 'area'
type Phase = 'idle' | 'draw' | 'side'

const KINDS: Kind[] = ['PROPERTY', 'ENTRY', 'DRIVEWAY', 'RESTRICTED', 'IGNORE']
const KIND_COLOR: Record<Kind, string> = {
  PROPERTY: '#22D3EE',
  ENTRY: '#F5A623',
  DRIVEWAY: '#8B5CF6',
  RESTRICTED: '#FF3B47',
  IGNORE: '#3A4756',
}
const KIND_HINT: Record<Kind, string> = {
  PROPERTY: 'OUTER BOUNDARY',
  ENTRY: 'DOOR / GATE',
  DRIVEWAY: 'VEHICLE APPROACH',
  RESTRICTED: 'KEEP-OUT AREA',
  IGNORE: 'MUTED — NO ALERTS',
}
const STATUS_COLOR: Record<CameraStatus, string> = {
  live: 'var(--accent-green)',
  connecting: 'var(--accent-amber)',
  error: 'var(--accent-red)',
  offline: 'var(--text-faint)',
}
const DRAW_ACCENT = '#22D3EE'

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n)

interface Rect {
  left: number
  top: number
  width: number
  height: number
}

/** object-contain math: the on-screen rect of an image of `aspect` inside W×H. */
function containRect(W: number, H: number, aspect: number | null): Rect {
  if (!aspect || W <= 0 || H <= 0) return { left: 0, top: 0, width: Math.max(0, W), height: Math.max(0, H) }
  const cA = W / H
  let width: number
  let height: number
  if (cA > aspect) {
    height = H
    width = H * aspect
  } else {
    width = W
    height = W / aspect
  }
  return { left: (W - width) / 2, top: (H - height) / 2, width, height }
}

let idSeq = 0
function genId(): string {
  idSeq = (idSeq + 1) % 1296
  return `Z-${Date.now().toString(36)}-${idSeq.toString(36).padStart(2, '0')}`
}

/* ── module ─────────────────────────────────────────────────────────── */

export default function Zones() {
  const serverCameras = useHome((s) => s.serverCameras)
  const webcamStatus = useHome((s) => s.webcamStatus)
  const allZones = useHome((s) => s.zones)
  const upsertZone = useHome((s) => s.upsertZone)
  const removeZone = useHome((s) => s.removeZone)

  const cameras = useMemo(() => {
    const list: { id: string; name: string; status: CameraStatus; isWebcam: boolean }[] = [
      { id: WEBCAM_ID, name: 'OPERATOR CAM · THIS MAC', status: webcamStatus, isWebcam: true },
    ]
    for (const c of serverCameras) list.push({ id: c.id, name: c.name, status: c.status, isWebcam: false })
    return list
  }, [serverCameras, webcamStatus])

  const [cameraId, setCameraId] = useState<string>(WEBCAM_ID)
  useEffect(() => {
    if (!cameras.some((c) => c.id === cameraId)) setCameraId(cameras[0]?.id ?? WEBCAM_ID)
  }, [cameras, cameraId])

  const selectedCam = cameras.find((c) => c.id === cameraId) ?? cameras[0]
  const isWebcam = selectedCam?.isWebcam ?? true

  const zones = useMemo(
    () =>
      allZones
        .filter((z) => z.cameraId === cameraId)
        .slice()
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    [allZones, cameraId],
  )

  // draw / edit state
  const [phase, setPhase] = useState<Phase>('idle')
  const [mode, setMode] = useState<DrawMode>('line')
  const [draft, setDraft] = useState<[number, number][]>([])
  const [hover, setHover] = useState<[number, number] | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const editing = editingId ? zones.find((z) => z.id === editingId) ?? null : null
  const drawing = phase === 'draw'
  const pickingSide = phase === 'side'

  // live surface state
  const [mediaError, setMediaError] = useState(false)
  const [natAspect, setNatAspect] = useState<number | null>(null)
  const [snapTick, setSnapTick] = useState(0)
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 })
  const stageRef = useRef<HTMLDivElement | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // reset transient UI when the camera changes
  useEffect(() => {
    setPhase('idle')
    setDraft([])
    setHover(null)
    setEditingId(null)
    setMediaError(false)
    setNatAspect(null)
  }, [cameraId])

  // LIVE webcam preview (mirrored like the wall) — draw on what you SEE
  useEffect(() => {
    if (!isWebcam) return
    let cancelled = false
    getFaceStream()
      .then((stream) => {
        if (cancelled) return
        const v = videoRef.current
        if (v) {
          v.srcObject = stream
          void v.play().catch(() => undefined)
        }
      })
      .catch(() => {
        if (!cancelled) setMediaError(true)
      })
    return () => {
      cancelled = true
    }
  }, [isWebcam, cameraId])

  // track the stage size so normalized <-> pixel math stays correct on resize
  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const measure = (): void => {
      const r = el.getBoundingClientRect()
      setSize({ w: r.width, h: r.height })
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // snapshot fallback refresh (server cameras whose live stream failed)
  useEffect(() => {
    if (isWebcam || !mediaError) return
    const id = setInterval(() => setSnapTick((t) => t + 1), 4000)
    return () => clearInterval(id)
  }, [isWebcam, mediaError, cameraId])

  // keyboard: Escape cancels, Enter finishes
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && phase !== 'idle') {
        setPhase('idle')
        setDraft([])
        setHover(null)
      }
      if (e.key === 'Enter' && drawing) finishDraw()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, draft, mode])

  useEffect(() => () => {
    if (clickTimer.current) clearTimeout(clickTimer.current)
  }, [])

  const imgRect = useMemo(() => containRect(size.w, size.h, natAspect ?? 4 / 3), [size, natAspect])

  const isNightNow = (() => {
    const h = new Date().getHours()
    return h < 7 || h > 20
  })()

  /* ── coordinate mapping (mirror-aware for the webcam) ── */
  const toNorm = (clientX: number, clientY: number): [number, number] | null => {
    const el = stageRef.current
    if (!el || imgRect.width <= 0 || imgRect.height <= 0) return null
    const r = el.getBoundingClientRect()
    let nx = (clientX - r.left - imgRect.left) / imgRect.width
    const ny = (clientY - r.top - imgRect.top) / imgRect.height
    if (isWebcam) nx = 1 - nx // display is mirrored — store unmirrored
    return [clamp01(nx), clamp01(ny)]
  }
  const px = (p: readonly [number, number]): [number, number] => {
    const dx = isWebcam ? 1 - p[0] : p[0]
    return [dx * imgRect.width, p[1] * imgRect.height]
  }
  const ptsStr = (poly: readonly [number, number][]): string =>
    poly
      .map((p) => {
        const q = px(p)
        return `${q[0]},${q[1]}`
      })
      .join(' ')

  /* ── actions ── */
  const startDraw = (m: DrawMode): void => {
    setEditingId(null)
    setDraft([])
    setHover(null)
    setMode(m)
    setPhase('draw')
    uiClick()
  }
  const cancelDraw = (): void => {
    setPhase('idle')
    setDraft([])
    setHover(null)
  }
  const undoPoint = (): void => setDraft((d) => d.slice(0, -1))

  const minPts = mode === 'line' ? 2 : 3

  const finishDraw = (): void => {
    if (draft.length < minPts) return
    if (mode === 'line') {
      // next click marks which side is the property
      setPhase('side')
      uiClick()
      return
    }
    saveZone(draft.map((p) => [p[0], p[1]] as [number, number]), undefined, undefined)
  }

  const pickSide = (sidePoint: [number, number]): void => {
    const line = draft.map((p) => [p[0], p[1]] as [number, number])
    const poly = lineSidePolygon(line, sidePoint)
    if (poly.length < 3) {
      cancelDraw()
      return
    }
    saveZone(poly, line, sidePoint)
  }

  const saveZone = (points: [number, number][], line?: [number, number][], sidePoint?: [number, number]): void => {
    const kind: Kind = 'PROPERTY'
    const zone: Zone = {
      id: genId(),
      cameraId,
      name: line ? `BOUNDARY ${zones.filter((z) => z.line).length + 1}` : `ZONE ${zones.length + 1}`,
      kind,
      points,
      line,
      sidePoint,
      alertOnEnter: true,
      nightOnly: false,
      color: KIND_COLOR[kind],
    }
    upsertZone(zone)
    setPhase('idle')
    setDraft([])
    setHover(null)
    setEditingId(zone.id)
    uiClick()
  }

  const patch = (z: Zone, part: Partial<Zone>): void => upsertZone({ ...z, ...part })
  const setKind = (z: Zone, kind: Kind): void =>
    patch(z, { kind, color: KIND_COLOR[kind], alertOnEnter: kind === 'IGNORE' ? false : z.alertOnEnter })
  const flipSide = (z: Zone): void => {
    if (!z.line) return
    const { a, b } = lineBothPolygons(z.line)
    if (a.length < 3 || b.length < 3) return
    const current = z.sidePoint && pointInPolygon(z.sidePoint, a) ? a : b
    const other = current === a ? b : a
    const centroid = polygonCentroid(other)
    patch(z, { points: other, sidePoint: centroid })
    uiClick()
  }

  /* ── stage pointer handlers ── */
  const onStageClick = (e: MouseEvent<HTMLDivElement>): void => {
    const pt = toNorm(e.clientX, e.clientY)
    if (!pt) return
    if (pickingSide) {
      pickSide(pt)
      return
    }
    if (!drawing) return
    // defer so a double-click (finish) doesn't also drop two stray points
    if (clickTimer.current) clearTimeout(clickTimer.current)
    clickTimer.current = setTimeout(() => {
      setDraft((d) => [...d, pt])
      clickTimer.current = null
    }, 170)
  }
  const onStageDbl = (e: MouseEvent<HTMLDivElement>): void => {
    if (!drawing) return
    e.preventDefault()
    if (clickTimer.current) {
      clearTimeout(clickTimer.current)
      clickTimer.current = null
    }
    finishDraw()
  }
  const onStageMove = (e: MouseEvent<HTMLDivElement>): void => {
    if (!drawing && !pickingSide) return
    setHover(toNorm(e.clientX, e.clientY))
  }

  const last = draft.length > 0 ? draft[draft.length - 1] : null
  // live preview of the armed side while picking
  const sidePreview = useMemo(() => {
    if (!pickingSide || !hover || draft.length < 2) return null
    const poly = lineSidePolygon(draft, hover)
    return poly.length >= 3 ? poly : null
  }, [pickingSide, hover, draft])

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-2">
      {/* header */}
      <div className="flex shrink-0 items-center gap-2">
        <span className="lbl text-prim/80">ZONES</span>
        <span className="lbl-faint">· {allZones.length} DEFINED</span>
        <ArmedBadge zones={allZones} />
        <div className="flex-1" />
        <span className="lbl-faint">DRAW THE BOUNDARY → PICK YOUR SIDE → ARMED</span>
      </div>

      <div className="flex min-h-0 flex-1 gap-2">
        {/* LEFT — picker + canvas */}
        <div className="flex min-h-0 flex-1 flex-col gap-2">
          {/* camera picker */}
          <div className="flex shrink-0 items-center gap-1.5 overflow-x-auto pb-0.5">
            <span className="lbl-faint shrink-0">CAMERA</span>
            {cameras.map((c) => {
              const active = c.id === cameraId
              const zc = allZones.filter((z) => z.cameraId === c.id).length
              return (
                <button
                  key={c.id}
                  onClick={() => {
                    setCameraId(c.id)
                    uiClick()
                  }}
                  className={`lbl flex shrink-0 items-center gap-1.5 border px-2 py-1 transition-colors ${
                    active ? 'border-accent/70 bg-accent/10 text-accent' : 'border-line text-dim hover:border-lineb hover:text-prim'
                  }`}
                >
                  <span className="led-pulse h-1.5 w-1.5 rounded-full" style={{ background: STATUS_COLOR[c.status] }} />
                  <span className="max-w-[160px] truncate">{c.name}</span>
                  <span className="lbl-faint">{c.isWebcam ? 'CAM-01' : c.id}</span>
                  {zc > 0 && <span className="num text-accent">{zc}</span>}
                </button>
              )
            })}
          </div>

          {/* canvas */}
          <section className="panel-surface relative flex min-h-0 flex-1 flex-col overflow-hidden">
            <CornerBrackets />
            <header className="flex h-6 shrink-0 items-center gap-2 border-b border-line px-2">
              <span className="led-pulse h-1.5 w-1.5 rounded-full" style={{ background: STATUS_COLOR[selectedCam?.status ?? 'offline'] }} />
              <span className="lbl truncate text-prim/80">{selectedCam?.name ?? '—'}</span>
              <span className="lbl-faint">{mediaError ? 'STILL' : 'LIVE'} CANVAS</span>
              <div className="flex-1" />
              {phase === 'idle' ? (
                <>
                  <button onClick={() => startDraw('line')} className="lbl flex items-center gap-1 border border-accent/60 bg-accent/10 px-2 py-0.5 text-accent hover:bg-accent/20">
                    + BOUNDARY LINE
                  </button>
                  <button onClick={() => startDraw('area')} className="lbl flex items-center gap-1 border border-line px-2 py-0.5 text-dim hover:border-lineb hover:text-prim">
                    + AREA
                  </button>
                </>
              ) : pickingSide ? (
                <span className="lbl flex items-center gap-1 text-amber">
                  <span className="led-pulse h-1.5 w-1.5 rounded-full bg-amber" /> CLICK YOUR PROPERTY SIDE
                </span>
              ) : (
                <span className="lbl flex items-center gap-1 text-accent">
                  <span className="led-pulse h-1.5 w-1.5 rounded-full bg-accent" /> {mode === 'line' ? 'BOUNDARY' : 'AREA'} · {draft.length} PTS
                </span>
              )}
            </header>

            {/* drawable surface */}
            <div
              ref={stageRef}
              className="relative min-h-0 flex-1 overflow-hidden bg-black"
              style={{ cursor: drawing || pickingSide ? 'crosshair' : 'default' }}
              onClick={onStageClick}
              onDoubleClick={onStageDbl}
              onMouseMove={onStageMove}
              onMouseLeave={() => setHover(null)}
            >
              {/* LIVE background — video (webcam) or MJPEG stream (bridged) */}
              {isWebcam ? (
                mediaError ? (
                  <MediaUnavailable label="WEBCAM UNAVAILABLE" />
                ) : (
                  <video
                    ref={videoRef}
                    muted
                    playsInline
                    onLoadedMetadata={(e) => {
                      const v = e.currentTarget
                      if (v.videoWidth > 0) setNatAspect(v.videoWidth / v.videoHeight)
                    }}
                    className="pointer-events-none absolute inset-0 h-full w-full object-contain"
                    style={{ transform: 'scaleX(-1)' }}
                  />
                )
              ) : mediaError ? (
                <img
                  key={`snap-${cameraId}-${snapTick}`}
                  src={`${cameraSnapshotUrl(API_ORIGIN, cameraId)}?t=${snapTick}`}
                  alt={selectedCam?.name ?? cameraId}
                  className="pointer-events-none absolute inset-0 h-full w-full object-contain"
                  draggable={false}
                  onLoad={(e) => {
                    const el = e.currentTarget
                    if (el.naturalWidth > 0) setNatAspect(el.naturalWidth / el.naturalHeight)
                  }}
                  onError={() => setNatAspect(null)}
                />
              ) : (
                <img
                  key={`live-${cameraId}`}
                  src={cameraStreamUrl(API_ORIGIN, cameraId)}
                  alt={selectedCam?.name ?? cameraId}
                  crossOrigin="anonymous"
                  className="pointer-events-none absolute inset-0 h-full w-full object-contain"
                  draggable={false}
                  onLoad={(e) => {
                    const el = e.currentTarget
                    if (el.naturalWidth > 0) setNatAspect(el.naturalWidth / el.naturalHeight)
                  }}
                  onError={() => setMediaError(true)}
                />
              )}

              {/* vector overlay (positioned exactly over the image rect) */}
              <svg
                className="pointer-events-none absolute"
                style={{ left: imgRect.left, top: imgRect.top, width: imgRect.width, height: imgRect.height }}
                width={imgRect.width}
                height={imgRect.height}
              >
                {zones.map((z) => {
                  const sel = z.id === editingId
                  return (
                    <g key={z.id}>
                      <polygon
                        points={ptsStr(z.points)}
                        fill={z.color}
                        fillOpacity={sel ? 0.16 : 0.09}
                        stroke={z.color}
                        strokeOpacity={z.line ? 0.35 : 0.95}
                        strokeWidth={sel ? 2 : 1.25}
                        strokeLinejoin="round"
                        strokeDasharray={z.line ? '3 4' : undefined}
                      />
                      {z.line && (
                        <polyline
                          points={ptsStr(z.line)}
                          fill="none"
                          stroke={z.color}
                          strokeOpacity={0.95}
                          strokeWidth={sel ? 3 : 2.25}
                          strokeLinejoin="round"
                          strokeLinecap="round"
                        />
                      )}
                      {sel &&
                        (z.line ?? z.points).map((p, i) => {
                          const q = px(p)
                          return <circle key={i} cx={q[0]} cy={q[1]} r={3} fill={z.color} />
                        })}
                    </g>
                  )
                })}

                {/* side-pick preview: tint the side the cursor is on */}
                {sidePreview && (
                  <polygon points={ptsStr(sidePreview)} fill={DRAW_ACCENT} fillOpacity={0.12} stroke={DRAW_ACCENT} strokeOpacity={0.3} strokeWidth={1} strokeDasharray="3 4" />
                )}

                {/* in-progress draft */}
                {draft.length > 0 && (
                  <g>
                    {mode === 'area' && draft.length >= 3 && <polygon points={ptsStr(draft)} fill={DRAW_ACCENT} fillOpacity={0.08} stroke="none" />}
                    <polyline
                      points={ptsStr(draft)}
                      fill="none"
                      stroke={DRAW_ACCENT}
                      strokeOpacity={0.95}
                      strokeWidth={mode === 'line' ? 2.5 : 1.5}
                      strokeLinejoin="round"
                      strokeLinecap="round"
                    />
                    {drawing && hover && last && (
                      <>
                        <line x1={px(last)[0]} y1={px(last)[1]} x2={px(hover)[0]} y2={px(hover)[1]} stroke={DRAW_ACCENT} strokeOpacity={0.6} strokeWidth={1} strokeDasharray="4 3" />
                        {mode === 'area' && draft.length >= 2 && (
                          <line x1={px(hover)[0]} y1={px(hover)[1]} x2={px(draft[0])[0]} y2={px(draft[0])[1]} stroke={DRAW_ACCENT} strokeOpacity={0.28} strokeWidth={1} strokeDasharray="2 3" />
                        )}
                      </>
                    )}
                    {draft.map((p, i) => {
                      const q = px(p)
                      const first = i === 0
                      return <circle key={i} cx={q[0]} cy={q[1]} r={first ? 4 : 2.5} fill={first ? DRAW_ACCENT : '#05070a'} stroke={DRAW_ACCENT} strokeWidth={1.25} />
                    })}
                  </g>
                )}
              </svg>

              {/* zone labels (HTML, above the vector) */}
              {imgRect.width > 0 &&
                zones.map((z) => {
                  const c = z.line && z.line.length > 0 ? z.line[Math.floor(z.line.length / 2)] : polygonCentroid(z.points)
                  const disp = px(c)
                  const left = imgRect.left + disp[0]
                  const top = imgRect.top + disp[1]
                  return (
                    <div key={z.id} className={`absolute -translate-x-1/2 -translate-y-1/2 ${phase !== 'idle' ? 'pointer-events-none' : ''}`} style={{ left, top }}>
                      <div className="flex items-center gap-1 border bg-void/80 px-1.5 py-0.5" style={{ borderColor: z.color }}>
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            setEditingId(z.id)
                            setPhase('idle')
                            uiClick()
                          }}
                          className="flex items-center gap-1"
                          title={`EDIT ${z.name}`}
                        >
                          <span className="h-1.5 w-1.5" style={{ background: z.color }} />
                          <span className="lbl" style={{ color: z.color }}>
                            {z.name}
                          </span>
                          {z.alertOnEnter && (
                            <span className="lbl-faint" style={{ color: z.color }}>
                              {z.nightOnly ? '☾' : '●'}
                            </span>
                          )}
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            removeZone(z.id)
                            if (editingId === z.id) setEditingId(null)
                            uiClick()
                          }}
                          className="lbl-faint pl-0.5 hover:text-red"
                          title="delete zone"
                        >
                          ✕
                        </button>
                      </div>
                    </div>
                  )
                })}

              {/* empty state */}
              {phase === 'idle' && zones.length === 0 && (
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                  <div className="relative bg-void/55 px-8 py-6 text-center">
                    <CornerBrackets size={10} />
                    <div className="font-grotesk text-[16px] tracking-[0.25em] text-prim/70">NO ZONES ON THIS CAMERA</div>
                    <div className="lbl-faint mt-2 leading-5">
                      CLICK <span className="text-accent">+ BOUNDARY LINE</span> AND TRACE YOUR PROPERTY BORDER
                      <br />
                      ON THE LIVE IMAGE — THEN CLICK WHICH SIDE IS YOURS
                    </div>
                  </div>
                </div>
              )}

              {/* drawing / side-pick control bar */}
              {phase !== 'idle' && (
                <div
                  className="absolute bottom-2 left-1/2 flex -translate-x-1/2 items-center gap-1.5 border border-lineb bg-panel2/90 px-2 py-1 shadow-glow"
                  onClick={(e) => e.stopPropagation()}
                  onDoubleClick={(e) => e.stopPropagation()}
                >
                  {pickingSide ? (
                    <>
                      <span className="lbl text-amber">CLICK THE SIDE THAT IS YOUR PROPERTY</span>
                      <span className="h-3 w-px bg-line" />
                      <button onClick={cancelDraw} className="lbl border border-line px-1.5 py-0.5 text-dim hover:border-red hover:text-red">
                        CANCEL
                      </button>
                    </>
                  ) : (
                    <>
                      <span className="lbl-faint">
                        {mode === 'line' ? 'CLICK ALONG THE BORDER · DBL-CLICK / ENTER TO FINISH' : 'CLICK TO ADD · DBL-CLICK TO CLOSE'}
                      </span>
                      <span className="h-3 w-px bg-line" />
                      <button onClick={undoPoint} disabled={draft.length === 0} className="lbl border border-line px-1.5 py-0.5 text-dim hover:border-lineb hover:text-prim disabled:opacity-40">
                        UNDO
                      </button>
                      <button onClick={finishDraw} disabled={draft.length < minPts} className="lbl border border-accent bg-accent/10 px-1.5 py-0.5 text-accent hover:bg-accent/20 disabled:opacity-40">
                        {mode === 'line' ? 'FINISH LINE' : 'CLOSE SHAPE'}
                      </button>
                      <button onClick={cancelDraw} className="lbl border border-line px-1.5 py-0.5 text-dim hover:border-red hover:text-red">
                        CANCEL
                      </button>
                    </>
                  )}
                </div>
              )}

              {/* HUD */}
              <div className="pointer-events-none absolute left-1.5 top-1.5 flex items-center gap-1">
                <span className="led-pulse h-1.5 w-1.5 rounded-full bg-accent" />
                <span className="num text-[9px] text-accent/80">ZONES · {mediaError ? 'STILL' : 'LIVE'}</span>
              </div>
            </div>
          </section>

          {/* honesty / help line */}
          <div className="lbl-faint shrink-0 px-1">
            DRAW ON THE LIVE IMAGE · A BOUNDARY LINE ARMS ONE SIDE (YOURS) · ALERTS &amp; RECORDINGS STAY ON-DEVICE
          </div>
        </div>

        {/* RIGHT — editor + list */}
        <aside className="flex w-[320px] shrink-0 flex-col gap-2">
          <section className="panel-surface relative flex shrink-0 flex-col">
            <header className="flex h-6 shrink-0 items-center gap-2 border-b border-line px-2">
              <span className="lbl flex-1 text-prim/80">{phase !== 'idle' ? 'DRAWING' : 'ZONE EDITOR'}</span>
              {editing && phase === 'idle' && (
                <span className="lbl-faint" style={{ color: editing.color }}>
                  {editing.line ? 'BOUNDARY' : editing.kind}
                </span>
              )}
            </header>
            <div className="p-2">
              {phase !== 'idle' ? (
                <DrawingPanel mode={mode} phase={phase} count={draft.length} minPts={minPts} onFinish={finishDraw} onUndo={undoPoint} onCancel={cancelDraw} />
              ) : editing ? (
                <EditorPanel
                  zone={editing}
                  night={isNightNow}
                  onPatch={patch}
                  onSetKind={setKind}
                  onFlipSide={() => flipSide(editing)}
                  onDelete={() => {
                    removeZone(editing.id)
                    setEditingId(null)
                    uiClick()
                  }}
                />
              ) : (
                <div className="py-4 text-center">
                  <div className="lbl-faint leading-5">
                    TRACE YOUR PROPERTY BORDER AS A LINE
                    <br />
                    OR SELECT A ZONE FROM THE LIST
                  </div>
                  <button onClick={() => startDraw('line')} className="lbl mt-3 border border-accent/60 bg-accent/10 px-3 py-1 text-accent hover:bg-accent/20">
                    + BOUNDARY LINE
                  </button>
                </div>
              )}
            </div>
          </section>

          <section className="panel-surface relative flex min-h-0 flex-1 flex-col">
            <header className="flex h-6 shrink-0 items-center gap-2 border-b border-line px-2">
              <span className="lbl flex-1 text-prim/80">ZONES</span>
              <span className="lbl-faint">
                {zones.length} ON {selectedCam?.isWebcam ? 'CAM-01' : cameraId}
              </span>
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {zones.length === 0 ? (
                <div className="lbl-faint px-2 py-4 text-center">NO ZONES ON THIS CAMERA</div>
              ) : (
                <ul>
                  {zones.map((z) => {
                    const sel = z.id === editingId
                    return (
                      <li
                        key={z.id}
                        onClick={() => {
                          setEditingId(z.id)
                          setPhase('idle')
                        }}
                        className={`flex cursor-pointer items-center gap-2 border-b border-line/50 px-2 py-1.5 ${sel ? 'bg-panel2' : 'hover:bg-panel2/60'}`}
                      >
                        <span className="h-2.5 w-2.5 shrink-0" style={{ background: z.color, boxShadow: sel ? `0 0 6px ${z.color}` : undefined }} />
                        <div className="min-w-0 flex-1">
                          <div className="lbl truncate text-prim/85">{z.name}</div>
                          <div className="lbl-faint">
                            {z.line ? `BOUNDARY LINE · ${z.line.length} PTS` : `${z.kind} · ${z.points.length} PTS`}
                          </div>
                        </div>
                        {z.nightOnly && (
                          <span className="lbl-faint" title="night only">
                            ☾
                          </span>
                        )}
                        <span className="lbl-faint" style={{ color: z.alertOnEnter ? 'var(--accent-green)' : 'var(--text-faint)' }} title={z.alertOnEnter ? 'armed' : 'disarmed'}>
                          {z.alertOnEnter ? 'ARMED' : 'OFF'}
                        </span>
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            removeZone(z.id)
                            if (editingId === z.id) setEditingId(null)
                            uiClick()
                          }}
                          className="lbl-faint px-1 hover:text-red"
                          title="delete zone"
                        >
                          ✕
                        </button>
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          </section>
        </aside>
      </div>
    </div>
  )
}

/* ── sub-components ──────────────────────────────────────────────────── */

function ArmedBadge({ zones }: { zones: Zone[] }): ReactNode {
  if (zones.length === 0) return null
  const armed = zones.filter((z) => z.alertOnEnter).length
  return (
    <span className="lbl flex items-center gap-1 border border-green/40 px-1 text-green">
      <span className="led-pulse h-1 w-1 rounded-full bg-green" /> {armed} ARMED
    </span>
  )
}

function MediaUnavailable({ label }: { label: string }): ReactNode {
  return (
    <div className="absolute inset-0 bg-void">
      <div className="pointer-events-none absolute left-0 right-0 top-2 flex justify-center px-4">
        <span className="lbl-faint max-w-full truncate border border-amber/40 bg-panel2/70 px-2 py-0.5 text-amber">{label} · DRAWING STILL WORKS ON THE BLANK CANVAS</span>
      </div>
    </div>
  )
}

function DrawingPanel({
  mode,
  phase,
  count,
  minPts,
  onFinish,
  onUndo,
  onCancel,
}: {
  mode: DrawMode
  phase: Phase
  count: number
  minPts: number
  onFinish: () => void
  onUndo: () => void
  onCancel: () => void
}): ReactNode {
  if (phase === 'side') {
    return (
      <div className="flex flex-col gap-2">
        <div className="lbl text-amber">STEP 2 · PICK YOUR SIDE</div>
        <div className="lbl-faint leading-5">
          CLICK THE SIDE OF THE LINE THAT IS <span className="text-prim">YOUR PROPERTY</span>. THAT SIDE BECOMES THE ARMED REGION — HOVER TO PREVIEW IT.
        </div>
        <button onClick={onCancel} className="lbl border border-line px-2 py-1 text-dim hover:border-red hover:text-red">
          CANCEL
        </button>
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="lbl-faint">POINTS PLACED</span>
        <span className="num text-[16px] text-accent">{count}</span>
      </div>
      <div className="lbl-faint leading-5">
        {mode === 'line' ? (
          <>
            TRACE YOUR PROPERTY BORDER ON THE LIVE IMAGE — ANY SHAPE, JUST A LINE. DOUBLE-CLICK, ENTER OR <span className="text-accent">FINISH LINE</span> WHEN DONE (MIN {minPts}). YOU PICK YOUR SIDE NEXT.
          </>
        ) : (
          <>
            CLICK TO DROP POLYGON POINTS. DOUBLE-CLICK OR <span className="text-accent">CLOSE SHAPE</span> TO FINISH (MIN {minPts}).
          </>
        )}
      </div>
      <div className="flex gap-1.5">
        <button onClick={onUndo} disabled={count === 0} className="lbl flex-1 border border-line px-2 py-1 text-dim hover:border-lineb hover:text-prim disabled:opacity-40">
          UNDO PT
        </button>
        <button onClick={onFinish} disabled={count < minPts} className="lbl flex-1 border border-accent bg-accent/10 px-2 py-1 text-accent hover:bg-accent/20 disabled:opacity-40">
          {mode === 'line' ? 'FINISH LINE' : 'CLOSE SHAPE'}
        </button>
      </div>
      <button onClick={onCancel} className="lbl border border-line px-2 py-1 text-dim hover:border-red hover:text-red">
        CANCEL
      </button>
    </div>
  )
}

function EditorPanel({
  zone,
  night,
  onPatch,
  onSetKind,
  onFlipSide,
  onDelete,
}: {
  zone: Zone
  night: boolean
  onPatch: (z: Zone, part: Partial<Zone>) => void
  onSetKind: (z: Zone, kind: Kind) => void
  onFlipSide: () => void
  onDelete: () => void
}): ReactNode {
  return (
    <div className="flex flex-col gap-2.5">
      <label className="block">
        <span className="lbl-faint">NAME</span>
        <input
          value={zone.name}
          onChange={(e) => onPatch(zone, { name: e.target.value.toUpperCase() })}
          className="num mt-1 w-full border border-line bg-void px-2 py-1 text-[12px] uppercase tracking-wide text-prim outline-none focus:border-accent"
          spellCheck={false}
          maxLength={28}
        />
      </label>

      {zone.line ? (
        <div className="border border-accent/25 bg-accent/5 px-2 py-1.5">
          <div className="flex items-center justify-between">
            <span className="lbl text-accent/90">BOUNDARY LINE</span>
            <span className="lbl-faint">{zone.line.length} PTS</span>
          </div>
          <div className="lbl-faint mt-1 leading-4">THE TINTED SIDE IS ARMED — YOUR PROPERTY.</div>
          <button onClick={onFlipSide} className="lbl mt-1.5 w-full border border-accent/50 bg-accent/10 px-2 py-1 text-accent hover:bg-accent/20">
            ⇄ FLIP ARMED SIDE
          </button>
        </div>
      ) : (
        <div>
          <span className="lbl-faint">KIND</span>
          <div className="mt-1 flex flex-wrap gap-1">
            {KINDS.map((k) => {
              const on = zone.kind === k
              return (
                <button
                  key={k}
                  onClick={() => onSetKind(zone, k)}
                  className="lbl border px-1.5 py-0.5 transition-colors"
                  style={{ borderColor: on ? KIND_COLOR[k] : 'var(--line)', color: on ? KIND_COLOR[k] : 'var(--text-dim)', background: on ? `${KIND_COLOR[k]}1a` : 'transparent' }}
                >
                  {k}
                </button>
              )
            })}
          </div>
          <div className="lbl-faint mt-1 opacity-70">{KIND_HINT[zone.kind]}</div>
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        <ToggleRow label="ALERT ON ENTER" on={zone.alertOnEnter} onLabel="ARMED" offLabel="DISARMED" color="var(--accent-green)" onToggle={() => onPatch(zone, { alertOnEnter: !zone.alertOnEnter })} />
        <ToggleRow label="SCHEDULE" on={zone.nightOnly} onLabel="NIGHT ONLY" offLabel="ALWAYS" color="var(--accent-violet)" onToggle={() => onPatch(zone, { nightOnly: !zone.nightOnly })} />
      </div>

      <div className="border border-line bg-void/50 px-2 py-1.5">
        <div className="flex items-center justify-between">
          <span className="lbl-faint">WATCH STATUS</span>
          <StatusReadout zone={zone} night={night} />
        </div>
        {zone.nightOnly && <div className="lbl-faint mt-1 opacity-70">NIGHT WINDOW 21:00–07:00 · CURRENTLY {night ? 'ACTIVE' : 'INACTIVE'}</div>}
      </div>

      <button onClick={onDelete} className="lbl border border-line px-2 py-1 text-dim hover:border-red hover:text-red">
        ✕ DELETE ZONE
      </button>
    </div>
  )
}

function StatusReadout({ zone, night }: { zone: Zone; night: boolean }): ReactNode {
  if (!zone.alertOnEnter) return <span className="lbl text-faint">DISARMED</span>
  if (zone.nightOnly && !night) return <span className="lbl text-violet">ARMED · IDLE (DAY)</span>
  return (
    <span className="lbl flex items-center gap-1 text-green">
      <span className="led-pulse h-1.5 w-1.5 rounded-full bg-green" /> WATCHING
    </span>
  )
}

function ToggleRow({ label, on, onLabel, offLabel, color, onToggle }: { label: string; on: boolean; onLabel: string; offLabel: string; color: string; onToggle: () => void }): ReactNode {
  return (
    <div className="flex items-center justify-between">
      <span className="lbl-faint">{label}</span>
      <button onClick={onToggle} className="lbl border px-2 py-0.5 transition-colors" style={{ borderColor: on ? color : 'var(--line)', color: on ? color : 'var(--text-dim)' }}>
        {on ? onLabel : offLabel}
      </button>
    </div>
  )
}
