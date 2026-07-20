/**
 * SURVEILLANCE GRID — shared canvas HUD primitives.
 *
 * Corner-bracket detection boxes, mono HUD text, confidence bars, film grain
 * and full-band static, crosshairs. Pure canvas helpers — no React, no state
 * beyond lazily built noise frames (module singletons, built once).
 */

export const CYAN = '#22d3ee'
export const CYAN_DIM = 'rgba(34, 211, 238, 0.45)'
export const AMBER = '#f5a623'
export const RED = '#ff3b47'
export const GREEN = '#34d399'
export const VIOLET = '#8b5cf6'
export const TEXT_DIM = 'rgba(201, 214, 228, 0.62)'
export const TEXT_FAINT = 'rgba(107, 124, 143, 0.8)'

export const HUD_FONT = '9px "JetBrains Mono", ui-monospace, monospace'
export const HUD_FONT_LG = '11px "JetBrains Mono", ui-monospace, monospace'

/* ── text ──────────────────────────────────────────────────────────── */

export type Anchor = 'tl' | 'tr' | 'bl' | 'br' | 'tc'

/** Uppercase mono HUD text with an optional dark backing strip. */
export function hudText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  color: string,
  opts: { anchor?: Anchor; back?: boolean; font?: string } = {},
): void {
  const { anchor = 'tl', back = true, font = HUD_FONT } = opts
  ctx.font = font
  ctx.textBaseline = 'top'
  const w = ctx.measureText(text).width
  const fh = font === HUD_FONT_LG ? 11 : 9
  const tx = anchor === 'tr' || anchor === 'br' ? x - w : anchor === 'tc' ? x - w / 2 : x
  const ty = anchor === 'bl' || anchor === 'br' ? y - fh : y
  if (back) {
    ctx.fillStyle = 'rgba(4, 6, 10, 0.72)'
    ctx.fillRect(tx - 3, ty - 2, w + 6, fh + 5)
  }
  ctx.fillStyle = color
  ctx.fillText(text, tx, ty)
}

/** Centered tag with hairline border — SIGNAL LOST / status banners. */
export function hudTag(
  ctx: CanvasRenderingContext2D,
  text: string,
  cx: number,
  cy: number,
  color: string,
  opts: { alpha?: number; font?: string } = {},
): void {
  const { alpha = 1, font = HUD_FONT } = opts
  ctx.save()
  ctx.globalAlpha = alpha
  ctx.font = font
  ctx.textBaseline = 'top'
  const fh = font === HUD_FONT_LG ? 11 : 9
  const w = ctx.measureText(text).width
  const px = 7
  const py = 4
  ctx.fillStyle = 'rgba(4, 6, 10, 0.88)'
  ctx.fillRect(cx - w / 2 - px, cy - fh / 2 - py, w + px * 2, fh + py * 2)
  ctx.strokeStyle = color
  ctx.lineWidth = 1
  ctx.strokeRect(cx - w / 2 - px + 0.5, cy - fh / 2 - py + 0.5, w + px * 2 - 1, fh + py * 2 - 1)
  ctx.fillStyle = color
  ctx.fillText(text, cx - w / 2, cy - fh / 2)
  ctx.restore()
}

/* ── detection chrome ──────────────────────────────────────────────── */

/** Four-L-corner bracket box (never a plain rect). */
export function drawBracketBox(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  color: string,
  opts: { corner?: number; lineWidth?: number; alpha?: number } = {},
): void {
  const corner = opts.corner ?? Math.max(5, Math.min(14, Math.min(w, h) * 0.22))
  const lw = opts.lineWidth ?? 1
  ctx.save()
  if (opts.alpha !== undefined) ctx.globalAlpha = opts.alpha
  ctx.strokeStyle = color
  ctx.lineWidth = lw
  ctx.beginPath()
  // TL
  ctx.moveTo(x, y + corner)
  ctx.lineTo(x, y)
  ctx.lineTo(x + corner, y)
  // TR
  ctx.moveTo(x + w - corner, y)
  ctx.lineTo(x + w, y)
  ctx.lineTo(x + w, y + corner)
  // BR
  ctx.moveTo(x + w, y + h - corner)
  ctx.lineTo(x + w, y + h)
  ctx.lineTo(x + w - corner, y + h)
  // BL
  ctx.moveTo(x + corner, y + h)
  ctx.lineTo(x, y + h)
  ctx.lineTo(x, y + h - corner)
  ctx.stroke()
  ctx.restore()
}

/** Thin confidence bar (track + fill). */
export function drawConfBar(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  conf: number,
  color: string,
): void {
  ctx.fillStyle = 'rgba(26, 36, 48, 0.9)'
  ctx.fillRect(x, y, w, 2)
  ctx.fillStyle = color
  ctx.fillRect(x, y, Math.max(1, w * Math.max(0, Math.min(1, conf))), 2)
}

