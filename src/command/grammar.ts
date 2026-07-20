/**
 * PANOPTICON // OS — COMMAND TERMINAL grammar.
 *
 * Pure module: no store imports, no side effects at parse time. The terminal
 * (or a test) supplies a ctx object carrying world data + injected actions.
 * `parse` compiles one input line into an executable plan; `complete` returns
 * token-position-aware suggestions. Everything is deterministic and testable.
 */
import type { EntityKind, EventChannel, Severity, TrafficMode, TransitMode, ViewId } from '../sim/types'

/* ── context ───────────────────────────────────────────────────────── */

/** Lightweight entity snapshot — built from getWorld() pools by the terminal. */
export interface EntityRef {
  id: string
  kind: EntityKind
  sector: string
  /** persons: rounded risk score 0-100 */
  risk?: number
  /** persons: currently track-designated */
  tracked?: boolean
  /** extra detail-column info (callsign · status, incident type, cam status…) */
  note?: string
}

/** Optional live infra state — enriches suggestion detail columns only. */
export interface InfraSnapshot {
  power?: Record<string, boolean>
  traffic?: Record<string, string>
  transit?: Record<string, string>
  bridgesRaised?: Record<string, boolean>
}

/** Data required by complete(). parse() additionally needs GrammarCtx. */
export interface CommandCtx {
  /** SECTOR-1..9 */
  sectors: string[]
  /** SECTOR-n → district name */
  sectorNames: Record<string, string>
  /** bridge ids (= full multi-word names, e.g. "KESSLER SPAN") */
  bridges: string[]
  /** metro line ids, e.g. METRO-A */
  lines: string[]
  entities(): EntityRef[]
  infra?: InfraSnapshot
}

export interface PendingConfirm {
  /** command identity key (e.g. "defcon:2") */
  key: string
  /** epoch ms at arm time */
  at: number
}

export interface GrammarActions {
  setView(v: ViewId): void
  locate(id: string): boolean
  setTracked(id: string, on: boolean): void
  setPower(sector: string, on: boolean): void
  setTraffic(sector: string, mode: TrafficMode): void
  setBridge(id: string, raised: boolean): void
  setTransit(line: string, mode: TransitMode): void
  autoRestore(): void
  spawnIncident(sector?: string): void
  setDefconOverride(level: number | null): void
  requestBiometric(): void
  select(id: string | null): void
  setMuted(m: boolean): void
  emit(severity: Severity, channel: EventChannel, message: string): void
}

export interface GrammarCtx extends CommandCtx {
  muted: boolean
  pending: PendingConfirm | null
  now(): number
  actions: GrammarActions
}

/* ── results ───────────────────────────────────────────────────────── */

export type LineKind = 'result' | 'help' | 'note'

export interface ExecResult {
  kind: 'exec'
  /** canonical echo of the command (`bridge KESSLER SPAN raise`) */
  echo: string
  /** view-switching commands ask the terminal to close shortly after */
  closes: boolean
  lineKind: LineKind
  /** clears an armed pending-confirm (defcon commit / defcon clear) */
  disarm: boolean
  /** perform side effects; returns transcript result line(s), '\n'-joined */
  run(): string | void
}

export interface ErrorResult {
  kind: 'error'
  message: string
}

export interface ConfirmResult {
  kind: 'confirm'
  echo: string
  message: string
  /** the next identical command within ttlMs commits */
  key: string
  /** short header tag while armed (e.g. "DEFCON 2") */
  label: string
  ttlMs: number
}

export type ParseResult = ExecResult | ErrorResult | ConfirmResult

export const CONFIRM_TTL_MS = 15_000

/* ── suggestions ───────────────────────────────────────────────────── */

export type SuggestionType = 'verb' | 'entity' | 'sector' | 'bridge' | 'line' | 'view' | 'mode' | 'level' | 'arg'

export interface Suggestion {
  /** stable unique cmdk item value */
  value: string
  /** full replacement input line when applied */
  insert: string
  label: string
  detail: string
  type: SuggestionType
  glyph: string
}

/* ── command table ─────────────────────────────────────────────────── */

export interface CommandSpecEntry {
  verb: string
  syntax: string
  hint: string
  /** no-argument verbs — suggestion insert omits the trailing space */
  nullary?: boolean
}

