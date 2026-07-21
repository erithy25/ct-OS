/**
 * PANOPTICON // OS — realtime server (Phase 0).
 *
 * Runs the authoritative EngineHost at 10 Hz, streams one TickMsg JSON object
 * per WebSocket message to every connected client, accepts client commands, and
 * persists rolling world state to SQLite so it survives restarts.
 *
 * Wire contract lives in ../../src/realtime/protocol.ts. Framing is exactly one
 * JSON object per WS message; a `hello` snapshot is sent immediately on connect,
 * then a `tick` every TICK_MS.
 *
 * Defensive by construction: no throw escapes the tick loop or the message
 * handler, DB failures degrade to a no-op, and dead sockets are pruned.
 */
import http from 'node:http'
import { WebSocket, WebSocketServer } from 'ws'
import { z } from 'zod'
import { EngineHost } from '../../src/realtime/engineHost'
import { isCommandMsg, type SourceCommand } from '../../src/realtime/protocol'
import { config } from './config'
import { Persistence } from './persistence'
import { startHostFeed } from './hostFeed'
import { startMarketFeed } from './marketFeed'
import { CameraManager, probeFfmpeg } from './realworld/cameras'
import { makeRouter, route } from './realworld/router'
import type { RealworldStatus } from '../../src/realworld/contract'

/* ── command validation (zod mirror of SourceCommand) ──────────────── */

const CommandSchema = z.discriminatedUnion('k', [
  z.object({ k: z.literal('power'), sector: z.string(), on: z.boolean() }),
  z.object({ k: z.literal('traffic'), sector: z.string(), mode: z.enum(['NORMAL', 'FORCE_GREEN', 'FORCE_RED', 'BLACKOUT']) }),
  z.object({ k: z.literal('transit'), line: z.string(), mode: z.enum(['RUN', 'HOLD']) }),
  z.object({ k: z.literal('bridge'), id: z.string(), raised: z.boolean() }),
  z.object({ k: z.literal('comms'), sector: z.string(), on: z.boolean() }),
  z.object({ k: z.literal('autoRestore') }),
  z.object({ k: z.literal('spawn'), sector: z.string().optional() }),
  z.object({ k: z.literal('defcon'), level: z.number().nullable() }),
  z.object({ k: z.literal('track'), id: z.string(), on: z.boolean() }),
  z.object({ k: z.literal('cv'), online: z.boolean(), subjects: z.number() }),
  z.object({
    k: z.literal('feed'),
    metrics: z.object({
      source: z.enum(['client', 'host']),
      label: z.string(),
      cpuPct: z.number().optional(),
      memPct: z.number().optional(),
      netKBps: z.number().optional(),
      rttMs: z.number().optional(),
      fps: z.number().optional(),
      cores: z.number().optional(),
      deviceMemGB: z.number().optional(),
      online: z.boolean().optional(),
      ts: z.number(),
    }),
  }),
])

/* ── boot: persistence + engine ────────────────────────────────────── */

const persistence = new Persistence(config.DB_PATH, config.SEED)
const seeded = persistence.loadSeed()
const host = new EngineHost(config.SEED, { seedHistories: seeded.histories, seedEvents: seeded.recentEvents })

const clients = new Set<WebSocket>()
const startedAt = Date.now()

// Phase 1: stream this machine's REAL metrics into the world
const hostFeed = startHostFeed((metrics) => {
  try {
    host.command({ k: 'feed', metrics })
  } catch {
    /* ignore a bad feed sample */
  }
})

// Phase 2: poll Kraken's public API and overlay REAL crypto quotes onto the world
const marketFeed: { stop(): void } = config.MARKET_ENABLED
  ? startMarketFeed(
      (quotes) => {
        try {
          host.injectMarket(quotes)
        } catch {
          /* ignore a bad quote batch — the sim keeps running */
        }
      },
      { pollMs: config.MARKET_POLL_SEC * 1000 },
    )
  : { stop() {} }

if (config.MARKET_ENABLED) {
  console.log(`[server] market feed starting · polling Kraken every ${config.MARKET_POLL_SEC}s`)
} else {
  console.log('[server] market feed disabled (MARKET_ENABLED=false) — instruments stay simulated')
}

function warn(msg: string, err?: unknown): void {
  if (err !== undefined) console.warn(`[server] ${msg}:`, err instanceof Error ? err.message : err)
  else console.warn(`[server] ${msg}`)
}

/* ── HOMEWATCH real-world API (/api/*) ─────────────────────────────── */

const cameras = new CameraManager(warn)
let ffmpegProbe: { ok: boolean; version?: string } = { ok: false }
void probeFfmpeg().then((r) => {
  ffmpegProbe = r
  console.log(`[server] ffmpeg ${r.ok ? `ready (${r.version ?? '?'})` : 'NOT FOUND — cameras need it (brew install ffmpeg)'}`)
})

const statusRoute = route('GET', '/api/realworld/status', (c) => {
  const status: RealworldStatus = {
    ok: true,
    ffmpeg: ffmpegProbe.ok,
    ffmpegVersion: ffmpegProbe.version,
    cameras: cameras.count,
    devices: { backend: 'none', connected: false, count: 0 },
    geo: { defaultCity: 'PENDING', feeds: true },
    uptime: Math.round((Date.now() - startedAt) / 1000),
  }
  c.json(200, status)
})

