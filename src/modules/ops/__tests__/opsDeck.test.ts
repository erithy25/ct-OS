/**
 * OPS DECK render smoke tests (node env, SSR renderToString).
 *
 * Effects (canvas draws, observers, typewriter) don't run under SSR — these
 * tests exercise the render path: store wiring, ranking/sorting, newest-first
 * event ordering and the virtualization window math.
 */
import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { getEvents, getHistories, useSim } from '../../../sim/store'
import type { ThreatEntry, HotspotForecast } from '../../../sim/types'
import OpsDeck from '../OpsDeck'

/** SSR inserts `<!-- -->` between dynamic/static text nodes — strip for assertions */
const render = () => renderToString(createElement(OpsDeck)).replace(/<!-- -->/g, '')

/**
 * zustand v5 serves `getInitialState()` as the useSyncExternalStore server
 * snapshot, so SSR hook reads ignore setState. Patch both so renderToString
 * sees the injected data (browser renders read live state as normal).
 */
const patchStore = (patch: Partial<ReturnType<typeof useSim.getState>>) => {
  useSim.setState(patch)
  Object.assign(useSim.getInitialState(), patch)
}

describe('OpsDeck', () => {
  it('renders all four zones in the empty pre-warmup state', () => {
    const html = render()
    for (const s of [
      'INCIDENT RATE',
      'ACTIVE UNITS',
      'SENSOR UPTIME %',
      'CITY RISK INDEX',
      'DETECTIONS/MIN',
      'NETWORK LOAD',
      'THREAT BOARD',
      'SOURCE: SIMULATED',
      'PREDICTIVE // NEXT-HOUR HOTSPOT FORECAST',
      'AI LAYER · SIMULATED',
      'ANALYST NOTE',
      'AUTO-GENERATED // TEMPLATED FROM LIVE SIM METRICS',
      'EVENT LOG',
    ]) {
      expect(html).toContain(s)
    }
    // analyst note initial text comes straight from the store
    expect(html).toContain(useSim.getState().analystNote)
  })

  it('shows current values and Δ arrow once histories have >30 samples', () => {
    const h = getHistories()
    for (let i = 0; i < 40; i++) {
      h.riskIndex.push(10 + i) // rising
      h.incidentRate.push(2)
      h.detectionsPerMin.push(30)
      h.netLoad.push(50)
      h.activeUnits.push(12)
      h.sensorUptime.push(97.5)
    }
    useSim.setState((s) => ({ vitalsVersion: s.vitalsVersion + 1 }))
    const html = render()
    expect(html).toContain('49.0') // riskIndex last value, fmt1
    expect(html).toContain('97.5%') // sensorUptime, fmtPct1
    expect(html).toContain('▲') // rising Δ
  })

  it('ranks the threat board by risk desc and renders risk-threshold data', () => {
    const board: ThreatEntry[] = [
      { id: 'P-001', name: 'AAA LOWRISK', risk: 30, sector: 'SECTOR-1', flags: 1, tracked: false },
      { id: 'P-002', name: 'BBB TOPRISK', risk: 82, sector: 'SECTOR-2', flags: 4, tracked: true },
      { id: 'P-003', name: 'CCC MIDRISK', risk: 55, sector: 'SECTOR-3', flags: 2, tracked: false },
    ]
    patchStore({ threatBoard: board })
    const html = render()
    const iTop = html.indexOf('BBB TOPRISK')
    const iMid = html.indexOf('CCC MIDRISK')
    const iLow = html.indexOf('AAA LOWRISK')
    expect(iTop).toBeGreaterThan(-1)
    expect(iTop).toBeLessThan(iMid)
    expect(iMid).toBeLessThan(iLow)
    expect(html).toContain('3 TRACKED CASES')
  })

  it('renders hotspot probabilities, confidence and driver tags', () => {
    const hotspots: HotspotForecast[] = [
      { sector: 'SECTOR-7', probability: 0.62, confidence: 0.83, driver: 'POWER LOSS' },
      { sector: 'SECTOR-2', probability: 0.41, confidence: 0.71, driver: 'CONGESTION' },
    ]
    patchStore({ hotspots, analystNote: 'TEST NOTE // REALLOCATE UNITS.' })
    const html = render()
    expect(html).toContain('SECTOR-7')
    expect(html).toContain('62%')
    expect(html).toContain('CONF 83%')
    expect(html).toContain('POWER LOSS')
    expect(html).toContain('TEST NOTE // REALLOCATE UNITS.')
  })

  it('lists events newest-first and windows long lists with a bottom spacer', () => {
    const emit = useSim.getState().emit
    for (let i = 0; i < 40; i++) emit('NOTICE', 'DETECTION', `EVT NUMBER ${String(i).padStart(2, '0')}`, 'SECTOR-4', 'CAM-05')
    emit('CRIT', 'INCIDENT', 'FINAL ALPHA EVENT', 'SECTOR-9', 'P-042')

    const html = render()
    const total = getEvents().length
    expect(html).toContain(`/${total} EVT`)
    // newest first
    expect(html.indexOf('FINAL ALPHA EVENT')).toBeLessThan(html.indexOf('EVT NUMBER 39'))
    // virtualization: initial window = ceil(viewH 320 / 22) + overscan 8 = 23 rows
    const rendered = Math.min(total, Math.ceil(320 / 22) + 8)
    expect(html).not.toContain('EVT NUMBER 00') // oldest rows are windowed out
    const spacer = (total - rendered) * 22
    expect(html).toContain(`height:${spacer}px`)
  })
})
