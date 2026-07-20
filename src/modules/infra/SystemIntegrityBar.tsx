/**
 * INFRASTRUCTURE CONTROL — header strip.
 *
 * SYSTEM INTEGRITY master readout (gauge + big tabular % + status line),
 * pulsing cascade-risk banner (alertTone(true) once per activation),
 * TRAFFIC IMPACT (polled avg congestion + trend arrow), CAMERAS,
 * ACTIVE INCIDENTS, and the right-aligned ⟲ AUTO-RESTORE action.
 */
import { useEffect, useRef, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import CornerBrackets from '../../components/CornerBrackets'
import Gauge from '../../components/Gauge'
import { alertTone, uiClick } from '../../lib/audio'
import { useSim } from '../../sim/store'
import { congestionColor } from './controls'

/** integrity → color: green > 70, amber > 45, red ≤ 45 */
const integrityColor = (v: number): string =>
  v > 70 ? 'var(--accent-green)' : v > 45 ? 'var(--accent-amber)' : 'var(--accent-red)'

const statusLine = (v: number, cascade: boolean): string =>
  cascade
    ? 'CASCADE PROTOCOLS ARMED'
    : v > 90
      ? 'ALL SYSTEMS NOMINAL'
      : v > 70
        ? 'MINOR DEGRADATION'
        : v > 45
          ? 'MULTIPLE SYSTEMS DEGRADED'
          : 'CRITICAL INSTABILITY'

function Readout({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="shrink-0">
      <div className="lbl-faint">{label}</div>
      <div className="num flex items-baseline gap-1 text-[15px] leading-5">{children}</div>
    </div>
  )
}

export default function SystemIntegrityBar({ avgCongestion, trend }: { avgCongestion: number; trend: -1 | 0 | 1 }) {
  const integrity = useSim((s) => s.systemIntegrity)
  const cascadeRisk = useSim((s) => s.cascadeRisk)
  const camerasOnline = useSim((s) => s.camerasOnline)
  const camerasTotal = useSim((s) => s.camerasTotal)
  const incidentsActive = useSim((s) => s.incidentsActive)
  const autoRestore = useSim((s) => s.autoRestore)

  /* alert tone on cascade ACTIVATION only (edge trigger, never repeats) */
  const prevCascade = useRef(cascadeRisk)
  useEffect(() => {
    if (cascadeRisk && !prevCascade.current) alertTone(true)
    prevCascade.current = cascadeRisk
  }, [cascadeRisk])

  const col = integrityColor(integrity)
  const congPct = Math.round(avgCongestion)
  const arrow = trend > 0 ? '▲' : trend < 0 ? '▼' : '→'
  const arrowCol = trend > 0 ? 'var(--accent-red)' : trend < 0 ? 'var(--accent-green)' : 'var(--text-faint)'

  return (
    <div className="panel-surface relative flex h-[64px] shrink-0 items-center gap-4 px-3">
      <CornerBrackets />

      {/* master integrity readout */}
      <div className="flex shrink-0 items-center gap-2.5">
        <Gauge value={integrity} size={52} color={col} label="INTG" />
        <div>
          <div className="lbl-faint">SYSTEM INTEGRITY</div>
          <div className="num text-[24px] font-medium leading-6" style={{ color: col }}>
            {Math.round(integrity)}
            <span className="text-[13px]">%</span>
          </div>
          <div className="lbl text-[8px]" style={{ color: col }}>
            {statusLine(integrity, cascadeRisk)}
          </div>
        </div>
      </div>

      <div className="h-9 w-px shrink-0 bg-line" />

      <Readout label="TRAFFIC IMPACT">
        <span style={{ color: congestionColor(congPct) }}>{congPct}%</span>
        <span className="text-[10px]" style={{ color: arrowCol }} aria-hidden>
          {arrow}
        </span>
      </Readout>

      <Readout label="CAMERAS">
        <span style={{ color: camerasOnline < camerasTotal ? 'var(--accent-red)' : 'var(--text-primary)' }}>
          {camerasOnline}/{camerasTotal}
        </span>
      </Readout>

      <Readout label="ACTIVE INCIDENTS">
        <span
          style={{
            color:
              incidentsActive >= 5 ? 'var(--accent-red)' : incidentsActive > 0 ? 'var(--accent-amber)' : 'var(--text-primary)',
          }}
        >
          {incidentsActive}
        </span>
      </Readout>

      {/* cascade banner claims the middle void when the grid destabilizes */}
      <div className="relative flex min-w-0 flex-1 items-center justify-center self-stretch">
        <AnimatePresence>
          {cascadeRisk && (
            <motion.div
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 6 }}
              transition={{ duration: 0.15, ease: [0.2, 0.8, 0.2, 1] }}
              className="infra-alarm lbl whitespace-nowrap border border-red px-3 py-1.5 text-[10px] tracking-[0.18em] text-red"
            >
              ⚠ GRID INSTABILITY: {Math.round(100 - integrity)}% — CASCADE RISK
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <button
        type="button"
        onClick={() => {
          uiClick()
          autoRestore()
        }}
        className="lbl shrink-0 border border-accent/70 px-2.5 py-2 text-[9px] text-accent transition-all duration-150 ease-tac hover:bg-accent hover:text-void hover:shadow-glow active:scale-[0.97]"
      >
        ⟲ AUTO-RESTORE
      </button>
    </div>
  )
}