export const COMMANDS: readonly CommandSpecEntry[] = [
  { verb: 'goto', syntax: 'goto map|grid|graph|infra|ops', hint: 'SWITCH CENTER STAGE VIEW' },
  { verb: 'locate', syntax: 'locate <ENTITY-ID>', hint: 'FLY TACTICAL MAP TO ENTITY' },
  { verb: 'track', syntax: 'track <PERSON-ID>', hint: 'DESIGNATE PERSON FOR TRACKING' },
  { verb: 'untrack', syntax: 'untrack <PERSON-ID>', hint: 'RELEASE TRACK DESIGNATION' },
  { verb: 'dossier', syntax: 'dossier <ENTITY-ID>', hint: 'OPEN DOSSIER · PERSON → LINK CHART' },
  { verb: 'scan', syntax: 'scan biometric', hint: 'ENGAGE BIOMETRIC SWEEP ON THE GRID' },
  { verb: 'blackout', syntax: 'blackout <SECTOR-ID>', hint: 'CUT SECTOR POWER' },
  { verb: 'restore', syntax: 'restore <SECTOR-ID>|all', hint: 'RESTORE POWER · all = FULL AUTO-RESTORE' },
  { verb: 'traffic', syntax: 'traffic <SECTOR-ID> green|red|normal', hint: 'FORCE TRAFFIC CONTROL MODE' },
  { verb: 'bridge', syntax: 'bridge <NAME> raise|lower', hint: 'ACTUATE RIVER SPAN' },
  { verb: 'transit', syntax: 'transit <LINE> run|hold', hint: 'RUN / HOLD METRO LINE' },
  { verb: 'defcon', syntax: 'defcon <1-5>|clear', hint: 'THREATCON OVERRIDE — RUN TWICE TO COMMIT' },
  { verb: 'spawn', syntax: 'spawn incident [SECTOR-ID]', hint: 'INJECT INCIDENT · RANDOM SECTOR IF OMITTED' },
  { verb: 'theme', syntax: 'theme', hint: 'LIGHT-OPS THEME STATUS', nullary: true },
  { verb: 'mute', syntax: 'mute', hint: 'TOGGLE AUDIO', nullary: true },
  { verb: 'help', syntax: 'help', hint: 'FULL COMMAND REFERENCE', nullary: true },
]

const VIEWS = ['map', 'grid', 'graph', 'infra', 'ops'] as const

const VIEW_LABELS: Record<ViewId, string> = {
  map: 'TACTICAL MAP',
  grid: 'SURVEILLANCE GRID',
  graph: 'PROFILER',
  infra: 'INFRASTRUCTURE',
  ops: 'OPS DECK',
}

function isView(v: string): v is ViewId {
  return (VIEWS as readonly string[]).includes(v)
}

const TRAFFIC_MODES: Record<string, TrafficMode> = {
  green: 'FORCE_GREEN',
  red: 'FORCE_RED',
  normal: 'NORMAL',
}

const TRAFFIC_HINTS: Record<string, string> = {
  green: 'FORCE ALL SIGNALS GREEN — FLUSH CORRIDOR',
  red: 'FORCE ALL SIGNALS RED — LOCK CORRIDOR',
  normal: 'RETURN TO ADAPTIVE CONTROL',
}

const DEFCON_HINTS: Record<string, string> = {
  '1': 'COND 1 — MAXIMUM READINESS',
  '2': 'COND 2 — ARMED POSTURE',
  '3': 'COND 3 — ELEVATED READINESS',
  '4': 'COND 4 — HEIGHTENED WATCH',
  '5': 'COND 5 — BASELINE POSTURE',
}

const KIND_GLYPH: Record<EntityKind, string> = {
  person: '◉',
  vehicle: '▢',
  patrol: '▲',
  incident: '◆',
  camera: '◎',
}

const GLYPH: Record<Exclude<SuggestionType, 'entity'>, string> = {
  verb: '▸',
  sector: '▦',
  bridge: '◠',
  line: '≡',
  view: '◫',
  mode: '◇',
  level: '△',
  arg: '·',
}

/* ── small helpers ─────────────────────────────────────────────────── */

