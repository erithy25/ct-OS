/**
 * CAM-01 — the operator's real webcam feed (the only real input in the app).
 *
 * COCO-SSD object detection with ease-follow bracket boxes, full HUD chrome,
 * and the BIOMETRIC mode: MediaPipe 468-point face mesh + a fully simulated
 * identity-resolution sequence (sweep → candidate cycling → SIMULATED MATCH).
 *
 * All pipeline state lives at module level so remounts (grid ↔ expanded)
 * never re-prompt permission, re-download models, or reset the sequence.
 * Processing is driven by the grid's single rAF via `register` and pauses
 * when the tile unmounts (stream tracks are never stopped).
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useSim } from '../../sim/store'
import { Rand, hashString } from '../../sim/seed'
import { PERSON_POOL, getDossier, personIdFromIndex } from '../../sim/identityFactory'
import { fmtUTC, pad } from '../../lib/format'
import { alertTone, uiClick, uiSwitch } from '../../lib/audio'
import {
  cvSubscribe,
  cvVersion,
  ensureDetector,
  ensureWebcam,
  getDetector,
  getDetectorStatus,
  getWebcamError,
  getWebcamStatus,
  getWebcamStream,
  mergeDetections,
  retryWebcam,
  type TrackedBox,
} from './webcamCV'
import {
  ensureFaceLandmarker,
  getContours,
  getFaceLandmarker,
  getFaceStatus,
  getTesselation,
  retryFaceLandmarker,
  type NormalizedLandmark,
} from './faceMesh'
import {
  AMBER,
  CYAN,
  CYAN_DIM,
  RED,
  TEXT_DIM,
  TEXT_FAINT,
  VIOLET,
  drawBracketBox,
  drawConfBar,
  drawCrosshair,
  drawGrain,
  drawStatic,
  hudText,
} from './hud'
import { TileShell, Field, type TickFn, type TickRegister } from './CamTile'
import BiometricOverlay, { type BioMatch, type BioPhase } from './BiometricOverlay'

const CAM01_TITLE = 'CAM-01 // NOVA HARBOR CORE'

/* ── module-level pipeline state (survives remounts) ───────────────── */

/** mirrored from the component so module-level report() can see the mode */
let biometricActiveFlag = false
let bioFailEmitted = false

const det = {
  frames: 0,
  frameIdx: 0,
  tracks: [] as TrackedBox[],
  busy: false,
  lastDetStart: 0,
  personCount: 0,
  labels: [] as string[],
  lastReport: 0,
  lastEmitAt: 0,
  lastEmittedCount: 0,
  /** rolling detections-per-second meter */
  dps: 0,
  dpsWindowStart: 0,
  dpsCount: 0,
}

interface BioState {
  phase: BioPhase
  faceFirstSeen: number
  faceLastSeen: number
  landmarks: NormalizedLandmark[] | null
  bbox: { x: number; y: number; w: number; h: number } | null
  phaseStart: number
  lastTs: number
  frameIdx: number
  candidates: string[]
  match: BioMatch | null
}

const bio: BioState = {
  phase: 'scan',
  faceFirstSeen: 0,
  faceLastSeen: 0,
  landmarks: null,
  bbox: null,
  phaseStart: 0,
  lastTs: 0,
  frameIdx: 0,
  candidates: [],
  match: null,
}

function resetBioToScan(): void {
  bio.phase = 'scan'
  bio.faceFirstSeen = 0
  bio.faceLastSeen = 0
  bio.landmarks = null
  bio.bbox = null
  bio.match = null
}

function makeBioMatch(): BioMatch {
  const minuteOfDay = Math.floor(Date.now() / 60000) % 1440
  const id = personIdFromIndex(Math.abs(hashString(`bio:pick:${minuteOfDay}`)) % PERSON_POOL)
  const pct = new Rand(`bio:pct:${minuteOfDay}`).range(82, 94)
  return { id, pct, dossier: getDossier(id) }
}

function makeCandidates(): string[] {
  const minuteOfDay = Math.floor(Date.now() / 60000) % 1440
  const out: string[] = []
  for (let i = 0; i < 10; i++) {
    out.push(personIdFromIndex(Math.abs(hashString(`bio:cand:${minuteOfDay}:${i}`)) % PERSON_POOL))
  }
  return out
}

