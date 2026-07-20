/**
 * TACTICAL MAP — 2D viewport camera.
 *
 * World units → screen px. zoom = 1 fits the whole city in the viewport
 * (baseScale), clamped to 0.5×–6×. Supports drag-pan, wheel-zoom anchored at
 * the cursor, a 350 ms fly-to animation on the tactical ease curve, and a
 * smooth follow lerp. A module-level singleton preserves the operator's
 * viewport across view switches (the component re-binds on mount).
 */
import { clamp } from '../../lib/geometry'

export const MIN_ZOOM = 0.5
export const MAX_ZOOM = 6
export const FLY_MS = 350

/* cubic-bezier(0.2, 0.8, 0.2, 1) — the design system's --ease-tac */
const P1X = 0.2
const P1Y = 0.8
const P2X = 0.2
const P2Y = 1

function bez(t: number, p1: number, p2: number): number {
  const u = 1 - t
  return 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t
}

function bezSlope(t: number, p1: number, p2: number): number {
  const u = 1 - t
  return 3 * u * u * p1 + 6 * u * t * (p2 - p1) + 3 * t * t * (1 - p2)
}

/** evaluate cubic-bezier(0.2, 0.8, 0.2, 1) at progress x ∈ [0,1] */
export function easeTac(x: number): number {
  if (x <= 0) return 0
  if (x >= 1) return 1
  let t = x
  for (let i = 0; i < 6; i++) {
    const err = bez(t, P1X, P2X) - x
    if (err > -1e-4 && err < 1e-4) break
    const d = bezSlope(t, P1X, P2X)
    if (d < 1e-6 && d > -1e-6) break
    t = clamp(t - err / d, 0, 1)
  }
  return bez(t, P1Y, P2Y)
}

export class MapCamera {
  /** world-space view center */
  cx: number
  cy: number
  /** 0.5..6, 1 = whole city fits */
  zoom = 1
  viewW = 1
  viewH = 1
  /** id of the entity a fly-to is targeting (retargeted live while flying) */
  flyTargetId: string | null = null

  private readonly worldW: number
  private readonly worldH: number
  private baseScale = 1

  private flyActive = false
  private flyStart = 0
  private fromCx = 0
  private fromCy = 0
  private fromZoom = 1
  private toCx = 0
  private toCy = 0
  private toZoom = 1

  constructor(worldW: number, worldH: number) {
    this.worldW = worldW
    this.worldH = worldH
    this.cx = worldW / 2
    this.cy = worldH / 2
  }

  get scale(): number {
    return this.baseScale * this.zoom
  }

  get isFlying(): boolean {
    return this.flyActive
  }

  setViewport(w: number, h: number): void {
    this.viewW = Math.max(1, w)
    this.viewH = Math.max(1, h)
    this.baseScale = Math.min(this.viewW / this.worldW, this.viewH / this.worldH)
    this.clampCenter()
  }

  /* world → screen */
  sx(wx: number): number {
    return (wx - this.cx) * this.scale + this.viewW / 2
  }

  sy(wy: number): number {
    return (wy - this.cy) * this.scale + this.viewH / 2
  }

  /* screen → world */
  wx(sx: number): number {
    return (sx - this.viewW / 2) / this.scale + this.cx
  }

  wy(sy: number): number {
    return (sy - this.viewH / 2) / this.scale + this.cy
  }

  /** drag by screen-px delta (cancels any fly) */
  panBy(dxPx: number, dyPx: number): void {
    this.cancelFly()
    const s = this.scale
    this.cx -= dxPx / s
    this.cy -= dyPx / s
    this.clampCenter()
  }

  /** multiply zoom by `factor`, keeping the world point under (sx, sy) fixed */
  zoomAt(sx: number, sy: number, factor: number): void {
    this.cancelFly()
    const ax = this.wx(sx)
    const ay = this.wy(sy)
    this.zoom = clamp(this.zoom * factor, MIN_ZOOM, MAX_ZOOM)
    const s = this.scale
    this.cx = ax - (sx - this.viewW / 2) / s
    this.cy = ay - (sy - this.viewH / 2) / s
    this.clampCenter()
  }

  centerOn(wx: number, wy: number): void {
    this.cancelFly()
    this.cx = wx
    this.cy = wy
    this.clampCenter()
  }

  /** kick off the 350 ms fly-to animation toward an entity */
  flyToEntity(id: string, wx: number, wy: number, targetZoom: number, now: number): void {
    this.flyActive = true
    this.flyTargetId = id
    this.flyStart = now
    this.fromCx = this.cx
    this.fromCy = this.cy
    this.fromZoom = this.zoom
    this.toCx = wx
    this.toCy = wy
    this.toZoom = clamp(targetZoom, MIN_ZOOM, MAX_ZOOM)
  }

  /** update the fly destination mid-flight (target entity keeps moving) */
  retargetFly(wx: number, wy: number): void {
    if (!this.flyActive) return
    this.toCx = wx
    this.toCy = wy
  }

  cancelFly(): void {
    this.flyActive = false
    this.flyTargetId = null
  }

  /** advance the fly animation; call once per frame */
  update(now: number): void {
    if (!this.flyActive) return
    const t = clamp((now - this.flyStart) / FLY_MS, 0, 1)
    const e = easeTac(t)
    this.cx = this.fromCx + (this.toCx - this.fromCx) * e
    this.cy = this.fromCy + (this.toCy - this.fromCy) * e
    this.zoom = this.fromZoom + (this.toZoom - this.fromZoom) * e
    if (t >= 1) {
      this.flyActive = false
      this.flyTargetId = null
    }
    this.clampCenter()
  }

  /** exponential follow lerp toward a world point (FOLLOW mode) */
  followTowards(tx: number, ty: number, dtMs: number): void {
    const k = 1 - Math.exp(-dtMs / 150)
    this.cx += (tx - this.cx) * k
    this.cy += (ty - this.cy) * k
    this.clampCenter()
  }

  private clampCenter(): void {
    const s = this.scale
    const hw = this.viewW / (2 * s)
    const hh = this.viewH / (2 * s)
    const slack = 90
    if (hw * 2 >= this.worldW + slack * 2) this.cx = this.worldW / 2
    else this.cx = clamp(this.cx, hw - slack, this.worldW - hw + slack)
    if (hh * 2 >= this.worldH + slack * 2) this.cy = this.worldH / 2
    else this.cy = clamp(this.cy, hh - slack, this.worldH - hh + slack)
  }
}

/* viewport survives view switches — module-level singleton */
let shared: MapCamera | null = null

export function getMapCamera(worldW: number, worldH: number): MapCamera {
  if (!shared) shared = new MapCamera(worldW, worldH)
  return shared
}
