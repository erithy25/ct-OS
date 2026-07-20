import { lazy, Suspense, useEffect } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import TopBar from './shell/TopBar'
import LeftRail from './shell/LeftRail'
import IntelColumn from './shell/IntelColumn'
import BottomTicker from './shell/BottomTicker'
import BootSequence from './shell/BootSequence'
import ModuleStub from './shell/ModuleStub'
import Scanlines from './components/Scanlines'
import GlitchWipe from './components/GlitchWipe'
import CommandTerminal from './command/CommandTerminal'
import { getEvents, startSimLoop, useSim } from './sim/store'
import type { ViewId } from './sim/types'
import { alertTone, uiSwitch } from './lib/audio'

const VIEW_KEYS: Record<string, ViewId> = { '1': 'map', '2': 'grid', '3': 'graph', '4': 'infra', '5': 'ops' }

const TacticalMap = lazy(() => import('./modules/map/TacticalMap'))
const OpsDeck = lazy(() => import('./modules/ops/OpsDeck'))
const InfrastructureControl = lazy(() => import('./modules/infra/InfrastructureControl'))
const RelationshipGraph = lazy(() => import('./modules/graph/RelationshipGraph'))
const SurveillanceGrid = lazy(() => import('./modules/surveil/SurveillanceGrid'))

function CenterStage({ view }: { view: ViewId }) {
  switch (view) {
    case 'map':
      return <TacticalMap />
    case 'grid':
      return <SurveillanceGrid />
    case 'graph':
      return <RelationshipGraph />
    case 'infra':
      return <InfrastructureControl />
    case 'ops':
      return <OpsDeck />
  }
}

export default function App() {
  const booted = useSim((s) => s.booted)
  const view = useSim((s) => s.view)

  useEffect(() => {
    startSimLoop()
  }, [])

  // audible ping on critical events, throttled
  useEffect(() => {
    let lastSeen = 0
    let lastTone = 0
    return useSim.subscribe((s, prev) => {
      if (s.eventsVersion === prev.eventsVersion) return
      const ev = getEvents()
      const newest = ev[ev.length - 1]
      if (!newest || newest.id <= lastSeen) return
      lastSeen = newest.id
      const now = performance.now()
      if (newest.severity === 'CRIT' && now - lastTone > 4000) {
        lastTone = now
        alertTone(true)
      }
    })
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const st = useSim.getState()
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        st.setTerminalOpen(!st.terminalOpen)
        return
      }
      const target = e.target as HTMLElement | null
      const typing = !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      if (e.key === 'Escape') {
        if (st.terminalOpen) st.setTerminalOpen(false)
        else if (st.expandedCam) st.setExpandedCam(null)
        else st.select(null)
        return
      }
      if (typing) return
      const v = VIEW_KEYS[e.key]
      if (v && st.booted) {
        st.setView(v)
        uiSwitch()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="h-full min-w-[1280px] font-mono text-prim">
      <Scanlines />

      <AnimatePresence>
        {!booted && (
          <motion.div key="boot" exit={{ opacity: 0 }} transition={{ duration: 0.45, ease: [0.2, 0.8, 0.2, 1] }}>
            <BootSequence onDone={() => useSim.getState().setBooted(true)} />
          </motion.div>
        )}
      </AnimatePresence>

      <motion.div
        className="grid h-full grid-cols-[188px_minmax(0,1fr)_324px] grid-rows-[44px_minmax(0,1fr)_28px]"
        initial={false}
        animate={{ opacity: booted ? 1 : 0 }}
        transition={{ duration: 0.4, ease: [0.2, 0.8, 0.2, 1] }}
      >
        <div className="col-span-3">
          <TopBar />
        </div>

        <LeftRail />

        <main className="relative min-h-0 min-w-0 overflow-hidden bg-void">
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.div
              key={view}
              className="absolute inset-0"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.14, ease: [0.2, 0.8, 0.2, 1] }}
            >
              <Suspense fallback={<ModuleStub title="LINKING" note="LOADING SUBSYSTEM MODULE" />}>
                <CenterStage view={view} />
              </Suspense>
            </motion.div>
          </AnimatePresence>
          <GlitchWipe trigger={view} />
          <CommandTerminal />
        </main>

        <IntelColumn />

        <div className="col-span-3">
          <BottomTicker />
        </div>
      </motion.div>
    </div>
  )
}