/** object-cover mapping: source video px → displayed container px */
function coverMap(vw: number, vh: number, cw: number, ch: number): { s: number; ox: number; oy: number } {
  const s = Math.max(cw / vw, ch / vh)
  return { s, ox: (cw - vw * s) / 2, oy: (ch - vh * s) / 2 }
}

/* ── component ─────────────────────────────────────────────────────── */

interface Cam01TileProps {
  expanded: boolean
  biometric: boolean
  onToggleBiometric: (on: boolean) => void
  register: TickRegister
}

export default function Cam01Tile({ expanded, biometric, onToggleBiometric, register }: Cam01TileProps) {
  useSyncExternalStore(cvSubscribe, cvVersion)
  const webcamStatus = getWebcamStatus()
  const detectorStatus = getDetectorStatus()
  const faceStatus = getFaceStatus()

  const videoRef = useRef<HTMLVideoElement>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)
  const biometricRef = useRef(biometric)
  biometricRef.current = biometric

  const [phase, setPhase] = useState<BioPhase>(bio.phase)
  const [faceSeen, setFaceSeen] = useState(false)

  /* acquire webcam once; load detector when live */
  useEffect(() => {
    void ensureWebcam()
  }, [])
  useEffect(() => {
    if (webcamStatus === 'live') void ensureDetector()
  }, [webcamStatus])

  /* attach the singleton stream to this mount's <video> */
  useEffect(() => {
    const video = videoRef.current
    const stream = getWebcamStream()
    if (webcamStatus === 'live' && video && stream && video.srcObject !== stream) {
      video.srcObject = stream
      void video.play().catch(() => undefined)
    }
  }, [webcamStatus])

  /* biometric mode: load the landmarker; auto-exit (with badge) if it fails */
  useEffect(() => {
    biometricActiveFlag = biometric
    if (!biometric) return
    if (faceStatus === 'failed') {
      if (!bioFailEmitted) {
        bioFailEmitted = true
        useSim.getState().emit('WARN', 'CV', 'BIOMETRIC MODEL UNAVAILABLE — CONTINUING OPTICAL DETECTION')
      }
      onToggleBiometric(false)
      return
    }
    bioFailEmitted = false
    void ensureFaceLandmarker()
    resetBioToScan()
  }, [biometric, faceStatus, onToggleBiometric])

  /* ── frame processing, driven by the grid's single rAF ── */
  useEffect(() => {
    const tick: TickFn = (t) => {
      const canvas = overlayRef.current
      const video = videoRef.current
      if (!canvas) return
      const cw = canvas.clientWidth
      const ch = canvas.clientHeight
      if (cw === 0 || ch === 0) return
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const W = Math.floor(cw * dpr)
      const H = Math.floor(ch * dpr)
      if (canvas.width !== W || canvas.height !== H) {
        canvas.width = W
        canvas.height = H
      }
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, cw, ch)

      const status = getWebcamStatus()
      if (status !== 'live' || !video) {
        if (status === 'denied') drawStatic(ctx, cw, ch, t)
        else drawGrain(ctx, cw, ch, 0.14)
        drawHud(ctx, cw, ch, t, false)
        report(t) // keep the sim informed — CV offline while the link is down
        return
      }

      det.frames++
      const ready = video.readyState >= 2 && video.videoWidth > 0

      if (ready) {
        const inBio = biometricRef.current && getFaceStatus() === 'ready'
        if (inBio) bioTick(ctx, video, cw, ch, t)
        else detTick(ctx, video, cw, ch, t)
      } else {
        drawGrain(ctx, cw, ch, 0.1)
      }

      drawCrosshair(ctx, cw, ch)
      drawHud(ctx, cw, ch, t, true, video)
      report(t)

      // mirror phase/face flags into React (bails out when unchanged)
      setPhase(bio.phase)
      setFaceSeen(bio.landmarks !== null && t - bio.faceLastSeen < 600)
    }

    register('CAM-01', tick)
    return () => {
      register('CAM-01', null)
      // pausing processing — report zero subjects once, keep model status
      useSim.getState().reportCv(getDetectorStatus() === 'ready', 0, [])
    }
  }, [register])

  /* ── UI callbacks ── */
  const onBiometricBtn = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      uiSwitch()
      if (biometric) {
        onToggleBiometric(false)
        return
      }
      if (getFaceStatus() === 'failed') void retryFaceLandmarker()
      onToggleBiometric(true)
    },
    [biometric, onToggleBiometric],
  )

  const onRetryCam = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    uiClick()
    void retryWebcam().then((s) => {
      const video = videoRef.current
      if (s && video) {
        video.srcObject = s
        void video.play().catch(() => undefined)
      }
    })
  }, [])

  const exitBiometric = useCallback(() => {
    uiClick()
    onToggleBiometric(false)
  }, [onToggleBiometric])

  const bioBtnActive = biometric
  return (
    <TileShell
      camId="CAM-01"
      label="NOVA HARBOR CORE · OPERATOR OPTIC"
      online={webcamStatus === 'live'}
      uptime="LIVE"
      expanded={expanded}
      headerRight={
        <button
          className={`lbl shrink-0 border px-1 py-px transition-colors duration-150 ease-tac ${
            bioBtnActive
              ? 'border-violet bg-violet/10 text-violet shadow-glow-violet'
              : 'border-line text-dim hover:border-lineb hover:text-prim'
          }`}
          onClick={onBiometricBtn}
          title="TOGGLE BIOMETRIC MODE"
        >
          ◇ BIOMETRIC
        </button>
      }
      footer={expanded ? <Cam01Footer biometric={biometric} /> : undefined}
    >
      <video
        ref={videoRef}
        className="absolute inset-0 h-full w-full object-cover"
        style={{ transform: 'scaleX(-1)', opacity: webcamStatus === 'live' ? 1 : 0 }}
        playsInline
        muted
      />
      <canvas ref={overlayRef} className="absolute inset-0 h-full w-full" />

      {/* permission / link states */}
      {webcamStatus === 'requesting' && (
        <CenterBadge className="sv-shimmer border-line text-dim">AWAITING OPTICAL LINK — GRANT CAMERA ACCESS</CenterBadge>
      )}
      {webcamStatus === 'denied' && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2">
          <div className="lbl border border-red/70 bg-void/80 px-2 py-1 text-red">
            NO SIGNAL // PERMISSION DENIED
          </div>
          <div className="lbl-faint">{getWebcamError() || 'OPTICAL LINK REFUSED BY OPERATOR'}</div>
          <button
            className="lbl mt-1 border border-line bg-panel px-3 py-1 text-dim transition-colors duration-150 ease-tac hover:border-accent hover:text-accent"
            onClick={onRetryCam}
          >
            ▸ RETRY LINK
          </button>
        </div>
      )}

      {/* CV model states (detection mode) */}
      {webcamStatus === 'live' && detectorStatus === 'loading' && !biometric && (
        <CenterBadge className="sv-shimmer border-accent/40 text-accent">CV SUBSYSTEM SYNCING…</CenterBadge>
      )}
      {webcamStatus === 'live' && detectorStatus === 'failed' && (
        <div className="absolute left-1/2 top-2 z-10 -translate-x-1/2">
          <span className="lbl border border-amber/70 bg-void/85 px-2 py-0.5 text-amber">CV OFFLINE</span>
        </div>
      )}
      {/* persistent badge after a failed biometric model load */}
      {webcamStatus === 'live' && faceStatus === 'failed' && (
        <div className="absolute bottom-7 left-1/2 z-10 -translate-x-1/2">
          <span className="lbl border border-amber/70 bg-void/85 px-2 py-0.5 text-amber">
            BIOMETRIC OFFLINE — MODEL UNAVAILABLE
          </span>
        </div>
      )}

      {biometric && webcamStatus === 'live' && (
        <BiometricOverlay
          phase={phase}
          faceStatus={faceStatus}
          faceSeen={faceSeen}
          candidates={bio.candidates}
          match={bio.match}
          compact={!expanded}
          onExit={exitBiometric}
        />
      )}
    </TileShell>
  )
}

