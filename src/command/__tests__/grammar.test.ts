import { describe, expect, it } from 'vitest'
import { CONFIRM_TTL_MS, complete, parse } from '../grammar'
import type { CommandCtx, EntityRef, GrammarCtx, ParseResult, PendingConfirm } from '../grammar'

/* ── test harness: injectable ctx, no store import ─────────────────── */

const SECTORS = Array.from({ length: 9 }, (_, i) => `SECTOR-${i + 1}`)
const NAMES = ['NORTHGATE', 'RELAY HEIGHTS', 'VELLUM', 'MERIDIAN', 'CINDER FLATS', 'HARBOR CORE', 'GRANARY ROW', 'THE LOCKS', 'DRYDOCK']
const BRIDGES = ['KESSLER SPAN', 'ARDENT LIFT', 'SOUTH LOCKS BRIDGE']
const LINES = ['METRO-A', 'METRO-B', 'METRO-C']

const baseEntities: EntityRef[] = [
  { id: 'P-0001', kind: 'person', sector: 'SECTOR-3', risk: 78, tracked: false },
  { id: 'P-0002', kind: 'person', sector: 'SECTOR-5', risk: 12, tracked: true },
  { id: 'V-1001', kind: 'vehicle', sector: 'SECTOR-1' },
  { id: 'U-01', kind: 'patrol', sector: 'SECTOR-2', note: 'UNIT-4K · PATROL' },
  { id: 'INC-0001', kind: 'incident', sector: 'SECTOR-4', note: 'INTRUSION · CLASS-3' },
  { id: 'CAM-05', kind: 'camera', sector: 'SECTOR-6', note: 'ONLINE' },
]

interface Harness {
  ctx: GrammarCtx
  calls: unknown[][]
  emits: string[]
}

function makeCtx(over: { entities?: EntityRef[]; muted?: boolean; pending?: PendingConfirm | null; now?: number } = {}): Harness {
  const calls: unknown[][] = []
  const emits: string[] = []
  const rec =
    (name: string, ret?: unknown) =>
    (...a: unknown[]) => {
      calls.push([name, ...a])
      return ret
    }
  const ctx: GrammarCtx = {
    sectors: SECTORS,
    sectorNames: Object.fromEntries(SECTORS.map((s, i) => [s, NAMES[i]])),
    bridges: BRIDGES,
    lines: LINES,
    entities: () => over.entities ?? baseEntities,
    muted: over.muted ?? false,
    pending: over.pending ?? null,
    now: () => over.now ?? 1_000_000,
    actions: {
      setView: rec('setView') as GrammarCtx['actions']['setView'],
      locate: ((id: string) => {
        calls.push(['locate', id])
        return true
      }) as GrammarCtx['actions']['locate'],
      setTracked: rec('setTracked') as GrammarCtx['actions']['setTracked'],
      setPower: rec('setPower') as GrammarCtx['actions']['setPower'],
      setTraffic: rec('setTraffic') as GrammarCtx['actions']['setTraffic'],
      setBridge: rec('setBridge') as GrammarCtx['actions']['setBridge'],
      setTransit: rec('setTransit') as GrammarCtx['actions']['setTransit'],
      autoRestore: rec('autoRestore') as GrammarCtx['actions']['autoRestore'],
      spawnIncident: rec('spawnIncident') as GrammarCtx['actions']['spawnIncident'],
      setDefconOverride: rec('setDefconOverride') as GrammarCtx['actions']['setDefconOverride'],
      requestBiometric: rec('requestBiometric') as GrammarCtx['actions']['requestBiometric'],
      select: rec('select') as GrammarCtx['actions']['select'],
      setMuted: rec('setMuted') as GrammarCtx['actions']['setMuted'],
      emit: (sev, ch, msg) => {
        calls.push(['emit', sev, ch, msg])
        emits.push(msg)
      },
    },
  }
  return { ctx, calls, emits }
}

function runExec(res: ParseResult): string | void {
  expect(res.kind).toBe('exec')
  if (res.kind !== 'exec') throw new Error('unreachable')
  return res.run()
}

/* ── parse: happy paths for every command ──────────────────────────── */

