/**
 * TACTICAL MAP — the centerpiece module. A stylized top-down live view of
 * NOVA HARBOR on a single HTML canvas.
 *
 * Rendering contract: one rAF loop reads the mutable world singleton
 * imperatively (never through React state), interpolates prevPos↔pos with a
 * tick-wall alpha, and draws void → water → districts → blocks → roads →
 * landmarks → bridges → night veil → labels → overlays → FOV cones →
 * entities → selection chrome. Reactive store bits (overlays, infra,
 * selection, focus requests) are read via useSim.getState() inside the loop
 * and via hooks for the DOM chrome.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import CornerBrackets from '../../components/CornerBrackets'
import { uiClick } from '../../lib/audio'
import { fmtCoord, fmtTick } from '../../lib/format'
import { findEntity, getWorld, useSim } from '../../sim/store'
import type { Overlays, SimEntity } from '../../sim/types'
import { getMapCamera, type MapCamera } from './camera'
import { COL } from './colors'
import { drawCity, drawMapLabels, getCityCache } from './cityRender'
import { drawChrome, drawEntities, getEntityCaches } from './entityRender'
import MapTooltip, { buildTooltip, type TooltipData } from './MapTooltip'
import Minimap from './Minimap'
import { drawFovCones, drawOfflineCameras } from './overlays/fov'
import { drawHeatmap } from './overlays/heatmap'
import { drawPowerOverlay } from './overlays/power'
import { drawTraffic } from './overlays/traffic'
import { drawUnitCoverage } from './overlays/units'

const OVERLAY_DEFS: { k: keyof Overlays; label: string; color: string; glow: string }[] = [
  { k: 'heatmap', label: 'HEATMAP', color: 'var(--accent-violet)', glow: 'rgba(139,92,246,0.30)' },
  { k: 'traffic', label: 'TRAFFIC', color: 'var(--accent-amber)', glow: 'rgba(245,166,35,0.25)' },
  { k: 'power', label: 'POWER', color: 'var(--accent-red)', glow: 'rgba(255,59,71,0.25)' },
  { k: 'fov', label: 'FOV', color: 'var(--accent)', glow: 'rgba(34,211,238,0.30)' },
  { k: 'units', label: 'UNITS', color: 'var(--accent-green)', glow: 'rgba(52,211,153,0.25)' },
]

/** hit radii (screen px) per entity kind — bigger glyphs are easier to grab */
const HIT_R_PERSON = 8
const HIT_R_WATCHLISTED = 10
const HIT_R_VEHICLE = 8
const HIT_R_PATROL = 12
const HIT_R_INCIDENT = 14
const HIT_R_CAMERA = 10

/** focusRequest.n values already handled — survives view switches */
let lastHandledFocusN = 0

interface Counts {
  p: number
  v: number
  u: number
  i: number
}

