/**
 * POWER overlay — dead sectors get a deep veil, a red boundary hairline and
 * a pulsing IEC breaker glyph at the district center. (The always-on
 * consequences — near-black blocks and the GRID DARK label — live in the
 * base city pass; this overlay is the explicit grid-status lens.)
 */
import type { InfraState, World } from '../../../sim/types'
import type { MapCamera } from '../camera'
import type { CityCache } from '../cityRender'
import { A_RED, aIdx } from '../colors'

export function drawPowerOverlay(
  ctx: CanvasRenderingContext2D,
  cam: MapCamera,
  world: World,
  infra: InfraState,
  cache: CityCache,
  now: number,
): void {
  const sc = cam.scale
  const ox = cam.viewW / 2 - cam.cx * sc
  const oy = cam.viewH / 2 - cam.cy * sc
  const pulse = 0.55 + 0.25 * Math.sin(now * 0.005)

  for (let si = 0; si < cache.sectorIds.length; si++) {
    if (infra.power[cache.sectorIds[si]] !== false) continue
    const poly = world.city.districts[si].polygon

    ctx.beginPath()
    ctx.moveTo(poly[0].x * sc + ox, poly[0].y * sc + oy)
    for (let k = 1; k < poly.length; k++) ctx.lineTo(poly[k].x * sc + ox, poly[k].y * sc + oy)
    ctx.closePath()
    ctx.fillStyle = 'rgba(2,4,8,0.5)'
    ctx.fill()
    ctx.strokeStyle = A_RED[aIdx(0.22)]
    ctx.lineWidth = 1
    ctx.stroke()

    /* IEC power glyph: broken ring + stem */
    const x = cache.districtCX[si] * sc + ox
    const y = cache.districtCY[si] * sc + oy - 26
    ctx.strokeStyle = A_RED[aIdx(pulse)]
    ctx.lineWidth = 1.4
    ctx.beginPath()
    ctx.arc(x, y, 6, -Math.PI / 2 + 0.6, -Math.PI / 2 - 0.6 + Math.PI * 2)
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(x, y - 8)
    ctx.lineTo(x, y - 1)
    ctx.stroke()
  }
}
