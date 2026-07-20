/**
 * PROFILER — d3-force layout controller.
 *
 * Owns the mutable simulation state. React renders the SVG structure; the
 * tick callback pushes positions imperatively. Initial placement is seeded
 * (hashString(id) → angle, BFS hop → ring radius) so the same subject
 * reproduces essentially the same picture on every open; node positions are
 * cached across network recomputes so pulling a thread feels continuous.
 *
 * CPU discipline: alphaMin 0.005 — the sim parks itself once settled and is
 * only reheated by interaction (drag / re-root / degree change).
 */
import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type ForceLink,
  type ForceX,
  type ForceY,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from 'd3-force'
import { hashString } from '../../sim/seed'
import type { EdgeType, LinkNetwork, NodeType } from '../../sim/types'
import { nodeRadius } from './glyphs'

export interface SimNode extends SimulationNodeDatum {
  id: string
  type: NodeType
  label: string
  sub?: string
  risk?: number
  /** BFS distance from the current root */
  hop: number
  /** base glyph radius (root renders larger) */
  r: number
}

export interface SimLink extends SimulationLinkDatum<SimNode> {
  id: string
  type: EdgeType
  weight: number
}

/** BFS hop distance from root (undirected). Unreachable nodes → 3. */
export function computeHops(net: LinkNetwork, rootId: string): Map<string, number> {
  const adj = new Map<string, string[]>()
  const add = (a: string, b: string): void => {
    const arr = adj.get(a)
    if (arr) arr.push(b)
    else adj.set(a, [b])
  }
  for (const e of net.edges) {
    add(e.source, e.target)
    add(e.target, e.source)
  }
  const hops = new Map<string, number>([[rootId, 0]])
  const queue: string[] = [rootId]
  for (let qi = 0; qi < queue.length; qi++) {
    const id = queue[qi]
    const h = hops.get(id) ?? 0
    for (const nb of adj.get(id) ?? []) {
      if (!hops.has(nb)) {
        hops.set(nb, h + 1)
        queue.push(nb)
      }
    }
  }
  for (const n of net.nodes) if (!hops.has(n.id)) hops.set(n.id, 3)
  return hops
}

/** deterministic radial seed: angle from id hash, radius from hop ring */
export function seedPos(id: string, hop: number, cx: number, cy: number): { x: number; y: number } {
  const h = hashString(`${id}:seed`)
  const angle = ((h % 4096) / 4096) * Math.PI * 2
  const radial = hop === 0 ? 0 : hop * 92 + (((h >>> 12) % 64) / 64) * 44
  return { x: cx + Math.cos(angle) * radial, y: cy + Math.sin(angle) * radial }
}

/** link distance by endpoint types: person↔person 110, locations 90, devices 60 */
const linkDistance = (l: SimLink): number => {
  const s = l.source as SimNode | string
  const t = l.target as SimNode | string
  if (typeof s === 'string' || typeof t === 'string') return 80
  if (s.type === 'person' && t.type === 'person') return 110
  if (s.type === 'location' || t.type === 'location') return 90
  return 60
}

export class ForceLayout {
  readonly sim: Simulation<SimNode, SimLink>
  nodes: SimNode[] = []
  links: SimLink[] = []
  rootId: string | null = null

  private cache = new Map<string, SimNode>()
  private linkForce: ForceLink<SimNode, SimLink>
  private anchorX: ForceX<SimNode>
  private anchorY: ForceY<SimNode>
  private ax = 0
  private ay = 0
  private booted = false

  constructor(onTick: () => void) {
    this.linkForce = forceLink<SimNode, SimLink>([])
      .id((d) => d.id)
      .distance(linkDistance)
    this.anchorX = forceX<SimNode>(0).strength(0.03)
    this.anchorY = forceY<SimNode>(0).strength(0.03)
    this.sim = forceSimulation<SimNode, SimLink>([])
      .alphaMin(0.005)
      .alphaDecay(0.032)
      .velocityDecay(0.38)
      .force('link', this.linkForce)
      .force('charge', forceManyBody<SimNode>().strength(-180).distanceMax(480))
      .force('collide', forceCollide<SimNode>().radius((d) => d.r + 7).strength(0.85))
      .force('ax', this.anchorX)
      .force('ay', this.anchorY)
      .on('tick', onTick)
    this.sim.stop()
  }

  getNode(id: string): SimNode | undefined {
    return this.cache.get(id)
  }

  /** containment target (follows the root; updated when the root is dropped elsewhere) */
  anchor(): { x: number; y: number } {
    return { x: this.ax, y: this.ay }
  }

  setAnchor(x: number, y: number): void {
    this.ax = x
    this.ay = y
    this.anchorX.x(x)
    this.anchorY.y(y)
  }

  /**
   * Swap in a (re)computed network. Nodes whose ids persist keep their
   * positions; new nodes are seeded radially around the root's current spot.
   * The root is pinned (fx/fy) where it lives — released when dragged.
   */
  setNetwork(net: LinkNetwork, rootId: string): void {
    if (this.rootId && this.rootId !== rootId) {
      const prev = this.cache.get(this.rootId)
      if (prev) {
        prev.fx = null
        prev.fy = null
      }
    }
    this.rootId = rootId

    const cachedRoot = this.cache.get(rootId)
    const rx = cachedRoot?.x ?? 0
    const ry = cachedRoot?.y ?? 0
    this.setAnchor(rx, ry)

    const hops = computeHops(net, rootId)
    this.nodes = net.nodes.map((n) => {
      const hop = hops.get(n.id) ?? 3
      let sn = this.cache.get(n.id)
      if (!sn) {
        const p = seedPos(n.id, hop, rx, ry)
        sn = { id: n.id, type: n.type, label: n.label, sub: n.sub, risk: n.risk, hop, r: nodeRadius(n.type), x: p.x, y: p.y }
        this.cache.set(n.id, sn)
      } else {
        sn.hop = hop
        sn.label = n.label
        sn.sub = n.sub
        sn.risk = n.risk
      }
      return sn
    })

    const root = this.cache.get(rootId)
    if (root) {
      root.fx = root.x ?? rx
      root.fy = root.y ?? ry
    }

    // fresh link objects every time — d3 mutates source/target in place
    this.links = net.edges.map((e) => ({ id: e.id, source: e.source, target: e.target, type: e.type, weight: e.weight }))

    this.sim.nodes(this.nodes)
    this.linkForce.links(this.links)
    this.sim.alpha(this.booted ? 0.65 : 1).alphaTarget(0).restart()
    this.booted = true
  }

  /** interaction reheat (node drag) — pair with settle() on gesture end */
  reheat(target = 0.3): void {
    this.sim.alphaTarget(target).restart()
  }

  settle(): void {
    this.sim.alphaTarget(0)
  }

  stop(): void {
    this.sim.stop()
  }
}
