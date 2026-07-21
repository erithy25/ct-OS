import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { getHomeEvents, useHome } from '../store'
import type { HomeEvent, HomeSeverity, HomeStatus, HomeView } from '../types'
import Panel from '../../components/Panel'
import { setAudioMuted, uiSwitch } from '../../lib/audio'

/* ── home status styling ───────────────────────────────────────────── */

const STATUS_STYLE: Record<HomeStatus, { color: string; glow: string }> = {
  SECURE: { color: 'var(--accent-green)', glow: '0 0 10px rgba(52,211,153,0.35)' },
  MONITOR: { color: 'var(--accent)', glow: 'var(--glow-accent)' },
  ELEVATED: { color: 'var(--accent-amber)', glow: '0 0 10px rgba(245,166,35,0.4)' },
  ALERT: { color: 'var(--accent-red)', glow: '0 0 12px rgba(255,59,71,0.55)' },
}

const SEV_STYLE: Record<HomeSeverity, string> = {
  INFO: 'var(--text-dim)',
  NOTICE: 'var(--accent)',
  WARN: 'var(--accent-amber)',
  CRIT: 'var(--accent-red)',
}

/* ── TOP BAR ───────────────────────────────────────────────────────── */

export function HomeTopBar() {
  const homeStatus = useHome((s) => s.homeStatus)
  const serverOnline = useHome((s) => s.serverOnline)
  const cams = useHome((s) => s.serverCameras.length)
  const setTerminalOpen = useHome((s) => s.setTerminalOpen)
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 500)
    return () => clearInterval(id)
  }, [])
  const st = STATUS_STYLE[homeStatus]
  const p = (n: number) => String(n).padStart(2, '0')

  return (
    <header className="relative z-20 flex h-11 items-center gap-4 border-b border-line bg-panel px-3">
      <div className="flex items-baseline gap-2">
        <span className="font-grotesk text-[15px] font-bold tracking-[0.22em] text-prim">PANOPTICON</span>
        <span className="text-[13px] font-medium tracking-widest text-accent">// HOMEWATCH</span>
      </div>
      <span className="h-4 w-px bg-line" />
      <div className="num text-[11px] text-dim">
        <span className="lbl-faint mr-1.5">LOCAL</span>
        <span className="text-prim/90">{`${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}`}</span>
      </div>
      <div className="flex-1" />
      <span className="lbl text-dim">{cams + 1} CAMERAS</span>
      <span className="h-4 w-px bg-line" />
      <div
        key={homeStatus}
        className="flash-amber flex items-center gap-2 border px-2 py-1"
        style={{ borderColor: st.color, boxShadow: st.glow }}
      >
        <span className="led-pulse h-1.5 w-1.5 rounded-full" style={{ background: st.color }} />
        <span className="lbl" style={{ color: st.color }}>
          {homeStatus}
        </span>
      </div>
      <span className="lbl border px-1.5 py-1" style={{ borderColor: serverOnline ? 'var(--accent-green)' : 'var(--accent-red)', color: serverOnline ? 'var(--accent-green)' : 'var(--accent-red)' }}>
        {serverOnline ? 'LINK ●' : 'NO LINK'}
      </span>
      <button
        onClick={() => setTerminalOpen(true)}
        className="lbl flex items-center gap-1.5 border border-line bg-panel2 px-2 py-1 text-dim transition-colors hover:border-accent hover:text-accent"
      >
        <span className="text-[11px]">⌘K</span>
      </button>
    </header>
  )
}

/* ── LEFT RAIL ─────────────────────────────────────────────────────── */

const NAV: { id: HomeView; label: string; key: string; icon: ReactNode }[] = [
  { id: 'wall', label: 'LIVE WALL', key: '1', icon: <GlyphWall /> },
  { id: 'people', label: 'PEOPLE', key: '2', icon: <GlyphPeople /> },
  { id: 'zones', label: 'ZONES', key: '3', icon: <GlyphZones /> },
  { id: 'activity', label: 'ACTIVITY', key: '4', icon: <GlyphActivity /> },
  { id: 'alerts', label: 'ALERTS', key: '5', icon: <GlyphAlerts /> },
]

