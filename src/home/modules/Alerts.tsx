/**
 * PANOPTICON // HOMEWATCH — ALERTS.
 *
 * The alert center: a big home-posture header, prominent cards for recent
 * WARN / CRIT events (with snapshot thumbnails and a local ACKNOWLEDGE
 * affordance), an honest read-only RULES panel whose status chips reflect actual
 * store state, and a browser-notification flow (permission request, test, and a
 * de-duped push for genuinely new WARN / CRIT events).
 *
 * Nothing here fabricates controls: where a rule has no backend toggle it is
 * shown as a status indicator, not a fake switch.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import Panel from '../../components/Panel'
import CornerBrackets from '../../components/CornerBrackets'
import { getHomeEvents, useHome } from '../store'
import type { HomeEvent, HomeSeverity, HomeStatus } from '../types'
import { fmtLocal } from '../../lib/format'

/* ── palette ───────────────────────────────────────────────────────── */

const STATUS_STYLE: Record<HomeStatus, { color: string; glow: string }> = {
  SECURE: { color: 'var(--accent-green)', glow: '0 0 10px rgba(52,211,153,0.35)' },
  MONITOR: { color: 'var(--accent)', glow: 'var(--glow-accent)' },
  ELEVATED: { color: 'var(--accent-amber)', glow: '0 0 10px rgba(245,166,35,0.4)' },
  ALERT: { color: 'var(--accent-red)', glow: '0 0 12px rgba(255,59,71,0.55)' },
}

const SEV_COLOR: Record<HomeSeverity, string> = {
  INFO: 'var(--text-dim)',
  NOTICE: 'var(--accent)',
  WARN: 'var(--accent-amber)',
  CRIT: 'var(--accent-red)',
}

const ALERT_CAP = 60

const isAlertSev = (e: HomeEvent): boolean => e.severity === 'WARN' || e.severity === 'CRIT'

/* ── module ────────────────────────────────────────────────────────── */

