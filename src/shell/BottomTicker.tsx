import { useEffect, useRef, useState } from 'react'
import { getEvents, useSim } from '../sim/store'
import { fmtSimTime, fmtTick } from '../lib/format'

/** Bottom status strip: scrolling event marquee + tick / fps / latency readouts. */
export default function BottomTicker() {
  return (
    <footer className="relative z-20 flex h-7 items-center gap-3 overflow-hidden border-t border-line bg-panel px-3">
      <span className="flex shrink-0 items-center gap-1.5">
        <span className="led-pulse h-1.5 w-1.5 bg-accent" style={{ boxShadow: 'var(--glow-accent)' }} />
        <span className="lbl text-accent">LIVE</span>
      </span>
      <span className="h-3.5 w-px shrink-0 bg-line" />
      <Marquee />
      <span className="h-3.5 w-px shrink-0 bg-line" />
      <RightStats />
    </footer>
  )
}

function Marquee() {
  const eventsVersion = useSim((s) => s.eventsVersion)
  const [text, setText] = useState('AWAITING EVENT STREAM')
  const lastBuild = useRef(0)

  useEffect(() => {
    const now = performance.now()
    if (now - lastBuild.current < 6000 && lastBuild.current !== 0) return
    lastBuild.current = now
    const ev = getEvents().slice(-14)
    if (ev.length === 0) return
    setText(
      ev
        .map((e) => `[${fmtSimTime(e.simMinutes)}] ${e.severity} · ${e.sector ? `${e.sector} · ` : ''}${e.message}`)
        .join('      ▹      '),
    )
  }, [eventsVersion])

  const dur = Math.max(28, Math.min(110, text.length * 0.28))

  return (
    <div className="relative min-w-0 flex-1 overflow-hidden">
      <div
        key={text}
        className="ticker-track num flex w-max items-center whitespace-nowrap text-[10px] tracking-wide text-dim"
        style={{ ['--ticker-dur' as string]: `${dur}s` }}
      >
        <span className="pr-24">{text}</span>
        <span className="pr-24" aria-hidden>
          {text}
        </span>
      </div>
    </div>
  )
}

function RightStats() {
  const tick = useSim((s) => s.tick)
  const [fps, setFps] = useState(60)
  const [lat, setLat] = useState(12)

  useEffect(() => {
    let raf = 0
    let last = performance.now()
    let ema = 60
    let frames = 0
    const loop = (t: number) => {
      const dt = t - last
      last = t
      if (dt > 0) ema = ema * 0.95 + (1000 / dt) * 0.05
      if (++frames % 30 === 0) setFps(Math.round(ema))
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [])

  useEffect(() => {
    const id = setInterval(() => {
      setLat((l) => {
        if (Math.random() < 0.04) return 34 + Math.floor(Math.random() * 28)
        const next = l + (Math.random() - 0.5) * 4
        return Math.max(8, Math.min(24, Math.round(next)))
      })
    }, 1300)
    return () => clearInterval(id)
  }, [])

  return (
    <div className="num flex shrink-0 items-center gap-3 text-[10px]">
      <span className="text-dim">
        <span className="lbl-faint mr-1">TICK</span>
        <span className="text-prim/80">{fmtTick(tick)}</span>
      </span>
      <span className="text-dim">
        <span className="lbl-faint mr-1">FPS</span>
        <span className={fps < 45 ? 'text-amber' : 'text-prim/80'}>{String(fps).padStart(2, '0')}</span>
      </span>
      <span className="text-dim">
        <span className="lbl-faint mr-1">LATENCY</span>
        <span className={lat > 30 ? 'text-amber' : 'text-prim/80'}>{lat}ms</span>
      </span>
    </div>
  )
}
