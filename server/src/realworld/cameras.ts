/**
 * Camera manager — bridges real cameras to the browser.
 *
 * Each server-bridged camera runs one ffmpeg that reads the source
 * (rtsp:// | http(s):// | file:// | "test") and emits a stream of JPEG frames.
 * We split the frames, keep the latest, and fan them out to every connected
 * `/stream` viewer as multipart/x-mixed-replace MJPEG (so a plain <img> shows
 * live video) plus a `/snapshot` still. ffmpeg is respawned with backoff while
 * the camera exists and killed on removal. The Mac webcam is NOT here — it's
 * browser-local (getUserMedia) and never leaves the client.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import type { ServerResponse } from 'node:http'
import type { AddCameraRequest, CameraInfo, CameraKind } from '../../../src/realworld/contract'
import { route, applyCors, type Route } from './router'

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg'
const BOUNDARY = 'panopticonframe'
const MAX_FAILS = 6
const SOI = Buffer.from([0xff, 0xd8]) // JPEG start
const EOI = Buffer.from([0xff, 0xd9]) // JPEG end

function classify(url: string): CameraKind | null {
  const u = url.trim()
  if (u.toLowerCase() === 'test') return 'test'
  if (u.startsWith('rtsp://') || u.startsWith('rtsps://')) return 'rtsp'
  if (u.startsWith('http://') || u.startsWith('https://')) return 'http'
  if (u.startsWith('file://') || u.startsWith('/')) return 'file'
  return null
}

function redact(url: string): string {
  return url.replace(/(\w+:\/\/[^:/@]+):([^@/]+)@/, '$1:***@')
}

function inputArgs(kind: CameraKind, url: string): string[] {
  switch (kind) {
    case 'test':
      return ['-f', 'lavfi', '-i', 'testsrc2=size=640x480:rate=12']
    case 'rtsp':
      return ['-rtsp_transport', 'tcp', '-i', url]
    case 'file':
      return ['-stream_loop', '-1', '-re', '-i', url.replace(/^file:\/\//, '')]
    default:
      return ['-i', url]
  }
}

interface Cam {
  info: CameraInfo
  proc: ChildProcess | null
  viewers: Set<ServerResponse>
  latest: Buffer | null
  acc: Buffer
  fails: number
  restartTimer: ReturnType<typeof setTimeout> | null
  stopped: boolean
}

export class CameraManager {
  private cams = new Map<string, Cam>()
  private seq = 1

  constructor(private warn: (msg: string, err?: unknown) => void) {}

  get count(): number {
    return this.cams.size
  }

  list(): CameraInfo[] {
    return [...this.cams.values()].map((c) => ({ ...c.info }))
  }

  add(req: AddCameraRequest): CameraInfo | { error: string } {
    const url = (req.url ?? '').trim()
    if (!url) return { error: 'url required' }
    const kind = classify(url)
    if (!kind) return { error: 'unsupported url (use rtsp://, http://, file://, or "test")' }
    const id = `RCAM-${String(this.seq++).padStart(2, '0')}`
    const info: CameraInfo = {
      id,
      name: req.name?.trim() || defaultName(kind, id),
      url,
      displayUrl: redact(url),
      kind,
      status: 'connecting',
      serverBridged: true,
      addedAt: Date.now(),
    }
    const cam: Cam = { info, proc: null, viewers: new Set(), latest: null, acc: Buffer.alloc(0), fails: 0, restartTimer: null, stopped: false }
    this.cams.set(id, cam)
    this.spawn(cam)
    return { ...info }
  }

  remove(id: string): boolean {
    const cam = this.cams.get(id)
    if (!cam) return false
    cam.stopped = true
    if (cam.restartTimer) clearTimeout(cam.restartTimer)
    this.killProc(cam)
    for (const v of cam.viewers) {
      try {
        v.end()
      } catch {
        /* ignore */
      }
    }
    cam.viewers.clear()
    this.cams.delete(id)
    return true
  }

  private killProc(cam: Cam): void {
    if (cam.proc) {
      try {
        cam.proc.kill('SIGKILL')
      } catch {
        /* ignore */
      }
      cam.proc = null
    }
  }

  private spawn(cam: Cam): void {
    if (cam.stopped) return
    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      ...inputArgs(cam.info.kind, cam.info.url),
      '-an',
      '-vf',
      "fps=12,scale='min(iw,640)':-2",
      '-f',
      'image2pipe',
      '-c:v',
      'mjpeg',
      '-q:v',
      '6',
      'pipe:1',
    ]
    let proc: ChildProcess
    try {
      proc = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      this.warn(`ffmpeg spawn failed for ${cam.info.id}`, err)
      this.fail(cam, 'ffmpeg not available')
      return
    }
    cam.proc = proc
    cam.acc = Buffer.alloc(0)

    proc.stdout?.on('data', (chunk: Buffer) => this.onData(cam, chunk))
    let errTail = ''
    proc.stderr?.on('data', (d: Buffer) => {
      errTail = (errTail + d.toString()).slice(-300)
    })
    proc.on('exit', (code) => {
      if (cam.stopped) return
      cam.proc = null
      if (code !== 0) {
        this.fail(cam, errTail.trim().split('\n').pop() || `ffmpeg exited ${code}`)
      } else {
        this.scheduleRestart(cam, 1000)
      }
    })
    proc.on('error', (err) => {
      if (cam.stopped) return
      this.fail(cam, err instanceof Error ? err.message : 'ffmpeg error')
    })
  }

  private fail(cam: Cam, reason: string): void {
    cam.fails += 1
    cam.info.status = 'error'
    cam.info.error = reason
    this.killProc(cam)
    if (cam.fails <= MAX_FAILS) this.scheduleRestart(cam, Math.min(8000, 1000 * cam.fails))
    else cam.info.status = 'offline'
  }

  private scheduleRestart(cam: Cam, ms: number): void {
    if (cam.stopped) return
    if (cam.restartTimer) clearTimeout(cam.restartTimer)
    cam.restartTimer = setTimeout(() => this.spawn(cam), ms)
  }

  private onData(cam: Cam, chunk: Buffer): void {
    cam.acc = cam.acc.length === 0 ? chunk : Buffer.concat([cam.acc, chunk])
    // extract every complete JPEG (SOI..EOI) in the accumulator
    for (;;) {
      const start = cam.acc.indexOf(SOI)
      if (start < 0) {
        if (cam.acc.length > 1) cam.acc = cam.acc.subarray(cam.acc.length - 1)
        return
      }
      const end = cam.acc.indexOf(EOI, start + 2)
      if (end < 0) {
        if (start > 0) cam.acc = cam.acc.subarray(start)
        return
      }
      const frame = cam.acc.subarray(start, end + 2)
      cam.acc = cam.acc.subarray(end + 2)
      this.emitFrame(cam, frame)
    }
  }

  private emitFrame(cam: Cam, frame: Buffer): void {
    cam.latest = frame
    cam.fails = 0
    cam.info.lastFrame = Date.now()
    if (cam.info.status !== 'live') cam.info.status = 'live'
    const head = Buffer.from(`\r\n--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`)
    for (const res of cam.viewers) {
      try {
        res.write(head)
        res.write(frame)
      } catch {
        cam.viewers.delete(res)
      }
    }
  }

  attachStream(id: string, res: ServerResponse): boolean {
    const cam = this.cams.get(id)
    if (!cam) return false
    applyCors(res)
    res.writeHead(200, {
      'content-type': `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
      'cache-control': 'no-cache, no-store',
      connection: 'close',
      pragma: 'no-cache',
    })
    cam.viewers.add(res)
    if (cam.latest) {
      const head = Buffer.from(`\r\n--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${cam.latest.length}\r\n\r\n`)
      try {
        res.write(head)
        res.write(cam.latest)
      } catch {
        /* client gone */
      }
    }
    const drop = () => cam.viewers.delete(res)
    res.on('close', drop)
    res.on('error', drop)
    return true
  }

  snapshot(id: string, res: ServerResponse): void {
    const cam = this.cams.get(id)
    applyCors(res)
    if (!cam || !cam.latest) {
      res.writeHead(503, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: cam ? 'no frame yet' : 'no such camera' }))
      return
    }
    res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'no-store' })
    res.end(cam.latest)
  }

  disposeAll(): void {
    for (const id of [...this.cams.keys()]) this.remove(id)
  }

  routes(): Route[] {
    return [
      route('GET', '/api/cameras', (c) => c.json(200, { cameras: this.list() })),
      route('POST', '/api/cameras', async (c) => {
        const body = (await c.readJson<AddCameraRequest>()) ?? { url: '' }
        const r = this.add(body)
        if ('error' in r) c.json(400, { ok: false, error: r.error })
        else c.json(201, r)
      }),
      route('DELETE', '/api/cameras/:id', (c) => {
        const ok = this.remove(c.params.id)
        c.json(ok ? 200 : 404, { ok })
      }),
      route('GET', '/api/cameras/:id/stream', (c) => {
        if (!this.attachStream(c.params.id, c.res)) c.json(404, { ok: false, error: 'no such camera' })
      }),
      route('GET', '/api/cameras/:id/snapshot', (c) => this.snapshot(c.params.id, c.res)),
    ]
  }
}

function defaultName(kind: CameraKind, id: string): string {
  const label = kind === 'test' ? 'TEST PATTERN' : kind === 'rtsp' ? 'IP CAMERA' : kind.toUpperCase()
  return `${label} · ${id}`
}

/** Resolve ffmpeg availability + version for the status endpoint. */
export async function probeFfmpeg(): Promise<{ ok: boolean; version?: string }> {
  return new Promise((resolve) => {
    let out = ''
    try {
      const p = spawn(FFMPEG, ['-hide_banner', '-version'], { stdio: ['ignore', 'pipe', 'ignore'] })
      p.stdout.on('data', (d: Buffer) => (out += d.toString()))
      p.on('error', () => resolve({ ok: false }))
      p.on('exit', (code) => {
        const m = out.match(/ffmpeg version (\S+)/)
        resolve({ ok: code === 0, version: m?.[1] })
      })
    } catch {
      resolve({ ok: false })
    }
  })
}