export default function Alerts() {
  const eventsVersion = useHome((s) => s.eventsVersion)
  const homeStatus = useHome((s) => s.homeStatus)
  const select = useHome((s) => s.select)

  const [acked, setAcked] = useState<Set<number>>(() => new Set())
  const [hideAcked, setHideAcked] = useState(false)

  // slow clock: keeps the night-window rule + relative readouts fresh
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 15000)
    return () => clearInterval(id)
  }, [])

  // notification permission is owned here so the push effect can read it
  const notifySupported = typeof Notification !== 'undefined'
  const [perm, setPerm] = useState<NotificationPermission>(() => (notifySupported ? Notification.permission : 'denied'))

  const alerts = useMemo(() => {
    const src = getHomeEvents()
    const out: HomeEvent[] = []
    for (let i = src.length - 1; i >= 0 && out.length < ALERT_CAP; i--) {
      if (isAlertSev(src[i])) out.push(src[i])
    }
    return out
    // eventsVersion is the deliberate subscribe key for the mutable ring buffer
  }, [eventsVersion])

  const activeCount = useMemo(() => alerts.filter((a) => !acked.has(a.id)).length, [alerts, acked])
  const newestId = alerts.length > 0 ? alerts[0].id : -1

  /* ── push new WARN/CRIT while granted; dedupe by id; ignore backlog ── */
  const lastSeenRef = useRef<number | null>(null)
  useEffect(() => {
    const evs = getHomeEvents()
    const newest = evs.length > 0 ? evs[evs.length - 1].id : 0
    if (lastSeenRef.current === null) {
      lastSeenRef.current = newest // baseline at mount → never notify the backlog
      return
    }
    if (perm === 'granted' && typeof Notification !== 'undefined') {
      const fresh: HomeEvent[] = []
      for (let i = evs.length - 1; i >= 0; i--) {
        if (evs[i].id <= lastSeenRef.current) break
        if (isAlertSev(evs[i])) fresh.push(evs[i])
      }
      for (const e of fresh.slice(0, 3)) {
        try {
          new Notification('HOMEWATCH', { body: `${e.severity} · ${e.kind} · ${e.message}`, tag: `homewatch-${e.id}` })
        } catch {
          /* browser refused (gesture / platform limits) — non-fatal */
        }
      }
    }
    lastSeenRef.current = newest
  }, [eventsVersion, perm])

  const ackOne = (id: number) => setAcked((s) => new Set(s).add(id))
  const ackAll = () => setAcked((s) => new Set([...s, ...alerts.map((a) => a.id)]))

  const visible = hideAcked ? alerts.filter((a) => !acked.has(a.id)) : alerts

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-2">
      <PostureHeader homeStatus={homeStatus} activeCount={activeCount} lastAlert={alerts[0]} />

      <div className="flex min-h-0 flex-1 gap-2">
        <Panel
          title="ALERT CENTER"
          live
          ledColor={activeCount > 0 ? 'var(--accent-red)' : 'var(--accent-green)'}
          pulseKey={eventsVersion}
          brackets
          className="min-h-0 flex-[1.6]"
          bodyClassName="flex min-h-0 flex-col"
          right={
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => setHideAcked((v) => !v)}
                className={`lbl border px-1 py-px transition-colors ${hideAcked ? 'border-accent/60 text-accent' : 'border-line text-dim hover:text-prim'}`}
                title="HIDE ACKNOWLEDGED"
              >
                {hideAcked ? 'HIDING ACK' : 'HIDE ACK'}
              </button>
              <button
                onClick={ackAll}
                disabled={activeCount === 0}
                className="lbl border border-line px-1 py-px text-dim transition-colors hover:border-lineb hover:text-prim disabled:opacity-40"
                title="ACKNOWLEDGE ALL"
              >
                ACK ALL
              </button>
            </div>
          }
        >
          <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
            <div className="flex flex-col gap-1.5">
              {visible.map((e) => (
                <AlertCard
                  key={e.id}
                  e={e}
                  acked={acked.has(e.id)}
                  newest={e.id === newestId && !acked.has(e.id)}
                  onAck={() => ackOne(e.id)}
                  onSelect={select}
                />
              ))}
            </div>
            {visible.length === 0 && (
              <div className="flex h-full flex-col items-center justify-center gap-1 py-10 text-center">
                <span className="lbl text-green">NO ACTIVE ALERTS</span>
                <span className="lbl-faint">{hideAcked && alerts.length > 0 ? 'ALL ACKNOWLEDGED' : 'POSTURE NOMINAL · MONITORING'}</span>
              </div>
            )}
          </div>
        </Panel>

        <div className="flex min-h-0 w-[320px] shrink-0 flex-col gap-2">
          <Panel title="ALERT RULES" className="min-h-0 flex-1" bodyClassName="overflow-y-auto" right={<span className="lbl-faint">READ-ONLY</span>}>
            <RulesSummary now={now} />
          </Panel>
          <Panel title="NOTIFICATIONS" brackets className="shrink-0" bodyClassName="p-2">
            <Notifications supported={notifySupported} perm={perm} setPerm={setPerm} />
          </Panel>
        </div>
      </div>
    </div>
  )
}

/* ── posture header ────────────────────────────────────────────────── */

function PostureHeader({ homeStatus, activeCount, lastAlert }: { homeStatus: HomeStatus; activeCount: number; lastAlert?: HomeEvent }) {
  const st = STATUS_STYLE[homeStatus]
  return (
    <div className="panel-surface relative flex shrink-0 items-center gap-4 px-4 py-2.5">
      <CornerBrackets size={10} />
      <div className="flex items-center gap-3">
        <span className="led-pulse h-2.5 w-2.5 rounded-full" style={{ background: st.color, boxShadow: st.glow }} />
        <div className="flex flex-col">
          <span className="lbl-faint">HOME POSTURE</span>
          <span key={homeStatus} className="flash-amber font-grotesk text-[26px] font-bold leading-7 tracking-[0.14em]" style={{ color: st.color, textShadow: st.glow }}>
            {homeStatus}
          </span>
        </div>
      </div>

      <span className="h-9 w-px bg-line" />

      <div className="flex flex-col">
        <span className="lbl-faint">UNACKNOWLEDGED</span>
        <span className="num text-[26px] font-medium leading-7" style={{ color: activeCount > 0 ? 'var(--accent-red)' : 'var(--accent-green)' }}>
          {String(activeCount).padStart(2, '0')}
        </span>
      </div>

      <div className="flex-1" />

      <div className="flex flex-col items-end">
        <span className="lbl-faint">MOST RECENT</span>
        {lastAlert ? (
          <span className="num text-[11px] text-prim/80">
            <span style={{ color: SEV_COLOR[lastAlert.severity] }}>{lastAlert.severity}</span>
            {' · '}
            {fmtLocal(new Date(lastAlert.ts))}
            {' · '}
            <span className="text-dim">{lastAlert.kind}</span>
          </span>
        ) : (
          <span className="lbl-faint">— NONE —</span>
        )}
      </div>
    </div>
  )
}