const realworldRouter = makeRouter([statusRoute, ...cameras.routes()], warn)

/* ── http + health ─────────────────────────────────────────────────── */

const server = http.createServer((req, res) => {
  void (async () => {
    try {
      const path = (req.url ?? '').split('?')[0]
      if (req.method === 'GET' && path === '/health') {
        const body = JSON.stringify({
          ok: true,
          tick: host.world.tick,
          clients: clients.size,
          cameras: cameras.count,
          uptime: Math.round((Date.now() - startedAt) / 1000),
        })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(body)
        return
      }
      // HOMEWATCH real-world endpoints
      if (await realworldRouter(req, res)) return

      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'not found' }))
    } catch (err) {
      warn('http handler error', err)
      try {
        if (!res.headersSent) res.writeHead(500)
        res.end()
      } catch {
        /* socket already gone */
      }
    }
  })()
})

server.on('error', (err) => warn('http server error', err))

/* ── websocket ─────────────────────────────────────────────────────── */

const wss = new WebSocketServer({ noServer: true })

server.on('upgrade', (req, socket, head) => {
  const path = (req.url ?? '').split('?')[0]
  if (path !== config.WS_PATH) {
    socket.destroy()
    return
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
})

function safeSend(ws: WebSocket, payload: string): void {
  if (ws.readyState !== WebSocket.OPEN) return
  try {
    ws.send(payload)
  } catch (err) {
    warn('send failed', err)
    clients.delete(ws)
    try {
      ws.terminate()
    } catch {
      /* ignore */
    }
  }
}

wss.on('connection', (ws) => {
  clients.add(ws)
  // hello immediately on connect (full snapshot)
  try {
    safeSend(ws, JSON.stringify(host.hello()))
  } catch (err) {
    warn('hello failed', err)
  }

  ws.on('message', (data) => {
    try {
      const text = typeof data === 'string' ? data : data.toString()
      const msg: unknown = JSON.parse(text)
      if (!isCommandMsg(msg)) {
        warn('ignored non-command message')
        return
      }
      const parsed = CommandSchema.safeParse(msg.cmd)
      if (!parsed.success) {
        warn(`rejected invalid command: ${parsed.error.issues.map((i) => i.message).join('; ')}`)
        return
      }
      host.command(parsed.data as SourceCommand)
    } catch (err) {
      warn('bad client message', err)
    }
  })

  ws.on('close', () => clients.delete(ws))
  ws.on('error', (err) => {
    warn('socket error', err)
    clients.delete(ws)
    try {
      ws.terminate()
    } catch {
      /* ignore */
    }
  })
})

/* ── 10 Hz tick loop — one stringify per tick, broadcast to all ────── */

const tickTimer = setInterval(() => {
  try {
    const msg = host.tick()
    const payload = JSON.stringify(msg)
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) safeSend(ws, payload)
      else if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) clients.delete(ws)
    }
  } catch (err) {
    warn('tick loop error', err)
  }
}, config.TICK_MS)

/* ── periodic snapshot persistence (already fully guarded) ─────────── */

const snapTimer = setInterval(() => {
  persistence.save(host.snapshot(), host.seed)
}, Math.max(1000, config.SNAPSHOT_SEC * 1000))

/* ── startup log ───────────────────────────────────────────────────── */

const seedHex = `0x${config.SEED.toString(16).toUpperCase()}`
const persistedEvents = seeded.recentEvents?.length ?? 0
const histLens = seeded.histories ? Object.values(seeded.histories).map((a) => (Array.isArray(a) ? a.length : 0)) : []
const persistedSamples = histLens.length > 0 ? Math.max(...histLens) : 0
const restored = persistedEvents > 0 || persistedSamples > 0

server.listen(config.PORT, config.HOST, () => {
  console.log(
    `PANOPTICON SERVER · ws://${config.HOST}:${config.PORT}${config.WS_PATH} · seed ${seedHex} · db ${config.DB_PATH} · ` +
      (restored ? `persisted ${persistedEvents} events / ${persistedSamples} history samples` : 'fresh start') +
      (persistence.enabled ? '' : ' · [persistence disabled]'),
  )
})

/* ── graceful shutdown ─────────────────────────────────────────────── */

let shuttingDown = false
function shutdown(signal: string): void {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`\n[server] ${signal} received — flushing + shutting down`)
  clearInterval(tickTimer)
  clearInterval(snapTimer)
  hostFeed.stop()
  cameras.disposeAll()
  marketFeed.stop()
  persistence.save(host.snapshot(), host.seed)
  persistence.close()
  for (const ws of clients) {
    try {
      ws.close(1001, 'server shutdown')
    } catch {
      /* ignore */
    }
  }
  clients.clear()
  try {
    wss.close()
  } catch {
    /* ignore */
  }
  const done = (): void => {
    try {
      host.dispose()
    } catch {
      /* ignore */
    }
    process.exit(0)
  }
  server.close(done)
  // hard cap in case a socket refuses to close
  setTimeout(done, 2000).unref()
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('beforeExit', () => {
  if (!shuttingDown) persistence.save(host.snapshot(), host.seed)
})
process.on('unhandledRejection', (reason) => warn('unhandledRejection', reason))
process.on('uncaughtException', (err) => warn('uncaughtException', err))
