/**
 * INFRASTRUCTURE CONTROL — tactile control primitives.
 *
 * Every control is a stateless view over the sim store (single source of
 * truth). Local state exists only for animation: hold progress, actuation
 * flashes. Motion is fast + mechanical — 150 ms, cubic-bezier(0.2,0.8,0.2,1).
 */
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { uiClick } from '../../lib/audio'

/* ── tones ─────────────────────────────────────────────────────────── */

export const TONE = {
  green: { c: 'var(--accent-green)', bg: 'rgba(52, 211, 153, 0.16)', glow: '0 0 8px rgba(52, 211, 153, 0.35)' },
  cyan: { c: 'var(--accent)', bg: 'rgba(34, 211, 238, 0.14)', glow: '0 0 8px rgba(34, 211, 238, 0.35)' },
  amber: { c: 'var(--accent-amber)', bg: 'rgba(245, 166, 35, 0.16)', glow: '0 0 8px rgba(245, 166, 35, 0.35)' },
  red: { c: 'var(--accent-red)', bg: 'rgba(255, 59, 71, 0.16)', glow: '0 0 9px rgba(255, 59, 71, 0.40)' },
  dim: { c: 'var(--text-dim)', bg: 'rgba(107, 124, 143, 0.10)', glow: 'none' },
} as const

export type Tone = keyof typeof TONE

/** congestion % → readout color */
export const congestionColor = (pct: number): string =>
  pct >= 70 ? 'var(--accent-red)' : pct >= 40 ? 'var(--accent-amber)' : 'var(--accent-green)'

/* ── value-change flash (fires for local AND external actuations) ──── */

export type FlashTone = 'cyan' | 'amber'

/**
 * Watch a store-derived value; when it changes, return a one-shot row flash
 * overlay. Because it keys off the store value (not the click), external
 * changes (⌘K `blackout SECTOR-3`, auto-restore) flash the row too.
 */
export function useValueFlash<T>(value: T, toneFor?: (next: T) => FlashTone): ReactNode {
  const [flash, setFlash] = useState<{ n: number; tone: FlashTone }>({ n: 0, tone: 'cyan' })
  const prev = useRef(value)
  const toneRef = useRef(toneFor)
  toneRef.current = toneFor

  useEffect(() => {
    if (Object.is(prev.current, value)) return
    prev.current = value
    const tone = toneRef.current ? toneRef.current(value) : 'cyan'
    setFlash((f) => ({ n: f.n + 1, tone }))
  }, [value])

  if (flash.n === 0) return null
  return (
    <span
      key={flash.n}
      aria-hidden
      className={`pointer-events-none absolute inset-0 ${flash.tone === 'amber' ? 'flash-amber' : 'flash-cyan'}`}
    />
  )
}

/* ── persistent destabilization tag ────────────────────────────────── */

/** Small bordered tag that stays on a row while a destructive state holds. */
export function StateTag({ text, tone }: { text: string; tone: Tone }) {
  const t = TONE[tone]
  return (
    <span
      className="lbl shrink-0 whitespace-nowrap border px-1 py-px text-[7px] leading-[10px]"
      style={{ borderColor: t.c, color: t.c, background: t.bg }}
    >
      {text}
    </span>
  )
}

/* ── hold-to-confirm (destructive actions) ─────────────────────────── */

export interface HoldBind {
  onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void
  onPointerUp: () => void
  onPointerLeave: () => void
  onPointerCancel: () => void
}

export interface HoldToConfirm {
  /** 0 = idle, ramps to 1 over the hold duration */
  progress: number
  holding: boolean
  bind: HoldBind
}

/**
 * Press-and-hold confirm: pointer-down starts a rAF ramp; releasing (or
 * leaving) before `durationMs` cancels; reaching 1 fires `onConfirm` once.
 */
