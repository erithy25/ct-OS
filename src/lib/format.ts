/** Formatting helpers — tabular, zero-padded, ops-console style. */

export const pad = (n: number, w = 2): string => String(Math.floor(Math.abs(n))).padStart(w, '0')

export function fmtUTC(d: Date): string {
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
}

export function fmtLocal(d: Date): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** sim-minutes → `D02 · 14:36` */
export function fmtSimClock(simMinutes: number): string {
  const day = Math.floor(simMinutes / 1440)
  const m = Math.floor(simMinutes % 1440)
  return `D${pad(day)} ${pad(Math.floor(m / 60))}:${pad(m % 60)}`
}

/** sim-minutes → `14:36` */
export function fmtSimTime(simMinutes: number): string {
  const m = Math.floor(simMinutes % 1440)
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`
}

export function fmtNum(n: number): string {
  return Math.round(n).toLocaleString('en-US')
}

export function fmtPct(n: number, digits = 1): string {
  return `${n.toFixed(digits)}%`
}

/** world position → fake grid-reference readout */
export function fmtCoord(x: number, y: number): string {
  return `${(41 + x / 4000).toFixed(4)}N ${(70 + y / 4000).toFixed(4)}W`
}

export function fmtTick(t: number): string {
  return `#${String(t).padStart(6, '0')}`
}
