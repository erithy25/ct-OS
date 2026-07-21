/**
 * Tiny REST router for the real-world `/api/*` surface. Adds permissive CORS
 * (localhost, single-user) so the Vite dev origin can fetch the API and read
 * MJPEG frames back into a canvas for CV. Pattern params via `:name`.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

export interface Ctx {
  req: IncomingMessage
  res: ServerResponse
  method: string
  path: string
  params: Record<string, string>
  query: URLSearchParams
  readJson<T>(): Promise<T | null>
  json(status: number, body: unknown): void
  send(status: number, contentType: string, body: string | Buffer): void
}

export type RouteHandler = (c: Ctx) => void | Promise<void>

export interface Route {
  method: string
  pattern: RegExp
  keys: string[]
  handler: RouteHandler
}

/** Define a route. `path` uses `:name` params, e.g. `/api/cameras/:id/stream`. */
export function route(method: string, path: string, handler: RouteHandler): Route {
  const keys: string[] = []
  const rx = path
    .split('/')
    .map((seg) => {
      if (seg.startsWith(':')) {
        keys.push(seg.slice(1))
        return '([^/]+)'
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    })
    .join('/')
  return { method: method.toUpperCase(), pattern: new RegExp(`^${rx}$`), keys, handler }
}

export function applyCors(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
}

function makeCtx(req: IncomingMessage, res: ServerResponse, path: string, query: URLSearchParams, params: Record<string, string>): Ctx {
  return {
    req,
    res,
    method: (req.method ?? 'GET').toUpperCase(),
    path,
    params,
    query,
    async readJson<T>(): Promise<T | null> {
      const chunks: Buffer[] = []
      for await (const c of req) chunks.push(c as Buffer)
      if (chunks.length === 0) return null
      try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T
      } catch {
        return null
      }
    },
    json(status: number, body: unknown): void {
      applyCors(res)
      const payload = JSON.stringify(body)
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(payload)
    },
    send(status: number, contentType: string, body: string | Buffer): void {
      applyCors(res)
      res.writeHead(status, { 'content-type': contentType })
      res.end(body)
    },
  }
}

/**
 * Build a dispatcher. Returns a function that handles a request and resolves
 * `true` if a route matched (or it was a CORS preflight), `false` otherwise.
 * Handler errors are caught and turned into a 500 so nothing escapes.
 */
export function makeRouter(routes: Route[], onError: (msg: string, err: unknown) => void): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname
    if (!path.startsWith('/api/')) return false

    const method = (req.method ?? 'GET').toUpperCase()
    if (method === 'OPTIONS') {
      applyCors(res)
      res.writeHead(204)
      res.end()
      return true
    }

    for (const r of routes) {
      if (r.method !== method) continue
      const m = r.pattern.exec(path)
      if (!m) continue
      const params: Record<string, string> = {}
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])))
      const ctx = makeCtx(req, res, path, url.searchParams, params)
      try {
        await r.handler(ctx)
      } catch (err) {
        onError(`route ${method} ${path}`, err)
        if (!res.headersSent) {
          applyCors(res)
          res.writeHead(500, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: 'internal error' }))
        } else {
          try {
            res.end()
          } catch {
            /* already closed */
          }
        }
      }
      return true
    }

    // an /api/* path with no matching route
    applyCors(res)
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: 'not found' }))
    return true
  }
}