export default function TacticalMap() {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const tipWrapRef = useRef<HTMLDivElement>(null)
  const coordRef = useRef<HTMLSpanElement>(null)
  const zoomRef = useRef<HTMLSpanElement>(null)
  const tickRef = useRef<HTMLSpanElement>(null)

  const world = getWorld()
  const camRef = useRef<MapCamera | null>(null)
  if (camRef.current === null) camRef.current = getMapCamera(world.city.size.x, world.city.size.y)
  const cam = camRef.current

  const [hover, setHover] = useState<TooltipData | null>(null)
  const [follow, setFollow] = useState(false)
  const followRef = useRef(false)
  const [counts, setCounts] = useState<Counts>({ p: 0, v: 0, u: 0, i: 0 })

  const overlays = useSim((s) => s.overlays)
  const toggleOverlay = useSim((s) => s.toggleOverlay)
  const trackedIds = useSim((s) => s.trackedIds)
  const focusRequest = useSim((s) => s.focusRequest)

  const breakFollow = useCallback(() => {
    followRef.current = false
    setFollow(false)
  }, [])

  /* fly-to on focusRequest (locate() already selected the entity) */
  useEffect(() => {
    if (!focusRequest || focusRequest.n === lastHandledFocusN) return
    lastHandledFocusN = focusRequest.n
    const e = findEntity(focusRequest.id)
    if (!e) return
    breakFollow()
    cam.flyToEntity(focusRequest.id, e.pos.x, e.pos.y, Math.max(cam.zoom, 2.6), performance.now())
  }, [focusRequest, cam, breakFollow])

  /* follow needs a live tracked target */
  useEffect(() => {
    if (trackedIds.length === 0 && followRef.current) breakFollow()
  }, [trackedIds, breakFollow])

  /* ── canvas lifecycle: rAF loop, listeners, observers ──────────────── */
  useEffect(() => {
    const container = containerRef.current
    const canvas = canvasRef.current
    if (!container || !canvas) return
    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) return

    const cache = getCityCache(world.city)
    const ec = getEntityCaches(world)

    let dpr = Math.max(1, window.devicePixelRatio || 1)
    const resize = (): void => {
      const r = container.getBoundingClientRect()
      const w = Math.max(1, Math.round(r.width))
      const h = Math.max(1, Math.round(r.height))
      dpr = Math.max(1, window.devicePixelRatio || 1)
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
      cam.setViewport(w, h)
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(container)

    /* interaction state (closure locals — no React) */
    let pointerDown = false
    let dragging = false
    let downX = 0
    let downY = 0
    let lastPX = 0
    let lastPY = 0
    let lastMx = -1
    let lastMy = -1
    let pointerInside = false
    let lastHitT = 0
    let hoveredEnt: SimEntity | null = null

    /* interpolation clock */
    let lastTick = world.tick
    let tickWall = performance.now()
    let lastAlpha = 1
    let lastFrame = performance.now()
    let frameNo = 0
    let shownZoom = -1
    let shownTick = -1

    const positionTip = (mx: number, my: number): void => {
      const tip = tipWrapRef.current
      if (!tip) return
      let px = mx + 16
      let py = my + 14
      if (px > cam.viewW - 196) px = mx - 194
      if (py > cam.viewH - 150) py = my - 132
      tip.style.transform = `translate(${px}px, ${py}px)`
    }

    const clearHover = (): void => {
      if (hoveredEnt !== null) {
        hoveredEnt = null
        setHover(null)
      }
      const tip = tipWrapRef.current
      if (tip) tip.style.transform = 'translate(-9999px, -9999px)'
    }

    const hitTest = (mx: number, my: number): SimEntity | null => {
      const s = useSim.getState()
      const sc = cam.scale
      const ox = cam.viewW / 2 - cam.cx * sc
      const oy = cam.viewH / 2 - cam.cy * sc
      let best: SimEntity | null = null
      let bestScore = 1 // normalized d²/r² must beat 1
      const consider = (e: SimEntity, r: number): void => {
        const x = (e.prevPos.x + (e.pos.x - e.prevPos.x) * lastAlpha) * sc + ox
        const y = (e.prevPos.y + (e.pos.y - e.prevPos.y) * lastAlpha) * sc + oy
        const dx = x - mx
        const dy = y - my
        const score = (dx * dx + dy * dy) / (r * r)
        if (score < bestScore) {
          bestScore = score
          best = e
        }
      }
      for (const inc of world.incidents) consider(inc, HIT_R_INCIDENT)
      for (const u of world.patrols) consider(u, HIT_R_PATROL)
      for (const p of world.persons) consider(p, p.watchlisted ? HIT_R_WATCHLISTED : HIT_R_PERSON)
      for (const v of world.vehicles) consider(v, HIT_R_VEHICLE)
      for (const c of world.cameras) {
        if (s.overlays.fov || !c.online) consider(c, HIT_R_CAMERA)
      }
      return best
    }

    const refreshHover = (): void => {
      if (lastMx < 0) return
      const hit = hitTest(lastMx, lastMy)
      const prevId = hoveredEnt ? hoveredEnt.id : null
      hoveredEnt = hit
      const nextId = hit ? hit.id : null
      if (nextId !== prevId) setHover(hit ? buildTooltip(hit) : null)
      if (hit) positionTip(lastMx, lastMy)
      else {
        const tip = tipWrapRef.current
        if (tip) tip.style.transform = 'translate(-9999px, -9999px)'
      }
    }

    const onPointerDown = (e: PointerEvent): void => {
      if (e.button !== 0) return
      pointerDown = true
      dragging = false
      downX = lastPX = e.clientX
      downY = lastPY = e.clientY
      canvas.setPointerCapture(e.pointerId)
    }

    const onPointerMove = (e: PointerEvent): void => {
      const r = canvas.getBoundingClientRect()
      const mx = e.clientX - r.left
      const my = e.clientY - r.top
      lastMx = mx
      lastMy = my
      pointerInside = true
      const el = coordRef.current
      if (el) el.textContent = fmtCoord(cam.wx(mx), cam.wy(my))
      if (pointerDown) {
        if (!dragging && Math.abs(e.clientX - downX) + Math.abs(e.clientY - downY) > 4) {
          dragging = true
          breakFollow()
          clearHover()
        }
        if (dragging) cam.panBy(e.clientX - lastPX, e.clientY - lastPY)
      } else {
        const now = performance.now()
        if (now - lastHitT > 40) {
          lastHitT = now
          refreshHover()
        } else if (hoveredEnt) {
          positionTip(mx, my)
        }
      }
      lastPX = e.clientX
      lastPY = e.clientY
    }

    const onPointerUp = (e: PointerEvent): void => {
      if (!pointerDown) return
      pointerDown = false
      if (!dragging) {
        const r = canvas.getBoundingClientRect()
        const hit = hitTest(e.clientX - r.left, e.clientY - r.top)
        useSim.getState().select(hit ? hit.id : null)
        if (hit) uiClick()
      }
      dragging = false
    }

    const onPointerLeave = (): void => {
      pointerInside = false
      lastMx = -1
      lastMy = -1
      clearHover()
      const el = coordRef.current
      if (el) el.textContent = '— —'
    }

    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      const r = canvas.getBoundingClientRect()
      cam.zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0014))
    }

    canvas.addEventListener('pointerdown', onPointerDown)
    canvas.addEventListener('pointermove', onPointerMove)
    canvas.addEventListener('pointerup', onPointerUp)
    canvas.addEventListener('pointercancel', onPointerUp)
    canvas.addEventListener('pointerleave', onPointerLeave)
    canvas.addEventListener('wheel', onWheel, { passive: false })

    /* slow chrome refresh: entity counts (≤2 Hz) + live tooltip fields */
    const slowTimer = window.setInterval(() => {
      let veh = 0
      for (const v of world.vehicles) if (v.parked !== true) veh++
      let inc = 0
      for (const it of world.incidents) if (it.phase !== 'RESOLVED') inc++
      setCounts({ p: world.persons.length, v: veh, u: world.patrols.length, i: inc })
      if (hoveredEnt) {
        const e = findEntity(hoveredEnt.id)
        if (!e) clearHover()
        else {
          hoveredEnt = e
          setHover(buildTooltip(e))
        }
      }
    }, 500)

    /* ── the draw loop ─────────────────────────────────────────────── */
    let raf = 0
    const frame = (): void => {
      raf = requestAnimationFrame(frame)
      const now = performance.now()
      const dt = Math.min(64, now - lastFrame)
      lastFrame = now
      frameNo++

      if ((window.devicePixelRatio || 1) !== dpr) resize()

      /* interpolation alpha off the 10 Hz tick clock */
      if (world.tick !== lastTick) {
        lastTick = world.tick
        tickWall = now
      }
      lastAlpha = Math.min(1, (now - tickWall) / 100)

      const s = useSim.getState()

      /* camera: follow → fly retarget → animate */
      if (followRef.current) {
        const tid = s.trackedIds[0]
        if (tid !== undefined) {
          const e = findEntity(tid)
          if (e) {
            cam.followTowards(
              e.prevPos.x + (e.pos.x - e.prevPos.x) * lastAlpha,
              e.prevPos.y + (e.pos.y - e.prevPos.y) * lastAlpha,
              dt,
            )
          }
        }
      }
      if (cam.isFlying && cam.flyTargetId !== null) {
        const e = findEntity(cam.flyTargetId)
        if (e) cam.retargetFly(e.pos.x, e.pos.y)
      }
      cam.update(now)

      /* paint */
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.fillStyle = COL.void
      ctx.fillRect(0, 0, cam.viewW, cam.viewH)

      drawCity(ctx, cam, world, s.infra, cache, now)

      /* day/night veil — dims the physical city, not the instruments */
      ctx.fillStyle = cache.veil
      ctx.fillRect(0, 0, cam.viewW, cam.viewH)

      drawMapLabels(ctx, cam, world, s.infra, cache, now)

      if (s.overlays.heatmap) drawHeatmap(ctx, cam, world, s.hotspots, cache, now)
      if (s.overlays.traffic) drawTraffic(ctx, cam, world, cache)
      if (s.overlays.power) drawPowerOverlay(ctx, cam, world, s.infra, cache, now)
      if (s.overlays.units) drawUnitCoverage(ctx, cam, world, lastAlpha)

      drawOfflineCameras(ctx, cam, world, now)
      if (s.overlays.fov) drawFovCones(ctx, cam, world, now)

      drawEntities(ctx, cam, world, lastAlpha, now, ec)

      const selEnt = s.selectedId !== null ? findEntity(s.selectedId) : undefined
      drawChrome(ctx, cam, lastAlpha, now, selEnt, hoveredEnt ?? undefined)

      /* keep hover honest while entities move under a resting cursor */
      if (!dragging && pointerInside && (frameNo & 15) === 0) refreshHover()

      /* imperative HUD text (no React churn) */
      const zPct = Math.round(cam.zoom * 100)
      if (zPct !== shownZoom && zoomRef.current) {
        shownZoom = zPct
        zoomRef.current.textContent = `${zPct}%`
      }
      if (world.tick !== shownTick && world.tick % 10 === 0 && tickRef.current) {
        shownTick = world.tick
        tickRef.current.textContent = fmtTick(world.tick)
      }
    }
    raf = requestAnimationFrame(frame)

    return () => {
      cancelAnimationFrame(raf)
      window.clearInterval(slowTimer)
      ro.disconnect()
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('pointerup', onPointerUp)
      canvas.removeEventListener('pointercancel', onPointerUp)
      canvas.removeEventListener('pointerleave', onPointerLeave)
      canvas.removeEventListener('wheel', onWheel)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const onMinimapMove = useCallback(() => {
    breakFollow()
    cam.cancelFly()
  }, [breakFollow, cam])

  return (
    <div ref={containerRef} className="absolute inset-0 select-none overflow-hidden bg-void">
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full cursor-crosshair" />

      {/* overlay toggle chips */}
      <div className="absolute left-2 top-2 z-20 flex flex-col gap-1">
        <div className="lbl-faint px-0.5">OVERLAYS</div>
        {OVERLAY_DEFS.map((def) => {
          const on = overlays[def.k]
          return (
            <button
              key={def.k}
              onClick={() => {
                toggleOverlay(def.k)
                uiClick()
              }}
              className={`lbl flex w-[96px] items-center gap-1.5 border px-1.5 py-0.5 text-left transition-colors duration-150 ease-tac ${
                on ? 'bg-panel/85' : 'border-line bg-panel/60 text-faint hover:border-lineb hover:text-dim'
              }`}
              style={on ? { borderColor: def.color, color: def.color, boxShadow: `0 0 10px ${def.glow}` } : undefined}
            >
              <span
                className="inline-block h-1 w-1 shrink-0"
                style={{ background: on ? def.color : 'var(--line-bright)' }}
              />
              {def.label}
            </button>
          )
        })}
      </div>

      {/* live status + follow */}
      <div className="absolute right-2 top-2 z-20 flex flex-col items-end gap-1">
        <div className="flex items-center gap-1.5 border border-line bg-panel/85 px-1.5 py-0.5">
          <span className="led-pulse h-1.5 w-1.5 rounded-full bg-accent shadow-glow" />
          <span className="lbl text-accent">LIVE</span>
          <span ref={tickRef} className="num lbl-faint">
            #000000
          </span>
        </div>
        {trackedIds.length > 0 && (
          <button
            onClick={() => {
              const next = !followRef.current
              followRef.current = next
              setFollow(next)
              if (next) cam.cancelFly()
              uiClick()
            }}
            className={`lbl border px-1.5 py-0.5 transition-colors duration-150 ease-tac ${
              follow
                ? 'border-accent bg-accent/10 text-accent shadow-glow'
                : 'border-line bg-panel/60 text-dim hover:border-lineb hover:text-prim'
            }`}
          >
            {follow ? '◉ FOLLOW' : '○ FOLLOW'} {trackedIds[0]}
          </button>
        )}
      </div>

      {/* status strip */}
      <div className="pointer-events-none absolute bottom-2 left-2 z-20 flex items-center gap-3 border border-line bg-panel/85 px-2 py-1">
        <span className="lbl-faint">NOVA HARBOR // GRID REF</span>
        <span ref={coordRef} className="num min-w-[136px] text-2xs text-prim/80">
          — —
        </span>
        <span className="lbl-faint">ZOOM</span>
        <span ref={zoomRef} className="num text-2xs text-accent">
          100%
        </span>
        <span className="lbl-faint">TRACKS</span>
        <span className="num text-2xs text-dim">
          P {counts.p} · V {counts.v} · U {counts.u} ·{' '}
          <span className={counts.i > 0 ? 'text-red' : ''}>I {counts.i}</span>
        </span>
      </div>

      {/* minimap */}
      <div className="absolute bottom-2 right-2 z-20 border border-line bg-panel/85 p-1">
        <Minimap camera={cam} city={world.city} onManualMove={onMinimapMove} />
      </div>

      {/* hover tooltip — wrapper transform is set imperatively per pointermove;
          it must never appear in the style prop or React re-renders would reset it */}
      <div ref={tipWrapRef} className="pointer-events-none absolute left-0 top-0 z-30 will-change-transform">
        {hover && <MapTooltip data={hover} />}
      </div>

      {/* HUD frame */}
      <CornerBrackets size={10} className="z-30" />
    </div>
  )
}
