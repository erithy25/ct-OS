import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { startHome, useHome } from './store'
import { startDetection } from './cv/scheduler'
import { startZoneWatch } from './zones/zoneWatch'
import { startFaceWatch } from './people/faceWatch'
import type { HomeView } from './types'
import { HomeIntel, HomeLeftRail, HomeTicker, HomeTopBar } from './shell/HomeShell'
import HomeBoot from './HomeBoot'
import ComingSoon from './modules/ComingSoon'
import Scanlines from '../components/Scanlines'
import GlitchWipe from '../components/GlitchWipe'
import { uiSwitch } from '../lib/audio'

const LiveWall = lazy(() => import('./modules/LiveWall'))
const People = lazy(() => import('./people/People'))
const Zones = lazy(() => import('./zones/Zones'))
const Activity = lazy(() => import('./modules/Activity'))
const Alerts = lazy(() => import('./modules/Alerts'))

const VIEW_KEYS: Record<string, HomeView> = { '1': 'wall', '2': 'people', '3': 'zones', '4': 'activity', '5': 'alerts' }

function CenterStage({ view }: { view: HomeView }) {
  switch (view) {
    case 'wall':
      return <LiveWall />
    case 'people':
      return <People />
    case 'zones':
      return <Zones />
    case 'activity':
      return <Activity />
    case 'alerts':
      return <Alerts />
  }
}

export default function HomeApp() {
  const booted = useHome((s) => s.booted)
  const view = useHome((s) => s.view)

  useEffect(() => {
    startHome()
    startDetection()
    startZoneWatch()
    startFaceWatch()
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const st = useHome.getState()
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        st.setTerminalOpen(!st.terminalOpen)
        return
      }
      const target = e.target as HTMLElement | null
      const typing = !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      if (e.key === 'Escape') {
        if (st.terminalOpen) st.setTerminalOpen(false)
        else if (st.expandedId) st.setExpanded(null)
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
            <HomeBoot onDone={() => useHome.getState().setBooted(true)} />
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
          <HomeTopBar />
        </div>
        <HomeLeftRail />
        <main className="relative min-h-0 min-w-0 overflow-hidden bg-void">
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.div key={view} className="absolute inset-0" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.14, ease: [0.2, 0.8, 0.2, 1] }}>
              <Suspense fallback={<ComingSoon title="LOADING" note="LINKING MODULE" />}>
                <CenterStage view={view} />
              </Suspense>
            </motion.div>
          </AnimatePresence>
          <GlitchWipe trigger={view} />
          <CommandPalette />
        </main>
        <HomeIntel />
        <div className="col-span-3">
          <HomeTicker />
        </div>
      </motion.div>
    </div>
  )
}

/* ── minimal ⌘K command palette (add/goto/remove) ──────────────────── */

function CommandPalette() {
  const open = useHome((s) => s.terminalOpen)
  const setOpen = useHome((s) => s.setTerminalOpen)
  const [lines, setLines] = useState<string[]>([])
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) inputRef.current?.focus()
    else setLines([])
  }, [open])

  if (!open) return null

  const run = async (raw: string) => {
    const s = useHome.getState()
    const [cmd, ...rest] = raw.trim().split(/\s+/)
    const arg = rest.join(' ')
    switch (cmd) {
      case 'add':
        if (!arg) return 'ERR: add <url|test>'
        setLines((l) => [...l, `› ${raw}`, 'CONNECTING…'])
        {
          const r = await s.addCamera({ url: arg })
          return r.ok ? `CAMERA ADDED` : `ERR: ${r.error}`
        }
      case 'remove':
        if (!arg) return 'ERR: remove <CAM-ID>'
        await s.removeCamera(arg)
        return `REMOVED ${arg}`
      case 'goto': {
        const v = arg as HomeView
        if (['wall', 'people', 'zones', 'activity', 'alerts'].includes(v)) {
          s.setView(v)
          setTimeout(() => setOpen(false), 250)
          return `→ ${v.toUpperCase()}`
        }
        return `ERR: unknown view '${arg}'`
      }
      case 'help':
        return 'COMMANDS: add <url|test> · remove <CAM-ID> · goto wall|people|zones|activity|alerts'
      default:
        return `ERR: unknown '${cmd}' — try help`
    }
  }

  return (
    <div className="absolute inset-0 z-50 flex items-start justify-center bg-void/70 pt-[12vh]" onClick={() => setOpen(false)}>
      <div className="panel-surface-2 w-[600px] max-w-[90%] border-lineb shadow-glow" onClick={(e) => e.stopPropagation()}>
        <div className="flex h-6 items-center justify-between border-b border-line px-2">
          <span className="lbl text-accent">HOMEWATCH COMMAND</span>
          <span className="lbl-faint">ESC TO CLOSE</span>
        </div>
        <div className="num max-h-44 overflow-y-auto px-2 py-1 text-[11px] leading-5">
          {lines.map((l, i) => (
            <div key={i} className={l.startsWith('ERR') ? 'text-red' : l.startsWith('›') ? 'text-dim' : 'text-accent'}>{l}</div>
          ))}
        </div>
        <form
          className="flex items-center gap-1.5 px-2 py-1.5"
          onSubmit={async (e) => {
            e.preventDefault()
            const v = inputRef.current?.value.trim()
            if (!v) return
            if (inputRef.current) inputRef.current.value = ''
            const out = await run(v)
            if (out) setLines((l) => [...l.slice(-8), `› ${v}`, out])
          }}
        >
          <span className="text-accent">›</span>
          <input ref={inputRef} className="num flex-1 bg-transparent text-[12px] text-prim outline-none" spellCheck={false} autoComplete="off" placeholder="add rtsp://…   ·   goto wall   ·   help" />
        </form>
      </div>
    </div>
  )
}
