import { useEffect, useRef, useState } from 'react'
import { bootTone } from '../lib/audio'
import { getWorld } from '../sim/store'
import { fmtNum } from '../lib/format'

interface BootLine {
  text: string
  /** suffix appended after a short pause, e.g. ' OK' */
  suffix?: string
  suffixClass?: string
  /** render an animated progress bar after the text */
  bar?: boolean
  pauseAfter?: number
  className?: string
}

const BAR_W = 12

function buildLines(): BootLine[] {
  const nodes = getWorld().city.nodes.length || 2412
  const edges = getWorld().city.segments.length || 6880
  return [
    { text: 'PANOPTICON BIOS v5.11.7 — SECURE BOOT PATH VERIFIED', className: 'text-faint', pauseAfter: 260 },
    { text: 'INITIALIZING PANOPTICON CORE...', pauseAfter: 320 },
    { text: 'MOUNTING SENSOR MESH ', bar: true, pauseAfter: 240 },
    { text: `LOADING CITY MODEL: NODES ${fmtNum(nodes)} / EDGES ${fmtNum(edges)}`, pauseAfter: 200 },
    { text: 'ESTABLISHING UPLINK...', suffix: ' OK', suffixClass: 'text-green', pauseAfter: 260 },
    { text: 'CV SUBSYSTEM: TENSORFLOW.JS READY', pauseAfter: 160 },
    { text: 'BIOMETRIC MODULE: STANDBY', pauseAfter: 200 },
    { text: 'AUTH: OP-7749 // CLEARANCE OMEGA ', suffix: 'GRANTED', suffixClass: 'text-accent', pauseAfter: 420 },
    { text: '>> SYSTEM ONLINE', className: 'text-accent font-medium', pauseAfter: 500 },
  ]
}

interface Rendered {
  text: string
  barFill: number
  suffixShown: boolean
  line: BootLine
}

export default function BootSequence({ onDone }: { onDone: () => void }) {
  const [rendered, setRendered] = useState<Rendered[]>([])
  const done = useRef(false)

  useEffect(() => {
    const lines = buildLines()
    let cancelled = false
    const timers: number[] = []
    const wait = (ms: number) => new Promise<void>((res) => timers.push(window.setTimeout(res, ms)))

    const finish = () => {
      if (done.current) return
      done.current = true
      bootTone()
      onDone()
    }

    const skip = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        cancelled = true
        setRendered(lines.map((line) => ({ text: line.text, barFill: BAR_W, suffixShown: true, line })))
        finish()
      }
    }
    window.addEventListener('keydown', skip)

    const run = async () => {
      await wait(420)
      for (const line of lines) {
        if (cancelled) return
        const idx = rendered.length // captured below via functional set
        setRendered((r) => [...r, { text: '', barFill: 0, suffixShown: false, line }])
        void idx
        // type characters
        for (let i = 1; i <= line.text.length; i++) {
          if (cancelled) return
          setRendered((r) => {
            const copy = [...r]
            copy[copy.length - 1] = { ...copy[copy.length - 1], text: line.text.slice(0, i) }
            return copy
          })
          await wait(line.text.startsWith('>>') ? 14 : 6 + Math.random() * 13)
        }
        if (line.bar) {
          for (let b = 1; b <= BAR_W; b++) {
            if (cancelled) return
            setRendered((r) => {
              const copy = [...r]
              copy[copy.length - 1] = { ...copy[copy.length - 1], barFill: b }
              return copy
            })
            await wait(26 + Math.random() * 30)
          }
        }
        if (line.suffix) {
          await wait(240 + Math.random() * 260)
          if (cancelled) return
          setRendered((r) => {
            const copy = [...r]
            copy[copy.length - 1] = { ...copy[copy.length - 1], suffixShown: true }
            return copy
          })
        }
        await wait(line.pauseAfter ?? 140)
      }
      if (!cancelled) finish()
    }

    void run()
    return () => {
      cancelled = true
      window.removeEventListener('keydown', skip)
      timers.forEach(clearTimeout)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-void" style={{ animation: 'boot-flicker 4s linear infinite' }}>
      <div className="w-[560px] max-w-[86vw] px-6">
        <div className="lbl-faint mb-4 flex items-center justify-between">
          <span>PANOPTICON // OS</span>
          <span>CONSOLE 0</span>
        </div>
        <div className="num min-h-[240px] text-[12px] leading-[20px]">
          {rendered.map((r, i) => (
            <div key={i} className={r.line.className ?? 'text-prim/85'}>
              <span className="mr-2 text-faint">{String(i).padStart(2, '0')}</span>
              {r.text}
              {r.line.bar && r.text.length === r.line.text.length && (
                <span className="text-accent">
                  [{'█'.repeat(r.barFill)}
                  {'░'.repeat(BAR_W - r.barFill)}] {Math.round((r.barFill / BAR_W) * 100)}%
                </span>
              )}
              {r.line.suffix && r.suffixShown && <span className={r.line.suffixClass}>{r.line.suffix}</span>}
              {i === rendered.length - 1 && <span className="blink ml-0.5 inline-block h-[13px] w-[7px] translate-y-[2px] bg-accent" />}
            </div>
          ))}
          {rendered.length === 0 && <span className="blink inline-block h-[13px] w-[7px] bg-accent" />}
        </div>
        <div className="lbl-faint mt-6 text-center opacity-60">ESC TO SKIP</div>
      </div>
    </div>
  )
}
