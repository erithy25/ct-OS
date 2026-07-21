import type { ReactNode } from 'react'
import { getHistories, useSim } from '../sim/store'
import type { ViewId } from '../sim/types'
import Sparkline from '../components/Sparkline'
import StatReadout from '../components/StatReadout'
import { fmtPct } from '../lib/format'
import { setAudioMuted, uiSwitch } from '../lib/audio'

const ICONS: Record<ViewId, ReactNode> = {
  map: (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.2">
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 1v3M8 12v3M1 8h3M12 8h3" />
      <circle cx="8" cy="8" r="1.2" fill="currentColor" stroke="none" />
    </svg>
  ),
  grid: (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.2">
      <rect x="1.5" y="3.5" width="9" height="7" />
      <path d="M10.5 6.5 14.5 4v8l-4-2.5M4 13.5h4" />
    </svg>
  ),
  graph: (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.2">
      <circle cx="8" cy="3" r="1.8" />
      <circle cx="3" cy="12" r="1.8" />
      <circle cx="13" cy="12" r="1.8" />
      <path d="M7 4.5 4 10.4M9 4.5l3 5.9M4.8 12h6.4" />
    </svg>
  ),
  infra: (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.2">
      <path d="M8.8 1.5 3.5 9h3.4l-1 5.5L11.5 7H8.1l.7-5.5Z" strokeLinejoin="round" />
    </svg>
  ),
  ops: (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.2">
      <path d="M1.5 14.5h13M3 11l3-4 2.5 2L13 4" />
      <path d="M10.5 4H13v2.5" />
    </svg>
  ),
  markets: (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.2">
      <path d="M2 12.5 5 8l2.5 2.5L10 5l1.6 2M2.2 3v10.5h11.6" />
      <path d="M11 4.5h2.5V7" strokeLinejoin="round" />
    </svg>
  ),
}

const NAV: { id: ViewId; label: string; key: string }[] = [
  { id: 'map', label: 'TACTICAL MAP', key: '1' },
  { id: 'grid', label: 'SURVEILLANCE', key: '2' },
  { id: 'graph', label: 'PROFILER', key: '3' },
  { id: 'infra', label: 'INFRASTRUCTURE', key: '4' },
  { id: 'ops', label: 'OPS DECK', key: '5' },
  { id: 'markets', label: 'MARKET OPS', key: '6' },
]

export default function LeftRail() {
  const view = useSim((s) => s.view)
  const setView = useSim((s) => s.setView)
  const vitals = useSim((s) => s.vitals)
  const vitalsVersion = useSim((s) => s.vitalsVersion)
  const muted = useSim((s) => s.muted)
  const setMuted = useSim((s) => s.setMuted)
  const linkUp = useSim((s) => s.linkUp)
  const linkMode = useSim((s) => s.linkMode)
  const linkLabel = linkMode === 'remote' ? 'REMOTE' : 'LOCAL'
  const linkColor = linkMode === 'remote' ? 'var(--accent-violet)' : 'var(--accent-green)'
  const realCpu = useSim((s) => s.realTelemetry.host?.cpuPct ?? s.realTelemetry.client?.cpuPct ?? null)

  const h = getHistories()

  return (
    <nav className="relative z-20 flex min-h-0 flex-col border-r border-line bg-panel">
      <div className="lbl-faint border-b border-line px-3 py-1.5">MODULES</div>
      <ul>
        {NAV.map((item) => {
          const active = view === item.id
          return (
            <li key={item.id}>
              <button
                onClick={() => {
                  setView(item.id)
                  uiSwitch()
                }}
                className={`group relative flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors duration-150 ease-tac ${
                  active ? 'bg-panel2 text-accent' : 'text-dim hover:bg-panel2/60 hover:text-prim'
                }`}
              >
                <span
                  className={`absolute inset-y-1 left-0 w-0.5 transition-all duration-150 ease-tac ${active ? 'bg-accent' : 'bg-transparent'}`}
                  style={active ? { boxShadow: 'var(--glow-accent)' } : undefined}
                />
                {ICONS[item.id]}
                <span className="lbl flex-1" style={{ color: 'inherit' }}>
                  {item.label}
                </span>
                <span className="lbl-faint opacity-50">{item.key}</span>
              </button>
            </li>
          )
        })}
      </ul>

      <div className="lbl-faint mt-2 border-y border-line px-3 py-1.5">SYSTEM VITALS</div>
      <div className="flex flex-col gap-2.5 px-3 py-2.5">
        <VitalRow label={realCpu !== null ? 'CITY LOAD ◆' : 'CITY LOAD'} value={fmtPct(vitals.cityLoad, 0)} data={() => h.cityLoad} version={vitalsVersion} color="#22D3EE" />
        <VitalRow label="ACTIVE UNITS" value={String(Math.round(vitals.activeUnits))} data={() => h.activeUnits} version={vitalsVersion} color="#34D399" />
        <VitalRow label="SENSOR UPTIME" value={fmtPct(vitals.sensorUptime)} data={() => h.sensorUptime} version={vitalsVersion} color="#34D399" />
        <VitalRow label="NETWORK LOAD" value={fmtPct(vitals.netLoad, 0)} data={() => h.netLoad} version={vitalsVersion} color="#F5A623" />
      </div>

      <OperatorTelemetry />

      <div className="flex-1" />

      <div className="border-t border-line px-3 py-2">
        <button
          onClick={() => {
            const m = !muted
            setMuted(m)
            setAudioMuted(m)
          }}
          className="lbl flex w-full items-center justify-between text-dim transition-colors hover:text-prim"
        >
          <span>AUDIO</span>
          <span className={muted ? 'text-faint' : 'text-accent'}>{muted ? 'MUTED' : 'LIVE'}</span>
        </button>
        <div className="lbl-faint mt-1.5 flex items-center justify-between">
          <span className="flex items-center gap-1">
            <span
              className={`inline-block h-1 w-1 rounded-full ${linkUp ? 'led-pulse' : ''}`}
              style={{ background: linkUp ? linkColor : 'var(--accent-red)', boxShadow: linkUp ? `0 0 5px ${linkColor}` : 'none' }}
            />
            LINK
          </span>
          <span className="num" style={{ color: linkUp ? linkColor : 'var(--accent-red)' }}>
            {linkUp ? linkLabel : 'OFFLINE'}
          </span>
        </div>
        <div className="lbl-faint mt-1 flex justify-between opacity-60">
          <span>MESH v5.11</span>
          <span className="num">SEED 0x2F7A</span>
        </div>
      </div>
    </nav>
  )
}