describe('parse — command execution', () => {
  it('goto switches view and closes', () => {
    const h = makeCtx()
    const res = parse('goto grid', h.ctx)
    expect(res.kind).toBe('exec')
    if (res.kind !== 'exec') return
    expect(res.closes).toBe(true)
    expect(res.echo).toBe('goto grid')
    expect(res.run()).toContain('SURVEILLANCE GRID')
    expect(h.calls).toContainEqual(['setView', 'grid'])
  })

  it('goto rejects unknown views', () => {
    const res = parse('goto nowhere', makeCtx().ctx)
    expect(res.kind).toBe('error')
    if (res.kind === 'error') expect(res.message).toContain('USAGE: goto')
  })

  it('locate flies to a known entity (case-insensitive id)', () => {
    const h = makeCtx()
    const out = runExec(parse('locate p-0001', h.ctx))
    expect(out).toContain('P-0001')
    expect(h.calls).toContainEqual(['locate', 'P-0001'])
  })

  it('locate unknown entity → exact error line', () => {
    const res = parse('locate V-9999', makeCtx().ctx)
    expect(res).toEqual({ kind: 'error', message: "ERR: NO SUCH ENTITY 'V-9999'" })
  })

  it('track designates persons only', () => {
    const h = makeCtx()
    runExec(parse('track P-0001', h.ctx))
    expect(h.calls).toContainEqual(['setTracked', 'P-0001', true])

    const bad = parse('track V-1001', makeCtx().ctx)
    expect(bad.kind).toBe('error')
    if (bad.kind === 'error') expect(bad.message).toContain('IS NOT A PERSON')

    const missing = parse('track P-9999', makeCtx().ctx)
    expect(missing).toEqual({ kind: 'error', message: "ERR: NO SUCH ENTITY 'P-9999'" })
  })

  it('untrack releases a track', () => {
    const h = makeCtx()
    runExec(parse('untrack P-0002', h.ctx))
    expect(h.calls).toContainEqual(['setTracked', 'P-0002', false])
  })

  it('blackout / restore set sector power', () => {
    const h = makeCtx()
    runExec(parse('blackout SECTOR-3', h.ctx))
    expect(h.calls).toContainEqual(['setPower', 'SECTOR-3', false])
    runExec(parse('restore SECTOR-3', h.ctx))
    expect(h.calls).toContainEqual(['setPower', 'SECTOR-3', true])
  })

  it('sector ids accept shorthand (3, s3, sector-3 lowercase)', () => {
    for (const form of ['blackout 3', 'blackout s3', 'blackout sector-3']) {
      const h = makeCtx()
      runExec(parse(form, h.ctx))
      expect(h.calls).toContainEqual(['setPower', 'SECTOR-3', false])
    }
  })

  it('unknown sector errors', () => {
    const res = parse('blackout SECTOR-12', makeCtx().ctx)
    expect(res.kind).toBe('error')
    if (res.kind === 'error') expect(res.message).toBe("ERR: NO SUCH SECTOR 'SECTOR-12'")
  })

  it('restore all triggers autoRestore', () => {
    const h = makeCtx()
    runExec(parse('restore all', h.ctx))
    expect(h.calls).toContainEqual(['autoRestore'])
  })

  it('traffic maps green|red|normal to force modes', () => {
    const h = makeCtx()
    runExec(parse('traffic SECTOR-2 green', h.ctx))
    runExec(parse('traffic 2 red', h.ctx))
    runExec(parse('traffic SECTOR-2 normal', h.ctx))
    expect(h.calls).toContainEqual(['setTraffic', 'SECTOR-2', 'FORCE_GREEN'])
    expect(h.calls).toContainEqual(['setTraffic', 'SECTOR-2', 'FORCE_RED'])
    expect(h.calls).toContainEqual(['setTraffic', 'SECTOR-2', 'NORMAL'])
    expect(parse('traffic SECTOR-2 purple', makeCtx().ctx).kind).toBe('error')
  })

  it('bridge matches multi-word names greedily and case-insensitively', () => {
    const h = makeCtx()
    runExec(parse('bridge kessler span raise', h.ctx))
    expect(h.calls).toContainEqual(['setBridge', 'KESSLER SPAN', true])
    runExec(parse('bridge SOUTH LOCKS BRIDGE lower', h.ctx))
    expect(h.calls).toContainEqual(['setBridge', 'SOUTH LOCKS BRIDGE', false])
  })

  it('bridge accepts a unique prefix', () => {
    const h = makeCtx()
    runExec(parse('bridge kessler raise', h.ctx))
    expect(h.calls).toContainEqual(['setBridge', 'KESSLER SPAN', true])
  })

  it('bridge errors: unknown name, missing action', () => {
    const bad = parse('bridge phantom crossing raise', makeCtx().ctx)
    expect(bad.kind).toBe('error')
    if (bad.kind === 'error') expect(bad.message).toBe("ERR: NO SUCH BRIDGE 'PHANTOM CROSSING'")
    expect(parse('bridge kessler span', makeCtx().ctx).kind).toBe('error')
  })

  it('transit runs / holds metro lines', () => {
    const h = makeCtx()
    runExec(parse('transit METRO-B hold', h.ctx))
    expect(h.calls).toContainEqual(['setTransit', 'METRO-B', 'HOLD'])
    runExec(parse('transit b run', h.ctx))
    expect(h.calls).toContainEqual(['setTransit', 'METRO-B', 'RUN'])
  })

  it('scan biometric requests biometric mode and closes', () => {
    const h = makeCtx()
    const res = parse('scan biometric', h.ctx)
    expect(res.kind).toBe('exec')
    if (res.kind !== 'exec') return
    expect(res.closes).toBe(true)
    res.run()
    expect(h.calls).toContainEqual(['requestBiometric'])
  })

  it('dossier on a person selects + jumps to graph', () => {
    const h = makeCtx()
    runExec(parse('dossier P-0001', h.ctx))
    expect(h.calls).toContainEqual(['select', 'P-0001'])
    expect(h.calls).toContainEqual(['setView', 'graph'])
  })

  it('dossier on a non-person selects + locates instead', () => {
    const h = makeCtx()
    runExec(parse('dossier CAM-05', h.ctx))
    expect(h.calls).toContainEqual(['select', 'CAM-05'])
    expect(h.calls).toContainEqual(['locate', 'CAM-05'])
    expect(h.calls.some((c) => c[0] === 'setView')).toBe(false)
  })

  it('spawn incident: optional sector', () => {
    const h = makeCtx()
    runExec(parse('spawn incident', h.ctx))
    expect(h.calls).toContainEqual(['spawnIncident', undefined])
    runExec(parse('spawn incident SECTOR-4', h.ctx))
    expect(h.calls).toContainEqual(['spawnIncident', 'SECTOR-4'])
    expect(parse('spawn', makeCtx().ctx).kind).toBe('error')
  })

  it('theme echoes the reserved-slot note without side effects', () => {
    const h = makeCtx()
    const res = parse('theme', h.ctx)
    expect(res.kind).toBe('exec')
    if (res.kind !== 'exec') return
    expect(res.lineKind).toBe('note')
    expect(res.run()).toBe('LIGHT-OPS THEME: TOKEN SLOTS RESERVED — NOT PROVISIONED IN THIS BUILD')
    expect(h.calls.filter((c) => c[0] !== 'emit')).toEqual([])
  })

  it('mute toggles from ctx state', () => {
    const h = makeCtx({ muted: false })
    expect(runExec(parse('mute', h.ctx))).toBe('AUDIO MUTED')
    expect(h.calls).toContainEqual(['setMuted', true])
    const h2 = makeCtx({ muted: true })
    expect(runExec(parse('mute', h2.ctx))).toBe('AUDIO UNMUTED')
    expect(h2.calls).toContainEqual(['setMuted', false])
  })

  it('help lists every command', () => {
    const out = runExec(parse('help', makeCtx().ctx))
    expect(typeof out).toBe('string')
    for (const verb of ['goto', 'locate', 'track', 'bridge', 'defcon', 'spawn', 'theme', 'mute']) {
      expect(out).toContain(verb)
    }
  })

  it('unknown command → exact error line', () => {
    const res = parse('xyz', makeCtx().ctx)
    expect(res).toEqual({ kind: 'error', message: "ERR: UNKNOWN COMMAND 'xyz' — TRY help" })
  })

  it('every executed command emits > raw to the COMMAND channel', () => {
    const h = makeCtx()
    runExec(parse('  blackout   SECTOR-1 ', h.ctx))
    expect(h.emits[0]).toBe('> blackout SECTOR-1')
    expect(h.calls[0]).toEqual(['emit', 'NOTICE', 'COMMAND', '> blackout SECTOR-1'])
  })
})

