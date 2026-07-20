import { useEffect, useRef, useState } from 'react'
import { useSim } from '../sim/store'

/**
 * Command terminal — placeholder shell. The full cmdk grammar module replaces
 * this file; for now it opens, echoes, and closes so ⌘K is wired end-to-end.
 */
export default function CommandTerminal() {
  const open = useSim((s) => s.terminalOpen)
  const setOpen = useSim((s) => s.setTerminalOpen)
  const [lines, setLines] = useState<string[]>([])
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) inputRef.current?.focus()
    else setLines([])
  }, [open])

  if (!open) return null

  return (
    <div className="absolute inset-0 z-50 flex items-start justify-center bg-void/70 pt-[12vh]" onClick={() => setOpen(false)}>
      <div
        className="panel-surface-2 w-[600px] max-w-[90%] border-lineb shadow-glow"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex h-6 items-center justify-between border-b border-line px-2">
          <span className="lbl text-accent">COMMAND TERMINAL</span>
          <span className="lbl-faint">ESC TO CLOSE</span>
        </div>
        <div className="num max-h-40 overflow-y-auto px-2 py-1 text-[11px] leading-5">
          {lines.map((l, i) => (
            <div key={i} className="text-amber">
              {l}
            </div>
          ))}
        </div>
        <form
          className="flex items-center gap-1.5 px-2 py-1.5"
          onSubmit={(e) => {
            e.preventDefault()
            const v = inputRef.current?.value.trim()
            if (v) setLines((ls) => [...ls.slice(-6), `ERR: GRAMMAR OFFLINE — '${v}' NOT EXECUTED (SUBSYSTEM PENDING)`])
            if (inputRef.current) inputRef.current.value = ''
          }}
        >
          <span className="text-accent">›</span>
          <input
            ref={inputRef}
            className="num flex-1 bg-transparent text-[12px] text-prim caret-transparent outline-none"
            spellCheck={false}
            autoComplete="off"
          />
          <span className="blink -ml-1 h-[13px] w-[7px] bg-accent" />
        </form>
      </div>
    </div>
  )
}
