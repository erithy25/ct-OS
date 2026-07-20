import { useEffect, useRef } from 'react'

/**
 * Animated ⌐ ¬ corner ticks. Bump `pulseKey` to flash them cyan
 * (used when a panel's data updates).
 */
export default function CornerBrackets({ pulseKey = 0, size = 8, className = '' }: { pulseKey?: number; size?: number; className?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const first = useRef(true)

  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    const el = ref.current
    if (!el) return
    for (const c of Array.from(el.children) as HTMLElement[]) {
      c.classList.remove('bracket-pulse')
      void c.offsetWidth
      c.classList.add('bracket-pulse')
    }
  }, [pulseKey])

  const s = `${size}px`
  const base = 'absolute border-lineb pointer-events-none'
  return (
    <div ref={ref} className={`absolute inset-0 pointer-events-none ${className}`} aria-hidden>
      <span className={`${base} left-0 top-0 border-l border-t`} style={{ width: s, height: s }} />
      <span className={`${base} right-0 top-0 border-r border-t`} style={{ width: s, height: s }} />
      <span className={`${base} left-0 bottom-0 border-l border-b`} style={{ width: s, height: s }} />
      <span className={`${base} right-0 bottom-0 border-r border-b`} style={{ width: s, height: s }} />
    </div>
  )
}