/* ── defcon confirm flow ───────────────────────────────────────────── */

describe('parse — defcon confirm flow', () => {
  it('first run arms a confirm, does not commit', () => {
    const h = makeCtx()
    const res = parse('defcon 2', h.ctx)
    expect(res.kind).toBe('confirm')
    if (res.kind !== 'confirm') return
    expect(res.message).toBe('CONFIRM THREATCON OVERRIDE → DEFCON 2 — RUN AGAIN TO COMMIT')
    expect(res.key).toBe('defcon:2')
    expect(res.ttlMs).toBe(CONFIRM_TTL_MS)
    expect(h.calls).toEqual([])
  })

  it('identical command within 15s commits', () => {
    const h = makeCtx({ pending: { key: 'defcon:2', at: 1_000_000 - 5_000 }, now: 1_000_000 })
    const res = parse('defcon 2', h.ctx)
    expect(res.kind).toBe('exec')
    if (res.kind !== 'exec') return
    expect(res.disarm).toBe(true)
    expect(res.run()).toContain('DEFCON 2')
    expect(h.calls).toContainEqual(['setDefconOverride', 2])
  })

  it('a different level re-arms instead of committing', () => {
    const h = makeCtx({ pending: { key: 'defcon:2', at: 1_000_000 - 5_000 }, now: 1_000_000 })
    expect(parse('defcon 3', h.ctx).kind).toBe('confirm')
  })

  it('an expired arm (>15s) re-arms', () => {
    const h = makeCtx({ pending: { key: 'defcon:2', at: 1_000_000 - CONFIRM_TTL_MS - 1 }, now: 1_000_000 })
    expect(parse('defcon 2', h.ctx).kind).toBe('confirm')
  })

  it('defcon clear needs no confirm', () => {
    const h = makeCtx()
    const res = parse('defcon clear', h.ctx)
    expect(res.kind).toBe('exec')
    if (res.kind !== 'exec') return
    expect(res.disarm).toBe(true)
    res.run()
    expect(h.calls).toContainEqual(['setDefconOverride', null])
  })

  it('defcon rejects out-of-range levels', () => {
    expect(parse('defcon 7', makeCtx().ctx).kind).toBe('error')
    expect(parse('defcon 0', makeCtx().ctx).kind).toBe('error')
  })
})

