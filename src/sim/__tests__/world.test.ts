import { describe, expect, it } from 'vitest'
import { advanceWorld, createWorld, getRoadGraph, type WorldInputs } from '../world'
import { onEvent } from '../events'
import { buildGraph, Pathfinder } from '../../lib/pathfind'
import type { InfraState, World } from '../types'

function infraFor(world: World): InfraState {
  const sectors = world.city.districts.map((d) => d.id)
  return {
    power: Object.fromEntries(sectors.map((s) => [s, true])),
    traffic: Object.fromEntries(sectors.map((s) => [s, 'NORMAL' as const])),
    transit: { 'METRO-A': 'RUN', 'METRO-B': 'RUN', 'METRO-C': 'RUN' },
    comms: Object.fromEntries(sectors.map((s) => [s, true])),
    water: Object.fromEntries(sectors.map((s) => [s, 'NOMINAL' as const])),
    bridgesRaised: Object.fromEntries(world.city.bridges.map((b) => [b.id, false])),
  }
}

const freshInputs = (): WorldInputs => ({ manualSpawns: [], cvOnline: false, cvSubjects: 0, defconOverride: null })

describe('advanceWorld (headless smoke)', () => {
  it('advances 1200 ticks: finite positions, visible motion, sane metrics', () => {
    const world = createWorld(0x2f7a)
    const infra = infraFor(world)
    const inputs = freshInputs()
    const startVehicle = world.vehicles.map((v) => ({ x: v.pos.x, y: v.pos.y }))
    const startPerson = world.persons.map((p) => ({ x: p.pos.x, y: p.pos.y }))

    let derived = advanceWorld(world, infra, inputs)
    for (let i = 1; i < 1200; i++) {
      derived = advanceWorld(world, infra, inputs)
      if (i % 200 === 0) {
        // prevPos is refreshed before pos moves — never more than one step apart
        for (const v of world.vehicles) {
          const d = Math.hypot(v.pos.x - v.prevPos.x, v.pos.y - v.prevPos.y)
          expect(d).toBeLessThan(20)
        }
      }
    }

    const all = [...world.persons, ...world.vehicles, ...world.patrols, ...world.incidents, ...world.cameras]
    for (const e of all) {
      expect(Number.isFinite(e.pos.x)).toBe(true)
      expect(Number.isFinite(e.pos.y)).toBe(true)
      expect(Number.isFinite(e.prevPos.x)).toBe(true)
      expect(Number.isFinite(e.prevPos.y)).toBe(true)
    }

    const movedVehicles = world.vehicles.filter((v, i) => v.pos.x !== startVehicle[i].x || v.pos.y !== startVehicle[i].y)
    const movedPersons = world.persons.filter((p, i) => p.pos.x !== startPerson[i].x || p.pos.y !== startPerson[i].y)
    expect(movedVehicles.length).toBeGreaterThan(40)
    expect(movedPersons.length).toBeGreaterThan(80)

    for (const d of world.city.districts) {
      const c = world.congestion[d.id]
      expect(c).toBeGreaterThanOrEqual(0)
      expect(c).toBeLessThanOrEqual(1)
    }
    expect(derived.defcon).toBeGreaterThanOrEqual(1)
    expect(derived.defcon).toBeLessThanOrEqual(5)
    expect(derived.riskIndex).toBeGreaterThanOrEqual(0)
    expect(derived.riskIndex).toBeLessThanOrEqual(100)
    expect(derived.systemIntegrity).toBeGreaterThan(75) // no operator destabilization (organic incidents may nibble)
    expect(derived.vitals.sensorUptime).toBe(100)
    expect(derived.hotspots.length).toBe(4)
    expect(derived.threatBoard.length).toBe(8)
    expect(world.tick).toBe(1200)
    expect(world.simMinutes).toBeCloseTo(7 * 60 + 35 + 200, 5)
  })

  it('manual spawn runs the full lifecycle and is culled', () => {
    const world = createWorld(0x2f7a)
    const infra = infraFor(world)
    const inputs = freshInputs()
    const log: string[] = []
    const off = onEvent((_sev, _ch, message) => log.push(message))

    inputs.manualSpawns.push('SECTOR-3')
    advanceWorld(world, infra, inputs)
    const inc = world.incidents.find((i) => i.sector === 'SECTOR-3')
    expect(inc).toBeDefined()
    const id = inc?.id ?? ''
    expect(log.some((m) => m.includes(`INCIDENT ${id}`))).toBe(true)

    let culled = false
    for (let i = 0; i < 8000; i++) {
      advanceWorld(world, infra, inputs)
      if (!world.incidents.some((x) => x.id === id)) {
        culled = true
        break
      }
    }
    off()
    expect(culled).toBe(true)
    expect(log.some((m) => m.includes('RESPONDING') && m.includes(id))).toBe(true)
    expect(log.some((m) => m.includes(`INCIDENT ${id} RESOLVED`))).toBe(true)
  })

  it('power cut darkens cameras, raises instability, caps DEFCON at 3', () => {
    const world = createWorld(0x2f7a)
    const infra = infraFor(world)
    const inputs = freshInputs()
    for (let i = 0; i < 50; i++) advanceWorld(world, infra, inputs)

    const darkSector = world.cameras[0].sector
    infra.power[darkSector] = false
    let derived = advanceWorld(world, infra, inputs)
    const darkCams = world.cameras.filter((c) => c.sector === darkSector)
    expect(darkCams.every((c) => !c.online)).toBe(true)
    expect(derived.camerasOnline).toBe(world.cameras.length - darkCams.length)
    expect(derived.vitals.sensorUptime).toBeLessThan(100)

    for (let i = 0; i < 600; i++) derived = advanceWorld(world, infra, inputs)
    expect(world.instability).toBeGreaterThan(0.05)
    expect(derived.defcon).toBeLessThanOrEqual(3)
    expect(derived.systemIntegrity).toBeLessThan(100)

    infra.power[darkSector] = true
    derived = advanceWorld(world, infra, inputs)
    expect(world.cameras.filter((c) => c.online).length).toBe(world.cameras.length)
  })

  it('raising every bridge makes cross-river paths unreachable', () => {
    const world = createWorld(0x2f7a)
    const city = world.city
    const graph = buildGraph(city.nodes, city.segments)
    const finder = new Pathfinder(graph)
    const blockedSet = new Set(city.bridges.map((b) => b.segmentIdx))
    const blocked = (segIdx: number): boolean => blockedSet.has(segIdx)

    const span = city.segments[city.bridges[0].segmentIdx]
    const out: number[] = []
    // reachable while bridges are down…
    expect(finder.findPathInto(span.a, span.b, out)).toBe(true)
    // …not when every span is up
    expect(finder.findPathInto(span.a, span.b, out, blocked)).toBe(false)

    // world integration: raised bridges must not strand the tick loop
    const infra = infraFor(world)
    for (const b of city.bridges) infra.bridgesRaised[b.id] = true
    const inputs = freshInputs()
    for (let i = 0; i < 400; i++) advanceWorld(world, infra, inputs)
    expect(getRoadGraph(world).count).toBe(city.nodes.length)
    for (const v of world.vehicles) expect(Number.isFinite(v.pos.x)).toBe(true)
  })
})
