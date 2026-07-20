import { useState, type ReactNode } from 'react'
import CornerBrackets from './CornerBrackets'

interface PanelProps {
  title: string
  children: ReactNode
  right?: ReactNode
  className?: string
  bodyClassName?: string
  collapsible?: boolean
  defaultOpen?: boolean
  /** show a pulsing LED in the header */
  live?: boolean
  ledColor?: string
  /** bump to flash the corner brackets on data update */
  pulseKey?: number
  brackets?: boolean
}

export default function Panel({
  title,
  children,
  right,
  className = '',
  bodyClassName = '',
  collapsible = false,
  defaultOpen = true,
  live = false,
  ledColor = 'var(--accent)',
  pulseKey = 0,
  brackets = false,
}: PanelProps) {
  const [open, setOpen] = useState(defaultOpen)

  return (
    <section className={`panel-surface relative flex min-h-0 flex-col ${className}`}>
      {brackets && <CornerBrackets pulseKey={pulseKey} />}
      <header
        className={`flex h-6 shrink-0 items-center gap-2 border-b border-line px-2 ${collapsible ? 'cursor-pointer select-none' : ''}`}
        onClick={collapsible ? () => setOpen((o) => !o) : undefined}
      >
        {live && (
          <span
            className="led-pulse inline-block h-1.5 w-1.5 rounded-full"
            style={{ background: ledColor, boxShadow: `0 0 6px ${ledColor}` }}
          />
        )}
        <h2 className="lbl flex-1 truncate text-prim/80">{title}</h2>
        {right}
        {collapsible && (
          <span className="lbl-faint w-3 text-center" aria-hidden>
            {open ? '▾' : '▸'}
          </span>
        )}
      </header>
      {(!collapsible || open) && <div className={`min-h-0 flex-1 ${bodyClassName}`}>{children}</div>}
    </section>
  )
}
