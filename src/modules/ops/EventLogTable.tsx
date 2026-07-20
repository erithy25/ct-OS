import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import Panel from '../../components/Panel'
import { getEvents, SECTORS, useSim } from '../../sim/store'
import type { EventChannel, Severity, SimEvent } from '../../sim/types'
import { fmtSimClock } from '../../lib/format'

const ROW_H = 22
const OVERSCAN = 8

const SEVERITIES: Severity[] = ['INFO', 'NOTICE', 'WARN', 'CRIT']
const CHANNELS: EventChannel[] = ['SYSTEM', 'INCIDENT', 'DETECTION', 'INFRA', 'UNIT', 'COMMAND', 'CV', 'PREDICT']

const SEV_COLOR: Record<Severity, string> = {
  INFO: 'var(--text-dim)',
  NOTICE: 'var(--accent)',
  WARN: 'var(--accent-amber)',
  CRIT: 'var(--accent-red)',
}

const GRID = 'grid grid-cols-[64px_56px_74px_44px_74px_minmax(0,1fr)] items-center gap-1.5 px-2'

/**
 * Full-width live event log. Newest-first, hand-rolled window virtualization
 * (fixed 22px rows, visible slice + overscan between two spacer divs), filter
 * bar (severity chips / channel / sector / free text), sticks to top only when
 * already at top — otherwise scroll position is compensated, never yanked.
 */