/* ── alert card ────────────────────────────────────────────────────── */

function AlertCard({ e, acked, newest, onAck, onSelect }: { e: HomeEvent; acked: boolean; newest: boolean; onAck: () => void; onSelect: (id: string) => void }) {
  const c = SEV_COLOR[e.severity]
  const source = e.personId ?? e.cameraId
  const clickable = source !== undefined
  return (
    <div
      className={`panel-surface-2 relative flex overflow-hidden border-l-2 transition-opacity duration-150 ${acked ? 'opacity-45' : ''} ${newest ? 'rise-in' : ''}`}
      style={{ borderLeftColor: c, boxShadow: e.severity === 'CRIT' && !acked ? '0 0 10px rgba(255,59,71,0.22)' : undefined }}
    >
      <div
        className={`min-w-0 flex-1 px-2.5 py-1.5 ${clickable ? 'cursor-pointer' : ''}`}
        onClick={clickable ? () => onSelect(source) : undefined}
      >
        <div className="flex items-center gap-1.5">
          <span className="lbl border px-1 py-px" style={{ borderColor: c, color: c }}>
            {e.severity}
          </span>
          <span className="lbl text-dim">{e.kind}</span>
          <span className="num lbl-faint">{fmtLocal(new Date(e.ts))}</span>
          {source !== undefined && <span className="num lbl-faint text-accent/70">· {source}</span>}
        </div>
        <div className="mt-1 text-[12px] leading-4 text-prim/90">{e.message}</div>
      </div>

      {e.snapshot && (
        <img
          src={e.snapshot}
          alt="snapshot"
          className="h-16 w-24 shrink-0 self-stretch border-l border-line object-cover"
          draggable={false}
        />
      )}

      <div className="flex shrink-0 items-stretch border-l border-line">
        <button
          onClick={onAck}
          disabled={acked}
          className={`lbl px-2 transition-colors ${acked ? 'text-green' : 'text-dim hover:bg-panel2 hover:text-accent'}`}
          title={acked ? 'ACKNOWLEDGED' : 'ACKNOWLEDGE'}
        >
          {acked ? 'ACK ✓' : 'ACK'}
        </button>
      </div>
    </div>
  )
}

/* ── rules summary (read-only, honest) ─────────────────────────────── */

type RuleTone = 'ARMED' | 'STANDBY' | 'INACTIVE' | 'TRIGGERED' | 'CLEAR'

const TONE_COLOR: Record<RuleTone, string> = {
  ARMED: 'var(--accent-green)',
  CLEAR: 'var(--accent-green)',
  STANDBY: 'var(--text-dim)',
  INACTIVE: 'var(--text-faint)',
  TRIGGERED: 'var(--accent-red)',
}