/** Faint center crosshair with tick marks. */
export function drawCrosshair(ctx: CanvasRenderingContext2D, w: number, h: number, color = 'rgba(201, 214, 228, 0.14)'): void {
  const cx = Math.round(w / 2)
  const cy = Math.round(h / 2)
  const arm = Math.min(w, h) * 0.055
  const gap = arm * 0.45
  ctx.save()
  ctx.strokeStyle = color
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(cx - arm, cy + 0.5)
  ctx.lineTo(cx - gap, cy + 0.5)
  ctx.moveTo(cx + gap, cy + 0.5)
  ctx.lineTo(cx + arm, cy + 0.5)
  ctx.moveTo(cx + 0.5, cy - arm)
  ctx.lineTo(cx + 0.5, cy - gap)
  ctx.moveTo(cx + 0.5, cy + gap)
  ctx.lineTo(cx + 0.5, cy + arm)
  ctx.stroke()
  ctx.strokeRect(cx - 1.5, cy - 1.5, 3, 3)
  ctx.restore()
}

/* ── noise / static ────────────────────────────────────────────────── */

const NOISE_SIZE = 128
const NOISE_FRAMES = 4
let noiseFrames: HTMLCanvasElement[] | null = null

function buildNoiseFrames(): HTMLCanvasElement[] {
  const frames: HTMLCanvasElement[] = []
  for (let f = 0; f < NOISE_FRAMES; f++) {
    const c = document.createElement('canvas')
    c.width = NOISE_SIZE
    c.height = NOISE_SIZE
    const g = c.getContext('2d')
    if (!g) {
      frames.push(c)
      continue
    }
    const img = g.createImageData(NOISE_SIZE, NOISE_SIZE)
    const d = img.data
    for (let i = 0; i < d.length; i += 4) {
      const v = Math.floor(Math.random() * 255)
      d[i] = v
      d[i + 1] = v
      d[i + 2] = v
      d[i + 3] = 255
    }
    g.putImageData(img, 0, 0)
    frames.push(c)
  }
  return frames
}

function getNoise(frame: number): HTMLCanvasElement {
  if (!noiseFrames) noiseFrames = buildNoiseFrames()
  return noiseFrames[((frame % NOISE_FRAMES) + NOISE_FRAMES) % NOISE_FRAMES]
}

/** Low-alpha film grain: pre-rendered noise tiled at random offsets. */
export function drawGrain(ctx: CanvasRenderingContext2D, w: number, h: number, alpha: number): void {
  const n = getNoise(Math.floor(Math.random() * NOISE_FRAMES))
  ctx.save()
  ctx.globalAlpha = alpha
  const ox = -Math.floor(Math.random() * NOISE_SIZE)
  const oy = -Math.floor(Math.random() * NOISE_SIZE)
  for (let x = ox; x < w; x += NOISE_SIZE) {
    for (let y = oy; y < h; y += NOISE_SIZE) {
      ctx.drawImage(n, x, y)
    }
  }
  ctx.restore()
}

/** Full-frame analog static (signal-loss state) with tear bands. */
export function drawStatic(ctx: CanvasRenderingContext2D, w: number, h: number, tMs: number): void {
  ctx.fillStyle = '#05070a'
  ctx.fillRect(0, 0, w, h)
  const n = getNoise(Math.floor(tMs / 40))
  ctx.save()
  ctx.globalAlpha = 0.5
  const ox = -Math.floor(Math.random() * NOISE_SIZE)
  const oy = -Math.floor(Math.random() * NOISE_SIZE)
  // stretch tiles horizontally — reads as broadcast static, not confetti
  for (let x = ox; x < w; x += NOISE_SIZE * 2) {
    for (let y = oy; y < h; y += NOISE_SIZE) {
      ctx.drawImage(n, x, y, NOISE_SIZE * 2, NOISE_SIZE)
    }
  }
  ctx.restore()
  // rolling tear bands
  const bandY = ((tMs * 0.11) % (h * 1.4)) - h * 0.2
  ctx.fillStyle = 'rgba(255, 255, 255, 0.05)'
  ctx.fillRect(0, bandY, w, 7)
  ctx.fillStyle = 'rgba(0, 0, 0, 0.4)'
  ctx.fillRect(0, bandY + 9, w, 3)
  if (Math.random() < 0.09) {
    const y = Math.random() * h
    ctx.fillStyle = 'rgba(255, 255, 255, 0.08)'
    ctx.fillRect(0, y, w, 1.5)
  }
}

/** One faint brighter scan row rolling down the frame (rolling-shutter feel). */
export function drawScanRow(ctx: CanvasRenderingContext2D, w: number, h: number, tMs: number, alpha = 0.03): void {
  const y = (tMs * 0.028) % (h + 40) - 20
  const grad = ctx.createLinearGradient(0, y - 10, 0, y + 10)
  grad.addColorStop(0, 'rgba(255,255,255,0)')
  grad.addColorStop(0.5, `rgba(255,255,255,${alpha})`)
  grad.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = grad
  ctx.fillRect(0, y - 10, w, 20)
}
