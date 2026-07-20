interface GaugeProps {
  /** 0..100 */
  value: number
  size?: number
  label?: string
  /** override the value→color mapping */
  color?: string
  className?: string
}

const riskColor = (v: number): string =>
  v >= 70 ? 'var(--accent-red)' : v >= 45 ? 'var(--accent-amber)' : 'var(--accent-green)'

/** Radial 270° gauge for risk scores / integrity. */
export default function Gauge({ value, size = 72, label, color, className = '' }: GaugeProps) {
  const v = Math.max(0, Math.min(100, value))
  const c = color ?? riskColor(v)
  const r = size / 2 - 5
  const circ = 2 * Math.PI * r
  const arc = circ * 0.75
  const filled = arc * (v / 100)

  return (
    <div className={`relative inline-flex items-center justify-center ${className}`} style={{ width: size, height: size }}>
      <svg width={size} height={size} className="rotate-[135deg]">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--line)"
          strokeWidth={3}
          strokeDasharray={`${arc} ${circ}`}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={c}
          strokeWidth={3}
          strokeDasharray={`${filled} ${circ}`}
          style={{ transition: 'stroke-dasharray 0.4s var(--ease-tac), stroke 0.4s var(--ease-tac)', filter: `drop-shadow(0 0 4px ${c})` }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="num text-[16px] font-medium leading-none" style={{ color: c }}>
          {Math.round(v)}
        </span>
        {label && <span className="lbl-faint mt-0.5 text-[8px]">{label}</span>}
      </div>
    </div>
  )
}
