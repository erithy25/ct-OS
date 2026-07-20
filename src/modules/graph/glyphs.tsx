/**
 * PROFILER — node glyph vocabulary.
 *
 * Everything here renders with EXPLICIT SVG attributes (literal hex colors,
 * numeric sizes — no CSS classes) so the live chart serializes losslessly
 * for PNG export. Violet is reserved for account glyphs + SIMULATED tags
 * (the synthetic-layer color) — nothing else may use it.
 */
import type { ReactElement } from 'react'
import type { EdgeType, NodeType } from '../../sim/types'

/** design tokens as literals — keep in sync with src/theme/tokens.css */
export const C = {
  void: '#05070a',
  panel: '#0a0e14',
  panel2: '#0d131c',
  line: '#1a2430',
  lineb: '#26384a',
  prim: '#c9d6e4',
  dim: '#6b7c8f',
  faint: '#3a4756',
  accent: '#22d3ee',
  amber: '#f5a623',
  red: '#ff3b47',
  green: '#34d399',
  violet: '#8b5cf6',
} as const

export const NODE_COLOR: Record<NodeType, string> = {
  person: C.accent,
  phone: C.green,
  vehicle: C.amber,
  account: C.violet,
  location: C.dim,
}

export const EDGE_TYPES: readonly EdgeType[] = ['ASSOCIATE', 'CO-LOCATED', 'CALLED', 'OWNS', 'TRANSACTED']

/** edge types drawn with a directional arrowhead (source → target) */
export const DIRECTED: ReadonlySet<EdgeType> = new Set<EdgeType>(['OWNS', 'CALLED', 'TRANSACTED'])

export const ROOT_R = 14

export function nodeRadius(type: NodeType): number {
  switch (type) {
    case 'person':
      return 10
    case 'phone':
      return 7
    case 'vehicle':
      return 8.5
    case 'account':
      return 8
    case 'location':
      return 7
  }
}

/** person risk ring color — red ≥70, amber ≥45, none below */
export function riskRing(risk: number | undefined): string | null {
  if (risk == null) return null
  return risk >= 70 ? C.red : risk >= 45 ? C.amber : null
}

function hexPoints(r: number): string {
  const pts: string[] = []
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i - Math.PI / 2
    pts.push(`${(Math.cos(a) * r).toFixed(2)},${(Math.sin(a) * r).toFixed(2)}`)
  }
  return pts.join(' ')
}

/** bare glyph shape centered at the origin (no rings) */
export function glyphShape(type: NodeType, r: number, strokeWidth = 1.1): ReactElement {
  const color = NODE_COLOR[type]
  switch (type) {
    case 'person':
      return (
        <>
          <circle r={r} fill={color} fillOpacity={0.14} stroke={color} strokeWidth={strokeWidth} />
          <circle r={1.5} fill={color} />
        </>
      )
    case 'phone':
      return <rect x={-r} y={-r} width={2 * r} height={2 * r} rx={2.5} fill={color} fillOpacity={0.12} stroke={color} strokeWidth={strokeWidth} />
    case 'vehicle':
      return <path d={`M0 ${-r} L${r} 0 L0 ${r} L${-r} 0 Z`} fill={color} fillOpacity={0.12} stroke={color} strokeWidth={strokeWidth} />
    case 'account':
      return <polygon points={hexPoints(r)} fill={color} fillOpacity={0.12} stroke={color} strokeWidth={strokeWidth} />
    case 'location':
      return (
        <>
          <rect x={-r} y={-r} width={2 * r} height={2 * r} fill={color} fillOpacity={0.08} stroke={color} strokeWidth={1} />
          <circle r={1.2} fill={color} />
        </>
      )
  }
}

/**
 * Full node glyph: shape + person risk ring + (root) pulsing double ring.
 * The pulse uses SVG <animate> — exports as a clean static frame.
 */
export function NodeGlyph({ type, r, risk, isRoot = false }: { type: NodeType; r: number; risk?: number; isRoot?: boolean }) {
  const ring = type === 'person' ? riskRing(risk) : null
  return (
    <>
      {isRoot && (
        <g pointerEvents="none">
          <circle r={r + 4.5} fill="none" stroke={C.accent} strokeWidth={1} opacity={0.85} />
          <circle r={r + 9} fill="none" stroke={C.accent} strokeWidth={0.75} opacity={0.4}>
            <animate attributeName="r" values={`${r + 7};${r + 15};${r + 7}`} dur="2.8s" repeatCount="indefinite" />
            <animate attributeName="opacity" values="0.45;0.06;0.45" dur="2.8s" repeatCount="indefinite" />
          </circle>
        </g>
      )}
      {ring && <circle pointerEvents="none" r={r + 3} fill="none" stroke={ring} strokeWidth={1.1} opacity={0.9} />}
      {glyphShape(type, r, isRoot ? 1.5 : 1.1)}
    </>
  )
}

/** tiny inline glyph for HTML contexts (dossier device list / focus footer) */
export function MiniGlyph({ type, size = 12 }: { type: NodeType; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="-8 -8 16 16" aria-hidden className="shrink-0">
      {glyphShape(type, 6, 1.4)}
    </svg>
  )
}
