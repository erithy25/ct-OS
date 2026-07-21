import { useMemo, useRef, useState, type MutableRefObject } from 'react'
import { API_ORIGIN, useHome } from '../store'
import { cameraStreamUrl } from '../../realworld/contract'
import type { CameraInfo } from '../../realworld/contract'
import type { Tile } from '../types'
import WebcamTile from './WebcamTile'
import DetectionOverlay from './DetectionOverlay'
import CornerBrackets from '../../components/CornerBrackets'
import { uiClick } from '../../lib/audio'

const STATUS_COLOR: Record<CameraInfo['status'], string> = {
  live: 'var(--accent-green)',
  connecting: 'var(--accent-amber)',
  error: 'var(--accent-red)',
  offline: 'var(--text-faint)',
}

/** Live Wall — the Mac webcam + every server-bridged camera, as a tile grid. */
export default function LiveWall() {
  const serverCameras = useHome((s) => s.serverCameras)
  const webcamStatus = useHome((s) => s.webcamStatus)
  const webcamError = useHome((s) => s.webcamError)
  const serverOnline = useHome((s) => s.serverOnline)
  const status = useHome((s) => s.status)
  const expandedId = useHome((s) => s.expandedId)
  const setExpanded = useHome((s) => s.setExpanded)
  const [adding, setAdding] = useState(false)

  const tiles = useMemo<Tile[]>(() => {
    const webcam: Tile = {
      info: {
        id: 'CAM-01',
        name: 'OPERATOR CAM · THIS MAC',
        url: 'webcam',
        displayUrl: 'local',
        kind: 'webcam',
        status: webcamStatus,
        error: webcamError,
        serverBridged: false,
        addedAt: 0,
      },
      isWebcam: true,
    }
    return [webcam, ...serverCameras.map((info) => ({ info, isWebcam: false }))]
  }, [serverCameras, webcamStatus, webcamError])

  const expanded = expandedId ? tiles.find((t) => t.info.id === expandedId) : null
  const cols = tiles.length <= 1 ? 1 : tiles.length <= 4 ? 2 : 3

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-2">
      {/* toolbar */}
      <div className="flex shrink-0 items-center gap-2">
        <span className="lbl text-prim/80">LIVE WALL</span>
        <span className="lbl-faint">· {tiles.length} FEEDS</span>
        <ServerBadge online={serverOnline} ffmpeg={status?.ffmpeg} />
        <div className="flex-1" />
        <button
          onClick={() => {
            uiClick()
            setAdding(true)
          }}
          className="lbl flex items-center gap-1 border border-accent/60 bg-accent/10 px-2 py-1 text-accent transition-colors hover:bg-accent/20"
        >
          + ADD CAMERA
        </button>
      </div>

      {/* grid or expanded */}
      {expanded ? (
        <div className="relative min-h-0 flex-1">
          <TileFrame tile={expanded} expanded onCollapse={() => setExpanded(null)} />
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 gap-2" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridAutoRows: '1fr' }}>
          {tiles.map((t) => (
            <TileFrame key={t.info.id} tile={t} onExpand={() => setExpanded(t.info.id)} />
          ))}
        </div>
      )}

      <div className="lbl-faint shrink-0 px-1">
        LOCAL & PRIVATE · CAM-01 PROCESSED ON THIS MAC · SERVER CAMERAS BRIDGED VIA FFMPEG · NOTHING UPLOADED
      </div>

      {adding && <AddCameraDialog onClose={() => setAdding(false)} />}
    </div>
  )
}

function ServerBadge({ online, ffmpeg }: { online: boolean; ffmpeg?: boolean }) {
  if (!online) return <span className="lbl border border-red/50 px-1 text-red">SERVER OFFLINE</span>
  return (
    <span className="lbl flex items-center gap-1 border border-green/40 px-1 text-green">
      <span className="led-pulse h-1 w-1 rounded-full bg-green" /> SERVER
      {ffmpeg === false && <span className="text-amber"> · NO FFMPEG</span>}
    </span>
  )
}

function TileFrame({ tile, expanded = false, onExpand, onCollapse }: { tile: Tile; expanded?: boolean; onExpand?: () => void; onCollapse?: () => void }) {
  const removeCamera = useHome((s) => s.removeCamera)
  const select = useHome((s) => s.select)
  const info = tile.info
  const color = STATUS_COLOR[info.status]
  const mediaRef = useRef<HTMLVideoElement | HTMLImageElement | null>(null) as MutableRefObject<HTMLVideoElement | HTMLImageElement | null>
  const live = info.status === 'live'

  return (
    <section
      className="panel-surface relative flex min-h-0 flex-col overflow-hidden"
      onClick={() => select(info.id)}
    >
      <CornerBrackets />
      {/* header */}
      <header className="flex h-6 shrink-0 items-center gap-2 border-b border-line px-2">
        <span className="led-pulse h-1.5 w-1.5 rounded-full" style={{ background: color, boxShadow: `0 0 5px ${color}` }} />
        <span className="lbl truncate text-prim/80">{info.name}</span>
        <span className="lbl-faint">{info.id}</span>
        <div className="flex-1" />
        {tile.isWebcam ? (
          <span className="lbl-faint text-accent">LOCAL</span>
        ) : (
          <span className="lbl-faint" style={{ color }}>
            {info.status.toUpperCase()}
          </span>
        )}
        {expanded ? (
          <button onClick={(e) => { e.stopPropagation(); onCollapse?.() }} className="lbl-faint px-1 hover:text-accent">✕</button>
        ) : (
          <button onClick={(e) => { e.stopPropagation(); onExpand?.() }} className="lbl-faint px-1 hover:text-accent" title="expand">⤢</button>
        )}
        {!tile.isWebcam && (
          <button onClick={(e) => { e.stopPropagation(); void removeCamera(info.id) }} className="lbl-faint px-1 hover:text-red" title="remove">🗙</button>
        )}
      </header>

      {/* feed */}
      <div className="relative min-h-0 flex-1 bg-black">
        {tile.isWebcam ? (
          <WebcamTile expanded={expanded} mediaRef={mediaRef} />
        ) : (
          <ServerFeed info={info} mediaRef={mediaRef} />
        )}
        {live && <DetectionOverlay cameraId={info.id} mediaRef={mediaRef} mirror={tile.isWebcam} />}
        {/* HUD */}
        <div className="pointer-events-none absolute left-1.5 top-1.5 flex items-center gap-1">
          <span className="h-1.5 w-1.5 rounded-full bg-red led-pulse" />
          <span className="num text-[9px] text-red">REC</span>
        </div>
        <Clock />
      </div>
    </section>
  )
}

