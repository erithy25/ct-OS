/**
 * Tiny synchronous pub/sub bus between the world tick and the store.
 * world.ts emits; store.ts subscribes and owns the 500-entry ring buffer.
 * Emissions before any subscriber attaches are backlogged and flushed on the
 * first subscribe, so module init order never drops boot events.
 */
import type { EventChannel, SectorId, Severity } from './types'

export type EventSink = (
  severity: Severity,
  channel: EventChannel,
  message: string,
  sector?: SectorId,
  entityId?: string,
) => void

const sinks: EventSink[] = []
const backlog: Parameters<EventSink>[] = []

export function onEvent(sink: EventSink): () => void {
  sinks.push(sink)
  if (backlog.length > 0) {
    const pending = backlog.splice(0, backlog.length)
    for (const args of pending) sink(...args)
  }
  return () => {
    const i = sinks.indexOf(sink)
    if (i >= 0) sinks.splice(i, 1)
  }
}

export function emitEvent(
  severity: Severity,
  channel: EventChannel,
  message: string,
  sector?: SectorId,
  entityId?: string,
): void {
  if (sinks.length === 0) {
    backlog.push([severity, channel, message, sector, entityId])
    if (backlog.length > 100) backlog.shift()
    return
  }
  for (const sink of sinks) sink(severity, channel, message, sector, entityId)
}