export function HomeLeftRail() {
  const view = useHome((s) => s.view)
  const setView = useHome((s) => s.setView)
  const status = useHome((s) => s.status)
  const serverCameras = useHome((s) => s.serverCameras)
  const webcamStatus = useHome((s) => s.webcamStatus)
  const cvOnline = useHome((s) => s.cvOnline)
  const detPerMin = useHome((s) => s.detectionsPerMin)
  const people = useHome((s) => s.people)
  const muted = useHome((s) => s.muted)
  const setMuted = useHome((s) => s.setMuted)

  const online = serverCameras.filter((c) => c.status === 'live').length + (webcamStatus === 'live' ? 1 : 0)
  const total = serverCameras.length + 1
  const present = people.filter((p) => p.present).length

  return (
    <nav className="relative z-20 flex min-h-0 flex-col border-r border-line bg-panel">
      <div className="lbl-faint border-b border-line px-3 py-1.5">HOMEWATCH</div>
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
                <span className="absolute inset-y-1 left-0 w-0.5 transition-all" style={{ background: active ? 'var(--accent)' : 'transparent', boxShadow: active ? 'var(--glow-accent)' : undefined }} />
                {item.icon}
                <span className="lbl flex-1">{item.label}</span>
                <span className="lbl-faint opacity-50">{item.key}</span>
              </button>
            </li>
          )
        })}
      </ul>

      <div className="lbl-faint mt-2 border-y border-line px-3 py-1.5">SYSTEM</div>
      <div className="flex flex-col gap-2 px-3 py-2.5">
        <Stat label="CAMERAS ONLINE" value={`${online}/${total}`} color={online === total ? 'var(--accent-green)' : 'var(--accent-amber)'} />
        <Stat label="DETECTION" value={cvOnline ? 'ACTIVE' : 'STANDBY'} color={cvOnline ? 'var(--accent-green)' : 'var(--text-dim)'} />
        <Stat label="DETECTIONS/MIN" value={String(Math.round(detPerMin))} />
        <Stat label="HOUSEHOLD PRESENT" value={String(present)} />
        <Stat label="FFMPEG" value={status?.ffmpeg ? 'READY' : status ? 'MISSING' : '—'} color={status?.ffmpeg ? 'var(--accent-green)' : 'var(--accent-amber)'} />
      </div>

      <div className="flex-1" />
      <div className="border-t border-line px-3 py-2">
        <button
          onClick={() => {
            const m = !muted
            setMuted(m)
            setAudioMuted(m)
          }}
          className="lbl flex w-full items-center justify-between text-dim hover:text-prim"
        >
          <span>AUDIO</span>
          <span className={muted ? 'text-faint' : 'text-accent'}>{muted ? 'MUTED' : 'LIVE'}</span>
        </button>
        <div className="lbl-faint mt-1.5 opacity-60">PRIVATE · LOCAL-ONLY</div>
      </div>
    </nav>
  )
}

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div>
      <div className="lbl-faint">{label}</div>
      <div className="num text-[13px] leading-4" style={{ color: color ?? 'var(--text-primary)' }}>
        {value}
      </div>
    </div>
  )
}

/* ── INTEL COLUMN ──────────────────────────────────────────────────── */

