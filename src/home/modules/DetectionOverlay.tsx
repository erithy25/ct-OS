import { useEffect, useRef, type RefObject } from 'react'
import { getTracks } from '../store'
import { registerSource } from '../cv/scheduler'
import type { DetClass, TrackedBox } from '../types'
import type { DetectSource } from '../cv/detector'

/* ── identity colors (canvas needs literals) ───────────────────────── */

const KNOWN_COLOR = '#34D399'
const UNKNOWN_COLOR = '#FF3B47'
const CLASS_COLOR: Record<DetClass, string> = {
  person: '#22D3EE', // pending — face engine hasn't judged yet
  vehicle: '#F5A623',
  animal: '#5EEAD4',
  package: '#8B5CF6',
  other: '#6B7C8F',
}

function colorFor(t: TrackedBox): string {
  if (t.cls === 'person') {
    if (t.identity === 'known') return KNOWN_COLOR
    if (t.identity === 'unknown') return UNKNOWN_COLOR
  }
  return CLASS_COLOR[t.cls]
}

function labelFor(t: TrackedBox): string {
  if (t.cls === 'person') {
    if (t.identity === 'known') return `${(t.personName ?? 'KNOWN').toUpperCase()} · ${t.personRole ?? 'HOUSEHOLD'}`
    if (t.identity === 'unknown') return 'UNKNOWN'
    return 'PERSON'
  }
  return `${t.label} ${(t.score * 100) | 0}%`
}

/* ── prediction + smoothing tunables ───────────────────────────────── */

/** extrapolate along the track velocity at most this far past the last det */
const PREDICT_CAP_MS = 200
/** fraction of the raw velocity lead actually applied (overshoot guard) */
const PREDICT_GAIN = 0.85
/** smoothing time constants — position snaps faster than size */
const TAU_POS_MS = 70
const TAU_SIZE_MS = 120
/** fade in after firstSeen / fade out after the track leaves the store */
const FADE_IN_MS = 120
const FADE_OUT_MS = 160
/** person boxes draw with this per-side inset (COCO runs loose) — visual only */
const PERSON_INSET = 0.03

interface DrawState {
  /** smoothed normalized [x, y, w, h] actually painted */
  box: [number, number, number, number]
  /** last smoothing step (wall ms) */
  lastStep: number
  /** wall ms the trackId vanished from the store, null while live */
  missingSince: number | null
  /** latest track snapshot — styles the fade-out after the track is gone */
  snap: TrackedBox
}

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v))

/** Predicted target box for a track at wall time `now`. */
function targetOf(t: TrackedBox, now: number): [number, number, number, number] {
  const lead = (Math.min(Math.max(0, now - t.updatedAt), PREDICT_CAP_MS) / 1000) * PREDICT_GAIN
  return [
    clamp01(t.box[0] + t.vel[0] * lead),
    clamp01(t.box[1] + t.vel[1] * lead),
    clamp01(t.box[2] + t.vel[2] * lead),
    clamp01(t.box[3] + t.vel[3] * lead),
  ]
}

type Media = HTMLVideoElement | HTMLImageElement

function naturalSize(el: Media): { w: number; h: number } {
  if (el instanceof HTMLVideoElement) return { w: el.videoWidth, h: el.videoHeight }
  return { w: el.naturalWidth, h: el.naturalHeight }
}

/**
 * Precision overlay: reads the identity-fused tracks every animation frame and
 * paints thin OUTLINE-ONLY rectangles (zero fill — nothing is ever shaded over
 * a person) with velocity prediction + critically-damped smoothing so boxes
 * ride the subject with no visible lag. Registers the tile's media element
 * with the scheduler and corrects for the `object-cover` crop (and mirror).
 */
