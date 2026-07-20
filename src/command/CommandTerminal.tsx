/**
 * COMMAND TERMINAL (⌘K) — cmdk-powered tactical command palette.
 *
 * The grammar + autocomplete engine lives in ./grammar (pure, store-free);
 * this file is the operating shell: session transcript, prompt line with a
 * block caret, context suggestions, command history, and the pending-confirm
 * arming for destructive overrides. Open/close state is store-driven
 * (terminalOpen); ⌘K and Esc are wired globally in App.
 */
import { Command } from 'cmdk'
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { getWorld, SECTORS, useSim } from '../sim/store'
import { setAudioMuted, uiClick } from '../lib/audio'
import { CONFIRM_TTL_MS, complete, parse } from './grammar'
import type { CommandCtx, EntityRef, GrammarCtx, Suggestion } from './grammar'

/* ── session state (survives close/reopen; resets on full reload) ──── */

interface TLine {
  id: number
  kind: 'input' | 'result' | 'error' | 'confirm' | 'help' | 'note'
  text: string
}

const transcript: TLine[] = []
const cmdHistory: string[] = []
let pendingConfirm: { key: string; at: number; label: string } | null = null
let lineSeq = 1

function pushLine(kind: TLine['kind'], text: string): void {
  transcript.push({ id: lineSeq++, kind, text })
  if (transcript.length > 80) transcript.splice(0, transcript.length - 80)
}

const LINE_STYLE: Record<TLine['kind'], string> = {
  input: 'text-dim',
  result: 'text-accent',
  error: 'text-red',
  confirm: 'text-amber',
  help: 'whitespace-pre text-[rgba(201,214,228,0.78)]',
  note: 'text-violet',
}

/* ── grammar ctx wiring ────────────────────────────────────────────── */

function entityRefs(): EntityRef[] {
  const w = getWorld()
  const out: EntityRef[] = []
  for (const p of w.persons)
    out.push({
      id: p.id,
      kind: 'person',
      sector: p.sector,
      risk: Math.round(p.riskScore),
      tracked: p.tracked,
      note: p.watchlisted ? 'WATCHLIST' : undefined,
    })
  for (const u of w.patrols) out.push({ id: u.id, kind: 'patrol', sector: u.sector, note: `${u.callsign} · ${u.status}` })
  for (const i of w.incidents) out.push({ id: i.id, kind: 'incident', sector: i.sector, note: `${i.type} · CLASS-${i.severity}` })
  for (const c of w.cameras) out.push({ id: c.id, kind: 'camera', sector: c.sector, note: c.online ? 'ONLINE' : 'OFFLINE' })
  for (const v of w.vehicles) out.push({ id: v.id, kind: 'vehicle', sector: v.sector, note: v.stalled ? 'STALLED' : undefined })
  return out
}

function dataCtx(): CommandCtx {
  const world = getWorld()
  const s = useSim.getState()
  const sectorNames: Record<string, string> = {}
  for (const d of world.city.districts) sectorNames[d.id] = d.name
  return {
    sectors: SECTORS,
    sectorNames,
    bridges: world.city.bridges.map((b) => b.id),
    lines: Object.keys(s.infra.transit),
    entities: entityRefs,
    infra: {
      power: s.infra.power,
      traffic: s.infra.traffic,
      transit: s.infra.transit,
      bridgesRaised: s.infra.bridgesRaised,
    },
  }
}

function execCtx(): GrammarCtx {
  const s = useSim.getState()
  return {
    ...dataCtx(),
    muted: s.muted,
    pending: pendingConfirm,
    now: () => Date.now(),
    actions: {
      setView: s.setView,
      locate: s.locate,
      setTracked: s.setTracked,
      setPower: s.setPower,
      setTraffic: s.setTraffic,
      setBridge: s.setBridge,
      setTransit: s.setTransit,
      autoRestore: s.autoRestore,
      spawnIncident: s.spawnIncident,
      setDefconOverride: s.setDefconOverride,
      requestBiometric: s.requestBiometric,
      select: s.select,
      setMuted: (m) => {
        s.setMuted(m)
        setAudioMuted(m)
      },
      emit: s.emit,
    },
  }
}

/* ── component ─────────────────────────────────────────────────────── */

