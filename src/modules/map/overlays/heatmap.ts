/**
 * HEATMAP overlay — the AI predictive layer. Violet ONLY, per the design
 * system. Radial blobs per sector, scored from the store's HotspotForecast
 * probabilities plus district baseRisk × night, breathing on a ~3 s pulse.
 * The blob sprite is pre-rendered once; the frame path is drawImage only.
 */
import type { HotspotForecast, World } from '../../../sim/types'
import type { MapCamera } from '../camera'
import type { CityCache } from '../cityRender'

let blob: HTMLCanvasElement | null = null

function getBlob(): HTMLCanvasElement {
  if (blob) return blob
  const c = document.createElement('canvas')
  c.width = 160
  c.height = 160
  const ctx = c.getContext('2d')
  if (ctx) {
    const g = ctx.createRadialGradient(80, 80, 4, 80, 80, 80)
    g.addColorStop(0, 'rgba(139,92,246,0.55)')
    g.addColorStop(0.45, 'rgba(139,92,246,0.22)')
    g.addColorStop(1, 'rgba(139,92,246,0)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, 160, 160)
  }
  blob = c
  return c
}

export function drawHeatmap(
  ctx: CanvasRenderingContext2D,
  cam: MapCamera,
  world: World,
  hotspots: HotspotForecast[],
  cache: CityCache,
  now: number,
): void {
  const sprite = getBlob()
  const sc = cam.scale
  const ox = cam.viewW / 2 - cam.cx * sc
  const oy = cam.viewH / 2 - cam.cy * sc

  ctx.save()
  ctx.globalCompositeOperation = 'lighter'
  for (let si = 0; si < cache.sectorIds.length; si++) {
    const d = world.city.districts[si]
    let score = d.baseRisk * world.night * 0.5
    for (let h = 0; h < hotspots.length; h++) {
      if (hotspots[h].sector === cache.sectorIds[si]) {
        score += hotspots[h].probability * 0.85
        break
      }
    }
    if (score < 0.05) continue
    /* slow ~3 s alpha pulse, phase-offset per sector */
    const pulse = 0.72 + 0.28 * Math.sin(now * 0.0021 + si * 1.7)
    const a = Math.min(0.55, score * 0.6) * pulse
    const r = cache.districtR[si] * (0.9 + 0.06 * Math.sin(now * 0.0013 + si)) * sc
    const x = cache.districtCX[si] * sc + ox
    const y = cache.districtCY[si] * sc + oy
    if (x + r < 0 || x - r > cam.viewW || y + r < 0 || y - r > cam.viewH) continue
    ctx.globalAlpha = a
    ctx.drawImage(sprite, x - r, y - r, r * 2, r * 2)
  }
  ctx.restore()
}
