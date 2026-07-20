/**
 * TACTICAL MAP — live entity layer.
 *
 * ~450 movers per frame, interpolated prevPos↔pos with the tick-wall alpha.
 * Draws are batched by style (single fillStyle per pass, diamonds share one
 * path) and every position is computed with plain arithmetic — no per-frame
 * allocations, no React state.
 */
import { TAU } from '../../lib/geometry'
import type { SimEntity, World } from '../../sim/types'
import type { MapCamera } from './camera'
import { A_ACCENT, A_GREEN, A_PRIM, A_RED, aIdx, FONT_9 } from './colors'

export interface EntityCaches {
  /** last known patrol headings (radians) — kept while a unit idles */
  headings: Float64Array
}

export function makeEntityCaches(world: World): EntityCaches {
  return { headings: new Float64Array(world.patrols.length) }
}

/* module-level singleton, same lifetime as the world */
let caches: EntityCaches | null = null

export function getEntityCaches(world: World): EntityCaches {
  if (!caches || caches.headings.length !== world.patrols.length) caches = makeEntityCaches(world)
  return caches
}

export function drawEntities(
  ctx: CanvasRenderingContext2D,
  cam: MapCamera,
  world: World,
  alpha: number,
  now: number,
  ec: EntityCaches,
): void {
  const sc = cam.scale
  const ox = cam.viewW / 2 - cam.cx * sc
  const oy = cam.viewH / 2 - cam.cy * sc
  const vw = cam.viewW
  const vh = cam.viewH
  /* mild presence scaling so glyphs stay readable when zoomed in */
  const f = Math.min(1.6, 1 + (cam.zoom - 1) * 0.12)

  /* ── vehicles: parked (dim) → moving (cyan) → stalled (amber jitter) ── */
  const vehicles = world.vehicles
  const vs = 2 * f

  ctx.fillStyle = 'rgba(107,124,143,0.22)'
  for (let i = 0; i < vehicles.length; i++) {
    const v = vehicles[i]
    if (v.parked !== true) continue
    const x = (v.prevPos.x + (v.pos.x - v.prevPos.x) * alpha) * sc + ox
    const y = (v.prevPos.y + (v.pos.y - v.prevPos.y) * alpha) * sc + oy
    if (x < -6 || x > vw + 6 || y < -6 || y > vh + 6) continue
    ctx.fillRect(x - vs / 2, y - vs / 2, vs, vs)
  }

  ctx.fillStyle = 'rgba(34,211,238,0.85)'
  for (let i = 0; i < vehicles.length; i++) {
    const v = vehicles[i]
    if (v.parked === true || v.stalled) continue
    const x = (v.prevPos.x + (v.pos.x - v.prevPos.x) * alpha) * sc + ox
    const y = (v.prevPos.y + (v.pos.y - v.prevPos.y) * alpha) * sc + oy
    if (x < -6 || x > vw + 6 || y < -6 || y > vh + 6) continue
    ctx.fillRect(x - vs / 2, y - vs / 2, vs, vs)
  }

  ctx.fillStyle = 'rgba(245,166,35,0.95)'
  for (let i = 0; i < vehicles.length; i++) {
    const v = vehicles[i]
    if (v.parked === true || !v.stalled) continue
    /* stress jitter — deterministic per index, no RNG in the hot loop */
    const jx = Math.sin(now * 0.021 + i * 7.7) * 0.7
    const jy = Math.cos(now * 0.019 + i * 3.1) * 0.7
    const x = (v.prevPos.x + (v.pos.x - v.prevPos.x) * alpha) * sc + ox + jx
    const y = (v.prevPos.y + (v.pos.y - v.prevPos.y) * alpha) * sc + oy + jy
    if (x < -6 || x > vw + 6 || y < -6 || y > vh + 6) continue
    ctx.fillRect(x - vs / 2, y - vs / 2, vs, vs)
  }

  /* ── persons: ambient dots, then watchlist diamonds in one path ────── */
  const persons = world.persons
  const ps = 1.5 * f

  ctx.fillStyle = 'rgba(107,124,143,0.55)'
  for (let i = 0; i < persons.length; i++) {
    const p = persons[i]
    if (p.watchlisted) continue
    const x = (p.prevPos.x + (p.pos.x - p.prevPos.x) * alpha) * sc + ox
    const y = (p.prevPos.y + (p.pos.y - p.prevPos.y) * alpha) * sc + oy
    if (x < -6 || x > vw + 6 || y < -6 || y > vh + 6) continue
    ctx.fillRect(x - ps / 2, y - ps / 2, ps, ps)
  }

  const ds = 3.5 * f
  ctx.fillStyle = 'rgba(245,166,35,0.92)'
  ctx.beginPath()
  let nd = 0
  for (let i = 0; i < persons.length; i++) {
    const p = persons[i]
    if (!p.watchlisted) continue
    const x = (p.prevPos.x + (p.pos.x - p.prevPos.x) * alpha) * sc + ox
    const y = (p.prevPos.y + (p.pos.y - p.prevPos.y) * alpha) * sc + oy
    if (x < -8 || x > vw + 8 || y < -8 || y > vh + 8) continue
    ctx.moveTo(x, y - ds)
    ctx.lineTo(x + ds, y)
    ctx.lineTo(x, y + ds)
    ctx.lineTo(x - ds, y)
    ctx.closePath()
    nd++
  }
  if (nd > 0) ctx.fill()

  /* ── patrols: green triangles rotated to heading ───────────────────── */
  const patrols = world.patrols
  const tip = 5.5 * f
  const back = 4.5 * f
  for (let i = 0; i < patrols.length; i++) {
    const u = patrols[i]
    const dxm = u.pos.x - u.prevPos.x
    const dym = u.pos.y - u.prevPos.y
    if (dxm * dxm + dym * dym > 1e-6) ec.headings[i] = Math.atan2(dym, dxm)
    const h = ec.headings[i]
    const x = (u.prevPos.x + dxm * alpha) * sc + ox
    const y = (u.prevPos.y + dym * alpha) * sc + oy
    if (x < -20 || x > vw + 20 || y < -20 || y > vh + 20) continue
    const ch = Math.cos(h)
    const sh = Math.sin(h)

    if (u.status === 'RESPONDING') {
      /* motion trail + halo — the hot unit */
      ctx.strokeStyle = A_GREEN[aIdx(0.35)]
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(x - ch * 6, y - sh * 6)
      ctx.lineTo(x - ch * 14, y - sh * 14)
      ctx.stroke()
      ctx.strokeStyle = A_GREEN[aIdx(0.15)]
      ctx.beginPath()
      ctx.moveTo(x - ch * 14, y - sh * 14)
      ctx.lineTo(x - ch * 22, y - sh * 22)
      ctx.stroke()
      ctx.fillStyle = A_GREEN[aIdx(0.12)]
      ctx.beginPath()
      ctx.arc(x, y, 8, 0, TAU)
      ctx.fill()
      ctx.fillStyle = 'rgba(125,255,209,0.98)'
    } else {
      ctx.fillStyle = 'rgba(52,211,153,0.92)'
    }

    ctx.beginPath()
    ctx.moveTo(x + ch * tip, y + sh * tip)
    ctx.lineTo(x + Math.cos(h + 2.62) * back, y + Math.sin(h + 2.62) * back)
    ctx.lineTo(x + Math.cos(h - 2.62) * back, y + Math.sin(h - 2.62) * back)
    ctx.closePath()
    ctx.fill()

    if (u.status === 'ON_SCENE') {
      ctx.strokeStyle = A_GREEN[aIdx(0.4 + 0.15 * Math.sin(now * 0.004 + i))]
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.arc(x, y, 7.5 * f, 0, TAU)
      ctx.stroke()
    }
  }

  /* ── incidents: red core + severity-scaled pulse rings ─────────────── */
  const incidents = world.incidents
  for (let i = 0; i < incidents.length; i++) {
    const inc = incidents[i]
    const fade = inc.phase === 'RESOLVED' ? Math.max(0, 1 - (world.tick - inc.phaseTick) / 80) : 1
    if (fade <= 0.01) continue
    const x = inc.pos.x * sc + ox
    const y = inc.pos.y * sc + oy
    if (x < -50 || x > vw + 50 || y < -50 || y > vh + 50) continue
    const sev = inc.severity
    const period = (2100 - sev * 260) * (inc.phase === 'ESCALATING' ? 0.55 : 1)
    const maxR = (8 + sev * 3.5) * f

    ctx.lineWidth = 1.25
    for (let k = 0; k < 2; k++) {
      const ph = (now / period + k * 0.5) % 1
      const a = (1 - ph) * 0.55 * fade
      ctx.strokeStyle = A_RED[aIdx(a)]
      ctx.beginPath()
      ctx.arc(x, y, 3 + ph * maxR, 0, TAU)
      ctx.stroke()
    }
    ctx.fillStyle = A_RED[aIdx(0.92 * fade)]
    ctx.beginPath()
    ctx.arc(x, y, 2.8 * f, 0, TAU)
    ctx.fill()
    ctx.fillStyle = A_PRIM[aIdx(0.75 * fade)]
    ctx.fillRect(x - 0.75, y - 0.75, 1.5, 1.5)
  }

  /* ── tracked persons: cyan double pulsing ring + id label ──────────── */
  ctx.font = FONT_9
  ctx.textAlign = 'center'
  ctx.textBaseline = 'alphabetic'
  for (let i = 0; i < persons.length; i++) {
    const p = persons[i]
    if (!p.tracked) continue
    const x = (p.prevPos.x + (p.pos.x - p.prevPos.x) * alpha) * sc + ox
    const y = (p.prevPos.y + (p.pos.y - p.prevPos.y) * alpha) * sc + oy
    if (x < -40 || x > vw + 40 || y < -40 || y > vh + 40) continue
    const r1 = 6 + Math.sin(now * 0.005 + i) * 1.3
    const r2 = 10.5 + Math.sin(now * 0.005 + i + 1.3) * 1.9
    ctx.strokeStyle = A_ACCENT[aIdx(0.85)]
    ctx.lineWidth = 1.2
    ctx.beginPath()
    ctx.arc(x, y, r1, 0, TAU)
    ctx.stroke()
    ctx.strokeStyle = A_ACCENT[aIdx(0.38)]
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.arc(x, y, r2, 0, TAU)
    ctx.stroke()
    ctx.fillStyle = A_ACCENT[aIdx(0.9)]
    ctx.fillRect(x - 1, y - 1, 2, 2)
    ctx.fillText(p.id, x, y - 16)
  }
}

