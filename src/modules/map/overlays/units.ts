/**
 * UNITS overlay — faint green patrol coverage circles (r ≈ 90 world units).
 * All twelve circles are pathed into one fill + one stroke.
 */
import { TAU } from '../../../lib/geometry'
import type { World } from '../../../sim/types'
import type { MapCamera } from '../camera'

const COVER_R = 90

export function drawUnitCoverage(ctx: CanvasRenderingContext2D, cam: MapCamera, world: World, alpha: number): void {
  const sc = cam.scale
  const ox = cam.viewW / 2 - cam.cx * sc
  const oy = cam.viewH / 2 - cam.cy * sc
  const r = COVER_R * sc
  const vw = cam.viewW
  const vh = cam.viewH

  ctx.beginPath()
  let n = 0
  for (let i = 0; i < world.patrols.length; i++) {
    const u = world.patrols[i]
    const x = (u.prevPos.x + (u.pos.x - u.prevPos.x) * alpha) * sc + ox
    const y = (u.prevPos.y + (u.pos.y - u.prevPos.y) * alpha) * sc + oy
    if (x + r < 0 || x - r > vw || y + r < 0 || y - r > vh) continue
    ctx.moveTo(x + r, y)
    ctx.arc(x, y, r, 0, TAU)
    n++
  }
  if (n === 0) return
  ctx.fillStyle = 'rgba(52,211,153,0.035)'
  ctx.fill()
  ctx.strokeStyle = 'rgba(52,211,153,0.13)'
  ctx.lineWidth = 1
  ctx.stroke()
}
