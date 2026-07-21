/**
 * Client-side realtime config, read from URL params so the demo is switchable
 * without a rebuild:
 *   ?source=worker   (default) — engine in a Web Worker, off the render thread
 *   ?source=inline             — engine on the main thread (fallback / single-file)
 *   ?source=remote             — connect to the node server over WebSocket
 *   ?ws=ws://host:port/ws      — override the remote endpoint
 *   ?seed=0x2F7A               — override the sim seed (worker/inline only)
 */
import { DEFAULT_SEED } from '../sim/cityGen'
import { DEFAULT_WS_URL, type SourceMode } from './protocol'

/** build-time flag injected by vite (`--mode singlefile`); undefined elsewhere */
declare const __PANOPTICON_SINGLEFILE__: boolean | undefined

export interface RealtimeConfig {
  mode: SourceMode | 'worker' | 'inline'
  wsUrl: string
  seed: number
}

function parseSeed(raw: string | null): number {
  if (!raw) return DEFAULT_SEED
  const n = raw.startsWith('0x') || raw.startsWith('0X') ? parseInt(raw, 16) : parseInt(raw, 10)
  return Number.isFinite(n) ? n >>> 0 : DEFAULT_SEED
}

export function readConfig(): RealtimeConfig {
  const params =
    typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : new URLSearchParams()
  const singlefile = typeof __PANOPTICON_SINGLEFILE__ !== 'undefined' && __PANOPTICON_SINGLEFILE__
  const raw = (params.get('source') || (singlefile ? 'inline' : 'worker')).toLowerCase()
  const mode: RealtimeConfig['mode'] = raw === 'remote' ? 'remote' : raw === 'inline' ? 'inline' : 'worker'
  return {
    mode,
    wsUrl: params.get('ws') || DEFAULT_WS_URL,
    seed: parseSeed(params.get('seed')),
  }
}