export default function CommandTerminal() {
  const open = useSim((s) => s.terminalOpen)
  const setOpen = useSim((s) => s.setTerminalOpen)
  const [input, setInputState] = useState('')
  const [sel, setSel] = useState('')
  const [caret, setCaret] = useState(0)
  const [, force] = useReducer((x: number) => x + 1, 0)

  const inputRef = useRef<HTMLInputElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const closeTimer = useRef<number | undefined>(undefined)
  const histIdx = useRef(-1)
  const draft = useRef('')
  const programmatic = useRef(false)

  /** programmatic input set (suggestion apply / history recall / clear) */
  const setInput = useCallback((v: string) => {
    programmatic.current = true
    setInputState(v)
  }, [])

  const suggestions = useMemo<Suggestion[]>(() => (open ? complete(input, dataCtx()) : []), [input, open])
  const highlighted = sel ? suggestions.find((sg) => sg.value === sel) : undefined

  /* keep a suggestion highlighted whenever the list is non-empty */
  useEffect(() => {
    if (!open) return
    if (suggestions.length === 0) {
      if (sel !== '') setSel('')
    } else if (!suggestions.some((sg) => sg.value === sel)) {
      setSel(suggestions[0].value)
    }
  }, [suggestions, sel, open])

  /* fresh prompt + focus on open; cancel a stale view-switch close timer */
  useEffect(() => {
    if (open) {
      if (closeTimer.current !== undefined) {
        window.clearTimeout(closeTimer.current)
        closeTimer.current = undefined
      }
      setInputState('')
      setSel('')
      setCaret(0)
      histIdx.current = -1
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  /* caret sync: programmatic sets jump to end; then mirror selectionStart */
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    if (programmatic.current) {
      programmatic.current = false
      el.setSelectionRange(input.length, input.length)
    }
    setCaret(el.selectionStart ?? input.length)
  }, [input])

  /* transcript auto-scroll */
  const lastLineId = transcript.length > 0 ? transcript[transcript.length - 1].id : 0
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lastLineId, open])

  const syncCaret = () => setCaret(inputRef.current?.selectionStart ?? 0)

  const applySuggestion = useCallback(
    (sg: Suggestion) => {
      histIdx.current = -1
      setInput(sg.insert)
      inputRef.current?.focus()
    },
    [setInput],
  )

  const cycleHistory = (dir: 1 | -1) => {
    if (cmdHistory.length === 0) return
    let idx = histIdx.current
    if (idx === -1) {
      if (dir === -1) return
      draft.current = input
      idx = 0
    } else {
      idx += dir
    }
    if (idx < 0) {
      histIdx.current = -1
      setInput(draft.current)
      return
    }
    if (idx > cmdHistory.length - 1) idx = cmdHistory.length - 1
    histIdx.current = idx
    setInput(cmdHistory[idx])
  }

  const execute = () => {
    const raw = input.trim().replace(/\s+/g, ' ')
    if (!raw) return
    uiClick()
    if (cmdHistory[0] !== raw) cmdHistory.unshift(raw)
    if (cmdHistory.length > 50) cmdHistory.pop()
    histIdx.current = -1

    const res = parse(raw, execCtx())
    pushLine('input', `› ${res.kind === 'error' ? raw : res.echo}`)
    if (res.kind === 'error') {
      pushLine('error', res.message)
    } else if (res.kind === 'confirm') {
      pendingConfirm = { key: res.key, at: Date.now(), label: res.label }
      pushLine('confirm', res.message)
      window.setTimeout(force, res.ttlMs + 60) // drop the armed tag on expiry
    } else {
      if (res.disarm) pendingConfirm = null
      const out = res.run()
      if (typeof out === 'string') {
        const kind = res.lineKind === 'help' ? 'help' : res.lineKind === 'note' ? 'note' : 'result'
        for (const l of out.split('\n')) pushLine(kind, l)
      }
      if (res.closes) {
        if (closeTimer.current !== undefined) window.clearTimeout(closeTimer.current)
        closeTimer.current = window.setTimeout(() => useSim.getState().setTerminalOpen(false), 300)
      }
    }
    setInput('')
    force()
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (highlighted && parse(input, execCtx()).kind === 'error') {
        applySuggestion(highlighted)
        return
      }
      execute()
      return
    }
    if (e.key === 'Tab') {
      e.preventDefault()
      if (highlighted) applySuggestion(highlighted)
      return
    }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const dir: 1 | -1 = e.key === 'ArrowUp' ? 1 : -1
      const wantHistory = e.altKey || suggestions.length === 0 || (input === '' && e.key === 'ArrowUp')
      if (wantHistory) {
        e.preventDefault() // also stops cmdk's own arrow handling
        cycleHistory(dir)
      }
      // otherwise fall through → cmdk navigates the suggestion list
    }
  }

  if (!open) return null

  const pendingActive = pendingConfirm && Date.now() - pendingConfirm.at < CONFIRM_TTL_MS ? pendingConfirm : null

  return (
    <div
      className="absolute inset-0 z-50 flex items-start justify-center bg-[rgba(5,7,10,0.72)] pt-[12vh]"
      onClick={() => setOpen(false)}
    >
      <div
        className="panel-surface-2 w-[640px] max-w-[92%] border-lineb shadow-glow"
        onClick={(e) => e.stopPropagation()}
      >
        {/* header */}
        <div className="flex h-6 items-center gap-2 border-b border-line px-2">
          <span className="led-pulse h-1.5 w-1.5 rounded-full bg-accent" style={{ boxShadow: '0 0 6px var(--accent)' }} />
          <span className="lbl text-accent">COMMAND TERMINAL</span>
          {pendingActive && (
            <span className="lbl led-pulse border border-[rgba(245,166,35,0.6)] bg-[rgba(245,166,35,0.08)] px-1 text-amber">
              CONFIRM ARMED · {pendingActive.label}
            </span>
          )}
          <span className="lbl-faint ml-auto">ESC TO CLOSE</span>
        </div>

        {/* transcript */}
        <div
          ref={scrollRef}
          className="num max-h-[190px] overflow-y-auto border-b border-line px-2 py-1.5 text-[11px] leading-[19px]"
        >
          {transcript.length === 0 && (
            <div className="lbl-faint py-0.5">PANOPTICON COMMAND INTERFACE — TYPE help FOR COMMAND REFERENCE</div>
          )}
          {transcript.map((l) => (
            <div key={l.id} className={`break-words ${LINE_STYLE[l.kind]}`}>
              {l.text}
            </div>
          ))}
        </div>

        <Command label="COMMAND TERMINAL" shouldFilter={false} loop value={sel} onValueChange={setSel}>
          {/* input line */}
          <div className="flex items-center gap-1.5 px-2 py-1.5">
            <span className="text-accent">›</span>
            <div className="relative min-w-0 flex-1 overflow-hidden">
              <Command.Input
                ref={inputRef}
                value={input}
                onValueChange={(v) => {
                  histIdx.current = -1
                  setInputState(v)
                }}
                onKeyDown={onKeyDown}
                onKeyUp={syncCaret}
                onClick={syncCaret}
                onSelect={syncCaret}
                autoFocus
                spellCheck={false}
                autoComplete="off"
                className="num w-full bg-transparent text-[12px] text-prim caret-transparent outline-none placeholder:text-faint"
                placeholder="ENTER COMMAND — TAB TO COMPLETE"
              />
              <span
                className="blink pointer-events-none absolute top-1/2 h-[14px] w-[7px] -translate-y-1/2 bg-[rgba(34,211,238,0.75)]"
                style={{ left: `${caret}ch` }}
              />
            </div>
          </div>

          {/* suggestions */}
          <Command.List
            label="SUGGESTIONS"
            className={`max-h-[212px] overflow-y-auto border-t border-line ${suggestions.length === 0 ? 'hidden' : ''}`}
            onMouseDown={(e) => e.preventDefault()} // keep input focus on click
          >
            {suggestions.map((sg) => (
              <Command.Item
                key={sg.value}
                value={sg.value}
                onSelect={() => applySuggestion(sg)}
                className="group flex h-[26px] cursor-pointer items-center gap-2 border-l-2 border-transparent px-2 data-[selected=true]:border-accent data-[selected=true]:bg-[rgba(34,211,238,0.08)]"
              >
                <span className="w-3 shrink-0 text-center text-[10px] text-faint group-data-[selected=true]:text-accent">
                  {sg.glyph}
                </span>
                <span className="num shrink-0 text-[11px] text-prim group-data-[selected=true]:text-accent">{sg.label}</span>
                <span className="lbl-faint ml-auto min-w-0 truncate text-right">{sg.detail}</span>
              </Command.Item>
            ))}
          </Command.List>
        </Command>

        {/* footer */}
        <div className="flex h-5 items-center justify-between border-t border-line px-2">
          <span className="lbl-faint">TAB COMPLETE · ENTER EXECUTE · ↑↓ NAV · ALT+↑ HISTORY</span>
          <span className="lbl-faint num">{suggestions.length > 0 ? `${suggestions.length} MATCH${suggestions.length === 1 ? '' : 'ES'}` : '—'}</span>
        </div>
      </div>
    </div>
  )
}
