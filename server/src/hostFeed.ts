/**
 * Phase 1 — server host feed.
 *
 * Samples REAL metrics of the machine the server runs on (the operator's Mac)
 * via `systeminformation` and pushes them to the EngineHost as host-origin
 * `feed` commands. All values are genuine; sampling failures are swallowed so
 * the daemon never crashes on a bad read.
 */
import os from 'node:os'
import si from 'systeminformation'
import type { RealMetrics } from '../../src/sim/types'

const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v)

export interface HostFeedHandle {
  stop(): void
}

export function startHostFeed(send: (m: RealMetrics) => void, intervalMs = 1000): HostFeedHandle {
  let stopped = false
  let cores = os.cpus().length || 0
  let totalMemGB = Math.round(os.totalmem() / 1024 / 1024 / 1024)
  const label = os.hostname() || 'MAC HOST'

  // refine core count from systeminformation when available
  si.cpu()
    .then((c) => {
      if (c.cores) cores = c.cores
    })
    .catch(() => undefined)

  const sample = async (): Promise<void> => {
    if (stopped) return
    try {
      const [load, mem, net] = await Promise.all([
        si.currentLoad(),
        si.mem(),
        si.networkStats().catch(() => [] as { rx_sec?: number; tx_sec?: number }[]),
      ])
      const m: RealMetrics = {
        source: 'host',
        label,
        ts: Date.now(),
        cpuPct: clamp(load.currentLoad ?? 0, 0, 100),
        memPct: mem.total > 0 ? clamp((mem.active / mem.total) * 100, 0, 100) : undefined,
        cores: cores || undefined,
        deviceMemGB: totalMemGB || undefined,
        online: true,
      }
      if (Array.isArray(net) && net.length > 0) {
        const bytesPerSec = net.reduce((acc, n) => acc + (n.rx_sec || 0) + (n.tx_sec || 0), 0)
        if (Number.isFinite(bytesPerSec)) m.netKBps = Math.max(0, Math.round(bytesPerSec / 1024))
      }
      send(m)
    } catch {
      /* skip a bad sample */
    }
  }

  void sample()
  const timer = setInterval(() => void sample(), intervalMs)
  return {
    stop() {
      stopped = true
      clearInterval(timer)
    },
  }
}
