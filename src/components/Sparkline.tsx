import { useEffect, useRef } from 'react'

interface SparklineProps {
  /** imperative getter — the array is read fresh on every version bump */
  data: () => number[]
  /** subscribe key; redraw when it changes */
  version: number
  width?: number
  height?: number
  color?: string
  fill?: boolean
  min?: number
  max?: number
  className?: string
}

/** Tiny canvas sparkline. Never allocates in the draw path. */
export default function Sparkline({
  data,
  version,
  width = 64,
  height = 18,
  color = '#22D3EE',
  fill = true,
  min,
  max,
  className = '',
}: SparklineProps) {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const cvs = ref.current
    if (!cvs) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    if (cvs.width !== width * dpr) {
      cvs.width = width * dpr
      cvs.height = height * dpr
    }
    const ctx = cvs.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, width, height)

    const arr = data()
    if (arr.length < 2) return
    let lo = min ?? Infinity
    let hi = max ?? -Infinity
    if (min === undefined || max === undefined) {
      for (const v of arr) {
        if (v < lo) lo = v
        if (v > hi) hi = v
      }
    }
    if (hi - lo < 1e-6) {
      lo -= 1
      hi += 1
    }
    const px = (i: number) => (i / (arr.length - 1)) * (width - 2) + 1
    const py = (v: number) => height - 2 - ((v - lo) / (hi - lo)) * (height - 4)

    if (fill) {
      ctx.beginPath()
      ctx.moveTo(px(0), height)
      for (let i = 0; i < arr.length; i++) ctx.lineTo(px(i), py(arr[i]))
      ctx.lineTo(px(arr.length - 1), height)
      ctx.closePath()
      ctx.fillStyle = color
      ctx.globalAlpha = 0.08
      ctx.fill()
      ctx.globalAlpha = 1
    }

    ctx.beginPath()
    for (let i = 0; i < arr.length; i++) {
      const x = px(i)
      const y = py(arr[i])
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.strokeStyle = color
    ctx.lineWidth = 1
    ctx.stroke()

    // last-point dot
    const lx = px(arr.length - 1)
    const ly = py(arr[arr.length - 1])
    ctx.beginPath()
    ctx.arc(lx, ly, 1.5, 0, Math.PI * 2)
    ctx.fillStyle = color
    ctx.fill()
  }, [version, data, width, height, color, fill, min, max])

  return <canvas ref={ref} style={{ width, height }} className={className} aria-hidden />
}