function CenterBadge({ children, className }: { children: React.ReactNode; className: string }) {
  return (
    <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
      <span className={`lbl border bg-void/80 px-3 py-1 ${className}`}>{children}</span>
    </div>
  )
}

/* expanded-mode telemetry strip */
function Cam01Footer({ biometric }: { biometric: boolean }) {
  const cvSubjects = useSim((s) => s.cvSubjects)
  const cvOnline = useSim((s) => s.cvOnline)
  const [, force] = useState(0)
  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), 500)
    return () => clearInterval(id)
  }, [])
  const video = getWebcamStream()?.getVideoTracks()[0]?.getSettings()

  return (
    <div className="grid shrink-0 grid-cols-6 gap-2 border-t border-line bg-panel px-2 py-1.5">
      <Field k="MODE" v={biometric ? 'BIOMETRIC' : 'DETECTION'} color={biometric ? 'var(--accent-violet)' : 'var(--accent)'} />
      <Field k="MODEL" v={biometric ? 'FACE-LMK 468' : 'COCO-SSD LITE'} />
      <Field k="INFER RATE" v={`${det.dps.toFixed(0)} DET/S`} />
      <Field k="SUBJECTS" v={String(cvSubjects)} color={cvSubjects > 0 ? 'var(--accent)' : undefined} />
      <Field k="RES" v={`${video?.width ?? 640}×${video?.height ?? 480}`} />
      <Field k="CV LINK" v={cvOnline ? 'ONLINE' : 'OFFLINE'} color={cvOnline ? 'var(--accent-green)' : 'var(--accent-amber)'} />
    </div>
  )
}

