/**
 * Camera FOV layer. Online cameras cast translucent cyan wedges (alpha ~0.05,
 * surging toward ~0.18 for ~1.5 s after a detection, and reading stronger at
 * night). Offline cameras — e.g. in a powered-down sector — are drawn as dim
 * red glyphs by a separate pass that stays on even when the FOV overlay is
 * toggled off, because sensor loss is an infra consequence that must be
 * visible.
 */
import type { World } from '../../../sim/types'
import type { MapCamera } from '../camera'
import { A_ACCENT, A_RED, aIdx } from '../colors'

/** ticks a detection keeps the cone surged (10 Hz ⇒ 1.5 s) */
const DETECT_TICKS = 15

export function drawFovCones(ctx: CanvasRenderingContext2D, cam: MapCamera, world: World, now: number): void {
  const sc = cam.scale
  const ox = cam.viewW / 2 - cam.cx * sc
  const oy = cam.viewH / 2 - cam.cy * sc
  const vw = cam.viewW
  const vh = cam.viewH
  const nightBoost = 1 + world.night * 0.7

  for (let i = 0; i < world.cameras.length; i++) {
    const c = world.cameras[i]
    if (!c.online) continue
    const x = c.pos.x * sc + ox
    const y = c.pos.y * sc + oy
    const r = c.range * sc
    if (x + r < 0 || x - r > vw || y + r < 0 || y - r > vh) continue

    const since = world.tick - c.lastDetectionTick
    const det = since >= 0 && since < DETECT_TICKS ? 1 - since / DETECT_TICKS : 0
    let a = (0.05 + 0.13 * det) * nightBoost
    if (a > 0.28) a = 0.28

    ctx.fillStyle = A_ACCENT[aIdx(a)]
    ctx.beginPath()
    ctx.moveTo(x, y)
    ctx.arc(x, y, r, c.dir - c.fov, c.dir + c.fov)
    ctx.closePath()
    ctx.fill()
    ctx.strokeStyle = A_ACCENT[aIdx(Math.min(0.4, a * 1.6))]
    ctx.lineWidth = 1
    ctx.stroke()

    /* mount glyph (+ detection flash ring) */
    ctx.fillStyle = A_ACCENT[aIdx(0.45 + 0.55 * det)]
    ctx.fillRect(x - 1.5, y - 1.5, 3, 3)
    if (det > 0) {
      ctx.strokeStyle = A_ACCENT[aIdx(0.6 * det)]
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.arc(x, y, 5 + (1 - det) * 6, 0, Math.PI * 2)
      ctx.stroke()
    }
  }
}

/** offline sensors — always drawn, independent of the FOV toggle */
export function drawOfflineCameras(ctx: CanvasRenderingContext2D, cam: MapCamera, world: World, now: number): void {
  const sc = cam.scale
  const ox = cam.viewW / 2 - cam.cx * sc
  const oy = cam.viewH / 2 - cam.cy * sc
  const a = 0.4 + 0.18 * Math.sin(now * 0.006)

  for (let i = 0; i < world.cameras.length; i++) {
    const c = world.cameras[i]
    if (c.online) continue
    const x = c.pos.x * sc + ox
    const y = c.pos.y * sc + oy
    if (x < -8 || x > cam.viewW + 8 || y < -8 || y > cam.viewH + 8) continue
    ctx.fillStyle = A_RED[aIdx(a)]
    ctx.fillRect(x - 1.5, y - 1.5, 3, 3)
    ctx.strokeStyle = A_RED[aIdx(a * 0.8)]
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(x - 3.5, y - 3.5)
    ctx.lineTo(x + 3.5, y + 3.5)
    ctx.stroke()
  }
}
