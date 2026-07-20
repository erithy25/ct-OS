import { useEffect, useState } from 'react'
import { useSim } from '../sim/store'
import { fmtLocal, fmtSimClock, fmtUTC } from '../lib/format'

const DEFCON_STYLE: Record<number, { color: string; glow: string; label: string }> = {
  5: { color: 'var(--accent-green)', glow: '0 0 10px rgba(52,211,153,0.35)', label: 'NOMINAL' },
  4: { color: 'var(--accent)', glow: 'var(--glow-accent)', label: 'GUARDED' },
  3: { color: 'var(--accent-amber)', glow: '0 0 10px rgba(245,166,35,0.4)', label: 'ELEVATED' },
  2: { color: '#ff7a45', glow: '0 0 10px rgba(255,122,69,0.45)', label: 'SEVERE' },
  1: { color: 'var(--accent-red)', glow: '0 0 12px rgba(255,59,71,0.55)', label: 'CRITICAL' },
}

export default function TopBar() {
  const defcon = useSim((s) => s.defcon)
  const overridden = useSim((s) => s.defconOverride !== null)
  const simMinutes = useSim((s) => s.simMinutes)
  const setTerminalOpen = useSim((s) => s.setTerminalOpen)
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 250)
    return () => clearInterval(id)
  }, [])

  const d = DEFCON_STYLE[defcon]

  return (
    <header className="relative z-20 flex h-11 items-center gap-4 border-b border-line bg-panel px-3">
      {/* product mark */}
      <div className="flex items-baseline gap-2">
        <span className="font-grotesk text-[15px] font-bold tracking-[0.22em] text-prim">PANOPTICON</span>
        <span className="text-[13px] font-medium tracking-widest text-accent">// OS</span>
      </div>

      <span className="h-4 w-px bg-line" />

      {/* clocks */}
      <div className="num flex items-center gap-3 text-[11px] text-dim">
        <span>
          <span className="lbl-faint mr-1.5">UTC</span>
          <span className="text-prim/90">{fmtUTC(now)}</span>
        </span>
        <span>
          <span className="lbl-faint mr-1.5">LOC</span>
          <span className="text-prim/90">{fmtLocal(now)}</span>
        </span>
        <span>
          <span className="lbl-faint mr-1.5">SIM</span>
          <span className="text-accent/90">{fmtSimClock(simMinutes)}</span>
        </span>
      </div>

      <div className="flex-1" />

      {/* operator badge */}
      <div className="hidden items-center gap-2 md:flex">
        <span className="h-1.5 w-1.5 rounded-full bg-green led-pulse" style={{ boxShadow: '0 0 6px var(--accent-green)' }} />
        <span className="lbl text-prim/70">OP-7749 // CLEARANCE: OMEGA</span>
      </div>

      <span className="h-4 w-px bg-line" />

      {/* DEFCON */}
      <div
        key={defcon}
        className="flash-amber flex items-center gap-2 border px-2 py-1"
        style={{ borderColor: d.color, boxShadow: d.glow }}
        title={overridden ? 'THREATCON — OPERATOR OVERRIDE ACTIVE' : 'THREATCON — DERIVED FROM SIM STATE'}
      >
        <span className="lbl" style={{ color: d.color }}>
          DEFCON {defcon}
        </span>
        <span className="flex gap-0.5" aria-hidden>
          {[5, 4, 3, 2, 1].map((lvl) => (
            <span
              key={lvl}
              className="h-2.5 w-1"
              style={{ background: lvl >= defcon ? d.color : 'var(--line)', opacity: lvl >= defcon ? 1 : 0.8 }}
            />
          ))}
        </span>
        <span className="lbl-faint hidden lg:inline" style={{ color: d.color, opacity: 0.75 }}>
          {d.label}
          {overridden ? ' · OVR' : ''}
        </span>
      </div>

      {/* command hint */}
      <button
        onClick={() => setTerminalOpen(true)}
        className="lbl flex items-center gap-1.5 border border-line bg-panel2 px-2 py-1 text-dim transition-colors duration-150 ease-tac hover:border-accent hover:text-accent"
      >
        <span className="text-[11px]">⌘K</span>
        <span className="hidden xl:inline">COMMAND</span>
      </button>
    </header>
  )
}
