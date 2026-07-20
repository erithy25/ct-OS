/**
 * Minimal Web Audio tone engine. Everything is quiet, short, and mechanical.
 * The context unlocks on the first user gesture (autoplay policy).
 */

let ctx: AudioContext | null = null
let muted = false
let unlockInstalled = false

function ensureCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null
  if (!ctx) {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AC) return null
    ctx = new AC()
  }
  if (ctx.state === 'suspended') {
    void ctx.resume().catch(() => undefined)
    installUnlock()
  }
  return ctx
}

function installUnlock(): void {
  if (unlockInstalled) return
  unlockInstalled = true
  const unlock = () => {
    void ctx?.resume().catch(() => undefined)
    window.removeEventListener('pointerdown', unlock)
    window.removeEventListener('keydown', unlock)
  }
  window.addEventListener('pointerdown', unlock)
  window.addEventListener('keydown', unlock)
}

export function setAudioMuted(m: boolean): void {
  muted = m
}

interface ToneOpts {
  freq: number
  dur: number
  type?: OscillatorType
  gain?: number
  sweepTo?: number
  delay?: number
}

function tone({ freq, dur, type = 'sine', gain = 0.06, sweepTo, delay = 0 }: ToneOpts): void {
  const c = ensureCtx()
  if (!c || muted || c.state !== 'running') return
  const t0 = c.currentTime + delay
  const osc = c.createOscillator()
  const g = c.createGain()
  osc.type = type
  osc.frequency.setValueAtTime(freq, t0)
  if (sweepTo) osc.frequency.exponentialRampToValueAtTime(sweepTo, t0 + dur)
  g.gain.setValueAtTime(0, t0)
  g.gain.linearRampToValueAtTime(gain, t0 + Math.min(0.02, dur * 0.2))
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur)
  osc.connect(g).connect(c.destination)
  osc.start(t0)
  osc.stop(t0 + dur + 0.05)
}

/** low power-up swell at the end of the boot sequence */
export function bootTone(): void {
  tone({ freq: 55, dur: 1.1, type: 'sine', gain: 0.1, sweepTo: 110 })
  tone({ freq: 660, dur: 0.09, type: 'square', gain: 0.022, delay: 0.75 })
  tone({ freq: 880, dur: 0.14, type: 'square', gain: 0.022, delay: 0.87 })
}

/** module switch blip */
export function uiSwitch(): void {
  tone({ freq: 1180, dur: 0.03, type: 'square', gain: 0.018 })
}

/** generic key/confirm click */
export function uiClick(): void {
  tone({ freq: 1900, dur: 0.015, type: 'square', gain: 0.012 })
}

/** two-tone alert; harsher for critical severity */
export function alertTone(crit = false): void {
  if (crit) {
    tone({ freq: 780, dur: 0.09, type: 'square', gain: 0.035 })
    tone({ freq: 520, dur: 0.12, type: 'square', gain: 0.035, delay: 0.11 })
    tone({ freq: 780, dur: 0.09, type: 'square', gain: 0.035, delay: 0.26 })
  } else {
    tone({ freq: 620, dur: 0.07, type: 'triangle', gain: 0.028 })
    tone({ freq: 470, dur: 0.09, type: 'triangle', gain: 0.028, delay: 0.09 })
  }
}