/** 0 = no match; higher = better. Prefix > substring > in-order subsequence. */
export function fuzzyScore(candidate: string, query: string): number {
  if (!query) return 1
  const c = candidate.toLowerCase()
  const q = query.toLowerCase()
  if (c === q) return 4
  if (c.startsWith(q)) return 3
  if (c.includes(q)) return 2
  let at = 0
  for (const ch of q) {
    at = c.indexOf(ch, at)
    if (at === -1) return 0
    at++
  }
  return 1
}

function normSector(tok: string, ctx: CommandCtx): string | null {
  const up = tok.toUpperCase()
  const m = /^(?:S(?:ECTOR)?-?)?([1-9])$/.exec(up)
  const id = m ? `SECTOR-${m[1]}` : up
  return ctx.sectors.includes(id) ? id : null
}

function findRef(id: string, ctx: CommandCtx): EntityRef | undefined {
  const up = id.toUpperCase()
  return ctx.entities().find((e) => e.id === up)
}

/** Case-insensitive exact → unique-prefix → unique-substring bridge match. */
function matchBridge(name: string, bridges: string[]): { hit?: string; ambiguous?: string[] } {
  const up = name.toUpperCase()
  const exact = bridges.find((b) => b.toUpperCase() === up)
  if (exact) return { hit: exact }
  const pre = bridges.filter((b) => b.toUpperCase().startsWith(up))
  if (pre.length === 1) return { hit: pre[0] }
  if (pre.length > 1) return { ambiguous: pre }
  const sub = bridges.filter((b) => b.toUpperCase().includes(up))
  if (sub.length === 1) return { hit: sub[0] }
  if (sub.length > 1) return { ambiguous: sub }
  return {}
}

function normLine(tok: string, ctx: CommandCtx): string | null {
  const up = tok.toUpperCase()
  if (ctx.lines.includes(up)) return up
  if (/^[A-Z]$/.test(up) && ctx.lines.includes(`METRO-${up}`)) return `METRO-${up}`
  return null
}

export function helpText(): string {
  const width = Math.max(...COMMANDS.map((c) => c.syntax.length)) + 3
  const rows = COMMANDS.map((c) => `  ${c.syntax.padEnd(width)}${c.hint}`)
  return [`COMMAND REFERENCE · ${COMMANDS.length} COMMANDS · ALL TARGETS SIMULATED`, ...rows].join('\n')
}

/* ── parse ─────────────────────────────────────────────────────────── */