function ServerFeed({ info, mediaRef }: { info: CameraInfo; mediaRef: MutableRefObject<HTMLVideoElement | HTMLImageElement | null> }) {
  const [failed, setFailed] = useState(false)
  if (info.status === 'error' || info.status === 'offline' || failed) {
    return (
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-void">
        <div className="lbl text-red">SIGNAL LOST</div>
        <div className="lbl-faint max-w-[80%] truncate text-center">{info.error ?? info.displayUrl}</div>
      </div>
    )
  }
  if (info.status === 'connecting') {
    return (
      <div className="absolute inset-0 flex items-center justify-center bg-void">
        <div className="lbl text-amber">CONNECTING…</div>
      </div>
    )
  }
  return (
    <img
      ref={(el) => {
        mediaRef.current = el
      }}
      src={cameraStreamUrl(API_ORIGIN, info.id)}
      alt={info.name}
      crossOrigin="anonymous"
      className="h-full w-full object-cover"
      onError={() => setFailed(true)}
    />
  )
}

function Clock() {
  return (
    <div className="pointer-events-none absolute bottom-1.5 right-1.5 num text-[9px] text-prim/70">
      <LiveTime />
    </div>
  )
}

function LiveTime() {
  const [, force] = useState(0)
  useMemo(() => {
    const id = setInterval(() => force((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [])
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return <>{`${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`}</>
}

/* ── add camera dialog ─────────────────────────────────────────────── */

function AddCameraDialog({ onClose }: { onClose: () => void }) {
  const addCamera = useHome((s) => s.addCamera)
  const [url, setUrl] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const submit = async (u?: string) => {
    const target = (u ?? url).trim()
    if (!target) return
    setBusy(true)
    setErr(null)
    const r = await addCamera({ url: target, name: name.trim() || undefined })
    setBusy(false)
    if (r.ok) onClose()
    else setErr(r.error ?? 'failed')
  }

  return (
    <div className="absolute inset-0 z-50 flex items-start justify-center bg-void/70 pt-[14vh]" onClick={onClose}>
      <div className="panel-surface-2 w-[460px] max-w-[92%] border-lineb p-3 shadow-glow" onClick={(e) => e.stopPropagation()}>
        <div className="mb-2 flex items-center justify-between">
          <span className="lbl text-accent">ADD CAMERA</span>
          <button onClick={onClose} className="lbl-faint hover:text-accent">ESC</button>
        </div>
        <div className="lbl-faint mb-1">CAMERA URL</div>
        <input
          autoFocus
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void submit()}
          placeholder="rtsp://user:pass@192.168.1.50:554/stream"
          className="num w-full border border-line bg-void px-2 py-1.5 text-[12px] text-prim outline-none focus:border-accent"
          spellCheck={false}
        />
        <div className="lbl-faint mb-1 mt-2">NAME (OPTIONAL)</div>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void submit()}
          placeholder="FRONT DOOR"
          className="num w-full border border-line bg-void px-2 py-1.5 text-[12px] text-prim outline-none focus:border-accent"
          spellCheck={false}
        />
        {err && <div className="lbl mt-2 text-red">ERR · {err}</div>}
        <div className="mt-3 flex items-center gap-2">
          <button
            disabled={busy}
            onClick={() => void submit()}
            className="lbl flex-1 border border-accent bg-accent/10 px-2 py-1.5 text-accent hover:bg-accent/20 disabled:opacity-50"
          >
            {busy ? 'CONNECTING…' : 'CONNECT'}
          </button>
          <button onClick={() => void submit('test')} disabled={busy} className="lbl border border-line px-2 py-1.5 text-dim hover:border-lineb hover:text-prim disabled:opacity-50">
            + TEST PATTERN
          </button>
        </div>
        <div className="lbl-faint mt-2 leading-4 opacity-70">
          SUPPORTS RTSP:// (IP CAMERAS), HTTP:// (MJPEG/HLS), FILE://, OR "TEST".
          THE SERVER BRIDGES THE STREAM VIA FFMPEG — NOTHING LEAVES YOUR MACHINE.
        </div>
      </div>
    </div>
  )
}
