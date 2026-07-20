/**
 * Hover tooltip for the tactical map. The parent positions the wrapper div
 * imperatively (per pointermove, no React state); this component only renders
 * the content when the hovered target changes.
 */
import { Fragment } from 'react'
import type { SimEntity } from '../../sim/types'

export interface TooltipData {
  id: string
  kind: string
  color: string
  rows: [string, string][]
}

export function buildTooltip(e: SimEntity): TooltipData {
  switch (e.kind) {
    case 'person': {
      const rows: [string, string][] = [
        ['STATUS', e.status],
        ['SECTOR', e.sector],
        ['RISK', String(Math.round(e.riskScore))],
      ]
      if (e.watchlisted) rows.push(['FLAG', 'WATCHLIST'])
      if (e.tracked) rows.push(['TRACE', 'ACTIVE'])
      return { id: e.id, kind: 'PERSON', color: e.watchlisted ? 'var(--accent-amber)' : 'var(--text-primary)', rows }
    }
    case 'vehicle':
      return {
        id: e.id,
        kind: 'VEHICLE',
        color: e.stalled ? 'var(--accent-amber)' : 'var(--accent)',
        rows: [
          ['STATE', e.stalled ? 'STALLED' : e.parked === true ? 'PARKED' : 'IN TRANSIT'],
          ['SECTOR', e.sector],
        ],
      }
    case 'patrol':
      return {
        id: e.id,
        kind: 'UNIT',
        color: 'var(--accent-green)',
        rows: [
          ['CALLSIGN', e.callsign],
          ['STATUS', e.status],
          ['SECTOR', e.sector],
        ],
      }
    case 'incident':
      return {
        id: e.id,
        kind: 'INCIDENT',
        color: 'var(--accent-red)',
        rows: [
          ['TYPE', e.type],
          ['PHASE', e.phase],
          ['SEVERITY', `CLASS-${e.severity}`],
          ['SECTOR', e.sector],
        ],
      }
    case 'camera':
      return {
        id: e.id,
        kind: 'SENSOR',
        color: e.online ? 'var(--accent)' : 'var(--accent-red)',
        rows: [
          ['FEED', e.label],
          ['STATUS', e.online ? 'ONLINE' : 'OFFLINE'],
          ['DETECTIONS', String(e.detections)],
          ['SECTOR', e.sector],
        ],
      }
  }
}

export default function MapTooltip({ data }: { data: TooltipData }) {
  return (
    <div className="panel-surface-2 w-[176px] px-2 py-1.5" style={{ borderLeft: `2px solid ${data.color}` }}>
      <div className="flex items-baseline justify-between gap-2 border-b border-line pb-1">
        <span className="num text-[11px]" style={{ color: data.color }}>
          {data.id}
        </span>
        <span className="lbl-faint">{data.kind}</span>
      </div>
      <div className="mt-1 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5">
        {data.rows.map(([k, v], i) => (
          <Fragment key={i}>
            <span className="lbl-faint">{k}</span>
            <span className="num truncate text-right text-[10px] text-prim/85">{v}</span>
          </Fragment>
        ))}
      </div>
    </div>
  )
}