export function parse(raw: string, ctx: GrammarCtx): ParseResult {
  const line = raw.trim().replace(/\s+/g, ' ')
  if (!line) return { kind: 'error', message: 'ERR: EMPTY COMMAND' }
  const tokens = line.split(' ')
  const verb = tokens[0].toLowerCase()
  const args = tokens.slice(1)
  const A = ctx.actions

  const err = (message: string): ErrorResult => ({ kind: 'error', message })
  const exec = (
    echo: string,
    run: () => string | void,
    o: { closes?: boolean; lineKind?: LineKind; disarm?: boolean } = {},
  ): ExecResult => ({
    kind: 'exec',
    echo,
    closes: o.closes ?? false,
    lineKind: o.lineKind ?? 'result',
    disarm: o.disarm ?? false,
    run: () => {
      A.emit('NOTICE', 'COMMAND', `> ${line}`)
      return run()
    },
  })

  switch (verb) {
    case 'goto': {
      const v = (args[0] ?? '').toLowerCase()
      if (args.length !== 1 || !isView(v)) return err('ERR: USAGE: goto map|grid|graph|infra|ops')
      return exec(`goto ${v}`, () => {
        A.setView(v)
        return `VIEW → ${VIEW_LABELS[v]}`
      }, { closes: true })
    }

    case 'locate': {
      if (args.length !== 1) return err('ERR: USAGE: locate <ENTITY-ID>')
      const ref = findRef(args[0], ctx)
      if (!ref) return err(`ERR: NO SUCH ENTITY '${args[0].toUpperCase()}'`)
      return exec(`locate ${ref.id}`, () => {
        if (!A.locate(ref.id)) return `ERR: NO SUCH ENTITY '${ref.id}'`
        return `FLY-TO ENGAGED · ${ref.id} · ${ref.sector}`
      })
    }

    case 'track':
    case 'untrack': {
      if (args.length !== 1) return err(`ERR: USAGE: ${verb} <PERSON-ID>`)
      const ref = findRef(args[0], ctx)
      if (!ref) return err(`ERR: NO SUCH ENTITY '${args[0].toUpperCase()}'`)
      const on = verb === 'track'
      if (on && ref.kind !== 'person') return err(`ERR: '${ref.id}' IS NOT A PERSON — TRACKING REQUIRES PERSON CLASS`)
      return exec(`${verb} ${ref.id}`, () => {
        A.setTracked(ref.id, on)
        return on ? `TRACK DESIGNATED · ${ref.id} · ${ref.sector}` : `TRACK RELEASED · ${ref.id}`
      })
    }

    case 'blackout': {
      if (args.length !== 1) return err('ERR: USAGE: blackout <SECTOR-ID>')
      const s = normSector(args[0], ctx)
      if (!s) return err(`ERR: NO SUCH SECTOR '${args[0].toUpperCase()}'`)
      return exec(`blackout ${s}`, () => {
        A.setPower(s, false)
        return `${s} POWER CUT — GRID DARK`
      })
    }

    case 'restore': {
      if (args.length !== 1) return err('ERR: USAGE: restore <SECTOR-ID>|all')
      if (args[0].toLowerCase() === 'all')
        return exec('restore all', () => {
          A.autoRestore()
          return 'AUTO-RESTORE ENGAGED — ALL SYSTEMS NOMINAL'
        })
      const s = normSector(args[0], ctx)
      if (!s) return err(`ERR: NO SUCH SECTOR '${args[0].toUpperCase()}'`)
      return exec(`restore ${s}`, () => {
        A.setPower(s, true)
        return `${s} POWER RESTORED`
      })
    }

    case 'traffic': {
      if (args.length !== 2) return err('ERR: USAGE: traffic <SECTOR-ID> green|red|normal')
      const s = normSector(args[0], ctx)
      if (!s) return err(`ERR: NO SUCH SECTOR '${args[0].toUpperCase()}'`)
      const word = args[1].toLowerCase()
      const mode = TRAFFIC_MODES[word]
      if (!mode) return err('ERR: TRAFFIC MODE MUST BE green|red|normal')
      return exec(`traffic ${s} ${word}`, () => {
        A.setTraffic(s, mode)
        return `${s} TRAFFIC CONTROL → ${mode.replace('_', '-')}`
      })
    }

    case 'bridge': {
      if (args.length < 2) return err('ERR: USAGE: bridge <NAME> raise|lower')
      const act = args[args.length - 1].toLowerCase()
      if (act !== 'raise' && act !== 'lower') return err('ERR: USAGE: bridge <NAME> raise|lower')
      const name = args.slice(0, -1).join(' ')
      const m = matchBridge(name, ctx.bridges)
      if (m.ambiguous) return err(`ERR: AMBIGUOUS BRIDGE '${name.toUpperCase()}' — MATCHES ${m.ambiguous.join(', ')}`)
      if (!m.hit) return err(`ERR: NO SUCH BRIDGE '${name.toUpperCase()}'`)
      const id = m.hit
      const raised = act === 'raise'
      return exec(`bridge ${id} ${act}`, () => {
        A.setBridge(id, raised)
        return `${id} ${raised ? 'RAISED — SPAN OPEN' : 'LOWERED — SPAN CLOSED'}`
      })
    }

    case 'transit': {
      if (args.length !== 2) return err('ERR: USAGE: transit <LINE> run|hold')
      const lineId = normLine(args[0], ctx)
      if (!lineId) return err(`ERR: NO SUCH LINE '${args[0].toUpperCase()}'`)
      const word = args[1].toLowerCase()
      if (word !== 'run' && word !== 'hold') return err('ERR: TRANSIT MODE MUST BE run|hold')
      const mode: TransitMode = word === 'run' ? 'RUN' : 'HOLD'
      return exec(`transit ${lineId} ${word}`, () => {
        A.setTransit(lineId, mode)
        return `${lineId} ${mode === 'RUN' ? 'SERVICE RESUMED' : 'HELD AT PLATFORM'}`
      })
    }

    case 'scan': {
      if (args.length !== 1 || args[0].toLowerCase() !== 'biometric') return err('ERR: USAGE: scan biometric')
      return exec('scan biometric', () => {
        A.requestBiometric()
        return 'BIOMETRIC SWEEP INITIATED — SURVEILLANCE GRID ENGAGED'
      }, { closes: true })
    }

    case 'dossier': {
      if (args.length !== 1) return err('ERR: USAGE: dossier <ENTITY-ID>')
      const ref = findRef(args[0], ctx)
      if (!ref) return err(`ERR: NO SUCH ENTITY '${args[0].toUpperCase()}'`)
      return exec(`dossier ${ref.id}`, () => {
        A.select(ref.id)
        if (ref.kind === 'person') {
          A.setView('graph')
          return `DOSSIER OPEN · ${ref.id} — LINK ANALYSIS ENGAGED`
        }
        A.locate(ref.id)
        return `DOSSIER OPEN · ${ref.id} — TRACKING ON TACTICAL MAP`
      }, { closes: true })
    }

    case 'defcon': {
      if (args.length !== 1) return err('ERR: USAGE: defcon <1-5>|clear')
      const arg = args[0].toLowerCase()
      if (arg === 'clear')
        return exec('defcon clear', () => {
          A.setDefconOverride(null)
          return 'THREATCON OVERRIDE CLEARED — AUTO ASSESSMENT RESUMED'
        }, { disarm: true })
      if (!/^[1-5]$/.test(arg)) return err('ERR: DEFCON LEVEL MUST BE 1-5 (OR clear)')
      const n = Number(arg)
      const key = `defcon:${n}`
      const armed = ctx.pending && ctx.pending.key === key && ctx.now() - ctx.pending.at <= CONFIRM_TTL_MS
      if (!armed)
        return {
          kind: 'confirm',
          echo: `defcon ${n}`,
          message: `CONFIRM THREATCON OVERRIDE → DEFCON ${n} — RUN AGAIN TO COMMIT`,
          key,
          label: `DEFCON ${n}`,
          ttlMs: CONFIRM_TTL_MS,
        }
      return exec(`defcon ${n}`, () => {
        A.setDefconOverride(n)
        return `THREATCON OVERRIDE COMMITTED → DEFCON ${n}`
      }, { disarm: true })
    }

    case 'spawn': {
      if (args.length < 1 || args[0].toLowerCase() !== 'incident' || args.length > 2)
        return err('ERR: USAGE: spawn incident [SECTOR-ID]')
      let sector: string | undefined
      if (args.length === 2) {
        const s = normSector(args[1], ctx)
        if (!s) return err(`ERR: NO SUCH SECTOR '${args[1].toUpperCase()}'`)
        sector = s
      }
      return exec(`spawn incident${sector ? ` ${sector}` : ''}`, () => {
        A.spawnIncident(sector)
        return `INCIDENT INJECTION AUTHORIZED · ${sector ?? 'RANDOM SECTOR'}`
      })
    }

    case 'theme': {
      if (args.length !== 0) return err('ERR: USAGE: theme')
      return exec('theme', () => 'LIGHT-OPS THEME: TOKEN SLOTS RESERVED — NOT PROVISIONED IN THIS BUILD', {
        lineKind: 'note',
      })
    }

    case 'mute': {
      if (args.length !== 0) return err('ERR: USAGE: mute')
      const next = !ctx.muted
      return exec('mute', () => {
        A.setMuted(next)
        return next ? 'AUDIO MUTED' : 'AUDIO UNMUTED'
      })
    }

    case 'help': {
      if (args.length !== 0) return err('ERR: USAGE: help')
      return exec('help', () => helpText(), { lineKind: 'help' })
    }

    default:
      return err(`ERR: UNKNOWN COMMAND '${tokens[0]}' — TRY help`)
  }
}

