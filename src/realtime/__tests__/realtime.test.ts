/**
 * Realtime layer: EngineHost serialisation + command application, and the
 * InlineSource wiring (fake timers). One host at a time — the events bus is a
 * process singleton, so overlapping hosts would cross-subscribe (in production
 * exactly one host exists per context: inline, worker, or server).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EngineHost } from '../engineHost'
import { InlineSource } from '../sources/inlineSource'
import { DEFAULT_SEED } from '../../sim/cityGen'
import type { HelloMsg, TickMsg } from '../protocol'

describe('EngineHost', () => {
  it('hello() carries a full, well-formed snapshot', () => {
    const host = new EngineHost(DEFAULT_SEED)
    const h = host.hello()
    expect(h.t).toBe('hello')
    expect(h.persons.length).toBe(260)
    expect(h.vehicles.length).toBe(150)
    expect(h.patrols.length).toBe(12)
    expect(h.cameras.length).toBe(24)
    expect(h.city.nodes.length).toBeGreaterThan(0)
    expect(h.infra.power['SECTOR-1']).toBe(true)
    expect(h.derived.defcon).toBeGreaterThanOrEqual(1)
    // boot lines are emitted synchronously into the snapshot
    expect(h.recentEvents.some((e) => e.message.includes('PANOPTICON CORE ONLINE'))).toBe(true)
    host.dispose()
  })

  it('tick() advances and serialises live positions', () => {
    const host = new EngineHost(DEFAULT_SEED)
    const t0 = host.tick()
    const t1 = host.tick()
    expect(t1.tick).toBe(t0.tick + 1)
    expect(t0.personPos.length).toBe(260 * 2)
    expect(t0.patrolStatus.length).toBe(12)
    expect(t0.congestion.length).toBe(9)
    // positions are finite numbers
    expect(t0.personPos.every((n) => Number.isFinite(n))).toBe(true)
    host.dispose()
  })

  it('command() mutates authoritative infra and acks it on the next tick', () => {
    const host = new EngineHost(DEFAULT_SEED)
    host.tick()
    host.command({ k: 'power', sector: 'SECTOR-1', on: false })
    const t = host.tick()
    expect(t.infra?.power['SECTOR-1']).toBe(false)
    // cameras in the dark sector drop offline within a couple of ticks
    host.tick()
    const t2 = host.tick()
    expect(t2.cameraOnline.some((o) => o === false)).toBe(true)
    host.dispose()
  })

  it('is deterministic: same seed → identical positions after N ticks', () => {
    const a = new EngineHost(DEFAULT_SEED)
    let ta: TickMsg | null = null
    for (let i = 0; i < 12; i++) ta = a.tick()
    a.dispose()

    const b = new EngineHost(DEFAULT_SEED)
    let tb: TickMsg | null = null
    for (let i = 0; i < 12; i++) tb = b.tick()
    b.dispose()

    expect(tb!.personPos).toEqual(ta!.personPos)
    expect(tb!.derived.riskIndex).toBe(ta!.derived.riskIndex)
  })
})

describe('InlineSource', () => {
  afterEach(() => vi.useRealTimers())

  it('emits hello immediately and streams ticks on the interval', () => {
    vi.useFakeTimers()
    const src = new InlineSource(DEFAULT_SEED, 100)
    let hello: HelloMsg | null = null
    let ticks = 0
    let linked = false
    src.start({
      onHello: (h) => (hello = h),
      onTick: () => (ticks += 1),
      onLink: (up) => (linked = up),
    })
    expect(linked).toBe(true)
    expect(hello).not.toBeNull()
    expect(hello!.persons.length).toBe(260)
    vi.advanceTimersByTime(350)
    expect(ticks).toBeGreaterThanOrEqual(3)
    src.dispose()
  })

  it('forwards commands to the host (infra ack arrives on the change tick)', () => {
    vi.useFakeTimers()
    const src = new InlineSource(DEFAULT_SEED, 100)
    // infra is only sent on the tick it changes — capture it from any tick
    let ackedOff: boolean | undefined
    src.start({
      onHello: () => {},
      onTick: (t) => {
        if (t.infra) ackedOff = t.infra.power['SECTOR-3']
      },
      onLink: () => {},
    })
    src.command({ k: 'power', sector: 'SECTOR-3', on: false })
    vi.advanceTimersByTime(250)
    expect(ackedOff).toBe(false)
    src.dispose()
  })
})
