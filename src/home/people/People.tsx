import { useEffect, useRef, useState } from 'react'
import { useHome, WEBCAM_ID } from '../store'
import type { Person } from '../types'
import Panel from '../../components/Panel'
import CornerBrackets from '../../components/CornerBrackets'
import { uiClick } from '../../lib/audio'
import {
  computeDescriptor,
  faceState,
  loadFace,
  onFaceState,
  retryFace,
  toStored,
  type FaceState,
} from './faceEngine'
import { getFaceStream } from './faceWatch'

/* ── palette for household color tags ──────────────────────────────── */

const SWATCHES = ['#22d3ee', '#34d399', '#f5a623', '#8b5cf6', '#ff3b47', '#5eead4', '#f472b6', '#c9d6e4']
const MAX_SAMPLES = 3

type Role = 'HOUSEHOLD' | 'GUEST'
type CamState = 'connecting' | 'live' | 'error'

/* ── engine-state subscription hook ────────────────────────────────── */

function useFaceState(): FaceState {
  const [s, setS] = useState<FaceState>(() => faceState())
  useEffect(() => onFaceState(setS), [])
  return s
}

/* ── 1s clock for live "last seen" relative times ──────────────────── */

function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}

function relTime(ts: number, now: number): string {
  const s = Math.max(0, Math.floor((now - ts) / 1000))
  if (s < 60) return `${s}s AGO`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m AGO`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h AGO`
  return `${Math.floor(h / 24)}d AGO`
}

/* ── root view ─────────────────────────────────────────────────────── */

export default function People() {
  const engine = useFaceState()
  const people = useHome((s) => s.people)
  const present = people.filter((p) => p.present).length

  // ensure the engine tries to load even if the watch loop hasn't (defensive)
  useEffect(() => {
    if (faceState() === 'idle') void loadFace()
  }, [])

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-2">
      {/* toolbar */}
      <div className="flex shrink-0 items-center gap-2">
        <span className="lbl text-prim/80">PEOPLE</span>
        <span className="lbl-faint">· {people.length} ENROLLED</span>
        <span className="lbl flex items-center gap-1 border border-green/30 px-1.5 py-0.5 text-green">
          <span className="led-pulse h-1 w-1 rounded-full bg-green" />
          {present} HOME
        </span>
        <div className="flex-1" />
        <EngineChip engine={engine} />
      </div>

      {/* body: enroll (left) + roster (right) */}
      <div className="flex min-h-0 flex-1 gap-2">
        <EnrollPanel engine={engine} />
        <RosterPanel />
      </div>

      {/* global privacy footer */}
      <div className="lbl-faint shrink-0 px-1 leading-4">
        FACE DATA IS COMPUTED &amp; STORED ON THIS MAC ONLY · NEVER UPLOADED · CLASSIFIES KNOWN vs UNKNOWN ONLY — NEVER A THREAT
      </div>
    </div>
  )
}

/* ── engine status chip ────────────────────────────────────────────── */

function EngineChip({ engine }: { engine: FaceState }) {
  const map: Record<FaceState, { label: string; color: string; pulse: boolean }> = {
    idle: { label: 'ENGINE IDLE', color: 'var(--text-faint)', pulse: false },
    loading: { label: 'ENGINE LOADING…', color: 'var(--accent-amber)', pulse: true },
    ready: { label: 'FACE ENGINE ●', color: 'var(--accent-green)', pulse: true },
    offline: { label: 'ENGINE OFFLINE', color: 'var(--accent-red)', pulse: false },
  }
  const m = map[engine]
  return (
    <span className="lbl flex items-center gap-1.5 border px-2 py-0.5" style={{ borderColor: m.color, color: m.color }}>
      {m.pulse && <span className="led-pulse h-1.5 w-1.5 rounded-full" style={{ background: m.color }} />}
      {m.label}
    </span>
  )
}

/* ── ENROLL panel ──────────────────────────────────────────────────── */

