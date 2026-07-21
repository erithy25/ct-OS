/**
 * InlineSource — EngineHost on the main thread. Used for tests, the single-file
 * build, and as the automatic fallback when a Web Worker can't be created.
 */
import { EngineHost } from '../engineHost'
import type { SourceCommand, SourceSink, WorldSource } from '../protocol'

export class InlineSource implements WorldSource {
  readonly mode = 'sim' as const
  private host: EngineHost | null = null
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly seed: number, private readonly tickMs = 100) {}

  start(sink: SourceSink): void {
    this.host = new EngineHost(this.seed)
    sink.onLink(true, 'inline')
    sink.onHello(this.host.hello())
    this.timer = setInterval(() => {
      if (this.host) sink.onTick(this.host.tick())
    }, this.tickMs)
  }

  command(cmd: SourceCommand): void {
    this.host?.command(cmd)
  }

  dispose(): void {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
    this.host?.dispose()
    this.host = null
  }
}