function RulesSummary({ now }: { now: number }) {
  const cvOnline = useHome((s) => s.cvOnline)
  const zones = useHome((s) => s.zones)
  const people = useHome((s) => s.people)
  const serverCameras = useHome((s) => s.serverCameras)
  const webcamStatus = useHome((s) => s.webcamStatus)

  const armedZones = zones.filter((z) => z.alertOnEnter).length
  const nightZones = zones.filter((z) => z.nightOnly).length
  const hour = new Date(now).getHours()
  const isNight = hour >= 22 || hour < 6

  const totalCams = serverCameras.length + 1
  const liveCams = serverCameras.filter((c) => c.status === 'live').length + (webcamStatus === 'live' ? 1 : 0)
  const feedsDown = totalCams - liveCams

  const rules: { name: string; tone: RuleTone; label: string; detail: string }[] = [
    {
      name: 'UNKNOWN PERSON DETECTED',
      tone: cvOnline ? 'ARMED' : 'STANDBY',
      label: cvOnline ? 'ARMED' : 'STANDBY',
      detail: `${people.length} FACES ENROLLED · ${cvOnline ? 'CV ACTIVE' : 'CV STANDBY — START DETECTION'}`,
    },
    {
      name: 'PERSON ENTERS ARMED ZONE',
      tone: armedZones > 0 ? 'ARMED' : 'INACTIVE',
      label: armedZones > 0 ? 'ARMED' : 'NO ZONES',
      detail: `${armedZones}/${zones.length} ZONES ARMED-ON-ENTER`,
    },
    {
      name: 'NIGHT ACTIVITY',
      tone: isNight ? 'ARMED' : 'STANDBY',
      label: isNight ? 'ACTIVE NOW' : 'STANDBY',
      detail: `WINDOW 22:00–06:00 · ${nightZones} NIGHT-ONLY ZONES · ${isNight ? 'IN WINDOW' : 'DAYTIME'}`,
    },
    {
      name: 'CAMERA SIGNAL LOST',
      tone: feedsDown > 0 ? 'TRIGGERED' : 'CLEAR',
      label: feedsDown > 0 ? `${feedsDown} DOWN` : 'CLEAR',
      detail: `${liveCams}/${totalCams} FEEDS LIVE`,
    },
  ]

  return (
    <div className="flex flex-col">
      {rules.map((r) => (
        <div key={r.name} className="border-b border-line/50 px-2 py-1.5">
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-[11px] text-prim/85">{r.name}</span>
            <span className="lbl shrink-0 border px-1 py-px" style={{ borderColor: TONE_COLOR[r.tone], color: TONE_COLOR[r.tone] }}>
              {r.label}
            </span>
          </div>
          <div className="lbl-faint mt-0.5 leading-4">{r.detail}</div>
        </div>
      ))}
      <div className="lbl-faint px-2 py-2 leading-4 opacity-70">
        STATUS REFLECTS CURRENT SYSTEM STATE · RULES RUN ON-DEVICE · ARM ZONES IN THE ZONES MODULE
      </div>
    </div>
  )
}

/* ── notifications ─────────────────────────────────────────────────── */

function Notifications({ supported, perm, setPerm }: { supported: boolean; perm: NotificationPermission; setPerm: (p: NotificationPermission) => void }) {
  if (!supported) {
    return (
      <div className="flex flex-col gap-1.5">
        <span className="lbl border border-line px-1.5 py-1 text-faint">UNSUPPORTED IN THIS BROWSER</span>
        <span className="lbl-faint leading-4">THE NOTIFICATION API IS UNAVAILABLE HERE. ALERTS STILL APPEAR IN THIS PANEL.</span>
      </div>
    )
  }

  const request = () => {
    if (typeof Notification === 'undefined') return
    try {
      Promise.resolve(Notification.requestPermission())
        .then((p) => { if (p) setPerm(p) })
        .catch(() => { /* ignore */ })
    } catch {
      /* legacy browsers — ignore */
    }
  }

  const test = () => {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
    try {
      new Notification('HOMEWATCH', { body: 'Test alert', tag: 'homewatch-test' })
    } catch {
      /* ignore */
    }
  }

  return (
    <div className="flex flex-col gap-2">
      {perm === 'granted' ? (
        <>
          <div className="flex items-center gap-2">
            <span className="led-pulse h-1.5 w-1.5 rounded-full bg-green" style={{ boxShadow: '0 0 6px var(--accent-green)' }} />
            <span className="lbl text-green">PUSH NOTIFICATIONS ENABLED</span>
          </div>
          <span className="lbl-faint leading-4">NEW WARN / CRIT EVENTS WILL RAISE A DESKTOP NOTIFICATION WHILE THIS TAB IS OPEN.</span>
          <button
            onClick={test}
            className="lbl border border-accent/60 bg-accent/10 px-2 py-1.5 text-accent transition-colors hover:bg-accent/20"
          >
            TEST NOTIFICATION
          </button>
        </>
      ) : perm === 'denied' ? (
        <>
          <span className="lbl border border-red/50 px-1.5 py-1 text-red">PERMISSION DENIED</span>
          <span className="lbl-faint leading-4">RE-ENABLE NOTIFICATIONS FOR THIS SITE IN YOUR BROWSER SETTINGS, THEN RELOAD.</span>
        </>
      ) : (
        <>
          <span className="lbl-faint leading-4">GET A DESKTOP ALERT THE MOMENT A WARN / CRIT EVENT FIRES. PERMISSION IS REQUESTED FROM YOUR BROWSER — NOTHING LEAVES THIS MACHINE.</span>
          <button
            onClick={request}
            className="lbl border border-accent/60 bg-accent/10 px-2 py-1.5 text-accent transition-colors hover:bg-accent/20"
          >
            ENABLE PUSH NOTIFICATIONS
          </button>
        </>
      )}
    </div>
  )
}
