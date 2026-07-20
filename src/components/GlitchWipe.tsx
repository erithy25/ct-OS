import { useEffect, useState } from 'react'

/**
 * One-shot "signal glitch" wipe rendered over the center stage on module
 * switch: a stack of horizontal slices that shear briefly with chromatic
 * fringes, then vanish. Re-triggers whenever `trigger` changes.
 */
export default function GlitchWipe({ trigger }: { trigger: string }) {
  const [slices, setSlices] = useState<{ top: number; h: number; gx: number; hue: boolean }[] | null>(null)

  useEffect(() => {
    const n = 7
    const out: { top: number; h: number; gx: number; hue: boolean }[] = []
    let top = 0
    for (let i = 0; i < n; i++) {
      const h = 100 / n
      out.push({ top, h, gx: (Math.random() - 0.5) * 22, hue: Math.random() > 0.5 })
      top += h
    }
    setSlices(out)
    const t = setTimeout(() => setSlices(null), 180)
    return () => clearTimeout(t)
  }, [trigger])

  if (!slices) return null
  return (
    <div className="pointer-events-none absolute inset-0 z-40 overflow-hidden" aria-hidden>
      {slices.map((s, i) => (
        <div
          key={i}
          className="absolute inset-x-0"
          style={{
            top: `${s.top}%`,
            height: `${s.h}%`,
            background: 'rgba(10, 14, 20, 0.55)',
            boxShadow: s.hue ? 'inset 2px 0 0 rgba(34,211,238,0.5)' : 'inset -2px 0 0 rgba(255,59,71,0.4)',
            animation: `glitch-slice 0.16s steps(3) forwards`,
            ['--gx' as string]: `${s.gx}px`,
          }}
        />
      ))}
    </div>
  )
}