export default function DetectionOverlay({ cameraId, mediaRef, mirror = false }: { cameraId: string; mediaRef: RefObject<Media | null>; mirror?: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const statesRef = useRef(new Map<number, DrawState>())

  useEffect(() => {
    const getter = (): DetectSource | null => {
      const el = mediaRef.current
      if (!el) return null
      const { w, h } = naturalSize(el)
      if (!w || !h) return null
      return { el, w, h }
    }
    const unregister = registerSource(cameraId, getter)
    return unregister
  }, [cameraId, mediaRef])

  useEffect(() => {
    const states = statesRef.current
    states.clear()
    let raf = 0
    const draw = () => {
      raf = requestAnimationFrame(draw)
      const canvas = canvasRef.current
      const media = mediaRef.current
      if (!canvas || !media) return
      const rect = canvas.getBoundingClientRect()
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      const cw = Math.round(rect.width)
      const ch = Math.round(rect.height)
      if (cw === 0 || ch === 0) return
      if (canvas.width !== cw * dpr || canvas.height !== ch * dpr) {
        canvas.width = cw * dpr
        canvas.height = ch * dpr
      }
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, cw, ch)

      const now = Date.now()
      const tracks = getTracks(cameraId)
      if (tracks.length === 0 && states.size === 0) return

      const { w: sw, h: sh } = naturalSize(media)
      if (!sw || !sh) return
      // object-cover transform: source → display
      const scale = Math.max(cw / sw, ch / sh)
      const ox = (sw * scale - cw) / 2
      const oy = (sh * scale - ch) / 2

      // ── advance draw states toward each live track's predicted target ──
      const liveIds = new Set<number>()
      for (const t of tracks) {
        liveIds.add(t.trackId)
        const target = targetOf(t, now)
        let st = states.get(t.trackId)
        if (!st) {
          // new track materializes at its own target — never flies in
          st = { box: [target[0], target[1], target[2], target[3]], lastStep: now, missingSince: null, snap: t }
          states.set(t.trackId, st)
        } else {
          const dt = Math.max(0, now - st.lastStep)
          const kPos = 1 - Math.exp(-dt / TAU_POS_MS)
          const kSize = 1 - Math.exp(-dt / TAU_SIZE_MS)
          st.box[0] += (target[0] - st.box[0]) * kPos
          st.box[1] += (target[1] - st.box[1]) * kPos
          st.box[2] += (target[2] - st.box[2]) * kSize
          st.box[3] += (target[3] - st.box[3]) * kSize
          st.lastStep = now
          st.missingSince = null
          st.snap = t
        }
      }

      // ── paint every state (live + fading-out ghosts) ──
      for (const [trackId, st] of states) {
        let alpha = clamp01((now - st.snap.firstSeen) / FADE_IN_MS)
        if (!liveIds.has(trackId)) {
          if (st.missingSince === null) st.missingSince = now
          const out = 1 - (now - st.missingSince) / FADE_OUT_MS
          if (out <= 0) {
            states.delete(trackId)
            continue
          }
          alpha *= out
        }
        if (alpha <= 0) continue

        let [nx, ny, nw, nh] = st.box
        if (st.snap.cls === 'person') {
          // visual-only tightening — stored boxes stay raw for the zone watch
          nx += nw * PERSON_INSET
          ny += nh * PERSON_INSET
          nw *= 1 - PERSON_INSET * 2
          nh *= 1 - PERSON_INSET * 2
        }
        let x = nx * sw * scale - ox
        const y = ny * sh * scale - oy
        const w = nw * sw * scale
        const h = nh * sh * scale
        if (mirror) x = cw - x - w
        if (w <= 1 || h <= 1) continue

        const color = colorFor(st.snap)
        drawOutline(ctx, x, y, w, h, color, alpha)
        drawChip(ctx, x, y, labelFor(st.snap), color, alpha, cw, ch)
      }
      ctx.globalAlpha = 1
    }
    raf = requestAnimationFrame(draw)
    return () => {
      cancelAnimationFrame(raf)
      states.clear()
    }
  }, [cameraId, mediaRef, mirror])

  return <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden />
}

/* ── painters ──────────────────────────────────────────────────────── */

/**
 * OUTLINE ONLY — a thin crisp rectangle plus heavier corner ticks. There is
 * deliberately NO fill of the box area, ever.
 */
function drawOutline(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string, alpha: number): void {
  // snap to the half-pixel grid so the thin stroke stays crisp
  const rx = Math.round(x) + 0.5
  const ry = Math.round(y) + 0.5
  const rw = Math.round(w)
  const rh = Math.round(h)

  ctx.strokeStyle = color
  ctx.globalAlpha = 0.95 * alpha
  ctx.lineWidth = 1.5
  ctx.strokeRect(rx, ry, rw, rh)

  // tactical corner ticks
  const tl = Math.min(7, rw * 0.3, rh * 0.3)
  if (tl >= 2) {
    ctx.lineWidth = 2.5
    ctx.beginPath()
    ctx.moveTo(rx, ry + tl); ctx.lineTo(rx, ry); ctx.lineTo(rx + tl, ry)
    ctx.moveTo(rx + rw - tl, ry); ctx.lineTo(rx + rw, ry); ctx.lineTo(rx + rw, ry + tl)
    ctx.moveTo(rx + rw, ry + rh - tl); ctx.lineTo(rx + rw, ry + rh); ctx.lineTo(rx + rw - tl, ry + rh)
    ctx.moveTo(rx + tl, ry + rh); ctx.lineTo(rx, ry + rh); ctx.lineTo(rx, ry + rh - tl)
    ctx.stroke()
  }
  ctx.globalAlpha = 1
}

/** Identity chip directly above the box (tucked below the top edge if clipped). */
function drawChip(ctx: CanvasRenderingContext2D, x: number, y: number, text: string, color: string, alpha: number, cw: number, ch: number): void {
  ctx.font = '600 10px "JetBrains Mono", monospace'
  const padX = 4
  const padY = 2
  const dot = 3
  const gap = 4
  const tw = ctx.measureText(text).width
  const chipW = padX * 2 + dot + gap + tw
  const chipH = 10 + padY * 2

  let bx = Math.round(x)
  let by = Math.round(y) - chipH - 3
  if (by < 1) by = Math.round(y) + 3 // clipped at the top → sit inside the box
  bx = Math.max(1, Math.min(bx, cw - chipW - 1))
  by = Math.max(1, Math.min(by, ch - chipH - 1))

  ctx.globalAlpha = alpha
  ctx.fillStyle = 'rgba(5,7,10,0.82)'
  ctx.fillRect(bx, by, chipW, chipH)
  ctx.strokeStyle = color
  ctx.lineWidth = 1
  ctx.strokeRect(bx + 0.5, by + 0.5, chipW - 1, chipH - 1)

  ctx.fillStyle = color
  ctx.fillRect(bx + padX, by + chipH / 2 - dot / 2, dot, dot)
  const prevBaseline = ctx.textBaseline
  ctx.textBaseline = 'middle'
  ctx.fillText(text, bx + padX + dot + gap, by + chipH / 2 + 0.5)
  ctx.textBaseline = prevBaseline
  ctx.globalAlpha = 1
}
