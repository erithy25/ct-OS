/**
 * PROFILER — SSR smoke render. Validates the whole render tree (controls
 * bar, chart SVG, dossier, empty state) executes without a DOM; effects
 * (zoom/drag/sim wiring) are exercised in the browser only.
 */
import { afterAll, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import RelationshipGraph from '../RelationshipGraph'
import { useSim } from '../../../sim/store'

/* the app is client-only; React's "useLayoutEffect does nothing on the
   server" warning is expected noise in this node-env smoke render */
const errSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
  const msg = String(args[0] ?? '')
  if (msg.includes('useLayoutEffect does nothing on the server')) return
  console.warn(...args)
})
afterAll(() => errSpy.mockRestore())

describe('RelationshipGraph', () => {
  it('renders the empty state when no person is selected', () => {
    useSim.setState({ selectedId: null })
    const html = renderToString(createElement(RelationshipGraph))
    expect(html).toContain('NO SUBJECT DESIGNATED')
    expect(html).toContain('PULL A THREAD')
    expect(html).toContain('SOURCE: SIMULATED')
  })

  it('renders chart + controls + dossier when rooted on a person', () => {
    useSim.setState({ selectedId: 'P-0007' })
    try {
      const html = renderToString(createElement(RelationshipGraph))
      expect(html).toContain('data-nid="P-0007"')
      expect(html).toContain('DEGREES')
      expect(html).toContain('EXPORT LINK CHART')
      expect(html).toContain('SUBJECT DOSSIER')
      expect(html).toContain('ACTIVITY TIMELINE')
      expect(html).toContain('SOURCE: SIMULATED')
      expect(html).toContain('lc-arrow')
    } finally {
      useSim.setState({ selectedId: null })
    }
  })
})
