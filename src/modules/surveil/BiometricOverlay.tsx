/**
 * BIOMETRIC mode DOM theater for CAM-01 — status tags, the RESOLVING
 * IDENTITY candidate cycler, and the ■ SIMULATED MATCH side panel.
 *
 * Every identity shown here is procedurally generated fiction
 * (identityFactory) and is labeled SOURCE: SIMULATED.
 */
import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import Gauge from '../../components/Gauge'
import { useSim } from '../../sim/store'
import { getDossier } from '../../sim/identityFactory'
import type { Dossier } from '../../sim/types'
import { uiClick } from '../../lib/audio'
import type { ModelStatus } from './webcamCV'

export type BioPhase = 'scan' | 'sweep' | 'resolve' | 'match'

export interface BioMatch {
  id: string
  /** 82–94, one decimal shown */
  pct: number
  dossier: Dossier
}

interface BiometricOverlayProps {
  phase: BioPhase
  faceStatus: ModelStatus
  faceSeen: boolean
  candidates: string[]
  match: BioMatch | null
  compact: boolean
  onExit: () => void
}

export default function BiometricOverlay({ phase, faceStatus, faceSeen, candidates, match, compact, onExit }: BiometricOverlayProps) {
  return (
    <div className="absolute inset-0 z-10">
      {/* mode tag */}
      <div className="pointer-events-none absolute left-1/2 top-2 -translate-x-1/2">
        <span className="lbl led-pulse border border-violet/70 bg-void/85 px-2 py-0.5 text-violet">
          {faceStatus === 'loading'
            ? '◇ BIOMETRIC — CORE SYNCING'
            : phase === 'match'
              ? '◇ BIOMETRIC — LOCK'
              : faceSeen
                ? '◇ BIOMETRIC — SUBJECT ACQUIRED'
                : '◇ BIOMETRIC — ALIGN SUBJECT'}
        </span>
      </div>

      {faceStatus === 'loading' && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <span className="lbl sv-shimmer border border-violet/50 bg-void/80 px-3 py-1 text-violet">
            LOADING FACE LANDMARK MODEL…
          </span>
        </div>
      )}

      {phase === 'resolve' && <ResolveCycler candidates={candidates} />}

      <AnimatePresence>
        {phase === 'match' && match && <MatchPanel key={match.id} match={match} compact={compact} onExit={onExit} />}
      </AnimatePresence>

      {/* exit is always reachable while in biometric mode */}
      {phase !== 'match' && (
        <button
          className="lbl absolute bottom-2 right-2 border border-line bg-void/80 px-1.5 py-0.5 text-dim transition-colors duration-150 ease-tac hover:border-lineb hover:text-prim"
          onClick={(e) => {
            e.stopPropagation()
            onExit()
          }}
        >
          ✕ EXIT BIOMETRIC
        </button>
      )}
    </div>
  )
}

/* ── RESOLVING IDENTITY… fast candidate cycling ────────────────────── */

function ResolveCycler({ candidates }: { candidates: string[] }) {
  const [idx, setIdx] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setIdx((i) => i + 1), 72)
    return () => clearInterval(id)
  }, [])
  const pid = candidates.length > 0 ? candidates[idx % candidates.length] : null
  const name = pid ? getDossier(pid).name : '·········'

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-[18%] flex flex-col items-center gap-1">
      <span className="lbl border border-accent/50 bg-void/85 px-2 py-0.5 text-accent">RESOLVING IDENTITY…</span>
      <span className="num bg-void/85 px-2 py-0.5 font-grotesk text-[14px] uppercase tracking-[0.14em] text-prim/90">
        {name}
      </span>
      <span className="lbl-faint">CROSS-REFERENCING SYNTHETIC REGISTRY · {candidates.length} CANDIDATES</span>
    </div>
  )
}

/* ── ■ SIMULATED MATCH side panel ──────────────────────────────────── */