function VitalRow({
  label,
  value,
  data,
  version,
  color,
}: {
  label: string
  value: string
  data: () => number[]
  version: number
  color: string
}) {
  return (
    <div className="flex items-end justify-between gap-2">
      <StatReadout label={label} value={value} className="min-w-0 flex-1" />
      <Sparkline data={data} version={version} width={56} height={18} color={color} />
    </div>
  )
}

/** Phase 1 — genuine local telemetry, streamed through the world source. */
function OperatorTelemetry() {
  const rt = useSim((s) => s.realTelemetry)
  const client = rt.client
  const host = rt.host
  const active = !!(client || host)

  return (
    <>
      <div className="mt-1 flex items-center justify-between border-y border-line px-3 py-1.5">
        <span className="lbl-faint">OPERATOR NODE</span>
        <span className="lbl flex items-center gap-1" style={{ color: active ? 'var(--accent-green)' : 'var(--text-faint)' }}>
          <span
            className={`inline-block h-1 w-1 rounded-full ${active ? 'led-pulse' : ''}`}
            style={{ background: active ? 'var(--accent-green)' : 'var(--text-faint)', boxShadow: active ? '0 0 5px var(--accent-green)' : 'none' }}
          />
          REAL
        </span>
      </div>
      <div className="px-3 py-2">
        {!active && <div className="lbl-faint opacity-60">AWAITING LOCAL FEED…</div>}
        {client && (
          <div className="grid grid-cols-2 gap-x-3 gap-y-1">
            <Metric k="LOAD" v={pct(client.cpuPct)} />
            <Metric k="RENDER" v={client.fps !== undefined ? `${client.fps} FPS` : '—'} />
            <Metric k="JS HEAP" v={pct(client.memPct)} />
            <Metric k="CORES" v={client.cores !== undefined ? String(client.cores) : '—'} />
            {client.rttMs !== undefined && <Metric k="NET RTT" v={`${client.rttMs}ms`} />}
            {client.deviceMemGB !== undefined && <Metric k="DEV MEM" v={`${client.deviceMemGB}GB`} />}
          </div>
        )}
        {host && (
          <div className="mt-1.5 border-t border-line/60 pt-1.5">
            <div className="lbl-faint mb-1 flex items-center gap-1" style={{ color: 'var(--accent-violet)' }}>
              <span className="inline-block h-1 w-1 rounded-full led-pulse" style={{ background: 'var(--accent-violet)' }} />
              HOST · {host.label}
            </div>
            <div className="grid grid-cols-2 gap-x-3 gap-y-1">
              <Metric k="CPU" v={pct(host.cpuPct)} />
              <Metric k="MEM" v={pct(host.memPct)} />
              {host.cores !== undefined && <Metric k="CORES" v={String(host.cores)} />}
              {host.netKBps !== undefined && <Metric k="NET" v={`${fmtNetKB(host.netKBps)}`} />}
            </div>
          </div>
        )}
      </div>
    </>
  )
}

function Metric({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-baseline justify-between gap-1">
      <span className="lbl-faint">{k}</span>
      <span className="num text-[11px] text-prim/90">{v}</span>
    </div>
  )
}

const pct = (n: number | undefined): string => (n === undefined ? '—' : `${Math.round(n)}%`)
const fmtNetKB = (kb: number): string => (kb >= 1024 ? `${(kb / 1024).toFixed(1)}MB/s` : `${Math.round(kb)}KB/s`)
