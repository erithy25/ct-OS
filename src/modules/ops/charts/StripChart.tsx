import { useEffect, useRef } from 'react'
import CornerBrackets from '../../../components/CornerBrackets'

interface StripChartProps {
  title: string
  /** imperative getter — the ring buffer is read fresh on every version bump */
  data: () => number[]
  /** subscribe key; redraw when it changes */
  version: number
  /** stroke/fill/value color (concrete hex — canvas can't resolve CSS vars) */
  color: string
  /** fixed scale overrides (otherwise auto-fit to data) */
  min?: number
  max?: number
  format?: (v: number) => string
  className?: string
}

const PAD_TOP = 26
const PAD_BOTTOM = 6
const PAD_X = 4
/** Δ readout compares latest sample vs this many samples back (~15s at 2 Hz) */
const DELTA_LOOKBACK = 30

const defaultFmt = (v: number): string => v.toFixed(0)

/**
 * Dense small-multiple strip chart: 1px line + 8% area fill + last-value dot,
 * 3 faint gridlines, faint min/max scale labels, big tabular current value and
 * a tiny Δ-vs-30-samples-ago arrow. DPR-aware canvas; redraws are driven by
 * the `version` prop (no internal timers) plus a single ResizeObserver.
 */
export default function StripChart({
  title,
  data,
  version,
  color,
  min,
  max,
  format = defaultFmt,
  className = '',
}: StripChartProps) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const cvsRef = useRef<HTMLCanvasElement>(null)

  // version bump re-renders; reading the mutable singleton here is the house idiom
  const arr = data()
  const last = arr.length > 0 ? arr[arr.length - 1] : undefined
  const base = arr.length > DELTA_LOOKBACK ? arr[arr.length - 1 - DELTA_LOOKBACK] : undefined

  let delta = 'Δ —'
  if (last !== undefined && base !== undefined) {
    const d = last - base
    delta = `${d > 0 ? '▲' : d < 0 ? '▼' : '·'} ${format(Math.abs(d))}`
  }

  /* latest-props draw closure, re-created each render, called via ref */
  const draw = () => {
    const wrap = wrapRef.current
    const cvs = cvsRef.current
    if (!wrap || !cvs) return
    const ctx = cvs.getContext('2d')
    if (!ctx) return

    const w = wrap.clientWidth
    const h = wrap.clientHeight
    if (w < 10 || h < 10) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const pw = Math.round(w * dpr)
    const ph = Math.round(h * dpr)
    if (cvs.width !== pw || cvs.height !== ph) {
      cvs.width = pw
      cvs.height = ph
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)

    const series = data()

    let lo = min ?? Infinity
    let hi = max ?? -Infinity
    if (min === undefined || max === undefined) {
      for (const v of series) {
        if (v < lo) lo = v
        if (v > hi) hi = v
      }
    }
    if (series.length === 0) {
      lo = min ?? 0
      hi = max ?? 1
    }
    if (!(hi - lo > 1e-6)) {
      lo -= 1
      hi += 1
    }

    const plotW = w - PAD_X * 2
    const plotH = h - PAD_TOP - PAD_BOTTOM
    const px = (i: number) => PAD_X + (series.length > 1 ? (i / (series.length - 1)) * plotW : plotW)
    const py = (v: number) => {
      const t = Math.max(0, Math.min(1, (v - lo) / (hi - lo)))
      return PAD_TOP + (1 - t) * plotH
    }

    // 3 faint horizontal gridlines
    ctx.strokeStyle = 'rgba(38, 56, 74, 0.45)'
    ctx.lineWidth = 1
    for (let g = 1; g <= 3; g++) {
      const y = Math.round(PAD_TOP + (plotH * g) / 4) + 0.5
      ctx.beginPath()
      ctx.moveTo(PAD_X, y)
      ctx.lineTo(w - PAD_X, y)
      ctx.stroke()
    }

    // faint min/max scale labels (behind the data)
    ctx.font = '8px "JetBrains Mono", ui-monospace, monospace'
    ctx.fillStyle = 'rgba(58, 71, 86, 0.95)'
    ctx.textBaseline = 'top'
    ctx.fillText(format(hi), PAD_X + 1, PAD_TOP + 1)
    ctx.textBaseline = 'bottom'
    ctx.fillText(format(lo), PAD_X + 1, h - PAD_BOTTOM + 1)

    if (series.length < 2) return

    // 8% area fill
    ctx.beginPath()
    ctx.moveTo(px(0), PAD_TOP + plotH)
    for (let i = 0; i < series.length; i++) ctx.lineTo(px(i), py(series[i]))
    ctx.lineTo(px(series.length - 1), PAD_TOP + plotH)
    ctx.closePath()
    ctx.fillStyle = color
    ctx.globalAlpha = 0.08
    ctx.fill()
    ctx.globalAlpha = 1

    // 1px line
    ctx.beginPath()
    for (let i = 0; i < series.length; i++) {
      const x = px(i)
      const y = py(series[i])
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.strokeStyle = color
    ctx.lineWidth = 1
    ctx.stroke()

    // last-value dot (the live datum gets the glow)
    ctx.beginPath()
    ctx.arc(px(series.length - 1), py(series[series.length - 1]), 1.8, 0, Math.PI * 2)
    ctx.fillStyle = color
    ctx.shadowColor = color
    ctx.shadowBlur = 5
    ctx.fill()
    ctx.shadowBlur = 0
  }

  const drawRef = useRef(draw)
  drawRef.current = draw

  /* redraw on data version / prop changes */
  useEffect(() => {
    drawRef.current()
  }, [version, data, color, min, max, format])

  /* one observer for the component lifetime; redraw on tile resize */
  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return
    const ro = new ResizeObserver(() => drawRef.current())
    ro.observe(wrap)
    return () => ro.disconnect()
  }, [])

  return (
    <div ref={wrapRef} className={`panel-surface relative min-w-0 overflow-hidden ${className}`}>
      <canvas ref={cvsRef} className="absolute inset-0 h-full w-full" aria-hidden />
      <CornerBrackets />
      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-1 px-1.5 pt-1">
        <span className="lbl min-w-0 truncate">{title}</span>
        <span className="flex shrink-0 flex-col items-end">
          <span className="num text-[15px] font-medium leading-4" style={{ color }}>
            {last === undefined ? '—' : format(last)}
          </span>
          <span className="num text-[9px] leading-3 text-dim">{delta}</span>
        </span>
      </div>
    </div>
  )
}