/* ── hover + selection chrome (topmost) ────────────────────────────── */

export function drawChrome(
  ctx: CanvasRenderingContext2D,
  cam: MapCamera,
  alpha: number,
  now: number,
  sel: SimEntity | undefined,
  hov: SimEntity | undefined,
): void {
  const sc = cam.scale
  const ox = cam.viewW / 2 - cam.cx * sc
  const oy = cam.viewH / 2 - cam.cy * sc

  if (hov && (!sel || hov.id !== sel.id)) {
    const x = (hov.prevPos.x + (hov.pos.x - hov.prevPos.x) * alpha) * sc + ox
    const y = (hov.prevPos.y + (hov.pos.y - hov.prevPos.y) * alpha) * sc + oy
    ctx.strokeStyle = A_PRIM[aIdx(0.35)]
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.arc(x, y, 8.5, 0, TAU)
    ctx.stroke()
  }

  if (sel) {
    const x = (sel.prevPos.x + (sel.pos.x - sel.prevPos.x) * alpha) * sc + ox
    const y = (sel.prevPos.y + (sel.pos.y - sel.prevPos.y) * alpha) * sc + oy
    /* rotating quad-tick designator */
    const base = now * 0.0012
    ctx.strokeStyle = A_ACCENT[aIdx(0.9)]
    ctx.lineWidth = 1.25
    for (let k = 0; k < 4; k++) {
      const a0 = base + (k * Math.PI) / 2
      ctx.beginPath()
      ctx.arc(x, y, 12.5, a0, a0 + 0.6)
      ctx.stroke()
    }
    ctx.strokeStyle = A_ACCENT[aIdx(0.45)]
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.arc(x, y, 8, 0, TAU)
    ctx.stroke()
    ctx.font = FONT_9
    ctx.textAlign = 'center'
    ctx.textBaseline = 'alphabetic'
    ctx.fillStyle = A_ACCENT[aIdx(0.9)]
    ctx.fillText(sel.id, x, y + 24)
  }
}
