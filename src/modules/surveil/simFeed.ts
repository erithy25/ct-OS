/**
 * Simulated camera feeds (CAM-02+) — procedurally rendered on canvas.
 *
 * Each tile is seeded by camera id: a static night-street composition
 * (skyline, building silhouettes, fence lines, lamp cones), drifting entity
 * blobs on seeded crossing schedules, an occasional auto MOTION DETECTED
 * box that tracks a blob, film grain + per-tile signal quality, and a
 * seeded RF dropout cycle. Ambient light follows the sim day/night cycle.
 *
 * Pure draw functions — one shared rAF (owned by SurveillanceGrid) calls
 * these for every visible tile.
 */

import { Rand, hashString } from '../../sim/seed'
import type { Camera } from '../../sim/types'
import { fmtUTC, pad } from '../../lib/format'
import {
  AMBER,
  CYAN_DIM,
  RED,
  TEXT_DIM,
  TEXT_FAINT,
  drawBracketBox,
  drawConfBar,
  drawGrain,
  drawScanRow,
  drawStatic,
  hudTag,
  hudText,
} from './hud'

/* ── scene model ───────────────────────────────────────────────────── */

interface FarBuilding {
  x: number
  w: number
  h: number
  antenna: boolean
  antennaPhase: number
}

interface NearBuilding {
  x: number
  w: number
  h: number
  windows: { x: number; y: number; phase: number }[]
}

interface Lamp {
  x: number
  headY: number
  spread: number
}

interface Blob {
  /** crossing duration seconds */
  dur: number
  /** idle gap between crossings, seconds */
  gap: number
  phase: number
  dir: 1 | -1
  /** ground line as fraction of height */
  y: number
  /** blob height as fraction of canvas height */
  hf: number
  bobFreq: number
}

interface Scene {
  horizonY: number
  groundY: number
  far: FarBuilding[]
  near: NearBuilding[]
  fence: { y: number; step: number } | null
  lamps: Lamp[]
  blobs: Blob[]
  /** 0.62..0.98 — lower = noisier, softer feed */
  quality: number
  dropPeriod: number
  dropDur: number
  dropPhase: number
  motionPeriod: number
  motionPhase: number
  uptime: string
}

const scenes = new Map<string, Scene>()

function getScene(camId: string): Scene {
  const hit = scenes.get(camId)
  if (hit) return hit
  const r = new Rand(`${camId}:feed`)

  const horizonY = r.range(0.5, 0.6)
  const groundY = r.range(0.8, 0.88)

  const far: FarBuilding[] = []
  let fx = -0.02
  while (fx < 1.02) {
    const w = r.range(0.05, 0.15)
    far.push({ x: fx, w, h: r.range(0.07, 0.22), antenna: r.chance(0.3), antennaPhase: r.range(0, 6.28) })
    fx += w + r.range(0, 0.035)
  }

  const near: NearBuilding[] = []
  const nNear = r.int(2, 4)
  for (let i = 0; i < nNear; i++) {
    const w = r.range(0.14, 0.3)
    const x = r.chance(0.5) ? r.range(-0.06, 0.25) : r.range(0.55, 0.92)
    const h = r.range(0.28, 0.55)
    const windows: NearBuilding['windows'] = []
    const cols = Math.max(1, Math.floor(w * 26))
    const rows = Math.max(2, Math.floor(h * 14))
    for (let c = 0; c < cols; c++) {
      for (let rw = 0; rw < rows; rw++) {
        if (r.chance(0.16)) {
          windows.push({
            x: x + (0.14 + c) * (w / cols),
            y: groundY - h + (0.2 + rw) * (h / rows),
            phase: r.range(0, 100),
          })
        }
      }
    }
    near.push({ x, w, h, windows })
  }

  const lamps: Lamp[] = []
  const nLamps = r.int(1, 2)
  for (let i = 0; i < nLamps; i++) {
    lamps.push({ x: r.range(0.18, 0.82), headY: r.range(0.42, 0.55), spread: r.range(0.09, 0.16) })
  }

  const blobs: Blob[] = []
  const nBlobs = r.int(2, 5)
  for (let i = 0; i < nBlobs; i++) {
    blobs.push({
      dur: r.range(9, 22),
      gap: r.range(5, 26),
      phase: r.range(0, 60),
      dir: r.chance(0.5) ? 1 : -1,
      y: r.range(groundY - 0.02, groundY + 0.06),
      hf: r.range(0.055, 0.095),
      bobFreq: r.range(5, 8),
    })
  }

  const scene: Scene = {
    horizonY,
    groundY,
    far,
    near,
    fence: r.chance(0.5) ? { y: r.range(0.66, 0.76), step: r.range(0.045, 0.075) } : null,
    lamps,
    blobs,
    quality: r.range(0.62, 0.98),
    dropPeriod: r.range(40, 90),
    dropDur: r.range(4, 8),
    dropPhase: r.range(0, 90),
    motionPeriod: r.range(14, 38),
    motionPhase: r.range(0, 38),
    uptime: r.range(97.4, 99.9).toFixed(1),
  }
  scenes.set(camId, scene)
  return scene
}

