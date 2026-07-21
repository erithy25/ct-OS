import { useEffect, useRef, useState } from 'react'
import { bootTone } from '../lib/audio'

const LINES = [
  { t: 'PANOPTICON // HOMEWATCH — SECURE LOCAL BOOT', c: 'text-faint' },
  { t: 'INITIALIZING HOME AWARENESS CORE...', c: 'text-prim/85' },
  { t: 'CAMERA MESH: SCANNING LOCAL NETWORK', c: 'text-prim/85' },
  { t: 'CV SUBSYSTEM: TENSORFLOW.JS READY', c: 'text-prim/85' },
  { t: 'FACE MODULE: STANDBY (CONSENT REQUIRED)', c: 'text-prim/85' },
  { t: 'PRIVACY: LOCAL-ONLY // NO CLOUD // NO UPLOAD', c: 'text-green' },
  { t: '>> HOMEWATCH ONLINE', c: 'text-accent font-medium' },
]

export default function HomeBoot({ onDone }: { onDone: () => void }) {
  const [shown, setShown] = useState<string[]>([])
  const done = useRef(false)

  useEffect(() => {
    let cancelled = false
    const timers: number[] = []
    const wait = (ms: number) => new Promise<void>((r) => timers.push(window.setTimeout(r, ms)))
    const finish = () => {
      if (done.current) return
      done.current = true
      bootTone()
      onDone()
    }
    const skip = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        cancelled = true
        finish()
      }
    }
    window.addEventListener('keydown', skip)
    ;(async () => {
      await wait(250)
      for (let i = 0; i < LINES.length; i++) {
        if (cancelled) return
        setShown((s) => [...s, LINES[i].t])
        await wait(i === LINES.length - 1 ? 420 : 230 + Math.random() * 160)
      }
      if (!cancelled) {
        await wait(350)
        finish()
      }
    })()
    return () => {
      cancelled = true
      window.removeEventListener('keydown', skip)
      timers.forEach(clearTimeout)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-void" style={{ animation: 'boot-flicker 4s linear infinite' }}>
      <div className="w-[540px] max-w-[86vw] px-6">
        <div className="lbl-faint mb-4 flex items-center justify-between">
          <span>PANOPTICON // HOMEWATCH</span>
          <span>CONSOLE 0</span>
        </div>
        <div className="num min-h-[200px] text-[12px] leading-[22px]">
          {shown.map((t, i) => {
            const line = LINES.find((l) => l.t === t)
            return (
              <div key={i} className={line?.c ?? 'text-prim/85'}>
                <span className="mr-2 text-faint">{String(i).padStart(2, '0')}</span>
                {t}
                {i === shown.length - 1 && <span className="blink ml-0.5 inline-block h-[13px] w-[7px] translate-y-[2px] bg-accent" />}
              </div>
            )
          })}
          {shown.length === 0 && <span className="blink inline-block h-[13px] w-[7px] bg-accent" />}
        </div>
        <div className="lbl-faint mt-6 text-center opacity-60">ESC TO SKIP</div>
      </div>
    </div>
  )
}
