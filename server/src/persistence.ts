/**
 * SQLite-backed rolling persistence for the PANOPTICON server.
 *
 * Persists the EngineHost's history ring buffers and recent-event tail so world
 * state survives restarts. EVERY sqlite call is wrapped: any failure logs a
 * warning and degrades to an in-memory no-op — persistence must NEVER crash the
 * daemon. When the DB can't be opened the instance simply becomes disabled and
 * all methods return safe empties.
 *
 * Schema:
 *   meta(key, value)                    — 'seed', 'savedAt'
 *   histories(id=1, json)               — single row, the 7 named number[] series
 *   events(seq, tick, sim_minutes, …)   — recent WireEvents, capped to MAX_EVENTS
 */
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'
import type { WireEvent } from '../../src/realtime/protocol'
import type { Histories } from '../../src/sim/types'

export interface LoadedState {
  histories?: Histories
  recentEvents?: WireEvent[]
}

export interface Snapshot {
  histories: Histories
  recent: WireEvent[]
}

interface EventRow {
  tick: number
  sim_minutes: number
  wall: number
  severity: string
  channel: string
  sector: string | null
  entity_id: string | null
  message: string
}

const MAX_EVENTS = 500

function warn(op: string, err: unknown): void {
  console.warn(`[persistence] ${op} failed — continuing in-memory:`, err instanceof Error ? err.message : err)
}

export class Persistence {
  private db: Database.Database | null = null
  private readonly expectedSeed: number

  constructor(dbPath: string, seed: number) {
    this.expectedSeed = seed
    try {
      mkdirSync(dirname(dbPath), { recursive: true })
      this.db = new Database(dbPath)
      this.db.pragma('journal_mode = WAL')
      this.db.pragma('synchronous = NORMAL')
      this.migrate()
    } catch (err) {
      warn('open', err)
      this.db = null
    }
  }

  /** false when the DB failed to open — the server keeps running regardless */
  get enabled(): boolean {
    return this.db !== null
  }

  private migrate(): void {
    if (!this.db) return
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS histories (
        id   INTEGER PRIMARY KEY CHECK (id = 1),
        json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        seq         INTEGER PRIMARY KEY AUTOINCREMENT,
        tick        INTEGER NOT NULL,
        sim_minutes REAL    NOT NULL,
        wall        INTEGER NOT NULL,
        severity    TEXT    NOT NULL,
        channel     TEXT    NOT NULL,
        sector      TEXT,
        entity_id   TEXT,
        message     TEXT    NOT NULL
      );
    `)
  }

  /**
   * Load persisted state IFF the stored seed matches the configured one.
   * Returns an empty object on: disabled DB, no prior save, seed mismatch, or
   * any read error — all of which mean "fresh start".
   */
  loadSeed(): LoadedState {
    if (!this.db) return {}
    try {
      const seedRow = this.db.prepare('SELECT value FROM meta WHERE key = ?').get('seed') as { value: string } | undefined
      if (!seedRow) return {}
      const storedSeed = Number(seedRow.value)
      if (!Number.isFinite(storedSeed) || storedSeed !== this.expectedSeed) return {}

      let histories: Histories | undefined
      const hRow = this.db.prepare('SELECT json FROM histories WHERE id = 1').get() as { json: string } | undefined
      if (hRow) {
        try {
          histories = JSON.parse(hRow.json) as Histories
        } catch (err) {
          warn('parse histories', err)
        }
      }

      const rows = this.db
        .prepare(
          'SELECT tick, sim_minutes, wall, severity, channel, sector, entity_id, message FROM events ORDER BY seq ASC LIMIT ?',
        )
        .all(MAX_EVENTS) as EventRow[]
      const recentEvents = rows.map(rowToEvent)

      return {
        histories,
        recentEvents: recentEvents.length > 0 ? recentEvents : undefined,
      }
    } catch (err) {
      warn('loadSeed', err)
      return {}
    }
  }

  /** Persist the current snapshot atomically; replaces prior state. No-op on error. */
  save(snapshot: Snapshot, seed: number): void {
    if (!this.db) return
    try {
      const db = this.db
      const upsertMeta = db.prepare(
        'INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      const upsertHist = db.prepare(
        'INSERT INTO histories(id, json) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json',
      )
      const clearEvents = db.prepare('DELETE FROM events')
      const insEvent = db.prepare(
        'INSERT INTO events(tick, sim_minutes, wall, severity, channel, sector, entity_id, message) VALUES(?, ?, ?, ?, ?, ?, ?, ?)',
      )
      const commit = db.transaction((snap: Snapshot, s: number) => {
        upsertMeta.run('seed', String(s))
        upsertMeta.run('savedAt', String(Date.now()))
        upsertHist.run(JSON.stringify(snap.histories))
        clearEvents.run()
        for (const e of snap.recent.slice(-MAX_EVENTS)) {
          insEvent.run(e.tick, e.simMinutes, e.wall, e.severity, e.channel, e.sector ?? null, e.entityId ?? null, e.message)
        }
      })
      commit(snapshot, seed)
    } catch (err) {
      warn('save', err)
    }
  }

  close(): void {
    if (!this.db) return
    try {
      this.db.close()
    } catch (err) {
      warn('close', err)
    } finally {
      this.db = null
    }
  }
}

function rowToEvent(r: EventRow): WireEvent {
  const e: WireEvent = {
    tick: r.tick,
    simMinutes: r.sim_minutes,
    wall: r.wall,
    severity: r.severity as WireEvent['severity'],
    channel: r.channel as WireEvent['channel'],
    message: r.message,
  }
  if (r.sector != null) e.sector = r.sector
  if (r.entity_id != null) e.entityId = r.entity_id
  return e
}
