/**
 * A* over the road-node adjacency, allocation-light: all working buffers are
 * typed arrays reused across calls (epoch-stamped, never cleared). Paths run
 * often but are cached per entity until the target is reached, so the hot cost
 * is a handful of heap ops over <600 nodes.
 */
import type { RoadNode, RoadSegment } from '../sim/types'

export interface RoadGraph {
  /** node count */
  count: number
  xs: Float64Array
  ys: Float64Array
  /** CSR adjacency: neighbors of node i live at [adjStart[i], adjStart[i+1]) */
  adjStart: Int32Array
  adjNode: Int32Array
  /** segment index carrying each directed adjacency entry */
  adjSeg: Int32Array
  adjCost: Float64Array
}

export function buildGraph(nodes: readonly RoadNode[], segments: readonly RoadSegment[]): RoadGraph {
  const n = nodes.length
  const deg = new Int32Array(n)
  for (const s of segments) {
    deg[s.a]++
    deg[s.b]++
  }
  const adjStart = new Int32Array(n + 1)
  for (let i = 0; i < n; i++) adjStart[i + 1] = adjStart[i] + deg[i]
  const m2 = adjStart[n]
  const adjNode = new Int32Array(m2)
  const adjSeg = new Int32Array(m2)
  const adjCost = new Float64Array(m2)
  const xs = new Float64Array(n)
  const ys = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    xs[i] = nodes[i].pos.x
    ys[i] = nodes[i].pos.y
  }
  const cursor = adjStart.slice(0, n)
  for (let si = 0; si < segments.length; si++) {
    const s = segments[si]
    const dx = xs[s.a] - xs[s.b]
    const dy = ys[s.a] - ys[s.b]
    const c = Math.sqrt(dx * dx + dy * dy) || 0.001
    adjNode[cursor[s.a]] = s.b
    adjSeg[cursor[s.a]] = si
    adjCost[cursor[s.a]++] = c
    adjNode[cursor[s.b]] = s.a
    adjSeg[cursor[s.b]] = si
    adjCost[cursor[s.b]++] = c
  }
  return { count: n, xs, ys, adjStart, adjNode, adjSeg, adjCost }
}

/** linear scan — used rarely (spawn placement, dispatch targets, landmarks) */
export function nearestNode(g: RoadGraph, x: number, y: number): number {
  let best = 0
  let bestD = Infinity
  for (let i = 0; i < g.count; i++) {
    const dx = g.xs[i] - x
    const dy = g.ys[i] - y
    const d = dx * dx + dy * dy
    if (d < bestD) {
      bestD = d
      best = i
    }
  }
  return best
}

export type BlockedFn = (segIdx: number) => boolean

export class Pathfinder {
  private g: RoadGraph
  private gScore: Float64Array
  private fScore: Float64Array
  private cameFrom: Int32Array
  private stamp: Int32Array
  private epoch = 0
  /** parallel binary heap (f-priority, node) — plain arrays reused across calls */
  private heapF: number[] = []
  private heapN: number[] = []

  constructor(g: RoadGraph) {
    this.g = g
    this.gScore = new Float64Array(g.count)
    this.fScore = new Float64Array(g.count)
    this.cameFrom = new Int32Array(g.count)
    this.stamp = new Int32Array(g.count)
  }

  private push(f: number, n: number): void {
    const hf = this.heapF
    const hn = this.heapN
    let i = hf.length
    hf.push(f)
    hn.push(n)
    while (i > 0) {
      const p = (i - 1) >> 1
      if (hf[p] <= hf[i]) break
      const tf = hf[p]
      hf[p] = hf[i]
      hf[i] = tf
      const tn = hn[p]
      hn[p] = hn[i]
      hn[i] = tn
      i = p
    }
  }

  private pop(): number {
    const hf = this.heapF
    const hn = this.heapN
    const top = hn[0]
    const lf = hf.pop() as number
    const ln = hn.pop() as number
    if (hf.length > 0) {
      hf[0] = lf
      hn[0] = ln
      let i = 0
      for (;;) {
        const l = i * 2 + 1
        const r = l + 1
        let s = i
        if (l < hf.length && hf[l] < hf[s]) s = l
        if (r < hf.length && hf[r] < hf[s]) s = r
        if (s === i) break
        const tf = hf[s]
        hf[s] = hf[i]
        hf[i] = tf
        const tn = hn[s]
        hn[s] = hn[i]
        hn[i] = tn
        i = s
      }
    }
    return top
  }

  /**
   * A* from → to; fills `out` with node indices (from … to inclusive) so
   * entities can reuse their `path` arrays. Returns false when unreachable
   * (e.g. every bridge to the far bank is raised).
   */
  findPathInto(from: number, to: number, out: number[], blocked?: BlockedFn): boolean {
    out.length = 0
    const g = this.g
    if (from < 0 || to < 0 || from >= g.count || to >= g.count) return false
    if (from === to) {
      out.push(from)
      return true
    }
    const epoch = ++this.epoch
    const { gScore, fScore, cameFrom, stamp } = this
    this.heapF.length = 0
    this.heapN.length = 0

    const tx = g.xs[to]
    const ty = g.ys[to]
    const h = (n: number): number => {
      const dx = g.xs[n] - tx
      const dy = g.ys[n] - ty
      return Math.sqrt(dx * dx + dy * dy)
    }

    stamp[from] = epoch
    gScore[from] = 0
    fScore[from] = h(from)
    cameFrom[from] = -1
    this.push(fScore[from], from)

    let found = false
    while (this.heapN.length > 0) {
      const fTop = this.heapF[0]
      const cur = this.pop()
      if (stamp[cur] !== epoch || fTop > fScore[cur] + 1e-9) continue // stale entry
      if (cur === to) {
        found = true
        break
      }
      const end = g.adjStart[cur + 1]
      for (let k = g.adjStart[cur]; k < end; k++) {
        if (blocked && blocked(g.adjSeg[k])) continue
        const nb = g.adjNode[k]
        const tentative = gScore[cur] + g.adjCost[k]
        if (stamp[nb] !== epoch || tentative < gScore[nb]) {
          stamp[nb] = epoch
          gScore[nb] = tentative
          fScore[nb] = tentative + h(nb)
          cameFrom[nb] = cur
          this.push(fScore[nb], nb)
        }
      }
    }
    if (!found) return false

    // walk back, then reverse in place
    let n = to
    while (n !== -1) {
      out.push(n)
      n = cameFrom[n]
    }
    for (let i = 0, j = out.length - 1; i < j; i++, j--) {
      const t = out[i]
      out[i] = out[j]
      out[j] = t
    }
    return true
  }
}
