/**
 * PANOPTICON // HOMEWATCH — local camera-bridge server.
 *
 * A deliberately lean, single-purpose HTTP server. It does exactly two things:
 *
 *   • bridges your real cameras (rtsp / http / file / "test") to the browser as
 *     MJPEG via ffmpeg, so a plain <img> shows live video, plus a JPEG snapshot;
 *   • answers a tiny status / health surface the cockpit polls.
 *
 * Nothing else — no database, no simulation engine, no market feeds, no native
 * add-ons. It imports only `node:http` and the camera modules (which use just
 * Node built-ins + ffmpeg as a child process). That matters: there is no heavy
 * dependency that could fail to load and abort startup, so `server.listen()`
 * runs immediately and the cockpit's "LINK ESTABLISHED" is instant and
 * reliable. It binds to 127.0.0.1 only, so it is reachable solely from this Mac.
 *
 * Fully guarded: a bad request can never crash the daemon; ffmpeg is probed
 * asynchronously and its absence degrades to a clear status flag rather than a
 * failure.
 */
import http from 'node:http'
import { CameraManager, probeFfmpeg } from './realworld/cameras'
import { makeRouter, route } from './realworld/router'
import type { RealworldStatus } from '../../src/realworld/contract'

/* ── config (env-overridable, zero external deps) ──────────────────────── */

const PORT = Number(process.env.PORT ?? process.env.HOMEWATCH_PORT ?? 8787)
const HOST = process.env.HOST ?? '127.0.0.1'
const startedAt = Date.now()

function warn(msg: string, err?: unknown): void {
  if (err !== undefined) console.warn(`[homewatch] ${msg}:`, err instanceof Error ? err.message : err)
  else console.warn(`[homewatch] ${msg}`)
}

/* ── camera bridge + ffmpeg probe ──────────────────────────────────────── */

const cameras = new CameraManager(warn)

let ffmpeg: { ok: boolean; version?: string } = { ok: false }
void probeFfmpeg().then((r) => {
  ffmpeg = r
  console.log(
    `[homewatch] ffmpeg ${r.ok ? `ready (${r.version ?? '?'})` : 'NOT FOUND — install it to bridge IP cameras: brew install ffmpeg'}`,
  )
})

/* ── status endpoint (shape the cockpit expects) ──────────────────────── */

const statusRoute = route('GET', '/api/realworld/status', (c) => {
  const status: RealworldStatus = {
    ok: true,
    ffmpeg: ffmpeg.ok,
    ffmpegVersion: ffmpeg.version,
    cameras: cameras.count,
    devices: { backend: 'none', connected: false, count: 0 },
    geo: { defaultCity: 'LOCAL', feeds: false },
    uptime: Math.round((Date.now() - startedAt) / 1000),
  }
  c.json(200, status)
})

const router = makeRouter([statusRoute, ...cameras.routes()], warn)

/* ── http server ───────────────────────────────────────────────────────── */

const server = http.createServer((req, res) => {
  void (async () => {
    try {
      const path = (req.url ?? '').split('?')[0]
      if (req.method === 'GET' && (path === '/health' || path === '/')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            ok: true,
            service: 'homewatch',
            cameras: cameras.count,
            ffmpeg: ffmpeg.ok,
            uptime: Math.round((Date.now() - startedAt) / 1000),
          }),
        )
        return
      }
      // HOMEWATCH real-world endpoints (/api/*)
      if (await router(req, res)) return

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

server.on('error', (err) => {
  if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
    console.error(
      `[homewatch] port ${PORT} is already in use — the server is probably already running in another tab. ` +
        `Close that one, or start this with a different port: PORT=8788 pnpm server`,
    )
    process.exit(1)
  }
  warn('http server error', err)
})

server.listen(PORT, HOST, () => {
  console.log(`PANOPTICON // HOMEWATCH · http://${HOST}:${PORT} · camera bridge + status · LOCAL-ONLY`)
  console.log('[homewatch] leave this running · now open a SECOND terminal tab and run:  pnpm dev')
  console.log('[homewatch] then open the cockpit at  http://localhost:5173')
})

/* ── graceful shutdown ─────────────────────────────────────────────────── */

let shuttingDown = false
function shutdown(signal: string): void {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`\n[homewatch] ${signal} received — stopping camera bridges + shutting down`)
  try {
    cameras.disposeAll()
  } catch {
    /* ignore */
  }
  const done = (): void => process.exit(0)
  server.close(done)
  setTimeout(done, 1500).unref()
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('unhandledRejection', (reason) => warn('unhandledRejection', reason))
process.on('uncaughtException', (err) => warn('uncaughtException', err))