/** Deterministic per-camera uptime figure for tile headers. */
export function camUptime(camId: string): string {
  return getScene(camId).uptime
}

/* ── signal state ──────────────────────────────────────────────────── */

export type FeedSignal = 'live' | 'lost' | 'reacq'

/** Seeded RF dropout cycle (~every 40–90 s, lasting 4–8 s, last 1.6 s reacquiring). */
export function feedSignal(camId: string, tMs: number): FeedSignal {
  const s = getScene(camId)
  const ph = (tMs / 1000 + s.dropPhase) % s.dropPeriod
  if (ph < s.dropDur - 1.6) return 'lost'
  if (ph < s.dropDur) return 'reacq'
  return 'live'
}

/* ── helpers ───────────────────────────────────────────────────────── */

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t

const hash01 = (s: string): number => hashString(s) / 4294967296

/** blob x position in 0..1, or null when off-frame */
function blobX(b: Blob, tSec: number): number | null {
  const cycle = b.dur + b.gap
  const tc = (tSec + b.phase) % cycle
  if (tc >= b.dur) return null
  const p = tc / b.dur
  return b.dir === 1 ? -0.08 + 1.16 * p : 1.08 - 1.16 * p
}

/* ── main draw ─────────────────────────────────────────────────────── */

export function drawSimFeed(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  cam: Camera,
  tMs: number,
  night: number,
): void {
  const s = getScene(cam.id)
  const tSec = tMs / 1000

  /* SIGNAL LOST — sector blacked out by the Infrastructure module */
  if (!cam.online) {
    drawStatic(ctx, w, h, tMs)
    hudTag(ctx, 'SIGNAL LOST // GRID DARK', w / 2, h / 2 - 8, RED, { alpha: 0.6 + 0.4 * Math.abs(Math.sin(tMs / 480)) })
    hudText(ctx, `${cam.sector} POWER FAIL — AWAITING RESTORE`, w / 2, h / 2 + 12, TEXT_FAINT, { back: false, anchor: 'tc' })
    drawHudChrome(ctx, w, h, cam, s, false)
    return
  }

  /* seeded RF dropout cycle */
  const sig = feedSignal(cam.id, tMs)
  if (sig === 'lost') {
    drawStatic(ctx, w, h, tMs)
    hudTag(ctx, 'SIGNAL LOST', w / 2, h / 2, RED, { alpha: 0.6 + 0.4 * Math.abs(Math.sin(tMs / 480)) })
    drawHudChrome(ctx, w, h, cam, s, false)
    return
  }

  /* ── live scene ── */
  const n = night // 0 = noon, 1 = deep night

  // sky
  const sky = ctx.createLinearGradient(0, 0, 0, h * s.horizonY * 1.15)
  sky.addColorStop(0, `rgb(${lerp(19, 6, n)}, ${lerp(26, 9, n)}, ${lerp(36, 14, n)})`)
  sky.addColorStop(1, `rgb(${lerp(26, 10, n)}, ${lerp(34, 15, n)}, ${lerp(46, 22, n)})`)
  ctx.fillStyle = sky
  ctx.fillRect(0, 0, w, h)

  // far skyline
  ctx.fillStyle = `rgb(${lerp(13, 7, n)}, ${lerp(17, 10, n)}, ${lerp(24, 15, n)})`
  for (const b of s.far) {
    ctx.fillRect(b.x * w, (s.horizonY - b.h) * h, b.w * w + 1, b.h * h)
  }
  // antenna beacons
  for (const b of s.far) {
    if (!b.antenna) continue
    const ax = (b.x + b.w / 2) * w
    const topY = (s.horizonY - b.h) * h
    ctx.fillStyle = 'rgba(60, 72, 88, 0.8)'
    ctx.fillRect(ax, topY - h * 0.045, 1, h * 0.045)
    if (Math.sin(tSec * 1.7 + b.antennaPhase) > 0.55) {
      ctx.fillStyle = 'rgba(255, 59, 71, 0.55)'
      ctx.fillRect(ax - 1, topY - h * 0.05, 2, 2)
    }
  }

  // ground plane
  ctx.fillStyle = `rgb(${lerp(9, 4, n)}, ${lerp(12, 6, n)}, ${lerp(17, 10, n)})`
  ctx.fillRect(0, s.horizonY * h, w, h)

  // lamp cones (stronger at night)
  for (const lamp of s.lamps) {
    const lx = lamp.x * w
    const hy = lamp.headY * h
    const gy = (s.groundY + 0.05) * h
    const spread = lamp.spread * w
    const coneA = 0.05 + 0.11 * n
    const grad = ctx.createLinearGradient(0, hy, 0, gy)
    grad.addColorStop(0, `rgba(190, 208, 235, ${coneA})`)
    grad.addColorStop(1, 'rgba(190, 208, 235, 0)')
    ctx.fillStyle = grad
    ctx.beginPath()
    ctx.moveTo(lx - 1.5, hy)
    ctx.lineTo(lx + 1.5, hy)
    ctx.lineTo(lx + spread, gy)
    ctx.lineTo(lx - spread, gy)
    ctx.closePath()
    ctx.fill()
    // pole + head
    ctx.fillStyle = 'rgba(8, 11, 16, 0.9)'
    ctx.fillRect(lx - 0.5, hy, 1, gy - hy)
    ctx.fillStyle = `rgba(210, 224, 245, ${0.35 + 0.5 * n})`
    ctx.fillRect(lx - 2, hy - 1, 4, 2)
    // light pool on the ground
    ctx.fillStyle = `rgba(190, 208, 235, ${coneA * 0.7})`
    ctx.beginPath()
    ctx.ellipse(lx, gy, spread * 0.9, h * 0.014, 0, 0, Math.PI * 2)
    ctx.fill()
  }

  // near silhouettes + windows
  for (const b of s.near) {
    ctx.fillStyle = `rgb(${lerp(6, 3, n)}, ${lerp(8, 5, n)}, ${lerp(12, 8, n)})`
    ctx.fillRect(b.x * w, (s.groundY - b.h) * h, b.w * w, b.h * h + 2)
    const winA = 0.08 + 0.26 * n
    for (const win of b.windows) {
      const flicker = Math.sin(tSec * 0.31 + win.phase) > -0.92 ? 1 : 0 // rare off-blink
      if (!flicker) continue
      ctx.fillStyle = `rgba(244, 200, 122, ${winA})`
      ctx.fillRect(win.x * w, win.y * h, Math.max(1, w * 0.004), Math.max(1, h * 0.006))
    }
  }

  // fence line
  if (s.fence) {
    const fy = s.fence.y * h
    ctx.strokeStyle = 'rgba(5, 7, 11, 0.95)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(0, fy)
    ctx.lineTo(w, fy)
    ctx.moveTo(0, fy + h * 0.022)
    ctx.lineTo(w, fy + h * 0.022)
    ctx.stroke()
    for (let x = 0; x < 1; x += s.fence.step) {
      ctx.fillStyle = 'rgba(5, 7, 11, 0.95)'
      ctx.fillRect(x * w, fy - h * 0.012, 1, h * 0.05)
    }
  }

  // drifting entity blobs (soft dark ellipses, slight bob)
  const visible: { x: number; y: number; bw: number; bh: number }[] = []
  for (const b of s.blobs) {
    const bx = blobX(b, tSec)
    if (bx === null || bx < -0.05 || bx > 1.05) continue
    const bh = b.hf * h
    const bw = bh * 0.42
    const bob = Math.sin(tSec * b.bobFreq) * bh * 0.035
    const cx = bx * w
    const cy = b.y * h - bh / 2 + bob
    const grad = ctx.createRadialGradient(cx, cy, bw * 0.2, cx, cy, bh * 0.62)
    grad.addColorStop(0, 'rgba(2, 4, 7, 0.92)')
    grad.addColorStop(0.75, 'rgba(2, 4, 7, 0.55)')
    grad.addColorStop(1, 'rgba(2, 4, 7, 0)')
    ctx.fillStyle = grad
    ctx.beginPath()
    ctx.ellipse(cx, cy, bw, bh / 2, (b.dir * bob) / bh, 0, Math.PI * 2)
    ctx.fill()
    visible.push({ x: cx, y: cy, bw, bh })
  }

  // occasional auto MOTION DETECTED box tracking one blob (~2.2 s window)
  const mCycle = Math.floor((tSec + s.motionPhase) / s.motionPeriod)
  const mT = (tSec + s.motionPhase) % s.motionPeriod
  if (mT < 2.2 && visible.length > 0) {
    const target = visible[mCycle % visible.length]
    const conf = 0.5 + hash01(`${cam.id}:m:${mCycle}`) * 0.42
    const bx = target.x - target.bw * 1.5
    const by = target.y - target.bh * 0.68
    const bw = target.bw * 3
    const bh = target.bh * 1.36
    const blinkIn = mT < 0.24 ? (Math.floor(mT / 0.08) % 2 === 0 ? 1 : 0.2) : 1
    drawBracketBox(ctx, bx, by, bw, bh, CYAN_DIM, { alpha: blinkIn })
    hudText(ctx, `MOTION DETECTED ${conf.toFixed(2)}`, bx, by - 13, CYAN_DIM, { back: true })
    drawConfBar(ctx, bx, by - 3, Math.min(bw, 52), conf, CYAN_DIM)
  }

  // per-tile signal quality: grain + rare horizontal displacement glitch
  drawGrain(ctx, w, h, 0.05 + (1 - s.quality) * 0.1)
  if (Math.random() < (1 - s.quality) * 0.03) {
    const gy = Math.random() * h
    const gh = 2 + Math.random() * 5
    ctx.drawImage(ctx.canvas, 0, gy, w, gh, (Math.random() - 0.5) * 14, gy, w, gh)
  }
  drawScanRow(ctx, w, h, tMs + hashString(cam.id) % 4000, 0.028)

  if (sig === 'reacq') {
    // scene visible but noisy while the link re-syncs
    drawGrain(ctx, w, h, 0.3)
    const ph = (tSec + s.dropPhase) % s.dropPeriod
    const prog = Math.min(99, Math.round(((ph - (s.dropDur - 1.6)) / 1.6) * 100))
    hudTag(ctx, `REACQUIRING… ${pad(prog)}%`, w / 2, h / 2, AMBER)
  }

  drawHudChrome(ctx, w, h, cam, s, true)
}

/* ── per-tile HUD chrome ───────────────────────────────────────────── */

function drawHudChrome(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  cam: Camera,
  s: Scene,
  live: boolean,
): void {
  const d = new Date()
  const cs = pad(Math.floor(d.getUTCMilliseconds() / 10))
  hudText(ctx, `${cam.id} // ${cam.label}`, 6, 5, live ? TEXT_DIM : TEXT_FAINT)
  hudText(ctx, `UTC ${fmtUTC(d)}.${cs}`, w - 6, 5, live ? TEXT_DIM : TEXT_FAINT, { anchor: 'tr' })
  hudText(ctx, live ? `UPTIME ${s.uptime}%` : 'LINK DOWN', 6, h - 5, live ? TEXT_FAINT : RED, { anchor: 'bl' })
  hudText(ctx, `${cam.sector.replace('SECTOR-', 'S-')} · SYN-FEED`, w - 6, h - 5, TEXT_FAINT, { anchor: 'br' })
}
