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

/* ── boundary lines ─────────────────────────────────────────────────── */
/* A property border is drawn as an OPEN polyline across the image. To arm one
 * side of it we extend the line's ends to the image border and close the ring
 * around the border through the chosen side — the result is a normal polygon
 * every existing watcher already understands. */

const EPS = 1e-9

/** Nearest forward intersection of ray p + t·d (t > 0) with the unit-square
 *  border. Falls back to the clamped point for a (near-)zero direction. */
function rayToBorder(p: Vec2, d: Vec2): [number, number] {
  const [px, py] = p
  const [dx, dy] = d
  let bestT = Infinity
  let best: [number, number] = [Math.min(1, Math.max(0, px)), Math.min(1, Math.max(0, py))]
  const consider = (t: number, x: number, y: number): void => {
    if (t <= EPS || t >= bestT) return
    if (x < -EPS || x > 1 + EPS || y < -EPS || y > 1 + EPS) return
    bestT = t
    best = [Math.min(1, Math.max(0, x)), Math.min(1, Math.max(0, y))]
  }
  if (Math.abs(dx) > EPS) {
    consider((0 - px) / dx, 0, py + ((0 - px) / dx) * dy)
    consider((1 - px) / dx, 1, py + ((1 - px) / dx) * dy)
  }
  if (Math.abs(dy) > EPS) {
    consider((0 - py) / dy, px + ((0 - py) / dy) * dx, 0)
    consider((1 - py) / dy, px + ((1 - py) / dy) * dx, 1)
  }
  return best
}

/** Extend an open polyline so both ends touch the image border (along the
 *  direction of their outermost segment). Returns a new array. */
export function extendLineToBorders(line: readonly Vec2[]): [number, number][] {
  if (line.length < 2) return line.map((p) => [p[0], p[1]])
  const p0 = line[0]
  const p1 = line[1]
  const pn = line[line.length - 1]
  const pm = line[line.length - 2]
  const a = rayToBorder(p0, [p0[0] - p1[0], p0[1] - p1[1]])
  const b = rayToBorder(pn, [pn[0] - pm[0], pn[1] - pm[1]])
  return [a, ...line.map((p) => [p[0], p[1]] as [number, number]), b]
}

/** Perimeter parameter s ∈ [0,4) of a point on the unit-square border:
 *  top edge (y=0) s=x · right s=1+y · bottom s=2+(1−x) · left s=3+(1−y). */
function borderParam(p: Vec2): number {
  const [x, y] = p
  const dTop = y
  const dRight = 1 - x
  const dBottom = 1 - y
  const dLeft = x
  const m = Math.min(dTop, dRight, dBottom, dLeft)
  if (m === dTop) return x
  if (m === dRight) return 1 + y
  if (m === dBottom) return 2 + (1 - x)
  return 3 + (1 - y)
}

const CORNER: readonly Vec2[] = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
]

/** Border corners strictly between params sFrom → sTo walking in `dir`. */
function cornersBetween(sFrom: number, sTo: number, dir: 1 | -1): [number, number][] {
  const out: [number, number][] = []
  let s = sFrom
  for (let guard = 0; guard < 5; guard++) {
    // the next integer corner param in walk direction
    const corner = dir === 1 ? Math.floor(s + 1 + EPS) % 4 : (((Math.ceil(s - 1 - EPS) % 4) + 4) % 4)
    // walk-direction distances from s to the target and to that corner
    const dTo = dir === 1 ? (sTo - s + 4) % 4 : (s - sTo + 4) % 4
    let dCorner = dir === 1 ? (corner - s + 4) % 4 : (s - corner + 4) % 4
    if (dCorner < EPS) dCorner = 4 // s sits exactly on a corner param
    if (dTo <= dCorner + EPS) return out
    out.push([CORNER[corner][0], CORNER[corner][1]])
    s = corner
  }
  return out
}

/** Both candidate polygons a boundary line splits the image into. */
export function lineBothPolygons(line: readonly Vec2[]): { a: [number, number][]; b: [number, number][] } {
  const ext = extendLineToBorders(line)
  if (ext.length < 2) return { a: [], b: [] }
  const sA = borderParam(ext[0])
  const sB = borderParam(ext[ext.length - 1])
  const a = [...ext, ...cornersBetween(sB, sA, 1)]
  const b = [...ext, ...cornersBetween(sB, sA, -1)]
  return { a, b }
}

/**
 * Close a boundary line into the polygon covering the side that contains
 * `sidePoint` ("this side is my property"). Falls back to the larger candidate
 * when the point sits exactly on the line.
 */
export function lineSidePolygon(line: readonly Vec2[], sidePoint: Vec2): [number, number][] {
  const { a, b } = lineBothPolygons(line)
  if (a.length < 3) return b.length >= 3 ? b : []
  if (b.length < 3) return a
  if (pointInPolygon(sidePoint, a)) return a
  if (pointInPolygon(sidePoint, b)) return b
  return polygonArea(a) >= polygonArea(b) ? a : b
}

/** |shoelace| area of a polygon in normalized units. */
export function polygonArea(poly: readonly Vec2[]): number {
  let s = 0
  for (let i = 0, n = poly.length; i < n; i++) {
    const [x0, y0] = poly[i]
    const [x1, y1] = poly[(i + 1) % n]
    s += x0 * y1 - x1 * y0
  }
  return Math.abs(s) / 2
}
