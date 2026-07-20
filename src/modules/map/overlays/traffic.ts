/**
 * TRAFFIC overlay — road segments tinted by their sector's live congestion,
 * green → amber → red, majors emphasized. Segments are pre-grouped by
 * sector × class so the frame path is 18 batched strokes with colors pulled
 * from a precomputed ramp (no string building per frame).
 */
import type { World } from '../../../sim/types'
import type { MapCamera } from '../camera'
import { strokeSegList, type CityCache } from '../cityRender'

const RAMP_N = 16

function rampColor(c: number, alpha: number): string {
  let r: number
  let g: number
  let b: number
  if (c <= 0.5) {
    const t = c * 2
    r = 52 + (245 - 52) * t
    g = 211 + (166 - 211) * t
    b = 153 + (35 - 153) * t
  } else {
    const t = (c - 0.5) * 2
    r = 245 + (255 - 245) * t
    g = 166 + (59 - 166) * t
    b = 35 + (71 - 35) * t
  }
  return `rgba(${r | 0},${g | 0},${b | 0},${alpha})`
}

const MINOR_RAMP: string[] = []
const MAJOR_RAMP: string[] = []
for (let i = 0; i <= RAMP_N; i++) {
  MINOR_RAMP.push(rampColor(i / RAMP_N, 0.4))
  MAJOR_RAMP.push(rampColor(i / RAMP_N, 0.75))
}

function bucketOf(c: number): number {
  const b = Math.round(c * RAMP_N)
  return b < 0 ? 0 : b > RAMP_N ? RAMP_N : b
}

export function drawTraffic(ctx: CanvasRenderingContext2D, cam: MapCamera, world: World, cache: CityCache): void {
  const sc = cam.scale
  const ox = cam.viewW / 2 - cam.cx * sc
  const oy = cam.viewH / 2 - cam.cy * sc
  const wx0 = cam.wx(0)
  const wy0 = cam.wy(0)
  const wx1 = cam.wx(cam.viewW)
  const wy1 = cam.wy(cam.viewH)

  for (let si = 0; si < cache.sectorIds.length; si++) {
    cache.cong[si] = world.congestion[cache.sectorIds[si]] ?? 0
  }

  /* minors first, majors on top for emphasis */
  ctx.lineWidth = 1.25
  for (let si = 0; si < cache.sectorIds.length; si++) {
    const list = cache.segsSectorMinor[si]
    if (list.length === 0) continue
    ctx.strokeStyle = MINOR_RAMP[bucketOf(cache.cong[si])]
    ctx.beginPath()
    if (strokeSegList(ctx, cache, list, sc, ox, oy, wx0, wy0, wx1, wy1) > 0) ctx.stroke()
  }
  ctx.lineWidth = 2.5
  for (let si = 0; si < cache.sectorIds.length; si++) {
    const list = cache.segsSectorMajor[si]
    if (list.length === 0) continue
    ctx.strokeStyle = MAJOR_RAMP[bucketOf(cache.cong[si])]
    ctx.beginPath()
    if (strokeSegList(ctx, cache, list, sc, ox, oy, wx0, wy0, wx1, wy1) > 0) ctx.stroke()
  }
}
