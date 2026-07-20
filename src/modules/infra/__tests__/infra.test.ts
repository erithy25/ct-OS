/**
 * INFRASTRUCTURE CONTROL — headless render smoke tests.
 *
 * Renders the module with react-dom/server against the real store + world and
 * asserts the board reflects EXTERNAL store changes. zustand's react binding
 * is swapped (test-only) for a pass-through that evaluates each `useSim`
 * selector against the LIVE store state — server renders would otherwise pin
 * to getInitialState() — so every assertion proves the rendered board derives
 * from the store alone (no local optimistic state beyond animation).
 */
import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'

/* eslint-disable @typescript-eslint/no-explicit-any */
vi.mock('zustand', async () => {
  const { createStore } = await import('zustand/vanilla')
  const create = (init: any): any => {
    const api: any = createStore(init)
    const hook = (selector?: (s: any) => any): any => (selector ? selector(api.getState()) : api.getState())
    return Object.assign(hook, api)
  }
  return { create }
})
/* eslint-enable @typescript-eslint/no-explicit-any */

import InfrastructureControl from '../InfrastructureControl'
import { getWorld, SECTORS, useSim } from '../../../sim/store'

/* strip React SSR text-node separators (`<!-- -->`) so interpolated strings match */
const render = (): string => renderToString(createElement(InfrastructureControl)).replace(/<!-- -->/g, '')

describe('InfrastructureControl', () => {
  it('renders all six control groups against the live world', () => {
    const html = render()
    expect(html).toContain('SYSTEM INTEGRITY')
    expect(html).toContain('POWER GRID')
    expect(html).toContain('TRAFFIC CONTROL')
    expect(html).toContain('TRANSIT AUTHORITY')
    expect(html).toContain('BRIDGE CONTROL')
    expect(html).toContain('COMMS MESH')
    expect(html).toContain('WATER / UTILITIES')
    expect(html).toContain('AUTO-RESTORE')
    for (const s of SECTORS) expect(html).toContain(s)
    for (const d of getWorld().city.districts) expect(html).toContain(d.name)
    for (const b of getWorld().city.bridges) expect(html).toContain(b.id)
    expect(html).toContain('METRO-A')
    expect(html).toContain('NOVA HARBOR IS FICTION')
  })

  it('reflects external store changes (single source of truth)', () => {
    const st = useSim.getState()

    st.setPower('SECTOR-3', false)
    st.setTraffic('SECTOR-2', 'BLACKOUT')
    st.setComms('SECTOR-5', false)
    st.setBridge(getWorld().city.bridges[0].id, true)
    st.setTransit('METRO-B', 'HOLD')

    const html = render()
    expect(html).toContain('GRID DARK')
    expect(html).toContain('SIGNALS DARK')
    expect(html).toContain('SUPPRESSED')
    expect(html).toContain('SPAN OPEN')
    expect(html).toContain('REDUCED') // water strip degrades with SECTOR-3 dark
    expect(html).toContain('8/9 ENERGIZED')
    expect(html).toContain('8/9 UP')
    expect(html).toContain('1 RAISED')
    expect(html).toContain('2/3 RUNNING')
  })

  it('auto-restore clears every destabilization tag', () => {
    useSim.getState().autoRestore()
    const html = render()
    expect(html).not.toContain('GRID DARK')
    expect(html).not.toContain('SIGNALS DARK')
    expect(html).not.toContain('SUPPRESSED')
    expect(html).not.toContain('SPAN OPEN')
    expect(html).toContain('9/9 ENERGIZED')
    expect(html).toContain('9/9 UP')
    expect(html).toContain('0 RAISED')
    expect(html).toContain('3/3 RUNNING')
  })
})
