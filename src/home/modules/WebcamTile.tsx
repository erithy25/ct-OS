import { useEffect, useRef, type MutableRefObject } from 'react'
import { useHome } from '../store'

/**
 * The Mac webcam tile — browser-local getUserMedia, never uploaded. A shared
 * module-level stream survives view switches so we don't re-prompt. On-device
 * detection is layered on in a later block.
 */
let sharedStream: MediaStream | null = null
let acquiring: Promise<MediaStream> | null = null

async function getStream(): Promise<MediaStream> {
  if (sharedStream) return sharedStream
  if (acquiring) return acquiring
  acquiring = navigator.mediaDevices
    .getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false })
    .then((s) => {
      sharedStream = s
      acquiring = null
      return s
    })
    .catch((e) => {
      acquiring = null
      throw e
    })
  return acquiring
}

export default function WebcamTile({
  expanded = false,
  mediaRef,
}: {
  expanded?: boolean
  mediaRef?: MutableRefObject<HTMLVideoElement | HTMLImageElement | null>
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const setVideo = (el: HTMLVideoElement | null) => {
    videoRef.current = el
    if (mediaRef) mediaRef.current = el
  }
  const status = useHome((s) => s.webcamStatus)
  const setWebcamStatus = useHome((s) => s.setWebcamStatus)
  const webcamRequest = useHome((s) => s.webcamRequest)
  const emit = useHome((s) => s.emit)

  useEffect(() => {
    let cancelled = false
    setWebcamStatus('connecting')
    getStream()
      .then((stream) => {
        if (cancelled) return
        if (videoRef.current) {
          videoRef.current.srcObject = stream
          void videoRef.current.play().catch(() => undefined)
        }
        setWebcamStatus('live')
      })
      .catch((e) => {
        if (cancelled) return
        const denied = e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'SecurityError')
        setWebcamStatus('error', denied ? 'PERMISSION DENIED' : 'NO CAMERA')
        emit('NOTICE', 'CAMERA', `WEBCAM ${denied ? 'PERMISSION DENIED' : 'UNAVAILABLE'} · CAM-01`)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [webcamRequest])

  const retry = () => {
    sharedStream = null
    useHome.getState().requestWebcam()
  }

  return (
    <div className="relative h-full w-full overflow-hidden bg-black">
      <video
        ref={setVideo}
        muted
        playsInline
        className="h-full w-full object-cover"
        style={{ transform: 'scaleX(-1)', display: status === 'live' ? 'block' : 'none' }}
      />
      {status !== 'live' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-void">
          {status === 'connecting' ? (
            <div className="lbl text-accent">REQUESTING CAMERA…</div>
          ) : (
            <>
              <div className="lbl text-red">NO SIGNAL // {useHome.getState().webcamError ?? 'CAMERA'}</div>
              <button onClick={retry} className="lbl mt-1 border border-lineb px-2 py-1 text-dim hover:border-accent hover:text-accent">
                RETRY
              </button>
            </>
          )}
        </div>
      )}
      {status === 'live' && expanded && (
        <div className="pointer-events-none absolute inset-0 opacity-40" style={{ background: 'repeating-linear-gradient(0deg,transparent,transparent 2px,rgba(0,0,0,.5) 3px)' }} />
      )}
    </div>
  )
}
