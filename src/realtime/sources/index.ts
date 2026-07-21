/** Source factory: pick a WorldSource from the runtime config. */
import type { WorldSource } from '../protocol'
import type { RealtimeConfig } from '../config'
import { InlineSource } from './inlineSource'
import { WorkerSource } from './workerSource'
import { RemoteSource } from './remoteSource'

export function createSource(cfg: RealtimeConfig): WorldSource {
  switch (cfg.mode) {
    case 'remote':
      return new RemoteSource(cfg.wsUrl)
    case 'inline':
      return new InlineSource(cfg.seed)
    case 'worker':
    default:
      return new WorkerSource(cfg.seed)
  }
}

export { InlineSource, WorkerSource, RemoteSource }
