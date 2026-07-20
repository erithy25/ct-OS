/**
 * PROFILER — subject dossier. A richer sibling of IntelColumn's dossier
 * panel: full timeline, itemized devices, network stats, track/locate
 * actions, and a focus footer for non-person nodes picked on the chart.
 */
import { useMemo, type ReactNode } from 'react'
import Gauge from '../../components/Gauge'
import Panel from '../../components/Panel'
import { fmtSimClock } from '../../lib/format'
import { getDossier } from '../../sim/identityFactory'
import { useSim } from '../../sim/store'
import type { EdgeType, GraphNode, NodeType } from '../../sim/types'
import { MiniGlyph, NODE_COLOR } from './glyphs'

export interface FocusInfo {
  node: GraphNode
  via: EdgeType | null
  degree: number
}

interface DossierProps {
  rootId: string
  hops: number
  nodeCount: number
  edgeCount: number
  focus: FocusInfo | null
  onClearFocus(): void
}

const DEVICE_TYPE: Record<string, NodeType> = { PHN: 'phone', VEH: 'vehicle', ACC: 'account' }

export default function Dossier({ rootId, hops, nodeCount, edgeCount, focus, onClearFocus }: DossierProps) {
  const d = useMemo(() => getDossier(rootId), [rootId])
  const trackedIds = useSim((s) => s.trackedIds)
  const setTracked = useSim((s) => s.setTracked)
  const locate = useSim((s) => s.locate)
  const tracking = trackedIds.includes(rootId)

  return (
    <Panel
      title="SUBJECT DOSSIER"
      live
      ledColor="var(--accent)"
      brackets
      className="w-[300px] shrink-0"
      bodyClassName="flex min-h-0 flex-col"
      right={<span className="num lbl-faint">{rootId}</span>}
    >
      <div className="shrink-0 p-2">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="truncate font-grotesk text-[16px] font-medium leading-5 text-prim">{d.name.toUpperCase()}</div>
            <div className="num mt-0.5 text-[10px] text-dim">
              ALIAS {d.alias} · DOB {d.dob}
            </div>
            <div className="mt-1.5 flex flex-wrap gap-1">
              <StatusChip status={d.status} />
              <span className="lbl border border-violet/60 bg-violet/10 px-1 py-px text-violet">SOURCE: SIMULATED</span>
            </div>
          </div>
          <Gauge value={d.risk} size={64} label="RISK" />
        </div>

        <div className="mt-2 grid grid-cols-3 gap-x-2 border-t border-line pt-2">
          <Stat k="LAST SEEN" v={d.lastSeenSector.replace('SECTOR-', 'SEC-')} />
          <Stat k="NET HOPS" v={String(hops)} />
          <Stat k="N / E" v={`${nodeCount}/${edgeCount}`} />
        </div>

        <div className="mt-2">
          <div className="lbl-faint mb-1">REGISTERED DEVICES</div>
          {d.devices.length === 0 && <div className="lbl-faint opacity-60">NONE ON FILE</div>}
          <ul className="flex flex-col gap-0.5">
            {d.devices.map((dev) => {
              const t = DEVICE_TYPE[dev.slice(0, 3)] ?? 'phone'
              return (
                <li key={dev} className="flex items-center gap-1.5">
                  <MiniGlyph type={t} size={11} />
                  <span className="num text-[10px] text-prim/85">{dev}</span>
                  <span className="lbl-faint ml-auto">{t.toUpperCase()}</span>
                </li>
              )
            })}
          </ul>
        </div>

        {d.flags.length > 0 && (
          <div className="mt-2">
            <div className="lbl-faint mb-1">BEHAVIOR FLAGS</div>
            <div className="flex flex-wrap gap-1">
              {d.flags.map((f) => (
                <span key={f} className="lbl border border-amber/50 px-1 py-px text-amber">
                  {f}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto border-t border-line px-2 py-1.5">
        <div className="lbl-faint mb-1">ACTIVITY TIMELINE · {d.timeline.length} ENTRIES</div>
        <ul className="border-l border-line pl-2">
          {d.timeline.map((t, i) => (
            <li key={i} className="relative mb-1.5">
              <span className="absolute -left-[11px] top-[4px] h-1 w-1 bg-accent/70" aria-hidden />
              <div className="num text-[10px] leading-3.5 text-dim">
                <span className="text-accent/80">{fmtSimClock(t.simMinutes)}</span> {t.label}
              </div>
              <div className="lbl-faint">{t.sector}</div>
            </li>
          ))}
        </ul>
      </div>

      <div className="shrink-0 border-t border-line p-1.5">
        <div className="flex gap-1.5">
          <ActionBtn onClick={() => setTracked(rootId, !tracking)} active={tracking}>
            {tracking ? '◉ TRACKING' : '○ TRACK'}
          </ActionBtn>
          <ActionBtn onClick={() => locate(rootId)}>⌖ LOCATE ON MAP</ActionBtn>
        </div>
      </div>

      {focus && (
        <div className="shrink-0 border-t border-lineb bg-panel2 p-1.5">
          <div className="flex items-center gap-1.5">
            <MiniGlyph type={focus.node.type} size={12} />
            <span className="lbl" style={{ color: NODE_COLOR[focus.node.type] }}>
              {focus.node.type}
            </span>
            <span className="num min-w-0 truncate text-[10px] text-prim/90">{focus.node.label}</span>
            <button onClick={onClearFocus} className="lbl-faint ml-auto shrink-0 hover:text-prim" aria-label="clear focus">
              ✕
            </button>
          </div>
          <div className="mt-1 flex items-center gap-2">
            {focus.node.sub && <span className="lbl-faint">{focus.node.sub}</span>}
            {focus.via && <span className="lbl border border-line px-1 py-px">{focus.via}</span>}
            <span className="num lbl-faint ml-auto">DEG {focus.degree}</span>
          </div>
        </div>
      )}
    </Panel>
  )
}

function StatusChip({ status }: { status: 'NOMINAL' | 'WATCH' | 'FLAGGED' }) {
  const color = status === 'FLAGGED' ? 'var(--accent-red)' : status === 'WATCH' ? 'var(--accent-amber)' : 'var(--accent-green)'
  return (
    <span className="lbl border px-1 py-px" style={{ borderColor: color, color }}>
      {status}
    </span>
  )
}

function Stat({ k, v }: { k: string; v: string }) {
  return (
    <div className="min-w-0">
      <div className="lbl-faint">{k}</div>
      <div className="num truncate text-[11px] text-prim/90">{v}</div>
    </div>
  )
}

function ActionBtn({ children, onClick, active = false }: { children: ReactNode; onClick: () => void; active?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={`lbl flex-1 border px-1.5 py-1 transition-colors duration-150 ease-tac ${
        active ? 'border-accent bg-accent/10 text-accent shadow-glow' : 'border-line text-dim hover:border-lineb hover:text-prim'
      }`}
    >
      {children}
    </button>
  )
}