/* ── HUD chrome ────────────────────────────────────────────────────── */

function drawHud(
  ctx: CanvasRenderingContext2D,
  cw: number,
  ch: number,
  t: number,
  live: boolean,
  video?: HTMLVideoElement | null,
): void {
  const d = new Date()
  hudText(ctx, CAM01_TITLE, 6, 5, live ? TEXT_DIM : TEXT_FAINT)
  hudText(ctx, `UTC ${fmtUTC(d)}.${pad(Math.floor(d.getUTCMilliseconds() / 10))}`, cw - 6, 5, live ? TEXT_DIM : TEXT_FAINT, {
    anchor: 'tr',
  })
  // REC ● + frame counter
  if (live) {
    const pulse = 0.45 + 0.55 * Math.abs(Math.sin(t / 320))
    ctx.save()
    ctx.globalAlpha = pulse
    ctx.fillStyle = RED
    ctx.beginPath()
    ctx.arc(10, ch - 10, 2.5, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
    hudText(ctx, `REC  F ${String(det.frames % 1000000).padStart(6, '0')}`, 17, ch - 5, TEXT_DIM, { anchor: 'bl', back: false })
  } else {
    hudText(ctx, 'STANDBY', 6, ch - 5, TEXT_FAINT, { anchor: 'bl' })
  }
  const vw = video?.videoWidth || 640
  const vh = video?.videoHeight || 480
  hudText(ctx, `${vw}×${vh} · LOCAL PROCESS ONLY`, cw - 6, ch - 5, TEXT_FAINT, { anchor: 'br' })
}

/* ── detection mode ────────────────────────────────────────────────── */

function detTick(ctx: CanvasRenderingContext2D, video: HTMLVideoElement, cw: number, ch: number, t: number): void {
  det.frameIdx++
  const detector = getDetector()

  // cadence gate: every ~2 frames, one inference in flight, ≥66 ms apart
  if (detector && det.frameIdx % 2 === 0 && !det.busy && t - det.lastDetStart >= 66) {
    det.busy = true
    det.lastDetStart = t
    detector
      .detect(video, 12, 0.45)
      .then((dets) => {
        const now = performance.now()
        mergeDetections(det.tracks, dets, now)
        det.personCount = det.tracks.filter((b) => b.cls === 'person').length
        det.labels = [...new Set(det.tracks.map((b) => b.cls))]
        det.dpsCount++
        if (now - det.dpsWindowStart >= 1000) {
          det.dps = det.dpsCount / ((now - det.dpsWindowStart) / 1000)
          det.dpsWindowStart = now
          det.dpsCount = 0
        }
      })
      .catch(() => undefined)
      .finally(() => {
        det.busy = false
      })
  }

  if (!detector && det.tracks.length > 0) det.tracks.length = 0

  // draw ease-followed tracks (mirrored, object-cover mapped)
  const m = coverMap(video.videoWidth, video.videoHeight, cw, ch)
  for (const b of det.tracks) {
    if (t - b.lastSeen > 800) continue // stale (e.g. just returned from biometric mode)
    const w = b.w * m.s
    const h = b.h * m.s
    const x = cw - (b.x * m.s + m.ox) - w
    const y = b.y * m.s + m.oy
    const person = b.cls === 'person'
    const color = person ? CYAN : CYAN_DIM
    drawBracketBox(ctx, x, y, w, h, color, { lineWidth: person ? 1.25 : 1 })
    const labelY = Math.max(2, y - 14)
    hudText(ctx, `${b.cls.toUpperCase()} ${b.score.toFixed(2)}`, x, labelY, color)
    drawConfBar(ctx, x, labelY + 10, Math.min(w, 46), b.score, color)
  }
}

/** throttled 1 Hz store report + rate-limited CV events */
function report(t: number): void {
  if (t - det.lastReport < 1000) return
  det.lastReport = t
  const s = useSim.getState()
  const live = getWebcamStatus() === 'live'
  // while the face model is still loading, detection mode keeps running
  const bioLive = biometricActiveFlag && getFaceStatus() === 'ready'
  const subjects = bioLive ? (bio.landmarks !== null ? 1 : 0) : det.personCount
  const online = live && (bioLive || getDetectorStatus() === 'ready')
  s.reportCv(online, online ? subjects : 0, bioLive ? ['face'] : det.labels)

  // subject-count change events (detection mode only, ≥4 s apart)
  if (!biometricActiveFlag && online && t - det.lastEmitAt >= 4000 && det.personCount !== det.lastEmittedCount) {
    det.lastEmitAt = t
    det.lastEmittedCount = det.personCount
    const n = det.personCount
    s.emit(n > 0 ? 'NOTICE' : 'INFO', 'CV', `CV: ${n} SUBJECT${n === 1 ? '' : 'S'} IN FRAME — CAM-01`)
  }
}

/* ── biometric mode ────────────────────────────────────────────────── */

function bioTick(ctx: CanvasRenderingContext2D, video: HTMLVideoElement, cw: number, ch: number, t: number): void {
  const lm = getFaceLandmarker()
  if (!lm) return
  bio.frameIdx++

  if (bio.frameIdx % 2 === 0) {
    try {
      bio.lastTs = Math.max(bio.lastTs + 1, performance.now())
      const res = lm.detectForVideo(video, bio.lastTs)
      const face = res.faceLandmarks[0]
      if (face && face.length > 0) {
        bio.landmarks = face
        bio.faceLastSeen = t
        if (bio.faceFirstSeen === 0) bio.faceFirstSeen = t
      }
    } catch {
      /* frame dropped — keep previous landmarks briefly */
    }
  }

  // face lost > 2 s → back to scanning state
  if (bio.faceLastSeen !== 0 && t - bio.faceLastSeen > 2000) {
    resetBioToScan()
  }

  const faceFresh = bio.landmarks !== null && t - bio.faceLastSeen < 600
  const m = coverMap(video.videoWidth, video.videoHeight, cw, ch)

  if (faceFresh && bio.landmarks) {
    drawFaceMesh(ctx, bio.landmarks, video, m, cw)
    // smoothed display-space bbox
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const p of bio.landmarks) {
      const px = cw - (p.x * video.videoWidth * m.s + m.ox)
      const py = p.y * video.videoHeight * m.s + m.oy
      if (px < minX) minX = px
      if (px > maxX) maxX = px
      if (py < minY) minY = py
      if (py > maxY) maxY = py
    }
    const padX = (maxX - minX) * 0.12
    const padY = (maxY - minY) * 0.16
    const fresh = { x: minX - padX, y: minY - padY, w: maxX - minX + padX * 2, h: maxY - minY + padY * 2 }
    if (!bio.bbox) bio.bbox = fresh
    else {
      bio.bbox.x += (fresh.x - bio.bbox.x) * 0.35
      bio.bbox.y += (fresh.y - bio.bbox.y) * 0.35
      bio.bbox.w += (fresh.w - bio.bbox.w) * 0.35
      bio.bbox.h += (fresh.h - bio.bbox.h) * 0.35
    }
  }

  /* phase machine */
  switch (bio.phase) {
    case 'scan': {
      if (bio.bbox && faceFresh) {
        drawBracketBox(ctx, bio.bbox.x, bio.bbox.y, bio.bbox.w, bio.bbox.h, CYAN_DIM)
        const held = ((t - bio.faceFirstSeen) / 1000).toFixed(1)
        hudText(ctx, `ACQUIRING SUBJECT · ${held}S`, bio.bbox.x, Math.max(2, bio.bbox.y - 14), CYAN_DIM)
      }
      if (faceFresh && bio.faceFirstSeen !== 0 && t - bio.faceFirstSeen >= 1000) {
        bio.phase = 'sweep'
        bio.phaseStart = t
        uiSwitch()
      }
      break
    }
    case 'sweep': {
      const b = bio.bbox
      const p = Math.min(1, (t - bio.phaseStart) / 1400)
      if (b) {
        drawBracketBox(ctx, b.x, b.y, b.w, b.h, CYAN, { lineWidth: 1.25 })
        // two passes: down, then up
        const p2 = p * 2
        const seg = p2 % 1
        const yFrac = Math.floor(p2) % 2 === 0 ? seg : 1 - seg
        const ly = b.y + b.h * yFrac
        // swept-region tint
        ctx.fillStyle = 'rgba(34, 211, 238, 0.05)'
        ctx.fillRect(b.x, b.y, b.w, ly - b.y)
        // glowing scan line
        ctx.fillStyle = 'rgba(34, 211, 238, 0.16)'
        ctx.fillRect(b.x, ly - 2, b.w, 5)
        ctx.fillStyle = CYAN
        ctx.fillRect(b.x, ly, b.w, 1.5)
        hudText(ctx, `SCAN ${pad(Math.floor(p * 100), 3)}%`, b.x + b.w + 6, ly - 4, CYAN)
      }
      if (p >= 1) {
        bio.phase = 'resolve'
        bio.phaseStart = t
        bio.candidates = makeCandidates()
      }
      break
    }
    case 'resolve': {
      const b = bio.bbox
      if (b) {
        drawBracketBox(ctx, b.x, b.y, b.w, b.h, CYAN, { lineWidth: 1.25 })
      }
      if (t - bio.phaseStart >= 1150) {
        bio.phase = 'match'
        bio.phaseStart = t
        bio.match = makeBioMatch()
        alertTone(false)
        useSim
          .getState()
          .emit('NOTICE', 'CV', `BIOMETRIC RESOLVE (SIMULATED): ${bio.match.id} ${bio.match.pct.toFixed(1)}%`, undefined, bio.match.id)
      }
      break
    }
    case 'match': {
      const b = bio.bbox
      if (b && bio.match) {
        drawBracketBox(ctx, b.x, b.y, b.w, b.h, VIOLET, { lineWidth: 1.25 })
        hudText(ctx, `IDENT LOCK · ${bio.match.pct.toFixed(1)}%`, b.x, Math.max(2, b.y - 14), VIOLET)
      }
      break
    }
  }

  if (!faceFresh && bio.phase === 'scan') {
    hudText(ctx, 'SEARCHING FOR SUBJECT…', cw / 2, ch * 0.62, AMBER, { back: true, anchor: 'tc' })
  }
}

