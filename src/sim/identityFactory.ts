/**
 * Deterministic fictional-identity generator.
 *
 * Every record is procedurally generated from token lists, keyed by entity id —
 * re-opening the same entity always yields the same dossier and network.
 * Names are invented combinations and represent no real person.
 * Every record carries `source: 'SIMULATED'`.
 */

import { Rand, hashString } from './seed'
import type { Dossier, EdgeType, GraphEdge, GraphNode, LinkNetwork, NodeType, SectorId, TimelineEntry } from './types'

const FIRST = [
  'Dario', 'Mirelle', 'Kaspar', 'Odile', 'Ansel', 'Vera', 'Rutger', 'Imara',
  'Silas', 'Nadia', 'Corin', 'Elva', 'Marek', 'Talia', 'Bram', 'Yara',
  'Hollis', 'Ingrid', 'Dorian', 'Sable', 'Emeric', 'Liora', 'Casimir', 'Wren',
  'Alaric', 'Petra', 'Lucian', 'Maren', 'Stellan', 'Ottilie',
] as const

const LAST = [
  'Voss', 'Calder', 'Renn', 'Marlowe', 'Hale', 'Strand', 'Kessler', 'Vane',
  'Mercer', 'Ashford', 'Locke', 'Farrow', 'Grieve', 'Holt', 'Nyberg', 'Corvi',
  'Draker', 'Elling', 'Sorrel', 'Thorne', 'Vasker', 'Quill', 'Rooke', 'Stavric',
  'Lund', 'Harrow', 'Fenn', 'Iversen', 'Moss', 'Blackwood',
] as const

const ALIAS = [
  'GHOST', 'CIPHER', 'LOWLINE', 'VECTOR', 'HALCYON', 'NOMAD', 'WIRE', 'DRIFT',
  'ECHO', 'MARROW', 'TALLY', 'FLINT', 'ORACLE', 'STATIC', 'HARBORMASTER', 'PALE',
] as const

const FLAGS = [
  'PATTERN-OF-LIFE ANOMALY',
  'FREQUENT SECTOR CROSSER',
  'SIGNAL-DARK PERIODS',
  'ASSOCIATE OF FLAGGED ENTITY',
  'FINANCIAL IRREGULARITY',
  'NIGHT MOVEMENT BIAS',
  'COUNTER-SURVEILLANCE BEHAVIOR',
  'UNREGISTERED DEVICE ROTATION',
] as const

const TIMELINE_TMPL = [
  'OBSERVED AT TRANSIT NODE',
  'ENTERED CAMERA FOV',
  'SIGNAL REACQUIRED',
  'TRANSACTION FLAGGED',
  'CO-LOCATION EVENT LOGGED',
  'DEVICE HANDSHAKE CAPTURED',
  'CROSSED SECTOR BOUNDARY',
  'DWELL-TIME THRESHOLD EXCEEDED',
] as const

const LOCATIONS = [
  'DRYDOCK 9', 'MERIDIAN PLAZA', 'HALE STREET EXCHANGE', 'NORTH TERMINAL',
  'PIER 4 ANNEX', 'CINDER YARD', 'VELLUM ARCADE', 'RELAY HOUSE 12',
  'THE GRANARY', 'SOUTH LOCKS',
] as const

/** Number of persons the world instantiates — associate ids map into this range. */
export const PERSON_POOL = 260

export function personIdFromIndex(i: number): string {
  return `P-${String(i + 1).padStart(4, '0')}`
}

export function sectorFromRand(r: Rand): SectorId {
  return `SECTOR-${r.int(1, 9)}`
}

export function fullNameFor(id: string): string {
  const r = new Rand(`${id}:name`)
  return `${r.pick(FIRST)} ${r.pick(LAST)}`
}

