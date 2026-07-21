/**
 * ZONES · pure geometry helpers.
 *
 * All coordinates are normalized to the camera view (0..1 on each axis), the
 * same space `Zone.points` and `Detection.box` live in — so a zone polygon and
 * a person's "feet" can be tested against each other directly, independent of
 * pixel resolution.
 *
 * Kept dependency-free and side-effect-free so they can be reasoned about (and
 * unit-tested) in isolation.
 */

/** A 2D point in normalized [x, y] camera coords. */
export type Vec2 = readonly [number, number]

/**
 * Ray-casting point-in-polygon test (even-odd rule). Works for convex and
 * concave polygons. Points exactly on an edge are treated as inside-ish
 * (browser rounding makes exact-edge hits vanishingly rare, and a false
 * negative on a boundary pixel is harmless for a presence alert).
 *
 * @returns true when `pt` lies within `poly` (a ring of >= 3 vertices).
 */
export function pointInPolygon(pt: Vec2, poly: readonly Vec2[]): boolean {
  const n = poly.length
  if (n < 3) return false
  const x = pt[0]
  const y = pt[1]
  let inside = false
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[i][0]
    const yi = poly[i][1]
    const xj = poly[j][0]
    const yj = poly[j][1]
    // does the horizontal ray at `y` cross edge (j -> i)?
    const crosses = yi > y !== yj > y
    if (crosses) {
      const xCross = ((xj - xi) * (y - yi)) / (yj - yi) + xi
      if (x < xCross) inside = !inside
    }
  }
  return inside
}

/**
 * Area-weighted polygon centroid (the shoelace centroid). Good for placing a
 * label at the visual middle of a zone. Falls back to the vertex average for
 * degenerate (zero-area or < 3 vertex) inputs.
 */
export function polygonCentroid(poly: readonly Vec2[]): [number, number] {
  const n = poly.length
  if (n === 0) return [0, 0]
  if (n < 3) return vertexAverage(poly)

  let area2 = 0 // twice the signed area
  let cx = 0
  let cy = 0
  for (let i = 0; i < n; i++) {
    const [x0, y0] = poly[i]
    const [x1, y1] = poly[(i + 1) % n]
    const cross = x0 * y1 - x1 * y0
    area2 += cross
    cx += (x0 + x1) * cross
    cy += (y0 + y1) * cross
  }
  if (Math.abs(area2) < 1e-12) return vertexAverage(poly)
  const k = 1 / (3 * area2)
  return [cx * k, cy * k]
}

function vertexAverage(poly: readonly Vec2[]): [number, number] {
  let sx = 0
  let sy = 0
  for (const [x, y] of poly) {
    sx += x
    sy += y
  }
  return [sx / poly.length, sy / poly.length]
}

/**
 * The "feet" of a detection box — the bottom-center point. For a person this is
 * where they meet the ground, which is the correct point to test for *presence
 * inside a ground region* (using the box center or top would trip a zone from
 * the far side of the frame). box = [x, y, w, h] normalized.
 */
export function boxBottomCenter(box: readonly [number, number, number, number]): [number, number] {
  return [box[0] + box[2] / 2, box[1] + box[3]]
}