/* ── complete ──────────────────────────────────────────────────────── */

const sug = (
  type: SuggestionType,
  label: string,
  insert: string,
  detail: string,
  glyph?: string,
): Suggestion => ({
  value: `${type}:${label}`,
  insert,
  label,
  detail,
  type,
  glyph: glyph ?? (type === 'entity' ? '·' : GLYPH[type as Exclude<SuggestionType, 'entity'>]),
})

function verbSuggestions(part: string): Suggestion[] {
  return COMMANDS.map((c) => ({ c, s: fuzzyScore(c.verb, part) }))
    .filter(({ s }) => s > 0)
    .sort((a, b) => b.s - a.s)
    .map(({ c }) => {
      const rest = c.syntax.slice(c.verb.length).trim()
      return sug('verb', c.verb, c.nullary ? c.verb : `${c.verb} `, rest ? `${rest} · ${c.hint}` : c.hint)
    })
}

function entityDetail(e: EntityRef): string {
  const bits = [e.kind.toUpperCase(), e.sector]
  if (e.risk !== undefined) bits.push(`RISK ${e.risk}`)
  if (e.note) bits.push(e.note)
  return bits.join(' · ')
}

function entitySuggestions(
  verb: string,
  part: string,
  ctx: CommandCtx,
  kinds?: EntityKind[],
  preferTracked = false,
): Suggestion[] {
  const q = part.toUpperCase()
  let pool = ctx.entities()
  if (kinds) pool = pool.filter((e) => kinds.includes(e.kind))
  if (preferTracked) {
    const tracked = pool.filter((e) => e.tracked)
    if (tracked.length > 0) pool = tracked
  }
  const scored: { e: EntityRef; s: number }[] = []
  for (const e of pool) {
    let s = 0
    if (!q) s = 1
    else if (e.id.startsWith(q)) s = 3
    else if (e.id.includes(q)) s = 2
    else continue
    scored.push({ e, s })
  }
  scored.sort((a, b) => b.s - a.s || (b.e.risk ?? -1) - (a.e.risk ?? -1))
  return scored
    .slice(0, 8)
    .map(({ e }) => sug('entity', e.id, `${verb} ${e.id}`, entityDetail(e), KIND_GLYPH[e.kind]))
}