function drawFaceMesh(
  ctx: CanvasRenderingContext2D,
  landmarks: NormalizedLandmark[],
  video: HTMLVideoElement,
  m: { s: number; ox: number; oy: number },
  cw: number,
): void {
  const vw = video.videoWidth
  const vh = video.videoHeight
  const n = landmarks.length
  const xs = new Float32Array(n)
  const ys = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    xs[i] = cw - (landmarks[i].x * vw * m.s + m.ox)
    ys[i] = landmarks[i].y * vh * m.s + m.oy
  }

  // tesselation wireframe, low alpha
  const tess = getTesselation()
  ctx.strokeStyle = 'rgba(34, 211, 238, 0.25)'
  ctx.lineWidth = 0.5
  ctx.beginPath()
  for (const c of tess) {
    if (c.start >= n || c.end >= n) continue
    ctx.moveTo(xs[c.start], ys[c.start])
    ctx.lineTo(xs[c.end], ys[c.end])
  }
  ctx.stroke()

  // contours slightly brighter
  const cont = getContours()
  ctx.strokeStyle = 'rgba(34, 211, 238, 0.55)'
  ctx.lineWidth = 1
  ctx.beginPath()
  for (const c of cont) {
    if (c.start >= n || c.end >= n) continue
    ctx.moveTo(xs[c.start], ys[c.start])
    ctx.lineTo(xs[c.end], ys[c.end])
  }
  ctx.stroke()

  // landmark points
  ctx.fillStyle = 'rgba(34, 211, 238, 0.5)'
  for (let i = 0; i < n; i++) {
    ctx.fillRect(xs[i] - 0.5, ys[i] - 0.5, 1, 1)
  }
}
