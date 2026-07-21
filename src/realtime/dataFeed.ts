/**
 * Phase 1 — client real-data feed.
 *
 * Samples GENUINE local telemetry from the operator's browser/machine and
 * pushes it to the world source as `{ k:'feed' }` commands (~1 Hz). Every value
 * is real and measured locally — nothing here is invented or uploaded anywhere
 * beyond the local world source. Fully guarded so it's a no-op off-browser
 * (node / tests).
 *
 * Signals: real render FPS (rAF), real JS heap %, real network downlink/RTT
 * (Network Information API), logical cores, device memory, online state, and a
 * main-thread load proxy derived from real event-loop lag.
 */
import type { RealMetrics } from '../sim/types'

const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v)

export interface FeedHandle {
  stop(): void
}

interface NavConn {
  rtt?: number
  downlink?: number
  effectiveType?: string
}

export function startClientFeed(send: (m: RealMetrics) => void, intervalMs = 1000): FeedHandle {
  if (typeof navigator === 'undefined' || typeof performance === 'undefined') {
    return { stop() {} }
  }

  // real render frame rate via a rAF EMA
  let fps = 60
  let lastFrame = performance.now()
  let rafId = 0
  const hasRaf = typeof requestAnimationFrame === 'function'
  const frame = (t: number) => {
    const dt = t - lastFrame
    lastFrame = t
    if (dt > 0) fps = fps * 0.9 + (1000 / dt) * 0.1
    rafId = requestAnimationFrame(frame)
  }
  if (hasRaf) rafId = requestAnimationFrame(frame)

  // real event-loop lag → honest main-thread load proxy
  const LAG_MS = 200
  let lagEma = 0
  let lagLast = performance.now()
  const lagTimer = setInterval(() => {
    const now = performance.now()
    lagEma = lagEma * 0.6 + Math.max(0, now - lagLast - LAG_MS) * 0.4
    lagLast = now
  }, LAG_MS)

  const sample = (): RealMetrics => {
    const nav = navigator as Navigator & {
      hardwareConcurrency?: number
      deviceMemory?: number
      connection?: NavConn
    }
    const perf = performance as Performance & { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } }
    const conn = nav.connection
    const m: RealMetrics = { source: 'client', label: 'OPERATOR NODE', ts: Date.now(), online: nav.onLine }
    if (typeof nav.hardwareConcurrency === 'number') m.cores = nav.hardwareConcurrency
    if (typeof nav.deviceMemory === 'number') m.deviceMemGB = nav.deviceMemory
    if (perf.memory && perf.memory.jsHeapSizeLimit > 0) {
      m.memPct = clamp((perf.memory.usedJSHeapSize / perf.memory.jsHeapSizeLimit) * 100, 0, 100)
    }
    if (hasRaf) m.fps = Math.round(clamp(fps, 0, 240))
    // ~30 ms sustained lag ⇒ ~100% — a real measure of main-thread contention
    m.cpuPct = clamp((lagEma / 30) * 100, 0, 100)
    if (conn) {
      if (typeof conn.rtt === 'number') m.rttMs = conn.rtt
      if (typeof conn.downlink === 'number') m.netKBps = Math.round(conn.downlink * 125)
    }
    return m
  }

  send(sample())
  const timer = setInterval(() => send(sample()), intervalMs)

  return {
    stop() {
      clearInterval(timer)
      clearInterval(lagTimer)
      if (rafId && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rafId)
    },
  }
}