/* ── complete: token contexts ──────────────────────────────────────── */

const cctx = (entities?: EntityRef[]): CommandCtx => {
  const h = makeCtx(entities ? { entities } : {})
  return h.ctx
}

describe('complete — suggestion contexts', () => {
  it('empty input lists all verbs', () => {
    const out = complete('', cctx())
    expect(out.map((s) => s.label)).toContain('goto')
    expect(out).toHaveLength(16)
    expect(out.every((s) => s.type === 'verb')).toBe(true)
  })

  it('partial verb fuzzy-filters', () => {
    const labels = complete('tra', cctx()).map((s) => s.label)
    expect(labels).toContain('track')
    expect(labels).toContain('traffic')
    expect(labels).not.toContain('goto')
  })

  it('goto completes views', () => {
    const out = complete('goto ', cctx())
    expect(out.map((s) => s.label)).toEqual(['map', 'grid', 'graph', 'infra', 'ops', 'markets'])
    expect(out[0].insert).toBe('goto map')
    expect(out[0].type).toBe('view')
  })

  it('locate completes entity ids with kind/sector/risk detail', () => {
    const out = complete('locate P', cctx())
    const p = out.find((s) => s.label === 'P-0001')
    expect(p).toBeDefined()
    expect(p?.detail).toBe('PERSON · SECTOR-3 · RISK 78')
    expect(p?.insert).toBe('locate P-0001')
    expect(p?.type).toBe('entity')
  })

  it('entity suggestions are capped at 8', () => {
    const many: EntityRef[] = Array.from({ length: 20 }, (_, i) => ({
      id: `P-${String(i + 1).padStart(4, '0')}`,
      kind: 'person',
      sector: 'SECTOR-1',
      risk: i,
    }))
    expect(complete('locate P', cctx(many))).toHaveLength(8)
  })

  it('track only suggests persons', () => {
    const out = complete('track ', cctx())
    expect(out.length).toBeGreaterThan(0)
    expect(out.every((s) => s.detail.startsWith('PERSON'))).toBe(true)
  })

  it('untrack prefers tracked persons', () => {
    const out = complete('untrack ', cctx())
    expect(out.map((s) => s.label)).toEqual(['P-0002'])
  })

  it('blackout completes sector ids with district names', () => {
    const out = complete('blackout ', cctx())
    expect(out).toHaveLength(9)
    expect(out[0].label).toBe('SECTOR-1')
    expect(out[0].detail).toContain('NORTHGATE')
    const cinder = complete('blackout cinder', cctx())
    expect(cinder.map((s) => s.label)).toEqual(['SECTOR-5'])
  })

  it('restore offers all + sectors', () => {
    const labels = complete('restore ', cctx()).map((s) => s.label)
    expect(labels[0]).toBe('all')
    expect(labels).toContain('SECTOR-9')
  })

  it('traffic completes sector then mode', () => {
    const sectors = complete('traffic ', cctx())
    expect(sectors[0].insert).toBe('traffic SECTOR-1 ')
    const modes = complete('traffic SECTOR-1 ', cctx())
    expect(modes.map((s) => s.label)).toEqual(['green', 'red', 'normal'])
    expect(modes[0].insert).toBe('traffic SECTOR-1 green')
  })

  it('bridge completes full multi-word names, then actions', () => {
    const names = complete('bridge ', cctx())
    expect(names.map((s) => s.label)).toEqual(BRIDGES)
    expect(names[0].insert).toBe('bridge KESSLER SPAN ')

    const filtered = complete('bridge kes', cctx())
    expect(filtered.map((s) => s.label)).toEqual(['KESSLER SPAN'])

    const actions = complete('bridge KESSLER SPAN ', cctx())
    expect(actions.map((s) => s.label)).toEqual(['raise', 'lower'])
    expect(actions[0].insert).toBe('bridge KESSLER SPAN raise')

    const partial = complete('bridge kessler span lo', cctx())
    expect(partial.map((s) => s.label)).toEqual(['lower'])
  })

  it('transit completes metro lines then run|hold', () => {
    const lines = complete('transit ', cctx())
    expect(lines.map((s) => s.label)).toEqual(LINES)
    const modes = complete('transit METRO-C ', cctx())
    expect(modes.map((s) => s.label)).toEqual(['run', 'hold'])
    expect(modes[1].insert).toBe('transit METRO-C hold')
  })

  it('defcon completes levels and clear', () => {
    const out = complete('defcon ', cctx())
    expect(out.map((s) => s.label)).toEqual(['1', '2', '3', '4', '5', 'clear'])
    expect(complete('defcon c', cctx()).map((s) => s.label)).toEqual(['clear'])
  })

  it('spawn completes incident, then sectors', () => {
    expect(complete('spawn ', cctx()).map((s) => s.label)).toEqual(['incident'])
    const sectors = complete('spawn incident ', cctx())
    expect(sectors).toHaveLength(9)
    expect(sectors[3].insert).toBe('spawn incident SECTOR-4')
  })

  it('nullary verbs offer no argument suggestions', () => {
    expect(complete('mute ', cctx())).toEqual([])
    expect(complete('theme ', cctx())).toEqual([])
    expect(complete('help ', cctx())).toEqual([])
  })

  it('unknown verbs offer nothing', () => {
    expect(complete('warp 9', cctx())).toEqual([])
  })
})