export function HomeIntel() {
  const eventsVersion = useHome((s) => s.eventsVersion)
  const select = useHome((s) => s.select)
  const selectedId = useHome((s) => s.selectedId)

  const feed = useMemo(() => {
    const all = getHomeEvents()
    const out: HomeEvent[] = []
    for (let i = all.length - 1; i >= 0 && out.length < 60; i--) out.push(all[i])
    return out
  }, [eventsVersion])

  return (
    <aside className="relative z-20 flex min-h-0 flex-col gap-1.5 border-l border-line bg-void/40 p-1.5">
      <Panel title="ALERT FEED" live brackets className="min-h-0 flex-[3]" bodyClassName="overflow-y-auto">
        <ul className="flex flex-col">
          {feed.map((e) => (
            <li
              key={e.id}
              className={`rise-in border-b border-line/50 px-2 py-1 ${e.cameraId || e.personId ? 'cursor-pointer hover:bg-panel2' : ''}`}
              onClick={e.cameraId || e.personId ? () => select(e.cameraId ?? e.personId ?? null) : undefined}
            >
              <div className="flex items-center gap-1.5">
                <span className="num lbl-faint">{fmtTime(e.ts)}</span>
                <span className="lbl" style={{ color: SEV_STYLE[e.severity] }}>{e.severity}</span>
                <span className="lbl-faint">{e.kind}</span>
              </div>
              <div className="mt-0.5 truncate text-[11px] leading-4 text-prim/85">{e.message}</div>
            </li>
          ))}
          {feed.length === 0 && <li className="lbl-faint px-2 py-3 text-center">NO EVENTS YET</li>}
        </ul>
      </Panel>

      <Panel title="SELECTED" collapsible className="shrink-0" bodyClassName="p-2">
        {selectedId ? (
          <div className="num text-[12px] text-prim/90">{selectedId}</div>
        ) : (
          <div className="lbl-faint py-2 text-center">NOTHING SELECTED</div>
        )}
      </Panel>
    </aside>
  )
}

/* ── TICKER ────────────────────────────────────────────────────────── */

export function HomeTicker() {
  const eventsVersion = useHome((s) => s.eventsVersion)
  const text = useMemo(() => {
    const ev = getHomeEvents().slice(-14)
    if (ev.length === 0) return 'HOMEWATCH ONLINE · AWAITING EVENTS'
    return ev.map((e) => `[${fmtTime(e.ts)}] ${e.severity} · ${e.kind} · ${e.message}`).join('      ▹      ')
  }, [eventsVersion])
  const dur = Math.max(28, Math.min(110, text.length * 0.28))

  return (
    <footer className="relative z-20 flex h-7 items-center gap-3 overflow-hidden border-t border-line bg-panel px-3">
      <span className="flex shrink-0 items-center gap-1.5">
        <span className="led-pulse h-1.5 w-1.5 bg-accent" style={{ boxShadow: 'var(--glow-accent)' }} />
        <span className="lbl text-accent">LIVE</span>
      </span>
      <span className="h-3.5 w-px shrink-0 bg-line" />
      <div className="relative min-w-0 flex-1 overflow-hidden">
        <div key={text} className="ticker-track num flex w-max items-center whitespace-nowrap text-[10px] tracking-wide text-dim" style={{ ['--ticker-dur' as string]: `${dur}s` }}>
          <span className="pr-24">{text}</span>
          <span className="pr-24" aria-hidden>{text}</span>
        </div>
      </div>
      <span className="lbl-faint shrink-0">PANOPTICON // HOMEWATCH</span>
    </footer>
  )
}

function fmtTime(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/* ── nav glyphs ────────────────────────────────────────────────────── */

function GlyphWall() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.2">
      <rect x="1.5" y="2.5" width="6" height="5" /><rect x="8.5" y="2.5" width="6" height="5" />
      <rect x="1.5" y="8.5" width="6" height="5" /><rect x="8.5" y="8.5" width="6" height="5" />
    </svg>
  )
}
function GlyphPeople() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.2">
      <circle cx="8" cy="5" r="2.4" /><path d="M3 13.5c0-2.8 2.2-4.5 5-4.5s5 1.7 5 4.5" />
    </svg>
  )
}
function GlyphZones() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.2">
      <path d="M2.5 5 8 2l5.5 3v6L8 14l-5.5-3V5Z" strokeLinejoin="round" /><circle cx="8" cy="8" r="1.4" fill="currentColor" stroke="none" />
    </svg>
  )
}
function GlyphActivity() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.2">
      <path d="M1.5 8.5h3l2-5 3 10 2-5h3" />
    </svg>
  )
}
function GlyphAlerts() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.2">
      <path d="M8 2 2 13h12L8 2Z" strokeLinejoin="round" /><path d="M8 6.5v3.2M8 11.4v.1" />
    </svg>
  )
}
