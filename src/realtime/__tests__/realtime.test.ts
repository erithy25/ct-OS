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

  it('accepts a real feed, announces it, and overlays it on the derived wire', () => {
    const host = new EngineHost(DEFAULT_SEED)
    host.tick()
    host.command({ k: 'feed', metrics: { source: 'client', label: 'OPERATOR NODE', cpuPct: 82, memPct: 40, fps: 60, cores: 8, ts: 1 } })
    const t = host.tick()
    expect(t.derived.realTelemetry.client?.cpuPct).toBe(82)
    expect(t.derived.realTelemetry.client?.cores).toBe(8)
    expect(t.events.some((e) => e.channel === 'FEED' && e.message.includes('REAL FEED ONLINE'))).toBe(true)
    host.dispose()
  })

  it('blends real CPU into the city load (same tick, with vs without feed)', () => {
    const a = new EngineHost(DEFAULT_SEED)
    let noFeed = 0
    for (let i = 0; i < 5; i++) noFeed = a.tick().derived.vitals.cityLoad
    a.dispose()

    const b = new EngineHost(DEFAULT_SEED)
    for (let i = 0; i < 4; i++) b.tick()
    b.command({ k: 'feed', metrics: { source: 'client', label: 'X', cpuPct: 100, ts: 1 } })
    const withFeed = b.tick().derived.vitals.cityLoad
    b.dispose()

    // deterministic sim → same base; real 100% CPU pulls the blended value up
    expect(withFeed).toBeGreaterThan(noFeed)
  })

  it('carries a simulated market that moves and reports stress', () => {
    const host = new EngineHost(DEFAULT_SEED)
    const h = host.hello()
    expect(h.instruments.length).toBe(12)
    expect(h.instruments.every((i) => i.source === 'sim')).toBe(true)
    const btc0 = h.instruments.find((i) => i.symbol === 'BTC')!
    expect(btc0.price).toBeGreaterThan(1000)
    expect(h.derived.marketSource).toBe('sim')

    let lastInstr = h.instruments
    let lastStress = 0
    for (let i = 0; i < 20; i++) {
      const t = host.tick()
      if (t.instruments) lastInstr = t.instruments
      lastStress = t.derived.marketStress
    }
    expect(typeof lastStress).toBe('number')
    // deterministic sim actually moves prices
    const btcNow = lastInstr.find((i) => i.symbol === 'BTC')!
    expect(btcNow.price).not.toBe(btc0.price)
    host.dispose()
  })

  it('injectMarket overlays real quotes and flips the source to live', () => {
    const host = new EngineHost(DEFAULT_SEED)
    host.tick()
    host.injectMarket([
      { symbol: 'BTC', price: 70123.45, changePct: 5.5, high: 71000, low: 64000, volume: 1234.5, bid: 70120, ask: 70127 },
    ])
    const t = host.tick()
    const btc = t.instruments!.find((i) => i.symbol === 'BTC')!
    expect(btc.source).toBe('live')
    expect(btc.price).toBe(70123.45)
    expect(t.derived.marketSource).toBe('live')
    expect(t.events.some((e) => e.channel === 'FEED' && e.message.includes('MARKET DATA LIVE'))).toBe(true)
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