function sectorDetail(ctx: CommandCtx, s: string): string {
  const bits = [ctx.sectorNames[s] ?? 'DISTRICT']
  if (ctx.infra?.power?.[s] === false) bits.push('GRID DARK')
  const t = ctx.infra?.traffic?.[s]
  if (t && t !== 'NORMAL' && t !== 'BLACKOUT') bits.push(t.replace('_', '-'))
  return bits.join(' · ')
}

function sectorSuggestions(lead: string, part: string, ctx: CommandCtx, trailingSpace: boolean): Suggestion[] {
  const q = part.toUpperCase()
  const out: Suggestion[] = []
  for (const s of ctx.sectors) {
    const name = (ctx.sectorNames[s] ?? '').toUpperCase()
    const num = s.replace('SECTOR-', '')
    const hit = !q || s.includes(q) || name.includes(q) || q === num || q === `S${num}` || q === `S-${num}`
    if (!hit) continue
    out.push(sug('sector', s, `${lead}${s}${trailingSpace ? ' ' : ''}`, sectorDetail(ctx, s)))
  }
  return out
}

function bridgeSuggestions(argsAll: string[], ctx: CommandCtx): Suggestion[] {
  const joined = argsAll.join(' ').toUpperCase()
  // full name already typed → offer actions (filtered by any trailing partial)
  for (const b of ctx.bridges) {
    const bu = b.toUpperCase()
    if (joined === bu || joined.startsWith(`${bu} `)) {
      const rest = joined.slice(bu.length).trim().toLowerCase()
      const out: Suggestion[] = []
      for (const act of ['raise', 'lower'] as const) {
        if (rest && !act.startsWith(rest)) continue
        out.push(
          sug('mode', act, `bridge ${b} ${act}`, act === 'raise' ? 'OPEN SPAN — SEVER CROSSING' : 'CLOSE SPAN — RESTORE CROSSING'),
        )
      }
      return out
    }
  }
  const out: Suggestion[] = []
  for (const b of ctx.bridges) {
    const bu = b.toUpperCase()
    if (joined && !bu.startsWith(joined) && !bu.includes(joined)) continue
    const raised = ctx.infra?.bridgesRaised?.[b]
    const detail = raised === true ? 'RAISED — SPAN OPEN' : raised === false ? 'LOWERED — SPAN CLOSED' : 'RIVER SPAN'
    out.push(sug('bridge', b, `bridge ${b} `, detail))
  }
  return out
}

function wordSuggestions(
  lead: string,
  part: string,
  words: readonly { w: string; hint: string; type?: SuggestionType; trailing?: boolean }[],
): Suggestion[] {
  const p = part.toLowerCase()
  return words
    .filter(({ w }) => !p || w.toLowerCase().startsWith(p))
    .map(({ w, hint, type, trailing }) => sug(type ?? 'arg', w, `${lead}${w}${trailing ? ' ' : ''}`, hint))
}

