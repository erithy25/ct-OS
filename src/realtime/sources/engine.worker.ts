/**
 * Web Worker entry: runs an EngineHost off the render thread and streams
 * hello/tick messages back via postMessage. Commands arrive the same way.
 * Keeping the 10 Hz sim here means the main thread only ever paints.
 */
/// <reference lib="webworker" />
import { EngineHost } from '../engineHost'
import type { SourceCommand } from '../protocol'

type InitMsg = { t: 'init'; seed: number; tickMs?: number }
type CmdMsg = { t: 'cmd'; cmd: SourceCommand }
type InMsg = InitMsg | CmdMsg

const ctx = self as unknown as Worker
let host: EngineHost | null = null
let timer: ReturnType<typeof setInterval> | null = null

ctx.onmessage = (ev: MessageEvent<InMsg>) => {
  const data = ev.data
  if (data.t === 'init') {
    if (host) return
    host = new EngineHost(data.seed)
    ctx.postMessage(host.hello())
    timer = setInterval(() => {
      if (host) ctx.postMessage(host.tick())
    }, data.tickMs ?? 100)
  } else if (data.t === 'cmd') {
    host?.command(data.cmd)
  }
}

ctx.addEventListener('close', () => {
  if (timer !== null) clearInterval(timer)
  host?.dispose()
})
