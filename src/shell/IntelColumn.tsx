import { useMemo } from 'react'
import Panel from '../components/Panel'
import Gauge from '../components/Gauge'
import Sparkline from '../components/Sparkline'
import { findEntity, getEvents, getHistories, useSim } from '../sim/store'
import { getDossier } from '../sim/identityFactory'
import type { Severity, SimEvent } from '../sim/types'
import { fmtSimTime } from '../lib/format'

const SEV: Record<Severity, { color: string; glyph: string }> = {
  INFO: { color: 'var(--text-dim)', glyph: '·' },
  NOTICE: { color: 'var(--accent)', glyph: '▸' },
  WARN: { color: 'var(--accent-amber)', glyph: '▲' },
  CRIT: { color: 'var(--accent-red)', glyph: '◆' },
}

export default function IntelColumn() {
  return (
    <aside className="relative z-20 flex min-h-0 flex-col gap-1.5 border-l border-line bg-void/40 p-1.5">
      <AlertFeed />
      <DossierPanel />
      <TelemetryPanel />
    </aside>
  )
}

/* ── ALERT FEED ────────────────────────────────────────────────────── */

function AlertFeed() {
  const eventsVersion = useSim((s) => s.eventsVersion)
  const select = useSim((s) => s.select)

  const feed = useMemo(() => {
    const all = getEvents()
    const out: SimEvent[] = []
    for (let i = all.length - 1; i >= 0 && out.length < 42; i--) out.push(all[i])
    return out
  }, [eventsVersion])

  return (
    <Panel title="ALERT FEED" live pulseKey={eventsVersion} brackets collapsible className="min-h-0 flex-[5]" bodyClassName="overflow-y-auto">
      <ul className="flex flex-col">
        {feed.map((e) => {
          const s = SEV[e.severity]
          return (
            <li
              key={e.id}
              className={`rise-in border-b border-line/50 px-2 py-1 ${e.entityId ? 'cursor-pointer hover:bg-panel2' : ''}`}
              onClick={e.entityId ? () => select(e.entityId ?? null) : undefined}
            >
              <div className="flex items-center gap-1.5">
                <span style={{ color: s.color }} className="w-2 text-[10px]" aria-hidden>
                  {s.glyph}
                </span>
                <span className="num lbl-faint">{fmtSimTime(e.simMinutes)}</span>
                <span className="lbl" style={{ color: s.color }}>
                  {e.severity}
                </span>
                <span className="lbl-faint truncate">{e.channel}</span>
                {e.sector && <span className="lbl-faint ml-auto shrink-0 border border-line px-1">{e.sector.replace('SECTOR-', 'S')}</span>}
              </div>
              <div className="mt-0.5 truncate pl-3.5 text-[11px] leading-4 text-prim/85">{e.message}</div>
            </li>
          )
        })}
        {feed.length === 0 && <li className="lbl-faint px-2 py-3 text-center">NO SIGNALS YET</li>}
      </ul>
    </Panel>
  )
}

/* ── DOSSIER ───────────────────────────────────────────────────────── */

