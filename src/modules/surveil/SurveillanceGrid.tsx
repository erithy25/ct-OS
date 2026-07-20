/**
 * SURVEILLANCE GRID — center-stage module.
 *
 * CAM-01 is the operator's real webcam (processed 100% locally); every other
 * tile is a procedurally simulated feed bound to a world camera entity, so
 * sector blackouts from the Infrastructure module black out the matching
 * tiles. One rAF loop drives every visible tile; tiles not rendered (grid
 * collapsed behind an expanded tile) are skipped entirely.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { getWorld, useSim } from '../../sim/store'
import type { Camera } from '../../sim/types'
import { uiClick } from '../../lib/audio'
import SimCamTile, { type TickFn, type TickRegister } from './CamTile'
import Cam01Tile from './Cam01Tile'
import './surveil.css'

/** last ⌘K `scan biometric` request this module has honored (survives remounts) */
let handledBioRequest = 0

export default function SurveillanceGrid() {
  const [nine, setNine] = useState(false)
  const [biometric, setBiometric] = useState(false)
  const expandedCam = useSim((s) => s.expandedCam)
  const camerasOnline = useSim((s) => s.camerasOnline)
  const camerasTotal = useSim((s) => s.camerasTotal)
  const cvOnline = useSim((s) => s.cvOnline)
  const biometricRequest = useSim((s) => s.biometricRequest)

  /* ── single rAF loop driving every visible tile ── */
  const ticksRef = useRef(new Map<string, TickFn>())
  const register = useCallback<TickRegister>((id, fn) => {
    if (fn) ticksRef.current.set(id, fn)
    else ticksRef.current.delete(id)
  }, [])

  useEffect(() => {
    let raf = 0
    const loop = (t: number) => {
      for (const fn of ticksRef.current.values()) fn(t)
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [])

  /* ── ⌘K `scan biometric` → auto-start biometric on CAM-01 ── */
  useEffect(() => {
    if (biometricRequest > 0 && biometricRequest !== handledBioRequest) {
      handledBioRequest = biometricRequest
      setBiometric(true)
      useSim.getState().setExpandedCam('CAM-01')
    }
  }, [biometricRequest])

  /* manual biometric toggle also focuses CAM-01 — the sequence needs stage room */
  const toggleBiometric = useCallback((on: boolean) => {
    setBiometric(on)
    if (on) useSim.getState().setExpandedCam('CAM-01')
  }, [])

  const world = getWorld()
  const simCams: Camera[] = world.cameras.slice(0, nine ? 8 : 3)
  const expandedSim: Camera | undefined =
    expandedCam && expandedCam !== 'CAM-01' ? world.cameras.find((c) => c.id === expandedCam) : undefined
  const showExpanded = expandedCam === 'CAM-01' || expandedSim !== undefined

  return (
    <div className="flex h-full min-h-0 flex-col gap-1.5 p-1.5">
      {/* ── toolbar ── */}
      <div className="flex h-7 shrink-0 items-center gap-3 border-b border-line px-1 pb-1.5">
        <span className="led-pulse inline-block h-1.5 w-1.5 rounded-full bg-accent shadow-glow" />
        <span className="lbl text-prim/80">SURVEILLANCE GRID</span>
        <span className="num lbl-faint">
          MESH {camerasOnline + 1}/{camerasTotal + 1}
        </span>
        <span className={`lbl border px-1 py-px ${cvOnline ? 'border-accent/60 text-accent' : 'border-line text-faint'}`}>
          {cvOnline ? 'CV LINK ACTIVE' : 'CV STANDBY'}
        </span>
        {biometric && <span className="lbl led-pulse border border-violet/60 px-1 py-px text-violet">BIOMETRIC</span>}
        <div className="flex-1" />
        <div className="flex gap-1">
          <LayoutBtn active={!nine} onClick={() => setNine(false)}>
            ▦ 2×2
          </LayoutBtn>
          <LayoutBtn active={nine} onClick={() => setNine(true)}>
            ▩ 3×3
          </LayoutBtn>
        </div>
      </div>

      {/* ── stage ── */}
      <div className="relative min-h-0 flex-1">
        {showExpanded ? (
          <motion.div
            key={expandedCam ?? 'stage'}
            className="absolute inset-0"
            initial={{ opacity: 0, scale: 0.985 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.16, ease: [0.2, 0.8, 0.2, 1] }}
          >
            {expandedCam === 'CAM-01' ? (
              <div className="h-full [&>section]:h-full">
                <Cam01Tile expanded biometric={biometric} onToggleBiometric={toggleBiometric} register={register} />
              </div>
            ) : (
              expandedSim && (
                <div className="h-full [&>section]:h-full">
                  <SimCamTile cam={expandedSim} expanded register={register} />
                </div>
              )
            )}
          </motion.div>
        ) : (
          <div className={`grid h-full gap-1.5 ${nine ? 'grid-cols-3 grid-rows-3' : 'grid-cols-2 grid-rows-2'}`}>
            <Cam01Tile expanded={false} biometric={biometric} onToggleBiometric={toggleBiometric} register={register} />
            {simCams.map((cam) => (
              <SimCamTile key={cam.id} cam={cam} expanded={false} register={register} />
            ))}
          </div>
        )}
      </div>

      {/* ── honesty strip ── */}
      <div className="flex h-4 shrink-0 items-center justify-between px-1">
        <span className="lbl-faint">CAM-01: OPERATOR OPTIC — ALL FRAMES PROCESSED LOCALLY · NEVER TRANSMITTED</span>
        <span className="lbl-faint">CAM-02+ FEEDS: SYNTHETIC RENDER // NOVA HARBOR SIM</span>
      </div>
    </div>
  )
}

function LayoutBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      className={`lbl border px-1.5 py-0.5 transition-colors duration-150 ease-tac ${
        active ? 'border-accent bg-accent/10 text-accent shadow-glow' : 'border-line text-dim hover:border-lineb hover:text-prim'
      }`}
      onClick={() => {
        onClick()
        uiClick()
      }}
    >
      {children}
    </button>
  )
}
