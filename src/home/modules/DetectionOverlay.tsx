import { useEffect, useRef, type RefObject } from 'react'
import { getDetections } from '../store'
import { registerSource } from '../cv/scheduler'
import type { DetClass } from '../types'
import type { DetectSource } from '../cv/detector'

const CLASS_COLOR: Record<DetClass, string> = {
  person: '#22D3EE',
  vehicle: '#F5A623',
  animal: '#34D399',
  package: '#8B5CF6',
  other: '#6B7C8F',
}

type Media = HTMLVideoElement | HTMLImageElement

function naturalSize(el: Media): { w: number; h: number } {
  if (el instanceof HTMLVideoElement) return { w: el.videoWidth, h: el.videoHeight }
  return { w: el.naturalWidth, h: el.naturalHeight }
}

/**
 * Draws the latest detection boxes over a tile. Registers the tile's media
 * element with the scheduler and paints boxes each frame, correcting for the
 * `object-cover` crop so boxes line up with what's on screen.
 */
export default function DetectionOverlay({ cameraId, mediaRef, mirror = false }: { cameraId: string; mediaRef: RefObject<Media | null>; mirror?: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const getter = (): DetectSource | null => {
      const el = mediaRef.current
      if (!el) return null
      const { w, h } = naturalSize(el)
      if (!w || !h) return null
      return { el, w, h }
    }
    const unregister = registerSource(cameraId, getter)
    return unregister
  }, [cameraId, mediaRef])

  useEffect(() => {
    let raf = 0
    const draw = () => {
      raf = requestAnimationFrame(draw)
      const canvas = canvasRef.current
      const media = mediaRef.current
      if (!canvas || !media) return
      const rect = canvas.getBoundingClientRect()
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      const cw = Math.round(rect.width)
      const ch = Math.round(rect.height)
      if (cw === 0 || ch === 0) return
      if (canvas.width !== cw * dpr) {
        canvas.width = cw * dpr
        canvas.height = ch * dpr
      }
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, cw, ch)

      const dets = getDetections(cameraId)
      if (dets.length === 0) return

      const { w: sw, h: sh } = naturalSize(media)
      if (!sw || !sh) return
      // object-cover transform: source → display
      const scale = Math.max(cw / sw, ch / sh)
      const ox = (sw * scale - cw) / 2
      const oy = (sh * scale - ch) / 2

      for (const d of dets) {
        let x = d.box[0] * sw * scale - ox
        const y = d.box[1] * sh * scale - oy
        const w = d.box[2] * sw * scale
        const h = d.box[3] * sh * scale
        if (mirror) x = cw - x - w
        const color = d.personId ? '#34D399' : CLASS_COLOR[d.cls]
        drawBracketBox(ctx, x, y, w, h, color)
        const label = d.personId ? d.personId : `${d.label} ${(d.score * 100) | 0}%`
        drawLabel(ctx, x, y, label, color)
      }
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [cameraId, mediaRef, mirror])

  return <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden />
}

function drawBracketBox(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string): void {
  const c = Math.min(14, w * 0.28, h * 0.28)
  ctx.strokeStyle = color
  ctx.lineWidth = 1.5
  ctx.globalAlpha = 0.9
  // four corner brackets
  ctx.beginPath()
  ctx.moveTo(x, y + c); ctx.lineTo(x, y); ctx.lineTo(x + c, y)
  ctx.moveTo(x + w - c, y); ctx.lineTo(x + w, y); ctx.lineTo(x + w, y + c)
  ctx.moveTo(x + w, y + h - c); ctx.lineTo(x + w, y + h); ctx.lineTo(x + w - c, y + h)
  ctx.moveTo(x + c, y + h); ctx.lineTo(x, y + h); ctx.lineTo(x, y + h - c)
  ctx.stroke()
  ctx.globalAlpha = 0.06
  ctx.fillStyle = color
  ctx.fillRect(x, y, w, h)
  ctx.globalAlpha = 1
}

function drawLabel(ctx: CanvasRenderingContext2D, x: number, y: number, text: string, color: string): void {
  ctx.font = '600 10px "JetBrains Mono", monospace'
  const pad = 3
  const tw = ctx.measureText(text).width
  const ly = y - 14 < 0 ? y + 2 : y - 14
  ctx.fillStyle = 'rgba(5,7,10,0.85)'
  ctx.fillRect(x, ly, tw + pad * 2, 13)
  ctx.fillStyle = color
  ctx.fillText(text, x + pad, ly + 9.5)
}
