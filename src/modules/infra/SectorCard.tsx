/**
 * POWER group — one sector breaker row.
 *
 * Industrial vertical breaker (I/O) with LED. Turning OFF is destructive:
 * press-and-hold 700 ms with a filling red progress bar + `HOLD TO BLACK OUT`
 * label; release early cancels. Turning ON is instant. State comes from the
 * store only — external flips (⌘K blackout, auto-restore) move the lever too.
 */
import { type PointerEvent as ReactPointerEvent } from 'react'
import { alertTone, uiClick } from '../../lib/audio'
import type { SectorId } from '../../sim/types'
import { congestionColor, StateTag, useHoldToConfirm, useValueFlash } from './controls'

export interface SectorCardProps {
  id: SectorId
  /** district name for this sector */
  name: string
  on: boolean
  /** live polled per-sector stats */
  congestion: number // 0..1
  camsOnline: number
  camsTotal: number
  incidents: number
  onSet: (id: SectorId, on: boolean) => void
}

const GREEN = 'var(--accent-green)'
const RED = 'var(--accent-red)'

function Chip({ k, v, color }: { k: string; v: string; color: string }) {
  return (
    <span className="flex items-baseline gap-1">
      <span className="lbl-faint text-[7px] leading-[10px]">{k}</span>
      <span className="num text-[9px] leading-[10px]" style={{ color }}>
        {v}
      </span>
    </span>
  )
}

export default function SectorCard({ id, name, on, congestion, camsOnline, camsTotal, incidents, onSet }: SectorCardProps) {
  const flashEl = useValueFlash(on, (v) => (v ? 'cyan' : 'amber'))
  const { progress, holding, bind } = useHoldToConfirm(700, () => {
    onSet(id, false)
    alertTone()
  })

  const pct = Math.round(congestion * 100)
  const tone = on ? GREEN : RED

  const holdDown = (e: ReactPointerEvent<HTMLButtonElement>): void => {
    uiClick()
    bind.onPointerDown(e)
  }
  const energize = (): void => {
    uiClick()
    onSet(id, true)
  }

  return (
    <div
      className={`relative flex min-h-[52px] flex-1 items-center gap-2 border-b border-line/60 px-2 transition-colors duration-300 last:border-b-0 ${
        on ? '' : 'bg-red/[0.05]'
      }`}
    >
      {flashEl}

      {/* sector identity + live chips (dim when dark) */}
      <div className={`min-w-0 flex-1 transition-opacity duration-300 ease-tac ${on ? '' : 'opacity-40'}`}>
        <div className="flex items-center gap-1.5">
          <span className="num text-[11px] leading-4 text-prim/90">{id}</span>
          <span className="lbl truncate text-[8px] text-dim">{name}</span>
        </div>
        <div className="mt-0.5 flex items-center gap-2.5">
          <Chip k="CONG" v={`${pct}%`} color={congestionColor(pct)} />
          <Chip k="CAMS" v={`${camsOnline}/${camsTotal}`} color={camsOnline < camsTotal ? RED : 'var(--text-dim)'} />
          <Chip k="INC" v={String(incidents)} color={incidents > 0 ? 'var(--accent-amber)' : 'var(--text-dim)'} />
        </div>
        {/* sector load telemetry bar */}
        <div className="mt-1 h-[2px] w-full bg-panel2">
          <div
            className="h-full transition-[width] duration-500 ease-linear"
            style={{ width: `${pct}%`, background: congestionColor(pct), opacity: 0.75 }}
          />
        </div>
      </div>

      {!on && <StateTag text="GRID DARK" tone="red" />}

      {/* LED */}
      <span
        aria-hidden
        className="h-2 w-2 shrink-0 rounded-full"
        style={{
          background: tone,
          boxShadow: on ? '0 0 7px rgba(52, 211, 153, 0.8)' : '0 0 6px rgba(255, 59, 71, 0.55)',
        }}
      />

      {/* breaker lever — hold to cut, click to energize */}
      <button
        type="button"
        title={on ? 'HOLD TO BLACK OUT' : 'ENERGIZE SECTOR'}
        onClick={on ? undefined : energize}
        onPointerDown={on ? holdDown : undefined}
        onPointerUp={on ? bind.onPointerUp : undefined}
        onPointerLeave={on ? bind.onPointerLeave : undefined}
        onPointerCancel={on ? bind.onPointerCancel : undefined}
        className="relative h-[32px] w-[40px] shrink-0 touch-none select-none border bg-panel2 transition-colors duration-150 ease-tac active:scale-95"
        style={{ borderColor: on ? 'rgba(52, 211, 153, 0.6)' : 'rgba(255, 59, 71, 0.65)' }}
      >
        <span className="lbl-faint pointer-events-none absolute left-[3px] top-[3px] text-[6px] leading-none">I</span>
        <span className="lbl-faint pointer-events-none absolute bottom-[3px] left-[3px] text-[6px] leading-none">O</span>
        <span
          className="pointer-events-none absolute left-[10px] right-[3px] flex h-[12px] items-center justify-center gap-[2px] border transition-all duration-150 ease-tac"
          style={{
            top: on ? 3 : 17,
            borderColor: tone,
            background: on ? 'rgba(52, 211, 153, 0.20)' : 'rgba(255, 59, 71, 0.22)',
            boxShadow: on ? '0 0 8px rgba(52, 211, 153, 0.25)' : 'none',
          }}
        >
          <span className="h-[6px] w-px" style={{ background: tone, opacity: 0.8 }} />
          <span className="h-[6px] w-px" style={{ background: tone, opacity: 0.8 }} />
          <span className="h-[6px] w-px" style={{ background: tone, opacity: 0.8 }} />
        </span>
      </button>

      {/* hold-to-confirm progress overlay */}
      {holding && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center overflow-hidden">
          <div
            className="absolute inset-y-0 left-0 border-r border-red bg-red/20"
            style={{ width: `${progress * 100}%` }}
          />
          <span className="lbl relative z-10 bg-void/60 px-1.5 py-0.5 text-[9px] tracking-[0.22em] text-red">
            HOLD TO BLACK OUT
          </span>
        </div>
      )}
    </div>
  )
}
