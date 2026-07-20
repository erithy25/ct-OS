import { useEffect, useRef, useState } from 'react'
import Panel from '../../components/Panel'
import { useSim } from '../../sim/store'

/**
 * Typewriter: shows `text` instantly on mount; when `text` changes it retypes
 * at ~`ms`/char. Previous text stays on screen until the retype begins.
 */
function useTypewriter(text: string, ms = 18): { shown: string; typing: boolean } {
  const [shown, setShown] = useState(text)
  const [typing, setTyping] = useState(false)
  const lastText = useRef<string | null>(null)

  useEffect(() => {
    if (lastText.current === text) return // StrictMode double-invoke / no-op re-run
    const isFirst = lastText.current === null
    lastText.current = text
    if (isFirst) {
      // first commit — render the current note without a retype
      setShown(text)
      return
    }
    setTyping(true)
    let i = 0
    setShown('')
    const id = setInterval(() => {
      i++
      setShown(text.slice(0, i))
      if (i >= text.length) {
        clearInterval(id)
        setTyping(false)
      }
    }, ms)
    return () => clearInterval(id)
  }, [text, ms])

  return { shown, typing }
}

/**
 * The violet AI layer: next-hour hotspot forecast + auto-generated analyst
 * note. Violet is used here (and on SIMULATED tags) exclusively.
 */
export default function PredictivePanel({ className = '' }: { className?: string }) {
  const hotspots = useSim((s) => s.hotspots)
  const note = useSim((s) => s.analystNote)
  const { shown, typing } = useTypewriter(note)

  return (
    <Panel
      title="PREDICTIVE // NEXT-HOUR HOTSPOT FORECAST"
      live
      ledColor="var(--accent-violet)"
      brackets
      className={`min-h-0 ${className}`}
      bodyClassName="flex min-h-0 flex-col overflow-hidden p-1.5"
      right={<span className="lbl shrink-0 border border-violet/60 bg-violet/10 px-1 py-px text-violet">AI LAYER · SIMULATED</span>}
    >
      <div className="flex min-h-0 flex-col gap-1 overflow-y-auto">
        {hotspots.slice(0, 4).map((h, i) => (
          <div key={h.sector} className="border-b border-line/50 px-0.5 pb-1">
            <div className="flex items-baseline justify-between gap-1">
              <span className="num min-w-0 truncate text-[11px] text-prim">
                <span className="text-faint">{String(i + 1).padStart(2, '0')} </span>
                {h.sector}
              </span>
              <span className="lbl shrink-0 border border-violet/40 px-1 py-px text-violet/90">{h.driver}</span>
            </div>
            <div className="mt-1 flex items-center gap-1.5">
              <span className="h-[7px] min-w-0 flex-1 border border-line bg-panel2">
                <span
                  className="block h-full bg-violet/80 transition-[width] duration-200 ease-tac"
                  style={{ width: `${Math.round(h.probability * 100)}%` }}
                />
              </span>
              <span className="num w-14 shrink-0 text-right text-[11px] text-violet">
                {Math.round(h.probability * 100)}%
              </span>
            </div>
            <div className="mt-0.5 flex items-center gap-1.5">
              <span className="h-[3px] min-w-0 flex-1 bg-panel2">
                <span
                  className="block h-full bg-violet/40 transition-[width] duration-200 ease-tac"
                  style={{ width: `${Math.round(h.confidence * 100)}%` }}
                />
              </span>
              <span className="num w-14 shrink-0 text-right text-[9px] text-dim">
                CONF {Math.round(h.confidence * 100)}%
              </span>
            </div>
          </div>
        ))}
        {hotspots.length === 0 && <div className="lbl-faint px-1 py-3 text-center">FORECAST MODEL SPOOLING…</div>}
      </div>

      <div className="mt-auto flex shrink-0 flex-col pt-1.5">
        <div className="mb-1 flex items-center justify-between">
          <span className="lbl text-violet/80">ANALYST NOTE</span>
          {typing && <span className="lbl-faint text-violet/60">SYNTHESIZING…</span>}
        </div>
        <div className="panel-surface-2 min-h-[56px] px-2 py-1.5 text-[11px] leading-4 text-prim/85">
          {shown}
          <span className="blink text-violet" aria-hidden>
            ▍
          </span>
        </div>
        <div className="lbl-faint mt-1">AUTO-GENERATED // TEMPLATED FROM LIVE SIM METRICS</div>
      </div>
    </Panel>
  )
}
