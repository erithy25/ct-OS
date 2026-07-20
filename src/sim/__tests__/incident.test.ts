import { describe, expect, it } from 'vitest'
import {
  createIncident,
  INCIDENT_LINGER_TICKS,
  stepIncident,
  type IncidentCtx,
  type RandLike,
} from '../entities'
import type { Incident } from '../types'

/** fully scripted randomness: chance() always true, int() returns its lower bound */
const scriptedRand = (): RandLike => ({
  next: () => 0.5,
  range: (a, b) => (a + b) / 2,
  int: (a, _b) => a,
  chance: () => true,
})

interface Harness {
  inc: Incident
  ctx: IncidentCtx
  escalations: number
  resolves: number
  unitAvailable: string | null
  arrived: boolean
  run(ticks: number): 'active' | 'cull'
}

function makeHarness(): Harness {
  const rand = scriptedRand()
  const h: Harness = {
    inc: createIncident(1, 'DISTURBANCE', 'SECTOR-3', { x: 100, y: 100 }, 5, 0, rand),
    escalations: 0,
    resolves: 0,
    unitAvailable: null,
    arrived: false,
    ctx: {
      tick: 0,
      rand,
      dispatch: () => h.unitAvailable,
      unitArrived: () => h.arrived,
      onEscalate: () => h.escalations++,
      onResolve: () => h.resolves++,
    },
    run(ticks: number) {
      let last: 'active' | 'cull' = 'active'
      for (let i = 0; i < ticks; i++) {
        h.ctx.tick++
        last = stepIncident(h.inc, h.ctx)
        expect(h.inc.severity).toBeLessThanOrEqual(5)
        expect(h.inc.severity).toBeGreaterThanOrEqual(1)
      }
      return last
    },
  }
  return h
}

describe('incident FSM', () => {
  it('walks SPAWNED → ESCALATING → RESPONDING → RESOLVED → cull', () => {
    const h = makeHarness()
    expect(h.inc.id).toBe('INC-0001')
    expect(h.inc.phase).toBe('SPAWNED')
    // scripted int() ⇒ phaseDur = 80 ticks of SPAWNED
    h.run(79)
    expect(h.inc.phase).toBe('SPAWNED')
    h.run(1)
    expect(h.inc.phase).toBe('ESCALATING')

    // no unit available → keeps escalating, retries dispatch
    h.run(200)
    expect(h.inc.phase).toBe('ESCALATING')
    expect(h.escalations).toBeGreaterThan(0)
    expect(h.inc.assignedUnitId).toBeNull()

    // unit frees up → dispatch retry lands within 25 ticks
    h.unitAvailable = 'U-07'
    h.run(26)
    expect(h.inc.phase).toBe('RESPONDING')
    expect(h.inc.assignedUnitId).toBe('U-07')

    // not on scene yet → stays RESPONDING
    h.run(50)
    expect(h.inc.phase).toBe('RESPONDING')

    // unit arrives → on-scene timer (scripted int ⇒ 150 ticks) → RESOLVED
    h.arrived = true
    h.run(1)
    expect(h.inc.onSceneTick).toBeDefined()
    h.run(149)
    expect(h.inc.phase).toBe('RESPONDING')
    h.run(1)
    expect(h.inc.phase).toBe('RESOLVED')
    expect(h.resolves).toBe(1)

    // resolved incidents linger, then cull
    expect(h.run(INCIDENT_LINGER_TICKS - 1)).toBe('active')
    expect(h.inc.phase).toBe('RESOLVED')
    expect(h.run(1)).toBe('cull')
  })

  it('severity never exceeds 5 even under forced escalation', () => {
    const h = makeHarness()
    // chance() always true ⇒ every escalation window fires; run long with no units
    h.run(3000)
    expect(h.inc.phase).toBe('ESCALATING')
    expect(h.inc.severity).toBe(5)
    expect(h.escalations).toBeLessThanOrEqual(4) // 1..5 leaves at most 4 raises from base
  })

  it('does not resolve before the unit arrives', () => {
    const h = makeHarness()
    h.unitAvailable = 'U-01'
    h.run(2000)
    expect(h.inc.phase).toBe('RESPONDING')
    expect(h.resolves).toBe(0)
  })
})