export function getDossier(id: string): Dossier {
  const r = new Rand(`${id}:dossier`)
  const name = fullNameFor(id)
  const risk = Math.round(10 + 88 * r.low(1.7))
  const status: Dossier['status'] = risk >= 70 ? 'FLAGGED' : risk >= 45 ? 'WATCH' : 'NOMINAL'
  const yob = r.int(1958, 2004)
  const dob = `${yob}-${String(r.int(1, 12)).padStart(2, '0')}-${String(r.int(1, 28)).padStart(2, '0')}`

  const devices: string[] = [`PHN-${r.int(2100, 9899)}-${r.int(1000, 9999)}`]
  if (r.chance(0.55)) devices.push(`VEH-${String.fromCharCode(65 + r.int(0, 25))}${String.fromCharCode(65 + r.int(0, 25))}${r.int(100, 999)}`)
  if (r.chance(0.3)) devices.push(`ACC-${r.int(10, 98)}-${r.int(10000, 98999)}`)

  const flagCount = risk >= 70 ? r.int(2, 4) : risk >= 45 ? r.int(1, 2) : r.chance(0.25) ? 1 : 0
  const flags = r.shuffle([...FLAGS]).slice(0, flagCount)

  const timeline: TimelineEntry[] = []
  let t = r.int(60, 400)
  const n = r.int(4, 7)
  for (let i = 0; i < n; i++) {
    timeline.push({ simMinutes: t, label: r.pick(TIMELINE_TMPL), sector: sectorFromRand(r) })
    t += r.int(25, 240)
  }

  return {
    id,
    name,
    alias: r.chance(0.45) ? `“${r.pick(ALIAS)}”` : '—',
    dob,
    risk,
    status,
    lastSeenSector: sectorFromRand(r),
    devices,
    flags,
    timeline,
    source: 'SIMULATED',
  }
}

/* ── link network ──────────────────────────────────────────────────── */

function edgeTypeFor(t: NodeType, r: Rand): EdgeType {
  switch (t) {
    case 'phone':
      return r.chance(0.6) ? 'CALLED' : 'OWNS'
    case 'vehicle':
      return 'OWNS'
    case 'account':
      return 'TRANSACTED'
    case 'location':
      return 'CO-LOCATED'
    case 'person':
      return r.chance(0.75) ? 'ASSOCIATE' : 'CO-LOCATED'
  }
}

function childrenOf(personId: string): GraphNode[] {
  const r = new Rand(`${personId}:net`)
  const out: GraphNode[] = []
  const nAssoc = r.int(2, 4)
  for (let i = 0; i < nAssoc; i++) {
    // associates are drawn from the same world person pool — deterministic
    const idx = Math.abs(hashString(`${personId}:assoc:${i}`)) % PERSON_POOL
    const pid = personIdFromIndex(idx)
    if (pid === personId) continue
    out.push({ id: pid, type: 'person', label: fullNameFor(pid), sub: pid, risk: getDossier(pid).risk })
  }
  const nPhones = r.int(1, 2)
  for (let i = 0; i < nPhones; i++) {
    const id = `PHN-${r.int(2100, 9899)}-${r.int(1000, 9999)}`
    out.push({ id: `${personId}:${id}`, type: 'phone', label: id, sub: 'HANDSET' })
  }
  if (r.chance(0.6)) {
    const plate = `${String.fromCharCode(65 + r.int(0, 25))}${String.fromCharCode(65 + r.int(0, 25))}-${r.int(100, 999)}`
    out.push({ id: `${personId}:VEH-${plate}`, type: 'vehicle', label: `VEH ${plate}`, sub: 'REGISTERED' })
  }
  if (r.chance(0.5)) {
    const acc = `ACC-${r.int(10, 98)}-${r.int(10000, 98999)}`
    out.push({ id: `${personId}:${acc}`, type: 'account', label: acc, sub: 'LEDGER' })
  }
  const nLoc = r.int(1, 2)
  for (let i = 0; i < nLoc; i++) {
    const loc = r.pick(LOCATIONS)
    out.push({ id: `LOC-${loc.replace(/\s+/g, '-')}`, type: 'location', label: loc, sub: 'SITE' })
  }
  return out
}

/**
 * Deterministic ego network for a person entity, expanded to `hops` degrees.
 * Person nodes re-expand with their own deterministic children, so pulling the
 * thread always reproduces the same web.
 */
export function getNetwork(rootId: string, hops: number): LinkNetwork {
  const nodes = new Map<string, GraphNode>()
  const edges = new Map<string, GraphEdge>()
  const rootDossier = getDossier(rootId)
  nodes.set(rootId, { id: rootId, type: 'person', label: rootDossier.name, sub: rootId, risk: rootDossier.risk })

  let frontier: string[] = [rootId]
  for (let hop = 0; hop < Math.max(1, Math.min(3, hops)); hop++) {
    const next: string[] = []
    for (const pid of frontier) {
      const r = new Rand(`${pid}:edges`)
      for (const child of childrenOf(pid)) {
        if (!nodes.has(child.id)) nodes.set(child.id, child)
        const eid = pid < child.id ? `${pid}→${child.id}` : `${child.id}→${pid}`
        if (!edges.has(eid)) {
          edges.set(eid, {
            id: eid,
            source: pid,
            target: child.id,
            type: edgeTypeFor(child.type, r),
            weight: r.range(0.3, 1),
          })
        }
        if (child.type === 'person') next.push(child.id)
      }
    }
    frontier = next
  }

  return { nodes: [...nodes.values()], edges: [...edges.values()] }
}