export function useHoldToConfirm(durationMs: number, onConfirm: () => void): HoldToConfirm {
  const [progress, setProgress] = useState(0)
  const raf = useRef(0)
  const startT = useRef(0)
  const active = useRef(false)
  const confirmRef = useRef(onConfirm)
  confirmRef.current = onConfirm

  const cancel = useCallback(() => {
    if (!active.current) return
    active.current = false
    cancelAnimationFrame(raf.current)
    setProgress(0)
  }, [])

  const begin = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      e.preventDefault()
      if (active.current) return
      active.current = true
      startT.current = performance.now()
      setProgress(0.001)
      const step = (): void => {
        if (!active.current) return
        const p = Math.min(1, (performance.now() - startT.current) / durationMs)
        if (p >= 1) {
          active.current = false
          setProgress(0)
          confirmRef.current()
          return
        }
        setProgress(p)
        raf.current = requestAnimationFrame(step)
      }
      raf.current = requestAnimationFrame(step)
    },
    [durationMs],
  )

  useEffect(
    () => () => {
      active.current = false
      cancelAnimationFrame(raf.current)
    },
    [],
  )

  return {
    progress,
    holding: progress > 0,
    bind: { onPointerDown: begin, onPointerUp: cancel, onPointerLeave: cancel, onPointerCancel: cancel },
  }
}

/* ── tactical two-state switch ─────────────────────────────────────── */

interface TacticalSwitchProps {
  on: boolean
  onToggle: (next: boolean) => void
  onLabel?: string
  offLabel?: string
  /** tone when ON (default green) / when OFF (default red) */
  onTone?: Tone
  offTone?: Tone
  className?: string
  title?: string
}

/**
 * Chunky industrial slide switch (~30 px target). The lever covers the
 * active half; 150 ms mechanical throw; uiClick on every actuation.
 */
export function TacticalSwitch({
  on,
  onToggle,
  onLabel = 'ON',
  offLabel = 'OFF',
  onTone = 'green',
  offTone = 'red',
  className = '',
  title,
}: TacticalSwitchProps) {
  const cur = TONE[on ? onTone : offTone]
  return (
    <button
      type="button"
      title={title}
      onClick={() => {
        uiClick()
        onToggle(!on)
      }}
      className={`relative h-[30px] w-[92px] shrink-0 touch-none select-none border bg-panel2 transition-all duration-150 ease-tac active:scale-[0.96] ${className}`}
      style={{ borderColor: cur.c }}
    >
      <span
        className="lbl pointer-events-none absolute inset-y-0 left-0 flex w-1/2 items-center justify-center text-[8px] leading-none transition-colors duration-150 ease-tac"
        style={{ color: on ? TONE[onTone].c : 'var(--text-faint)' }}
      >
        {onLabel}
      </span>
      <span
        className="lbl pointer-events-none absolute inset-y-0 right-0 flex w-1/2 items-center justify-center text-[8px] leading-none transition-colors duration-150 ease-tac"
        style={{ color: on ? 'var(--text-faint)' : TONE[offTone].c }}
      >
        {offLabel}
      </span>
      {/* lever */}
      <span
        className="pointer-events-none absolute bottom-[2px] top-[2px] flex w-[calc(50%-4px)] items-center justify-center gap-[3px] border transition-transform duration-150 ease-tac"
        style={{
          left: 2,
          transform: on ? 'translateX(0)' : 'translateX(calc(100% + 4px))',
          borderColor: cur.c,
          background: cur.bg,
          boxShadow: cur.glow,
        }}
      >
        <span className="h-[8px] w-px" style={{ background: cur.c, opacity: 0.75 }} />
        <span className="h-[8px] w-px" style={{ background: cur.c, opacity: 0.75 }} />
        <span className="h-[8px] w-px" style={{ background: cur.c, opacity: 0.75 }} />
      </span>
    </button>
  )
}

/* ── segmented N-state control ─────────────────────────────────────── */

export interface SegOption<T extends string> {
  value: T
  label: string
  /** classes applied to the active segment */
  activeCls: string
}

export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  className = '',
}: {
  value: T
  options: readonly SegOption<T>[]
  onChange: (next: T) => void
  className?: string
}) {
  return (
    <div className={`flex h-[26px] border border-line bg-void/40 ${className}`}>
      {options.map((o) => {
        const active = o.value === value
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => {
              if (active) return
              uiClick()
              onChange(o.value)
            }}
            className={`lbl min-w-0 flex-1 border-r border-line text-[8px] leading-none transition-all duration-150 ease-tac last:border-r-0 active:scale-[0.97] ${
              active ? o.activeCls : 'text-faint hover:bg-panel2 hover:text-dim'
            }`}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}