export function complete(input: string, ctx: CommandCtx): Suggestion[] {
  const trailing = /\s$/.test(input)
  const trimmed = input.trim()
  const tokens = trimmed ? trimmed.split(/\s+/) : []

  if (tokens.length === 0) return verbSuggestions('')
  if (tokens.length === 1 && !trailing) return verbSuggestions(tokens[0])

  const verb = tokens[0].toLowerCase()
  const argsAll = tokens.slice(1)
  const done = trailing ? argsAll : argsAll.slice(0, -1)
  const part = trailing ? '' : (argsAll[argsAll.length - 1] ?? '')

  switch (verb) {
    case 'goto':
      if (done.length > 0) return []
      return wordSuggestions('goto ', part, VIEWS.map((v) => ({ w: v, hint: VIEW_LABELS[v], type: 'view' as const })))

    case 'locate':
      return done.length > 0 ? [] : entitySuggestions('locate', part, ctx)

    case 'dossier':
      return done.length > 0 ? [] : entitySuggestions('dossier', part, ctx)

    case 'track':
      return done.length > 0 ? [] : entitySuggestions('track', part, ctx, ['person'])

    case 'untrack':
      return done.length > 0 ? [] : entitySuggestions('untrack', part, ctx, ['person'], true)

    case 'blackout':
      return done.length > 0 ? [] : sectorSuggestions('blackout ', part, ctx, false)

    case 'restore': {
      if (done.length > 0) return []
      const all = wordSuggestions('restore ', part, [{ w: 'all', hint: 'AUTO-RESTORE — ALL SECTORS & SYSTEMS' }])
      return [...all, ...sectorSuggestions('restore ', part, ctx, false)]
    }

    case 'traffic': {
      if (done.length === 0) return sectorSuggestions('traffic ', part, ctx, true)
      if (done.length === 1) {
        const s = normSector(done[0], ctx) ?? done[0].toUpperCase()
        return wordSuggestions(`traffic ${s} `, part, (['green', 'red', 'normal'] as const).map((w) => ({
          w,
          hint: TRAFFIC_HINTS[w],
          type: 'mode' as const,
        })))
      }
      return []
    }

    case 'bridge':
      return bridgeSuggestions(argsAll, ctx)

    case 'transit': {
      if (done.length === 0) {
        const q = part.toUpperCase()
        return ctx.lines
          .filter((l) => !q || l.includes(q) || l.endsWith(`-${q}`))
          .map((l) => sug('line', l, `transit ${l} `, `METRO LINE${ctx.infra?.transit?.[l] ? ` · ${ctx.infra.transit[l]}` : ''}`))
      }
      if (done.length === 1) {
        const l = normLine(done[0], ctx) ?? done[0].toUpperCase()
        return wordSuggestions(`transit ${l} `, part, [
          { w: 'run', hint: 'RESUME SERVICE', type: 'mode' as const },
          { w: 'hold', hint: 'HOLD ALL TRAINS AT PLATFORM', type: 'mode' as const },
        ])
      }
      return []
    }

    case 'scan':
      if (done.length > 0) return []
      return wordSuggestions('scan ', part, [{ w: 'biometric', hint: 'BIOMETRIC SWEEP — JUMPS TO SURVEILLANCE GRID' }])

    case 'defcon': {
      if (done.length > 0) return []
      const levels = (['1', '2', '3', '4', '5'] as const).map((w) => ({
        w,
        hint: DEFCON_HINTS[w],
        type: 'level' as const,
      }))
      return wordSuggestions('defcon ', part, [...levels, { w: 'clear', hint: 'RELEASE OVERRIDE — AUTO ASSESSMENT' }])
    }

    case 'spawn': {
      if (done.length === 0)
        return wordSuggestions('spawn ', part, [
          { w: 'incident', hint: 'INJECT SYNTHETIC INCIDENT', trailing: true },
        ])
      if (done.length === 1 && done[0].toLowerCase() === 'incident')
        return sectorSuggestions('spawn incident ', part, ctx, false)
      return []
    }

    default:
      return []
  }
}