export default function EventLogTable({ className = '' }: { className?: string }) {
  const eventsVersion = useSim((s) => s.eventsVersion)
  const select = useSim((s) => s.select)

  const [sevOn, setSevOn] = useState<Record<Severity, boolean>>({ INFO: true, NOTICE: true, WARN: true, CRIT: true })
  const [channel, setChannel] = useState<'ALL' | EventChannel>('ALL')
  const [sector, setSector] = useState<'ALL' | string>('ALL')
  const [query, setQuery] = useState('')

  const scrollRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewH, setViewH] = useState(320)

  const all = getEvents()
  const total = all.length
  const newestId = total > 0 ? all[total - 1].id : -1

  /* newest-first filtered view */
  const filtered = useMemo(() => {
    const src = getEvents()
    const q = query.trim().toUpperCase()
    const out: SimEvent[] = []
    for (let i = src.length - 1; i >= 0; i--) {
      const e = src[i]
      if (!sevOn[e.severity]) continue
      if (channel !== 'ALL' && e.channel !== channel) continue
      if (sector !== 'ALL' && e.sector !== sector) continue
      if (q && !(e.message.toUpperCase().includes(q) || (e.entityId?.toUpperCase().includes(q) ?? false))) continue
      out.push(e)
    }
    return out
    // eventsVersion is the deliberate subscribe key for the mutable ring buffer
  }, [eventsVersion, sevOn, channel, sector, query])

  /* viewport height tracking */
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    setViewH(el.clientHeight)
    const ro = new ResizeObserver(() => setViewH(el.clientHeight))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  /* stick-to-top / scroll compensation */
  const filterKey = `${SEVERITIES.filter((s) => sevOn[s]).join('.')}|${channel}|${sector}|${query}`
  const prevFilterKey = useRef(filterKey)
  const prevTopId = useRef<number | null>(null)

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const topId = filtered.length > 0 ? filtered[0].id : null
    if (prevFilterKey.current !== filterKey) {
      // filter changed → jump to top of the new result set
      prevFilterKey.current = filterKey
      prevTopId.current = topId
      el.scrollTop = 0
      setScrollTop(0)
      return
    }
    const pid = prevTopId.current
    prevTopId.current = topId
    if (pid === null || el.scrollTop < ROW_H) return // at top → stick (newest rows appear in place)
    // ids are monotonically increasing, newest first: count fresh rows above the old top
    let fresh = 0
    while (fresh < filtered.length && filtered[fresh].id > pid) fresh++
    if (fresh > 0) {
      el.scrollTop += fresh * ROW_H
      setScrollTop(el.scrollTop)
    }
  }, [filtered, filterKey])

  /* windowing */
  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN)
  const end = Math.min(filtered.length, Math.ceil((scrollTop + viewH) / ROW_H) + OVERSCAN)
  const slice = filtered.slice(start, end)

  const toggleSev = (sv: Severity) => setSevOn((s) => ({ ...s, [sv]: !s[sv] }))

  return (
    <Panel
      title="EVENT LOG // ALL CHANNELS"
      live
      pulseKey={eventsVersion}
      brackets
      className={`min-h-0 ${className}`}
      bodyClassName="flex min-h-0 flex-col"
      right={<span className="num lbl-faint shrink-0">RING CAP 500</span>}
    >
      {/* filter bar */}
      <div className="flex h-7 shrink-0 items-center gap-1 border-b border-line px-1.5">
        {SEVERITIES.map((sv) => {
          const on = sevOn[sv]
          return (
            <button
              key={sv}
              type="button"
              onClick={() => toggleSev(sv)}
              className={`lbl border px-1 py-px transition-colors duration-150 ease-tac ${
                on ? 'bg-panel2' : 'border-line text-faint hover:text-dim'
              }`}
              style={on ? { borderColor: SEV_COLOR[sv], color: SEV_COLOR[sv] } : undefined}
              title={`TOGGLE ${sv}`}
            >
              {sv}
            </button>
          )
        })}
        <span className="mx-0.5 h-3.5 w-px shrink-0 bg-line" aria-hidden />
        <select
          value={channel}
          onChange={(ev) => setChannel(ev.target.value as 'ALL' | EventChannel)}
          className="lbl h-[18px] border border-line bg-panel2 px-0.5 text-dim outline-none focus:border-accent/60"
          style={{ colorScheme: 'dark' }}
          title="CHANNEL FILTER"
        >
          <option value="ALL">CH: ALL</option>
          {CHANNELS.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <select
          value={sector}
          onChange={(ev) => setSector(ev.target.value)}
          className="lbl h-[18px] border border-line bg-panel2 px-0.5 text-dim outline-none focus:border-accent/60"
          style={{ colorScheme: 'dark' }}
          title="SECTOR FILTER"
        >
          <option value="ALL">SEC: ALL</option>
          {SECTORS.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <input
          value={query}
          onChange={(ev) => setQuery(ev.target.value)}
          placeholder="SEARCH MSG / ENTITY"
          spellCheck={false}
          className="num h-[18px] w-44 border border-line bg-panel2 px-1.5 text-[10px] uppercase tracking-lbl text-prim outline-none transition-colors duration-150 ease-tac placeholder:text-faint focus:border-accent/60"
        />
        <span className="num lbl-faint ml-auto shrink-0">
          {filtered.length}/{total} EVT
        </span>
      </div>

      {/* column header */}
      <div className={`${GRID} h-[18px] shrink-0 border-b border-line bg-panel2/60`}>
        <span className="lbl-faint">TIME</span>
        <span className="lbl-faint">SEV</span>
        <span className="lbl-faint">CHANNEL</span>
        <span className="lbl-faint">SECTOR</span>
        <span className="lbl-faint">ENTITY</span>
        <span className="lbl-faint">MESSAGE</span>
      </div>

      {/* virtualized body */}
      <div
        ref={scrollRef}
        onScroll={(ev) => setScrollTop(ev.currentTarget.scrollTop)}
        className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden"
      >
        <div style={{ height: start * ROW_H }} aria-hidden />
        {slice.map((e) => (
          <EventRow key={e.id} e={e} newest={e.id === newestId} onSelect={select} />
        ))}
        <div style={{ height: (filtered.length - end) * ROW_H }} aria-hidden />
        {filtered.length === 0 && <div className="lbl-faint px-2 py-4 text-center">NO EVENTS MATCH FILTER</div>}
      </div>
    </Panel>
  )
}

function EventRow({ e, newest, onSelect }: { e: SimEvent; newest: boolean; onSelect: (id: string) => void }) {
  const c = SEV_COLOR[e.severity]
  const eid = e.entityId
  const clickable = eid !== undefined
  return (
    <div
      className={`${GRID} h-[22px] border-b border-line/50 transition-colors duration-150 ease-tac ${
        clickable ? 'cursor-pointer hover:bg-panel2' : 'hover:bg-panel2/40'
      } ${newest ? 'rise-in' : ''}`}
      onClick={eid !== undefined ? () => onSelect(eid) : undefined}
    >
      <span className="num text-[10px] text-dim">{fmtSimClock(e.simMinutes)}</span>
      <span className="min-w-0">
        <span className="lbl border px-1 py-px" style={{ borderColor: c, color: c }}>
          {e.severity}
        </span>
      </span>
      <span className="lbl truncate">{e.channel}</span>
      <span className="num text-[10px] text-dim">{e.sector ? e.sector.replace('SECTOR-', 'S-') : '—'}</span>
      <span className={`num truncate text-[10px] ${clickable ? 'text-accent/80' : 'text-faint'}`}>{e.entityId ?? '—'}</span>
      <span className="num truncate text-[11px] text-prim/85">{e.message}</span>
    </div>
  )
}
