/**
 * Minimap — whole-city overwatch (~180×112). Static base (water, majors,
 * district bounds, block mass) is pre-rendered once; the live pass adds the
 * viewport rectangle, active incident dots and tracked-person dots.
 * Click / drag re-centers the main viewport.
 */
import { useEffect, useRef } from 'react'
import { TAU } from '../../lib/geometry'
import { getWorld } from '../../sim/store'
import type { City } from '../../sim/types'
import type { MapCamera } from './camera'
import { renderMinimapBase } from './cityRender'
import { A_ACCENT, A_RED, aIdx } from './colors'

export const MINIMAP_W = 180
export const MINIMAP_H = 112

interface MinimapProps {
  camera: MapCamera
  city: City
  /** called when the operator moves the viewport via the minimap */
  onManualMove: () => void
}

export default function Minimap({ camera, city, onManualMove }: MinimapProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const dpr = Math.max(1, window.devicePixelRatio || 1)
    canvas.width = Math.round(MINIMAP_W * dpr)
    canvas.height = Math.round(MINIMAP_H * dpr)
    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) return

    const base = renderMinimapBase(city, MINIMAP_W, MINIMAP_H, dpr)
    const s = Math.min(MINIMAP_W / city.size.x, MINIMAP_H / city.size.y)
    const ox = (MINIMAP_W - city.size.x * s) / 2
    const oy = (MINIMAP_H - city.size.y * s) / 2

    let raf = 0
    const draw = () => {
      raf = requestAnimationFrame(draw)
      const now = performance.now()
      const world = getWorld()
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.drawImage(base, 0, 0, MINIMAP_W, MINIMAP_H)

      /* viewport rectangle + focus dim outside it */
      const rx = camera.wx(0) * s + ox
      const ry = camera.wy(0) * s + oy
      const rw = (camera.wx(camera.viewW) - camera.wx(0)) * s
      const rh = (camera.wy(camera.viewH) - camera.wy(0)) * s
      ctx.fillStyle = 'rgba(3,5,9,0.42)'
      ctx.fillRect(0, 0, MINIMAP_W, Math.max(0, ry))
      ctx.fillRect(0, ry + rh, MINIMAP_W, Math.max(0, MINIMAP_H - ry - rh))
      ctx.fillRect(0, ry, Math.max(0, rx), rh)
      ctx.fillRect(rx + rw, ry, Math.max(0, MINIMAP_W - rx - rw), rh)
      ctx.strokeStyle = A_ACCENT[aIdx(0.85)]
      ctx.lineWidth = 1
      ctx.strokeRect(rx, ry, rw, rh)

      /* active incidents */
      const blink = 0.55 + 0.4 * Math.sin(now * 0.008)
      ctx.fillStyle = A_RED[aIdx(blink)]
      for (let i = 0; i < world.incidents.length; i++) {
        const inc = world.incidents[i]
        if (inc.phase === 'RESOLVED') continue
        ctx.beginPath()
        ctx.arc(inc.pos.x * s + ox, inc.pos.y * s + oy, 1.8, 0, TAU)
        ctx.fill()
      }

      /* tracked persons */
      ctx.fillStyle = A_ACCENT[aIdx(0.95)]
      for (let i = 0; i < world.persons.length; i++) {
        const p = world.persons[i]
        if (!p.tracked) continue
        ctx.beginPath()
        ctx.arc(p.pos.x * s + ox, p.pos.y * s + oy, 1.6, 0, TAU)
        ctx.fill()
      }
    }
    raf = requestAnimationFrame(draw)

    /* click / drag → move viewport */
    let dragging = false
    const moveTo = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect()
      const wx = (e.clientX - r.left - ox) / s
      const wy = (e.clientY - r.top - oy) / s
      onManualMove()
      camera.centerOn(wx, wy)
    }
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return
      dragging = true
      canvas.setPointerCapture(e.pointerId)
      moveTo(e)
    }
    const onMove = (e: PointerEvent) => {
      if (dragging) moveTo(e)
    }
    const onUp = () => {
      dragging = false
    }
    canvas.addEventListener('pointerdown', onDown)
    canvas.addEventListener('pointermove', onMove)
    canvas.addEventListener('pointerup', onUp)
    canvas.addEventListener('pointercancel', onUp)

    return () => {
      cancelAnimationFrame(raf)
      canvas.removeEventListener('pointerdown', onDown)
      canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('pointerup', onUp)
      canvas.removeEventListener('pointercancel', onUp)
    }
  }, [camera, city, onManualMove])

  return (
    <canvas
      ref={canvasRef}
      className="block cursor-pointer"
      style={{ width: MINIMAP_W, height: MINIMAP_H }}
      aria-label="minimap"
    />
  )
}