function MatchPanel({ match, compact, onExit }: { match: BioMatch; compact: boolean; onExit: () => void }) {
  const select = useSim((s) => s.select)
  const d = match.dossier

  return (
    <motion.aside
      className={`panel-surface-2 absolute bottom-2 right-2 top-9 flex flex-col overflow-hidden border-violet/50 ${
        compact ? 'w-[62%] min-w-[210px]' : 'w-[280px]'
      }`}
      initial={{ x: 42, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: 42, opacity: 0 }}
      transition={{ duration: 0.18, ease: [0.2, 0.8, 0.2, 1] }}
      onClick={(e) => e.stopPropagation()}
    >
      <header className="flex h-6 shrink-0 items-center gap-2 border-b border-violet/40 bg-violet/10 px-2">
        <span className="text-[10px] text-violet">■</span>
        <span className="lbl flex-1 text-violet">SIMULATED MATCH</span>
        <span className="lbl-faint">PROVISIONAL</span>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="lbl-faint">SUBJECT</div>
            <div className="truncate font-grotesk text-[15px] font-medium leading-5 text-prim">{d.name}</div>
            <div className="num mt-0.5 text-2xs text-dim">
              {match.id} · ALIAS {d.alias}
            </div>
          </div>
          <Gauge value={d.risk} size={46} label="RISK" />
        </div>

        <div className="num mt-2 flex items-baseline gap-2 border-t border-line pt-2">
          <span className="lbl-faint">MATCH</span>
          <span className="text-[17px] font-medium text-violet">{match.pct.toFixed(1)}%</span>
          <span className="lbl-faint ml-auto">RECORD: PROVISIONAL</span>
        </div>
        <div className="mt-1 h-0.5 w-full bg-line">
          <div className="h-full bg-violet" style={{ width: `${match.pct}%`, boxShadow: '0 0 8px rgba(139,92,246,0.5)' }} />
        </div>

        <div className="mt-2 grid grid-cols-2 gap-x-2 gap-y-1.5">
          <MiniField k="STATUS" v={d.status} color={d.status === 'FLAGGED' ? 'var(--accent-red)' : d.status === 'WATCH' ? 'var(--accent-amber)' : 'var(--accent-green)'} />
          <MiniField k="LAST SEEN" v={d.lastSeenSector} />
        </div>

        {d.flags.length > 0 && (
          <div className="mt-2">
            <div className="lbl-faint mb-1">FLAGS</div>
            <div className="flex flex-wrap gap-1">
              {d.flags.slice(0, 2).map((f) => (
                <span key={f} className="lbl border border-amber/50 px-1 py-px text-amber">
                  {f}
                </span>
              ))}
            </div>
          </div>
        )}

        <div className="mt-2 flex flex-wrap gap-1">
          <span className="lbl border border-violet/60 px-1 py-px text-violet">SOURCE: SIMULATED</span>
        </div>
        <div className="lbl-faint mt-1.5 leading-4 opacity-70">SYNTHETIC RECORD — NO REAL BIOMETRIC DATABASE</div>
      </div>

      <div className="flex shrink-0 gap-1.5 border-t border-line p-1.5">
        <button
          className="lbl flex-1 border border-line px-1.5 py-1 text-dim transition-colors duration-150 ease-tac hover:border-accent hover:text-accent"
          onClick={() => {
            uiClick()
            select(match.id)
          }}
        >
          OPEN DOSSIER
        </button>
        <button
          className="lbl flex-1 border border-line px-1.5 py-1 text-dim transition-colors duration-150 ease-tac hover:border-lineb hover:text-prim"
          onClick={onExit}
        >
          EXIT BIOMETRIC
        </button>
      </div>
    </motion.aside>
  )
}

function MiniField({ k, v, color }: { k: string; v: string; color?: string }) {
  return (
    <div className="min-w-0">
      <div className="lbl-faint">{k}</div>
      <div className="num truncate text-[11px]" style={{ color: color ?? 'var(--text-primary)' }}>
        {v}
      </div>
    </div>
  )
}
