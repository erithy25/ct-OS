/**
 * Tile chrome shared by every feed (header strip, status LED, expand/close)
 * plus the simulated-camera tile (CAM-02+), whose canvas is driven by the
 * single grid rAF loop via `register`.
 */
import { useEffect, useRef, type ReactNode } from 'react'
import CornerBrackets from '../../components/CornerBrackets'
import { getWorld, useSim } from '../../sim/store'
import type { Camera } from '../../sim/types'
import { fmtCoord } from '../../lib/format'
import { uiClick } from '../../lib/audio'
import { camUptime, drawSimFeed, feedSignal } from './simFeed'

export type TickFn = (tMs: number) => void
export type TickRegister = (id: string, fn: TickFn | null) => void

/* ── shared tile shell ─────────────────────────────────────────────── */

interface TileShellProps {
  camId: string
  label: string
  online: boolean
  uptime: string
  expanded: boolean
  headerRight?: ReactNode
  footer?: ReactNode
  children: ReactNode
}

export function TileShell({ camId, label, online, uptime, expanded, headerRight, footer, children }: TileShellProps) {
  const setExpandedCam = useSim((s) => s.setExpandedCam)
  const ledColor = online ? 'var(--accent)' : 'var(--accent-red)'

  return (
    <section
      className={`panel-surface relative flex min-h-0 min-w-0 flex-col overflow-hidden ${
        expanded ? '' : 'cursor-pointer transition-colors duration-150 ease-tac hover:border-lineb'
      }`}
      onClick={
        expanded
          ? undefined
          : () => {
              setExpandedCam(camId)
              uiClick()
            }
      }
    >
      <header className="flex h-6 shrink-0 items-center gap-1.5 border-b border-line px-1.5">
        <span
          className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${online ? 'led-pulse' : ''}`}
          style={{ background: ledColor, boxShadow: online ? `0 0 6px ${ledColor}` : 'none' }}
        />
        <span className="lbl shrink-0 text-prim/80">{camId}</span>
        <span className="lbl-faint min-w-0 flex-1 truncate">{label}</span>
        <span className="num lbl-faint shrink-0">{online ? uptime : 'OFFLINE'}</span>
        {headerRight}
        {expanded && (
          <button
            className="lbl -mr-0.5 border border-line px-1 py-px text-dim transition-colors duration-150 ease-tac hover:border-red hover:text-red"
            onClick={(e) => {
              e.stopPropagation()
              setExpandedCam(null)
              uiClick()
            }}
            title="COLLAPSE [ESC]"
          >
            ✕
          </button>
        )}
      </header>

      <div className="relative min-h-0 flex-1 bg-[#020304]">
        {children}
        {/* CRT dressing layers */}
        <div className="sv-scanlines pointer-events-none absolute inset-0" />
        <div className="sv-rollline pointer-events-none" />
        <div className="sv-vignette pointer-events-none absolute inset-0" />
        <CornerBrackets size={expanded ? 12 : 7} className="opacity-70" />
      </div>

      {footer}
    </section>
  )
}

/* ── simulated camera tile ─────────────────────────────────────────── */

export default function SimCamTile({ cam, expanded, register }: { cam: Camera; expanded: boolean; register: TickRegister }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const tick: TickFn = (t) => {
      const canvas = canvasRef.current
      if (!canvas) return
      const cw = canvas.clientWidth
      const ch = canvas.clientHeight
      if (cw === 0 || ch === 0) return
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5)
      const W = Math.floor(cw * dpr)
      const H = Math.floor(ch * dpr)
      if (canvas.width !== W || canvas.height !== H) {
        canvas.width = W
        canvas.height = H
      }
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      drawSimFeed(ctx, cw, ch, cam, t, getWorld().night)
    }
    register(cam.id, tick)
    return () => register(cam.id, null)
  }, [cam, register])

  return (
    <TileShell
      camId={cam.id}
      label={cam.label}
      online={cam.online}
      uptime={`${camUptime(cam.id)}%`}
      expanded={expanded}
      footer={expanded ? <SimTelemetryFooter cam={cam} /> : undefined}
    >
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
    </TileShell>
  )
}

/* expanded-mode telemetry strip — reads live world fields at tick rate */
function SimTelemetryFooter({ cam }: { cam: Camera }) {
  useSim((s) => s.tick) // re-render at sim tick so detections/online stay live
  const sig = cam.online ? feedSignal(cam.id, performance.now()) : 'lost'
  const sigLabel = !cam.online ? 'GRID DARK' : sig === 'live' ? 'NOMINAL' : sig === 'reacq' ? 'REACQUIRING' : 'RF DROPOUT'
  const sigColor = !cam.online ? 'var(--accent-red)' : sig === 'live' ? 'var(--accent-green)' : 'var(--accent-amber)'

  return (
    <div className="grid shrink-0 grid-cols-6 gap-2 border-t border-line bg-panel px-2 py-1.5">
      <Field k="SECTOR" v={cam.sector} />
      <Field k="GRID REF" v={fmtCoord(cam.pos.x, cam.pos.y)} />
      <Field k="FOV" v={`${Math.round((cam.fov * 2 * 180) / Math.PI)}°`} />
      <Field k="RANGE" v={`${Math.round(cam.range)} M`} />
      <Field k="DETECTIONS" v={String(cam.detections)} />
      <Field k="LINK" v={sigLabel} color={sigColor} />
    </div>
  )
}

export function Field({ k, v, color }: { k: string; v: string; color?: string }) {
  return (
    <div className="min-w-0">
      <div className="lbl-faint">{k}</div>
      <div className="num truncate text-[11px]" style={{ color: color ?? 'var(--text-primary)' }}>
        {v}
      </div>
    </div>
  )
}
