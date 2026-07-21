/**
 * WorkerSource — runs the EngineHost in a Web Worker. If the worker can't be
 * created or fails to produce a hello within a short grace window (single-file
 * builds, restrictive CSPs), it transparently falls back to an InlineSource so
 * the cockpit always comes up.
 */
import type { ServerMsg, SourceCommand, SourceSink, WorldSource } from '../protocol'
import { InlineSource } from './inlineSource'

const HELLO_GRACE_MS = 1500

export class WorkerSource implements WorldSource {
  readonly mode = 'sim' as const
  private worker: Worker | null = null
  private fallback: InlineSource | null = null
  private gotHello = false
  private graceTimer: ReturnType<typeof setTimeout> | null = null
  private disposed = false

  constructor(private readonly seed: number, private readonly tickMs = 100) {}

  start(sink: SourceSink): void {
    if (typeof Worker === 'undefined') {
      this.useFallback(sink, 'no worker support')
      return
    }
    try {
      this.worker = new Worker(new URL('./engine.worker.ts', import.meta.url), { type: 'module' })
    } catch {
      this.useFallback(sink, 'worker construct failed')
      return
    }

    this.worker.onmessage = (ev: MessageEvent<ServerMsg>) => {
      const m = ev.data
      if (m.t === 'hello') {
        this.gotHello = true
        if (this.graceTimer !== null) clearTimeout(this.graceTimer)
        sink.onLink(true, 'worker')
        sink.onHello(m)
      } else if (m.t === 'tick') {
        sink.onTick(m)
      }
    }
    this.worker.onerror = () => {
      if (!this.gotHello) this.useFallback(sink, 'worker error')
    }
    this.worker.postMessage({ t: 'init', seed: this.seed, tickMs: this.tickMs })

    // silent-failure guard: if no hello arrives, drop to inline
    this.graceTimer = setTimeout(() => {
      if (!this.gotHello) this.useFallback(sink, 'worker timeout')
    }, HELLO_GRACE_MS)
  }

  private useFallback(sink: SourceSink, _reason: string): void {
    if (this.disposed || this.fallback) return
    if (this.worker) {
      this.worker.onmessage = null
      this.worker.onerror = null
      this.worker.terminate()
      this.worker = null
    }
    this.fallback = new InlineSource(this.seed, this.tickMs)
    this.fallback.start(sink)
  }

  command(cmd: SourceCommand): void {
    if (this.fallback) this.fallback.command(cmd)
    else this.worker?.postMessage({ t: 'cmd', cmd })
  }

  dispose(): void {
    this.disposed = true
    if (this.graceTimer !== null) clearTimeout(this.graceTimer)
    this.fallback?.dispose()
    this.fallback = null
    this.worker?.terminate()
    this.worker = null
  }
}