function EnrollPanel({ engine }: { engine: FaceState }) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [camState, setCamState] = useState<CamState>('connecting')
  const [camError, setCamError] = useState<string>('')
  const [camNonce, setCamNonce] = useState(0)

  const [samples, setSamples] = useState<number[][]>([])
  const [name, setName] = useState('')
  const [role, setRole] = useState<Role>('HOUSEHOLD')
  const [color, setColor] = useState<string>(SWATCHES[0])
  const [capturing, setCapturing] = useState(false)
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null)

  const upsertPerson = useHome((s) => s.upsertPerson)
  const emit = useHome((s) => s.emit)

  // attach the shared webcam stream to the live preview
  useEffect(() => {
    let cancelled = false
    setCamState('connecting')
    getFaceStream()
      .then((stream) => {
        if (cancelled) return
        const v = videoRef.current
        if (v) {
          v.srcObject = stream
          void v.play().catch(() => undefined)
        }
        setCamState('live')
      })
      .catch((e: unknown) => {
        if (cancelled) return
        const denied = e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'SecurityError')
        setCamError(denied ? 'PERMISSION DENIED' : 'NO CAMERA')
        setCamState('error')
      })
    return () => {
      cancelled = true
    }
  }, [camNonce])

  const flash = (text: string, ok: boolean) => {
    setMsg({ text, ok })
    window.setTimeout(() => setMsg(null), 2600)
  }

  const capture = async () => {
    if (capturing || engine !== 'ready' || samples.length >= MAX_SAMPLES) return
    const v = videoRef.current
    if (!v) return
    uiClick()
    setCapturing(true)
    const d = await computeDescriptor(v)
    setCapturing(false)
    if (!d) {
      flash('NO FACE DETECTED — CENTER FACE, GOOD LIGHT', false)
      return
    }
    setSamples((s) => [...s, toStored(d)])
    flash(`SAMPLE ${samples.length + 1}/${MAX_SAMPLES} CAPTURED`, true)
  }

  const enroll = () => {
    const nm = name.trim()
    if (samples.length === 0 || !nm) return
    const rnd = Math.floor(Math.random() * 1296)
      .toString(36)
      .toUpperCase()
      .padStart(2, '0')
    const person: Person = {
      id: `P-${Date.now().toString(36).toUpperCase()}${rnd}`,
      name: nm,
      role,
      descriptors: samples,
      color,
      addedAt: Date.now(),
      present: false,
      lastCameraId: WEBCAM_ID,
    }
    upsertPerson(person)
    emit('NOTICE', 'PERSON', `ENROLLED · ${nm.toUpperCase()} · ${role} · ${samples.length} SAMPLE${samples.length > 1 ? 'S' : ''}`, {
      personId: person.id,
    })
    setSamples([])
    setName('')
    setColor(SWATCHES[(SWATCHES.indexOf(color) + 1) % SWATCHES.length])
    flash(`ENROLLED ${nm.toUpperCase()}`, true)
  }

  const canCapture = engine === 'ready' && camState === 'live' && samples.length < MAX_SAMPLES
  const canEnroll = samples.length > 0 && name.trim().length > 0

  return (
    <Panel title="ENROLL HOUSEHOLD MEMBER" brackets className="w-[384px] shrink-0" bodyClassName="min-h-0 overflow-y-auto">
      <div className="flex flex-col gap-2.5 p-2">
        {/* consent — always visible, always first */}
        <div className="border border-accent/25 bg-accent/5 px-2 py-1.5">
          <div className="lbl text-accent/90">CONSENT REQUIRED</div>
          <div className="lbl-faint mt-0.5 leading-4 text-dim">
            ONLY ENROLL PEOPLE WHO CONSENT · FACE DATA STAYS ON THIS MAC · DELETE ANYTIME
          </div>
        </div>

        {engine === 'offline' ? (
          <OfflineCard />
        ) : (
          <>
            {/* live preview */}
            <div className="panel-surface-2 relative aspect-video w-full overflow-hidden border-line bg-black">
              <video
                ref={videoRef}
                muted
                playsInline
                className="h-full w-full object-cover"
                style={{ transform: 'scaleX(-1)', display: camState === 'live' ? 'block' : 'none' }}
              />
              {/* framing reticle */}
              {camState === 'live' && (
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                  <div className="h-[62%] w-[42%] rounded-[40%] border border-accent/40" style={{ boxShadow: '0 0 12px rgba(34,211,238,0.15) inset' }} />
                </div>
              )}
              {camState === 'live' && (
                <div className="pointer-events-none absolute left-1.5 top-1.5 flex items-center gap-1">
                  <span className="led-pulse h-1.5 w-1.5 rounded-full bg-red" />
                  <span className="num text-[9px] text-red">LIVE</span>
                </div>
              )}
              {camState !== 'live' && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-void">
                  {camState === 'connecting' ? (
                    <div className="lbl text-accent">REQUESTING CAMERA…</div>
                  ) : (
                    <>
                      <div className="lbl text-red">NO SIGNAL // {camError || 'CAMERA'}</div>
                      <button
                        onClick={() => setCamNonce((n) => n + 1)}
                        className="lbl border border-lineb px-2 py-1 text-dim hover:border-accent hover:text-accent"
                      >
                        RETRY CAMERA
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>

            {/* capture row */}
            <div className="flex items-center gap-2">
              <button
                onClick={() => void capture()}
                disabled={!canCapture}
                className="lbl flex-1 border border-accent/60 bg-accent/10 px-2 py-1.5 text-accent transition-colors hover:bg-accent/20 disabled:cursor-not-allowed disabled:border-line disabled:bg-transparent disabled:text-faint"
              >
                {capturing ? 'READING FACE…' : engine !== 'ready' ? 'ENGINE LOADING…' : '◎ CAPTURE FACE'}
              </button>
              <div className="flex items-center gap-1" title={`${samples.length}/${MAX_SAMPLES} samples`}>
                {Array.from({ length: MAX_SAMPLES }).map((_, i) => (
                  <span
                    key={i}
                    className="h-2.5 w-2.5 border"
                    style={{
                      borderColor: i < samples.length ? color : 'var(--line-bright)',
                      background: i < samples.length ? color : 'transparent',
                      boxShadow: i < samples.length ? `0 0 5px ${color}` : undefined,
                    }}
                  />
                ))}
              </div>
            </div>

            {samples.length > 0 && (
              <button onClick={() => setSamples([])} className="lbl-faint self-start hover:text-red">
                ✕ CLEAR SAMPLES
              </button>
            )}

            {/* name */}
            <div>
              <div className="lbl-faint mb-1">NAME</div>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && canEnroll && enroll()}
                placeholder="E.G. ALEX MORGAN"
                maxLength={40}
                className="num w-full border border-line bg-void px-2 py-1.5 text-[12px] text-prim outline-none focus:border-accent"
                spellCheck={false}
              />
            </div>

            {/* role */}
            <div>
              <div className="lbl-faint mb-1">ROLE</div>
              <div className="flex gap-1">
                {(['HOUSEHOLD', 'GUEST'] as Role[]).map((r) => (
                  <button
                    key={r}
                    onClick={() => setRole(r)}
                    className={`lbl flex-1 border px-2 py-1.5 transition-colors ${
                      role === r ? 'border-accent bg-accent/10 text-accent' : 'border-line text-dim hover:border-lineb hover:text-prim'
                    }`}
                  >
                    {r}
                  </button>
                ))}
              </div>
            </div>

            {/* color */}
            <div>
              <div className="lbl-faint mb-1">TAG COLOR</div>
              <div className="flex flex-wrap gap-1.5">
                {SWATCHES.map((c) => (
                  <button
                    key={c}
                    onClick={() => setColor(c)}
                    aria-label={`color ${c}`}
                    className="h-5 w-5 rounded-full border transition-transform hover:scale-110"
                    style={{
                      background: c,
                      borderColor: color === c ? 'var(--text-primary)' : 'transparent',
                      boxShadow: color === c ? `0 0 8px ${c}` : undefined,
                    }}
                  />
                ))}
              </div>
            </div>

            {/* enroll */}
            <button
              onClick={enroll}
              disabled={!canEnroll}
              className="lbl mt-0.5 flex items-center justify-center gap-1.5 border border-green/60 bg-green/10 px-2 py-2 text-green transition-colors hover:bg-green/20 disabled:cursor-not-allowed disabled:border-line disabled:bg-transparent disabled:text-faint"
            >
              + ENROLL {role === 'HOUSEHOLD' ? 'MEMBER' : 'GUEST'}
            </button>

            {msg && (
              <div className="lbl text-center" style={{ color: msg.ok ? 'var(--accent-green)' : 'var(--accent-red)' }}>
                {msg.text}
              </div>
            )}
          </>
        )}
      </div>
    </Panel>
  )
}

/* ── polished FACE ENGINE OFFLINE state ────────────────────────────── */

function OfflineCard() {
  const [busy, setBusy] = useState(false)
  const retry = async () => {
    if (busy) return
    uiClick()
    setBusy(true)
    await retryFace()
    // faceState listener flips the panel automatically on success
    window.setTimeout(() => setBusy(false), 600)
  }
  return (
    <div className="relative border border-red/25 bg-red/5 px-4 py-6 text-center">
      <CornerBrackets size={10} />
      <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center">
        <FaceOffGlyph />
      </div>
      <div className="font-grotesk text-[15px] font-medium tracking-[0.22em] text-red">FACE ENGINE OFFLINE</div>
      <div className="lbl mt-1 text-amber">MODEL UNAVAILABLE</div>
      <div className="lbl-faint mx-auto mt-3 max-w-[280px] leading-4 text-dim">
        THE ON-DEVICE FACE MODELS COULD NOT BE FETCHED FROM THE WEIGHTS CDN IN THIS ENVIRONMENT. ENROLLMENT &amp; LIVE MATCHING ARE PAUSED — YOUR ROSTER &amp; PRIVACY CONTROLS REMAIN FULLY AVAILABLE.
      </div>
      <button
        onClick={() => void retry()}
        disabled={busy}
        className="lbl mt-4 border border-lineb px-3 py-1.5 text-dim transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
      >
        {busy ? 'RETRYING…' : '↻ RETRY ENGINE'}
      </button>
      <div className="lbl-faint mt-3 opacity-70">ALL PROCESSING STAYS LOCAL · NOTHING UPLOADED</div>
    </div>
  )
}

function FaceOffGlyph() {
  return (
    <svg viewBox="0 0 32 32" className="h-11 w-11" fill="none" stroke="var(--accent-red)" strokeWidth="1.3">
      <rect x="5" y="5" width="22" height="22" rx="3" opacity="0.5" />
      <circle cx="16" cy="14" r="4" opacity="0.7" />
      <path d="M9 25c0-3.6 3.1-6 7-6s7 2.4 7 6" opacity="0.7" />
      <path d="M6 6l20 20" stroke="var(--accent-red)" strokeWidth="1.6" />
    </svg>
  )
}

/* ── ROSTER panel ──────────────────────────────────────────────────── */

function RosterPanel() {
  const people = useHome((s) => s.people)
  const removePerson = useHome((s) => s.removePerson)
  const emit = useHome((s) => s.emit)
  const now = useNow(1000)
  const present = people.filter((p) => p.present).length

  const del = (p: Person) => {
    uiClick()
    removePerson(p.id)
    emit('NOTICE', 'PERSON', `REMOVED · ${p.name.toUpperCase()} · FACE DATA DELETED`, { personId: p.id })
  }

  return (
    <Panel
      title="ROSTER"
      live
      className="min-h-0 flex-1"
      bodyClassName="min-h-0 overflow-y-auto"
      right={
        <span className="lbl-faint">
          <span className="text-green">{present}</span> HOME / {people.length} ENROLLED
        </span>
      }
    >
      {people.length === 0 ? (
        <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
          <div className="lbl text-faint">NO ONE ENROLLED YET</div>
          <div className="lbl-faint max-w-[260px] leading-4">
            CAPTURE A CONSENTING HOUSEHOLD MEMBER&apos;S FACE TO BEGIN · KNOWN FACES ARE GREETED, UNKNOWN FACES ARE FLAGGED
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2 p-2" style={{ gridAutoRows: 'min-content' }}>
          {people.map((p) => (
            <RosterCard key={p.id} p={p} now={now} onDelete={() => del(p)} />
          ))}
        </div>
      )}
    </Panel>
  )
}

function RosterCard({ p, now, onDelete }: { p: Person; now: number; onDelete: () => void }) {
  return (
    <div className="panel-surface-2 relative flex flex-col gap-1.5 border-line p-2" style={{ borderLeft: `2px solid ${p.color}` }}>
      <div className="flex items-center gap-1.5">
        <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: p.color, boxShadow: `0 0 6px ${p.color}` }} />
        <span className="truncate text-[13px] font-medium leading-4 text-prim">{p.name}</span>
        <div className="flex-1" />
        <button onClick={onDelete} className="lbl-faint shrink-0 px-0.5 hover:text-red" title="delete — removes face data">
          🗙
        </button>
      </div>

      <div className="flex items-center gap-1.5">
        <span className="lbl-faint">{p.role}</span>
        <div className="flex-1" />
        {p.present ? (
          <span className="lbl flex items-center gap-1 border border-green/40 px-1 text-green">
            <span className="led-pulse h-1 w-1 rounded-full bg-green" /> HOME
          </span>
        ) : (
          <span className="lbl border border-line px-1 text-faint">AWAY</span>
        )}
      </div>

      <div className="flex items-center justify-between border-t border-line/60 pt-1">
        <span className="lbl-faint">{p.lastSeen ? `SEEN ${relTime(p.lastSeen, now)}` : 'NOT YET SEEN'}</span>
        <span className="lbl-faint">
          {p.descriptors.length} SAMPLE{p.descriptors.length === 1 ? '' : 'S'}
        </span>
      </div>
    </div>
  )
}