function DossierPanel() {
  const selectedId = useSim((s) => s.selectedId)
  const trackedIds = useSim((s) => s.trackedIds)
  const setTracked = useSim((s) => s.setTracked)
  const setView = useSim((s) => s.setView)

  const isPerson = selectedId?.startsWith('P-') ?? false
  const dossier = isPerson && selectedId ? getDossier(selectedId) : null
  const entity = selectedId ? findEntity(selectedId) : undefined

  return (
    <Panel
      title="DOSSIER"
      collapsible
      live={!!selectedId}
      ledColor="var(--accent-amber)"
      className="min-h-0 flex-[4]"
      bodyClassName="overflow-y-auto"
      right={selectedId ? <span className="num lbl-faint">{selectedId}</span> : undefined}
    >
      {!selectedId && (
        <div className="flex h-full min-h-[120px] flex-col items-center justify-center gap-2 py-6">
          <svg viewBox="0 0 24 24" className="h-8 w-8 text-faint" fill="none" stroke="currentColor" strokeWidth="1">
            <circle cx="12" cy="12" r="8" />
            <path d="M12 1v6M12 17v6M1 12h6M17 12h6" />
          </svg>
          <div className="lbl-faint">NO TARGET DESIGNATED</div>
          <div className="lbl-faint max-w-[200px] text-center opacity-60">SELECT AN ENTITY ON THE TACTICAL MAP OR ALERT FEED</div>
        </div>
      )}

      {selectedId && dossier && (
        <div className="p-2">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="truncate font-grotesk text-[15px] font-medium leading-5 text-prim">{dossier.name}</div>
              <div className="num mt-0.5 text-[10px] text-dim">
                ALIAS {dossier.alias} · DOB {dossier.dob}
              </div>
              <div className="mt-1.5 flex flex-wrap gap-1">
                <StatusChip status={dossier.status} />
                <span className="lbl border border-violet/60 px-1 py-px text-violet">SOURCE: SIMULATED</span>
              </div>
            </div>
            <Gauge value={dossier.risk} size={62} label="RISK" />
          </div>

          <div className="mt-2 grid grid-cols-2 gap-x-2 gap-y-1.5 border-t border-line pt-2">
            <Field k="LAST SEEN" v={dossier.lastSeenSector} />
            <Field k="DEVICES" v={dossier.devices.length ? dossier.devices.join(' · ') : '—'} />
          </div>

          {dossier.flags.length > 0 && (
            <div className="mt-2">
              <div className="lbl-faint mb-1">BEHAVIOR FLAGS</div>
              <div className="flex flex-wrap gap-1">
                {dossier.flags.map((f) => (
                  <span key={f} className="lbl border border-amber/50 px-1 py-px text-amber">
                    {f}
                  </span>
                ))}
              </div>
            </div>
          )}

          <div className="mt-2">
            <div className="lbl-faint mb-1">ACTIVITY TIMELINE</div>
            <ul className="border-l border-line pl-2">
              {dossier.timeline.slice(0, 5).map((t, i) => (
                <li key={i} className="num mb-1 text-[10px] leading-3.5 text-dim">
                  <span className="text-faint">{fmtSimTime(t.simMinutes)}</span> {t.label}
                  <span className="text-faint"> · {t.sector}</span>
                </li>
              ))}
            </ul>
          </div>

          <div className="mt-2 flex gap-1.5 border-t border-line pt-2">
            <ActionBtn
              onClick={() => setTracked(dossier.id, !trackedIds.includes(dossier.id))}
              active={trackedIds.includes(dossier.id)}
            >
              {trackedIds.includes(dossier.id) ? '◉ TRACKING' : '○ TRACK'}
            </ActionBtn>
            <ActionBtn onClick={() => setView('graph')}>◇ LINK CHART</ActionBtn>
          </div>
        </div>
      )}

      {selectedId && !dossier && (
        <div className="p-2">
          <div className="font-grotesk text-[14px] font-medium text-prim">{selectedId}</div>
          <div className="mt-1.5 grid grid-cols-2 gap-x-2 gap-y-1.5">
            <Field k="CLASS" v={entity ? entity.kind.toUpperCase() : 'UNKNOWN'} />
            <Field k="SECTOR" v={entity?.sector ?? '—'} />
            {entity?.kind === 'camera' && <Field k="STATUS" v={entity.online ? 'ONLINE' : 'OFFLINE'} />}
            {entity?.kind === 'camera' && <Field k="DETECTIONS" v={String(entity.detections)} />}
            {entity?.kind === 'incident' && <Field k="PHASE" v={entity.phase} />}
            {entity?.kind === 'incident' && <Field k="SEVERITY" v={`CLASS-${entity.severity}`} />}
            {entity?.kind === 'patrol' && <Field k="CALLSIGN" v={entity.callsign} />}
            {entity?.kind === 'patrol' && <Field k="STATUS" v={entity.status} />}
            {entity?.kind === 'vehicle' && <Field k="STATE" v={entity.stalled ? 'STALLED' : 'IN TRANSIT'} />}
          </div>
          <div className="mt-2">
            <span className="lbl border border-violet/60 px-1 py-px text-violet">SOURCE: SIMULATED</span>
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

function Field({ k, v }: { k: string; v: string }) {
  return (
    <div className="min-w-0">
      <div className="lbl-faint">{k}</div>
      <div className="num truncate text-[11px] text-prim/90">{v}</div>
    </div>
  )
}

function ActionBtn({ children, onClick, active = false }: { children: React.ReactNode; onClick: () => void; active?: boolean }) {
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

/* ── TELEMETRY ─────────────────────────────────────────────────────── */

function TelemetryPanel() {
  const vitalsVersion = useSim((s) => s.vitalsVersion)
  const riskIndex = useSim((s) => s.riskIndex)
  const detectionsPerMin = useSim((s) => s.detectionsPerMin)
  const netLoad = useSim((s) => s.vitals.netLoad)
  const h = getHistories()

  return (
    <Panel title="TELEMETRY" collapsible live pulseKey={vitalsVersion} brackets className="shrink-0" bodyClassName="p-2">
      <TelemetryRow label="CITY RISK INDEX" value={riskIndex.toFixed(1)} data={() => h.riskIndex} version={vitalsVersion} color="#F5A623" />
      <TelemetryRow label="DETECTIONS / MIN" value={detectionsPerMin.toFixed(0)} data={() => h.detectionsPerMin} version={vitalsVersion} color="#22D3EE" />
      <TelemetryRow label="NETWORK LOAD" value={`${netLoad.toFixed(0)}%`} data={() => h.netLoad} version={vitalsVersion} color="#34D399" last />
    </Panel>
  )
}

function TelemetryRow({
  label,
  value,
  data,
  version,
  color,
  last = false,
}: {
  label: string
  value: string
  data: () => number[]
  version: number
  color: string
  last?: boolean
}) {
  return (
    <div className={last ? '' : 'mb-2'}>
      <div className="mb-0.5 flex items-baseline justify-between">
        <span className="lbl-faint">{label}</span>
        <span className="num text-[11px]" style={{ color }}>
          {value}
        </span>
      </div>
      <Sparkline data={data} version={version} width={288} height={26} color={color} />
    </div>
  )
}
