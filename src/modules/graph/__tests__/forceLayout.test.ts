/** PROFILER — layout determinism + hop math sanity (node env, no DOM). */
import { describe, expect, it } from 'vitest'
import { getNetwork } from '../../../sim/identityFactory'
import { ForceLayout, computeHops, seedPos } from '../forceLayout'

describe('computeHops', () => {
  it('radiates outward from the root, adjacent hops differ by ≤1', () => {
    const net = getNetwork('P-0001', 2)
    const hops = computeHops(net, 'P-0001')
    expect(hops.get('P-0001')).toBe(0)
    for (const n of net.nodes) expect(hops.has(n.id)).toBe(true)
    for (const e of net.edges) {
      const a = hops.get(e.source) ?? -9
      const b = hops.get(e.target) ?? -9
      expect(Math.abs(a - b)).toBeLessThanOrEqual(1)
    }
  })
})

describe('seedPos', () => {
  it('is deterministic per id and radial by hop', () => {
    expect(seedPos('X-1', 2, 0, 0)).toEqual(seedPos('X-1', 2, 0, 0))
    expect(seedPos('root', 0, 5, 7)).toEqual({ x: 5, y: 7 })
    const p1 = seedPos('X-1', 1, 0, 0)
    const p2 = seedPos('X-1', 2, 0, 0)
    expect(Math.hypot(p2.x, p2.y)).toBeGreaterThan(Math.hypot(p1.x, p1.y))
  })
})

describe('ForceLayout', () => {
  const settle = (rootId: string): string => {
    const l = new ForceLayout(() => {})
    l.setNetwork(getNetwork(rootId, 2), rootId)
    l.stop()
    for (let i = 0; i < 150; i++) l.sim.tick()
    const sig = l.nodes.map((n) => `${n.id}:${(n.x ?? 0).toFixed(3)},${(n.y ?? 0).toFixed(3)}`).join('|')
    l.stop()
    return sig
  }

  it('reproduces the same picture for the same subject', () => {
    expect(settle('P-0007')).toBe(settle('P-0007'))
  })

  it('pins the root at the anchor and keeps positions across expansion', () => {
    const l = new ForceLayout(() => {})
    l.setNetwork(getNetwork('P-0007', 1), 'P-0007')
    l.stop()
    for (let i = 0; i < 80; i++) l.sim.tick()
    const root = l.getNode('P-0007')
    expect(root?.fx).toBe(0)
    expect(root?.fy).toBe(0)
    const before = new Map(l.nodes.map((n) => [n.id, { x: n.x, y: n.y }]))

    l.setNetwork(getNetwork('P-0007', 2), 'P-0007')
    l.stop()
    for (const [id, p] of before) {
      const n = l.getNode(id)
      expect(n).toBeDefined()
      expect(n?.x).toBe(p.x)
      expect(n?.y).toBe(p.y)
    }
    l.stop()
  })
})
