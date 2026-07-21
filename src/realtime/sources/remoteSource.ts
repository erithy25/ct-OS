/**
 * RemoteSource — connects to the node server over WebSocket. Reconnects with
 * exponential backoff and queues commands issued while the link is down; the
 * next hello re-seeds the client on reconnect.
 */
import { PROTOCOL_VERSION, isServerMsg, type SourceCommand, type SourceSink, type WorldSource } from '../protocol'

const BACKOFF_MIN = 500
const BACKOFF_MAX = 8000

export class RemoteSource implements WorldSource {
  readonly mode = 'remote' as const
  private ws: WebSocket | null = null
  private sink: SourceSink | null = null
  private closed = false
  private backoff = BACKOFF_MIN
  private queue: SourceCommand[] = []
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly url: string) {}

  start(sink: SourceSink): void {
    this.sink = sink
    this.connect()
  }

  private connect(): void {
    if (this.closed) return
    try {
      this.ws = new WebSocket(this.url)
    } catch {
      this.scheduleReconnect()
      return
    }
    this.ws.onopen = () => {
      this.backoff = BACKOFF_MIN
      this.sink?.onLink(true, this.url)
      const pending = this.queue
      this.queue = []
      for (const c of pending) this.send(c)
    }
    this.ws.onmessage = (ev: MessageEvent) => {
      let m: unknown
      try {
        m = JSON.parse(typeof ev.data === 'string' ? ev.data : '')
      } catch {
        return
      }
      if (!isServerMsg(m)) return
      if (m.t === 'hello') this.sink?.onHello(m)
      else this.sink?.onTick(m)
    }
    this.ws.onclose = () => {
      this.sink?.onLink(false, 'link lost')
      this.scheduleReconnect()
    }
    this.ws.onerror = () => {
      this.ws?.close()
    }
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer !== null) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, this.backoff)
    this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX)
  }

  private send(cmd: SourceCommand): void {
    this.ws?.send(JSON.stringify({ t: 'cmd', v: PROTOCOL_VERSION, cmd }))
  }

  command(cmd: SourceCommand): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.send(cmd)
    else this.queue.push(cmd)
  }

  dispose(): void {
    this.closed = true
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    if (this.ws) {
      this.ws.onopen = this.ws.onmessage = this.ws.onclose = this.ws.onerror = null
      this.ws.close()
      this.ws = null
    }
  }
}
