import { useEffect, useRef, useState } from 'react'

interface StatReadoutProps {
  label: string
  value: string
  /** flash the value background when it changes (throttled) */
  flash?: boolean
  color?: string
  className?: string
}

/** Label-over-value readout with a throttled cyan data-update flash. */
export default function StatReadout({ label, value, flash = true, color, className = '' }: StatReadoutProps) {
  const [flashing, setFlashing] = useState(false)
  const last = useRef(value)
  const lastFlash = useRef(0)

  useEffect(() => {
    if (!flash || value === last.current) return
    last.current = value
    const now = performance.now()
    if (now - lastFlash.current < 900) return
    lastFlash.current = now
    setFlashing(true)
    const t = setTimeout(() => setFlashing(false), 430)
    return () => clearTimeout(t)
  }, [value, flash])

  return (
    <div className={className}>
      <div className="lbl-faint">{label}</div>
      <div
        className={`num px-0.5 text-[13px] leading-4 ${flashing ? 'flash-cyan' : ''}`}
        style={{ color: color ?? 'var(--text-primary)' }}
      >
        {value}
      </div>
    </div>
  )
}
