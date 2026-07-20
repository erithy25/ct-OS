/**
 * Small dependency-free 2D helpers shared by cityGen, the world tick, and
 * renderers. No allocations beyond explicit `new`-returning helpers.
 */
import type { Vec2 } from '../sim/types'

export const TAU = Math.PI * 2

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

export function dist(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x
  const dy = a.y - b.y
  return Math.sqrt(dx * dx + dy * dy)
}

/** squared distance — cheap proximity tests */
export function dist2(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x
  const dy = a.y - b.y
  return dx * dx + dy * dy
}

/** new-vector lerp */
export function lerpVec(a: Vec2, b: Vec2, t: number): Vec2 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
}

/** allocation-free lerp into an existing vector (hot paths) */
export function lerpVecInto(out: Vec2, a: Vec2, b: Vec2, t: number): Vec2 {
  out.x = a.x + (b.x - a.x) * t
  out.y = a.y + (b.y - a.y) * t
  return out
}

/** ray-cast point-in-polygon (handles concave polygons) */
export function pointInPolygon(p: Vec2, poly: Vec2[]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const yi = poly[i].y
    const yj = poly[j].y
    if (yi > p.y !== yj > p.y) {
      const xi = poly[i].x
      const xj = poly[j].x
      const t = (p.y - yi) / (yj - yi)
      if (p.x < xi + t * (xj - xi)) inside = !inside
    }
  }
  return inside
}

export function pointInAnyPolygon(p: Vec2, polys: Vec2[][]): boolean {
  for (let i = 0; i < polys.length; i++) if (pointInPolygon(p, polys[i])) return true
  return false
}

/** area-weighted centroid (shoelace); falls back to vertex mean for degenerate polys */
export function polygonCentroid(poly: Vec2[]): Vec2 {
  let a = 0
  let cx = 0
  let cy = 0
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const cross = poly[j].x * poly[i].y - poly[i].x * poly[j].y
    a += cross
    cx += (poly[j].x + poly[i].x) * cross
    cy += (poly[j].y + poly[i].y) * cross
  }
  if (Math.abs(a) < 1e-9) {
    let mx = 0
    let my = 0
    for (const p of poly) {
      mx += p.x
      my += p.y
    }
    return { x: mx / poly.length, y: my / poly.length }
  }
  const f = 1 / (3 * a)
  return { x: cx * f, y: cy * f }
}

/** heading of b as seen from a, radians */
export function angleTo(a: Vec2, b: Vec2): number {
  return Math.atan2(b.y - a.y, b.x - a.x)
}

/** wrap to (-π, π] */
export function normalizeAngle(a: number): number {
  let r = a % TAU
  if (r <= -Math.PI) r += TAU
  else if (r > Math.PI) r -= TAU
  return r
}

/** signed smallest difference a−b, wrapped to (-π, π] */
export function angleDiff(a: number, b: number): number {
  return normalizeAngle(a - b)
}
