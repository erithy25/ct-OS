/**
 * PROFILER — relationship graph (link-analysis) module.
 *
 * SVG + d3-force ego network around a root person. Progressive disclosure:
 * clicking a person node "pulls the thread" — it becomes the new root, the
 * network recomputes (deterministic per id), persisting node positions so
 * the web unfolds instead of resetting. Pan/zoom (d3-zoom 0.4–3×), node
 * drag (d3-drag, reheat α≈0.3), hover highlighting, substring search,
 * degree control, edge-type filters, PNG export, rich side dossier.
 *
 * The chart SVG uses EXPLICIT attributes only (see glyphs.tsx) so export
 * is a straight serialization.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react'
import { drag as d3drag, type D3DragEvent } from 'd3-drag'
import { select } from 'd3-selection'
import { zoom as d3zoom, zoomIdentity, zoomTransform, type D3ZoomEvent, type ZoomBehavior } from 'd3-zoom'
import { getDossier, getNetwork } from '../../sim/identityFactory'
import { getWorld, useSim } from '../../sim/store'
import type { EdgeType, GraphEdge, GraphNode, LinkNetwork } from '../../sim/types'
import Dossier, { type FocusInfo } from './Dossier'
import { exportLinkChart } from './exportPng'
import { ForceLayout, type SimNode } from './forceLayout'
import { C, DIRECTED, EDGE_TYPES, NodeGlyph, ROOT_R, nodeRadius } from './glyphs'

const isPersonId = (id: string | null | undefined): id is string => !!id && id.startsWith('P-')

const setLine = (el: SVGLineElement, x1: number, y1: number, x2: number, y2: number): void => {
  el.setAttribute('x1', x1.toFixed(2))
  el.setAttribute('y1', y1.toFixed(2))
  el.setAttribute('x2', x2.toFixed(2))
  el.setAttribute('y2', y2.toFixed(2))
}

interface EdgeEls {
  line: SVGLineElement
  hit: SVGLineElement
  label: SVGGElement
}

export default function RelationshipGraph() {
  const selectedId = useSim((s) => s.selectedId)
  const storeSelect = useSim((s) => s.select)

  const [rootId, setRootId] = useState<string | null>(() => {
    const sel = useSim.getState().selectedId
    return isPersonId(sel) ? sel : null
  })
  const [hops, setHops] = useState(2)
  const [query, setQuery] = useState('')
  const [activeTypes, setActiveTypes] = useState<ReadonlySet<EdgeType>>(() => new Set(EDGE_TYPES))
  const [hoverNode, setHoverNode] = useState<string | null>(null)
  const [hoverEdge, setHoverEdge] = useState<string | null>(null)
  const [focusId, setFocusId] = useState<string | null>(null)
  const [zoomedIn, setZoomedIn] = useState(false)

  /* re-root whenever the world selection lands on a person */
  useEffect(() => {
    if (isPersonId(selectedId)) setRootId(selectedId)
  }, [selectedId])

  /* ── derived network state ─────────────────────────────────────────── */

  const net: LinkNetwork | null = useMemo(() => (rootId ? getNetwork(rootId, hops) : null), [rootId, hops])
  const rootDossier = useMemo(() => (rootId ? getDossier(rootId) : null), [rootId])

  const adjacency = useMemo(() => {
    const m = new Map<string, Set<string>>()
    if (!net) return m
    const add = (a: string, b: string): void => {
      const s = m.get(a)
      if (s) s.add(b)
      else m.set(a, new Set([b]))
    }
    for (const e of net.edges) {
      add(e.source, e.target)
      add(e.target, e.source)
    }
    return m
  }, [net])

  const edgeById = useMemo(() => new Map((net?.edges ?? []).map((e) => [e.id, e])), [net])

  const matchSet = useMemo(() => {
    const q = query.trim().toUpperCase()
    if (!q || !net) return null
    const s = new Set<string>()
    for (const n of net.nodes) {
      if (n.label.toUpperCase().includes(q) || n.id.toUpperCase().includes(q) || (n.sub ?? '').toUpperCase().includes(q)) s.add(n.id)
    }
    return s
  }, [net, query])

  const visibleEdges = useMemo(() => (net ? net.edges.filter((e) => activeTypes.has(e.type)) : []), [net, activeTypes])
  const filtersActive = activeTypes.size < EDGE_TYPES.length

  const visibleDegree = useMemo(() => {
    const m = new Map<string, number>()
    for (const e of visibleEdges) {
      m.set(e.source, (m.get(e.source) ?? 0) + 1)
      m.set(e.target, (m.get(e.target) ?? 0) + 1)
    }
    return m
  }, [visibleEdges])

  const hoverHood = useMemo(() => {
    if (!hoverNode) return null
    const s = new Set<string>([hoverNode])
    for (const nb of adjacency.get(hoverNode) ?? []) s.add(nb)
    return s
  }, [hoverNode, adjacency])

  const hoverEdgeEnds = useMemo(() => {
    if (!hoverEdge) return null
    const e = edgeById.get(hoverEdge)
    return e ? new Set([e.source, e.target]) : null
  }, [hoverEdge, edgeById])

  const focusInfo: FocusInfo | null = useMemo(() => {
    if (!focusId || !net) return null
    const node = net.nodes.find((n) => n.id === focusId)
    if (!node) return null
    const edge = net.edges.find((e) => e.source === focusId || e.target === focusId)
    return { node, via: edge?.type ?? null, degree: adjacency.get(focusId)?.size ?? 0 }
  }, [focusId, net, adjacency])

  /* stale interaction state cannot survive a network swap */
  useEffect(() => {
    setHoverNode(null)
    setHoverEdge(null)
  }, [net])
  useEffect(() => {
    if (focusId && net && !net.nodes.some((n) => n.id === focusId)) setFocusId(null)
  }, [net, focusId])

  /* ── imperative graph plumbing ─────────────────────────────────────── */

  const containerRef = useRef<HTMLDivElement | null>(null)
  const svgRef = useRef<SVGSVGElement | null>(null)
  const viewportRef = useRef<SVGGElement | null>(null)
  const nodeEls = useRef(new Map<string, SVGGElement>())
  const edgeEls = useRef(new Map<string, EdgeEls>())
  const layoutRef = useRef<ForceLayout | null>(null)
  const zoomRef = useRef<ZoomBehavior<SVGSVGElement, unknown> | null>(null)
  const sizeRef = useRef({ w: 800, h: 600 })
  const tweenRaf = useRef(0)
  const zoomReadout = useRef<HTMLSpanElement | null>(null)
  const gesture = useRef({ moved: false, x0: 0, y0: 0 })
  const rootIdRef = useRef(rootId)
  rootIdRef.current = rootId
  const prevRootRef = useRef<string | null>(null)

  /** push sim positions into the DOM (tick callback + after every commit) */
  const applyPositions = useCallback(() => {
    const layout = layoutRef.current
    if (!layout) return
    const rid = rootIdRef.current
    for (const n of layout.nodes) {
      const el = nodeEls.current.get(n.id)
      if (el) el.setAttribute('transform', `translate(${(n.x ?? 0).toFixed(2)},${(n.y ?? 0).toFixed(2)})`)
    }
    for (const l of layout.links) {
      const els = edgeEls.current.get(l.id)
      if (!els) continue
      const s = l.source as SimNode | string
      const t = l.target as SimNode | string
      if (typeof s === 'string' || typeof t === 'string') continue
      const sx = s.x ?? 0
      const sy = s.y ?? 0
      const tx = t.x ?? 0
      const ty = t.y ?? 0
      const dx = tx - sx
      const dy = ty - sy
      const dist = Math.hypot(dx, dy) || 1
      const ux = dx / dist
      const uy = dy / dist
      const sr = (s.id === rid ? ROOT_R : s.r) + 2
      const tr = (t.id === rid ? ROOT_R : t.r) + (DIRECTED.has(l.type) ? 7 : 2)
      setLine(els.line, sx + ux * sr, sy + uy * sr, tx - ux * tr, ty - uy * tr)
      setLine(els.hit, sx, sy, tx, ty)
      els.label.setAttribute('transform', `translate(${((sx + tx) / 2).toFixed(2)},${((sy + ty) / 2).toFixed(2)})`)
    }
  }, [])

  if (!layoutRef.current) layoutRef.current = new ForceLayout(applyPositions)

  /** smooth camera pan so (x, y) in sim space lands at the viewport center */
  const tweenTo = useCallback((x: number, y: number) => {
    const svg = svgRef.current
    const zb = zoomRef.current
    if (!svg || !zb) return
    cancelAnimationFrame(tweenRaf.current)
    const start = zoomTransform(svg)
    const k = start.k
    const ex = sizeRef.current.w / 2 - k * x
    const ey = sizeRef.current.h / 2 - k * y
    if (Math.hypot(ex - start.x, ey - start.y) < 1) return
    const sel = select(svg)
    const t0 = performance.now()
    const dur = 480
    const step = (now: number): void => {
      const p = Math.min(1, (now - t0) / dur)
      const e = 1 - Math.pow(1 - p, 3)
      zb.transform(sel, zoomIdentity.translate(start.x + (ex - start.x) * e, start.y + (ey - start.y) * e).scale(k))
      if (p < 1) tweenRaf.current = requestAnimationFrame(step)
    }
    tweenRaf.current = requestAnimationFrame(step)
  }, [])

  /** node click (derived from a no-movement drag gesture): pull the thread / focus */
  const clickRef = useRef<(id: string) => void>(() => {})
  clickRef.current = (id: string) => {
    const n = net?.nodes.find((nn) => nn.id === id)
    if (!n) return
    if (n.type === 'person') {
      if (id !== rootId) {
        setFocusId(null)
        setRootId(id)
        storeSelect(id)
      } else {
        const rn = layoutRef.current?.getNode(id)
        if (rn) tweenTo(rn.x ?? 0, rn.y ?? 0)
      }
    } else {
      setFocusId((f) => (f === id ? null : id))
    }
  }

  const hasNet = !!net && !!rootId

  /* feed the layout; on re-root, glide the camera to the new center */
  useLayoutEffect(() => {
    const layout = layoutRef.current
    if (!layout || !net || !rootId) return
    layout.setNetwork(net, rootId)
    applyPositions()
    if (prevRootRef.current !== rootId) {
      prevRootRef.current = rootId
      const rn = layout.getNode(rootId)
      if (rn) tweenTo(rn.x ?? 0, rn.y ?? 0)
    }
  }, [net, rootId, applyPositions, tweenTo])

  /* keep freshly (re)rendered elements in position — cheap, every commit */
  useLayoutEffect(() => {
    applyPositions()
  })

  /* zoom / pan behavior + container measurement */
  useEffect(() => {
    if (!hasNet) return
    const svg = svgRef.current
    const vp = viewportRef.current
    const wrap = containerRef.current
    if (!svg || !vp || !wrap) return

    const measure = (): void => {
      const r = wrap.getBoundingClientRect()
      if (r.width > 0 && r.height > 0) sizeRef.current = { w: r.width, h: r.height }
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(wrap)

    const zb = d3zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.4, 3])
      .on('zoom', (ev: D3ZoomEvent<SVGSVGElement, unknown>) => {
        if (ev.sourceEvent) cancelAnimationFrame(tweenRaf.current)
        vp.setAttribute('transform', ev.transform.toString())
        if (zoomReadout.current) zoomReadout.current.textContent = `${Math.round(ev.transform.k * 100)}%`
        setZoomedIn(ev.transform.k > 1.4)
      })
    zoomRef.current = zb
    const sel = select(svg)
    sel.call(zb)
    sel.on('dblclick.zoom', null)
    zb.transform(sel, zoomIdentity.translate(sizeRef.current.w / 2, sizeRef.current.h / 2))

    return () => {
      ro.disconnect()
      sel.on('.zoom', null)
      zoomRef.current = null
    }
  }, [hasNet])

  /* node drag (d3-drag); a gesture without movement is a click */
  useEffect(() => {
    if (!net) return
    const vp = viewportRef.current
    if (!vp) return
    const behavior = d3drag<SVGGElement, unknown, SimNode>()
      .subject(function (this: SVGGElement) {
        const id = this.getAttribute('data-nid') ?? ''
        return layoutRef.current?.getNode(id) as SimNode
      })
      .on('start', (ev: D3DragEvent<SVGGElement, unknown, SimNode>) => {
        gesture.current = { moved: false, x0: ev.x, y0: ev.y }
      })
      .on('drag', (ev: D3DragEvent<SVGGElement, unknown, SimNode>) => {
        const g = gesture.current
        if (!g.moved && Math.hypot(ev.x - g.x0, ev.y - g.y0) > 3) {
          g.moved = true
          layoutRef.current?.reheat(0.3)
        }
        if (g.moved) {
          ev.subject.fx = ev.x
          ev.subject.fy = ev.y
        }
      })
      .on('end', (ev: D3DragEvent<SVGGElement, unknown, SimNode>) => {
        if (gesture.current.moved) {
          layoutRef.current?.settle()
          ev.subject.fx = null
          ev.subject.fy = null
          if (ev.subject.id === rootIdRef.current) layoutRef.current?.setAnchor(ev.subject.x ?? 0, ev.subject.y ?? 0)
        } else {
          clickRef.current(ev.subject.id)
        }
      })
    const nodesSel = select(vp).selectAll<SVGGElement, unknown>('g[data-nid]')
    nodesSel.call(behavior)
    return () => {
      nodesSel.on('.drag', null)
    }
  }, [net])

  /* teardown: stop the simulation, kill any camera tween */
  useEffect(
    () => () => {
      layoutRef.current?.stop()
      cancelAnimationFrame(tweenRaf.current)
    },
    [],
  )

  /* ── per-render visual state ───────────────────────────────────────── */

  const nodeOpacity = (id: string): number => {
    if (hoverNode === id || focusId === id) return 1 // direct attention beats any dimming
    let o = 1
    if (matchSet && !matchSet.has(id)) o = 0.15
    if (hoverHood && !hoverHood.has(id)) o = Math.min(o, 0.25)
    if (filtersActive && id !== rootId && (visibleDegree.get(id) ?? 0) === 0) o = Math.min(o, 0.3)
    return o
  }

  const nodeLabelShown = (n: GraphNode): boolean =>
    n.type === 'person' ||
    zoomedIn ||
    (hoverHood?.has(n.id) ?? false) ||
    (hoverEdgeEnds?.has(n.id) ?? false) ||
    (matchSet?.has(n.id) ?? false) ||
    focusId === n.id

  const toggleType = (t: EdgeType): void =>
    setActiveTypes((prev) => {
      const next = new Set(prev)
      if (next.has(t)) next.delete(t)
      else next.add(t)
      return next
    })

  const onExport = (): void => {
    if (svgRef.current && rootId && rootDossier) exportLinkChart(svgRef.current, rootId, rootDossier.name)
  }

  /* ── empty state ───────────────────────────────────────────────────── */

  if (!hasNet || !net || !rootId || !rootDossier) {
    return (
      <EmptyState
        onPick={(id) => {
          setRootId(id)
          storeSelect(id)
        }}
      />
    )
  }

  /* ── module ────────────────────────────────────────────────────────── */

  return (
    <div className="rise-in flex h-full w-full flex-col gap-1.5 p-1.5">
      {/* controls bar */}
      <div className="panel-surface flex h-8 shrink-0 items-center gap-2.5 overflow-x-auto px-2">
        <div className="flex shrink-0 items-center gap-1 border border-line bg-panel2 px-1.5 py-0.5 transition-colors duration-150 ease-tac focus-within:border-accent/60">
          <span className="text-[10px] text-dim" aria-hidden>
            ⌕
          </span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="SEARCH NODES"
            spellCheck={false}
            className="w-28 bg-transparent text-[10px] uppercase tracking-lbl text-prim placeholder:text-faint focus:outline-none"
          />
          {matchSet && (
            <span className="num lbl shrink-0" style={{ color: matchSet.size > 0 ? C.accent : C.red }}>
              {matchSet.size}/{net.nodes.length}
            </span>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <span className="lbl-faint">DEGREES</span>
          <div className="flex border border-line">
            {[1, 2, 3].map((d) => (
              <button
                key={d}
                onClick={() => setHops(d)}
                className={`num px-1.5 py-0.5 text-[10px] transition-colors duration-150 ease-tac ${
                  hops === d ? 'bg-accent/15 text-accent' : 'text-faint hover:bg-panel2 hover:text-dim'
                }`}
              >
                {d}
              </button>
            ))}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {EDGE_TYPES.map((t) => {
            const on = activeTypes.has(t)
            return (
              <button
                key={t}
                onClick={() => toggleType(t)}
                title={`${on ? 'HIDE' : 'SHOW'} ${t} EDGES`}
                className={`border px-1 py-px text-[9px] uppercase tracking-lbl transition-colors duration-150 ease-tac ${
                  on ? 'border-lineb bg-panel2 text-dim hover:text-prim' : 'border-line text-faint line-through opacity-50 hover:opacity-80'
                }`}
              >
                {t}
              </button>
            )
          })}
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-2.5">
          <span className="num lbl-faint">
            N={net.nodes.length} E={visibleEdges.length}
          </span>
          <button
            onClick={onExport}
            className="lbl border border-line px-1.5 py-0.5 text-dim transition-colors duration-150 ease-tac hover:border-accent hover:text-accent"
          >
            ⤓ EXPORT LINK CHART
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 gap-1.5">
        {/* chart */}
        <div
          ref={containerRef}
          className="relative min-w-0 flex-1 overflow-hidden rounded border border-line bg-void"
          style={{
            backgroundImage:
              'linear-gradient(rgba(201,214,228,0.02) 1px, transparent 1px), linear-gradient(90deg, rgba(201,214,228,0.02) 1px, transparent 1px)',
            backgroundSize: '32px 32px',
          }}
        >
          <svg
            ref={svgRef}
            width="100%"
            height="100%"
            style={{ display: 'block', cursor: 'grab' }}
            fontFamily="'JetBrains Mono','IBM Plex Mono',ui-monospace,monospace"
            onMouseLeave={() => {
              setHoverNode(null)
              setHoverEdge(null)
            }}
          >
            <defs>
              <marker id="lc-arrow" viewBox="0 0 8 8" refX="6.5" refY="4" markerWidth="7" markerHeight="7" orient="auto">
                <path d="M0,0.6 L7,4 L0,7.4 Z" fill={C.lineb} />
              </marker>
              <marker id="lc-arrow-hot" viewBox="0 0 8 8" refX="6.5" refY="4" markerWidth="7" markerHeight="7" orient="auto">
                <path d="M0,0.6 L7,4 L0,7.4 Z" fill={C.accent} />
              </marker>
            </defs>
            <g ref={viewportRef}>
              <g>
                {visibleEdges.map((e) => (
                  <EdgeView
                    key={e.id}
                    edge={e}
                    hovered={hoverEdge === e.id}
                    hotIncident={hoverNode !== null && (e.source === hoverNode || e.target === hoverNode)}
                    dimmed={
                      hoverEdge !== e.id &&
                      ((hoverNode !== null && !(e.source === hoverNode || e.target === hoverNode)) ||
                        (matchSet !== null && !(matchSet.has(e.source) || matchSet.has(e.target))))
                    }
                    labelShown={zoomedIn || hoverEdge === e.id}
                    edgeEls={edgeEls}
                    setHoverEdge={setHoverEdge}
                  />
                ))}
              </g>
              <g>
                {net.nodes.map((n) => {
                  const isRoot = n.id === rootId
                  const r = isRoot ? ROOT_R : nodeRadius(n.type)
                  const showLbl = nodeLabelShown(n)
                  return (
                    <g
                      key={n.id}
                      data-nid={n.id}
                      opacity={nodeOpacity(n.id)}
                      style={{ cursor: 'pointer', transition: 'opacity 180ms cubic-bezier(0.2,0.8,0.2,1)' }}
                      ref={(el) => {
                        if (el) nodeEls.current.set(n.id, el)
                        else nodeEls.current.delete(n.id)
                      }}
                      onMouseEnter={() => setHoverNode(n.id)}
                      onMouseLeave={() => setHoverNode((h) => (h === n.id ? null : h))}
                    >
                      <NodeGlyph type={n.type} r={r} risk={n.risk} isRoot={isRoot} />
                      {focusId === n.id && (
                        <circle pointerEvents="none" r={r + 5.5} fill="none" stroke={C.accent} strokeWidth={1} strokeDasharray="3 3" opacity={0.9} />
                      )}
                      {hoverNode === n.id && !isRoot && (
                        <circle pointerEvents="none" r={r + 4.5} fill="none" stroke={C.accent} strokeWidth={0.75} opacity={0.6} />
                      )}
                      <g pointerEvents="none" style={showLbl ? undefined : { display: 'none' }}>
                        <text
                          y={r + 11}
                          textAnchor="middle"
                          fontSize={isRoot ? 10 : 9}
                          letterSpacing="0.08em"
                          fill={n.type === 'person' ? C.prim : C.dim}
                          stroke={C.void}
                          strokeWidth={3}
                          paintOrder="stroke"
                        >
                          {n.label.toUpperCase()}
                        </text>
                        {(isRoot || hoverNode === n.id) && n.sub && (
                          <text
                            y={r + 21}
                            textAnchor="middle"
                            fontSize={7.5}
                            letterSpacing="0.1em"
                            fill={C.faint}
                            stroke={C.void}
                            strokeWidth={2.5}
                            paintOrder="stroke"
                          >
                            {n.sub.toUpperCase()}
                          </text>
                        )}
                      </g>
                    </g>
                  )
                })}
              </g>
            </g>
          </svg>

          {/* HUD overlays (HTML — excluded from export) */}
          <div className="pointer-events-none absolute left-2 top-1.5 flex items-center gap-1.5">
            <span className="lbl text-accent">◎ {rootDossier.name.toUpperCase()}</span>
            <span className="num lbl-faint">{rootId}</span>
            <span className="lbl border border-violet/60 px-1 text-violet">SIMULATED</span>
          </div>
          <div className="pointer-events-none absolute bottom-1.5 left-2 lbl-faint">SCROLL ZOOM · DRAG PAN · CLICK PERSON = PULL THREAD</div>
          <div className="pointer-events-none absolute bottom-1.5 right-2 num lbl-faint">
            ZOOM <span ref={zoomReadout}>100%</span>
          </div>
        </div>

        <Dossier rootId={rootId} hops={hops} nodeCount={net.nodes.length} edgeCount={visibleEdges.length} focus={focusInfo} onClearFocus={() => setFocusId(null)} />
      </div>
    </div>
  )
}

/* ── edge ────────────────────────────────────────────────────────────── */

function EdgeView({
  edge,
  hovered,
  hotIncident,
  dimmed,
  labelShown,
  edgeEls,
  setHoverEdge,
}: {
  edge: GraphEdge
  hovered: boolean
  hotIncident: boolean
  dimmed: boolean
  labelShown: boolean
  edgeEls: MutableRefObject<Map<string, EdgeEls>>
  setHoverEdge: Dispatch<SetStateAction<string | null>>
}) {
  const hot = hovered || hotIncident
  return (
    <g
      opacity={dimmed ? 0.15 : 1}
      style={{ transition: 'opacity 180ms cubic-bezier(0.2,0.8,0.2,1)' }}
      ref={(el) => {
        if (!el) {
          edgeEls.current.delete(edge.id)
          return
        }
        const line = el.querySelector('line[data-l]')
        const hit = el.querySelector('line[data-h]')
        const label = el.querySelector('g[data-lb]')
        if (line && hit && label) edgeEls.current.set(edge.id, { line: line as SVGLineElement, hit: hit as SVGLineElement, label: label as SVGGElement })
      }}
    >
      <line
        data-l="1"
        pointerEvents="none"
        stroke={hot ? C.accent : C.lineb}
        strokeOpacity={hovered ? 1 : 0.3 + 0.55 * edge.weight}
        strokeWidth={hot ? 1.4 : 1}
        markerEnd={DIRECTED.has(edge.type) ? `url(#${hot ? 'lc-arrow-hot' : 'lc-arrow'})` : undefined}
      />
      <line
        data-h="1"
        stroke="rgba(0,0,0,0)"
        strokeWidth={11}
        pointerEvents="stroke"
        style={{ cursor: 'pointer' }}
        onMouseEnter={() => setHoverEdge(edge.id)}
        onMouseLeave={() => setHoverEdge((h) => (h === edge.id ? null : h))}
      />
      <g data-lb="1" pointerEvents="none" style={labelShown ? undefined : { display: 'none' }}>
        <text
          textAnchor="middle"
          dy={-4}
          fontSize={8}
          letterSpacing="0.1em"
          fill={hovered ? C.accent : C.faint}
          stroke={C.void}
          strokeWidth={3}
          paintOrder="stroke"
        >
          {edge.type}
        </text>
      </g>
    </g>
  )
}

/* ── empty state ─────────────────────────────────────────────────────── */

function EmptyState({ onPick }: { onPick: (id: string) => void }) {
  const threatBoard = useSim((s) => s.threatBoard)

  const subjects = useMemo(() => {
    if (threatBoard.length > 0) return threatBoard.slice(0, 4).map((t) => ({ id: t.id, name: t.name, risk: t.risk }))
    const persons = getWorld().persons
    const watch = persons.filter((p) => p.watchlisted).slice(0, 4)
    const pool = watch.length > 0 ? watch : persons.slice(0, 4)
    return pool.map((p) => ({ id: p.id, name: getDossier(p.id).name, risk: getDossier(p.id).risk }))
  }, [threatBoard])

  return (
    <div className="rise-in flex h-full w-full items-center justify-center">
      <div className="flex w-[420px] max-w-[85%] flex-col items-center text-center">
        <svg viewBox="0 0 48 48" className="h-12 w-12 text-faint" fill="none" stroke="currentColor" strokeWidth="1">
          <circle cx="24" cy="24" r="15" />
          <circle cx="24" cy="24" r="2" fill="currentColor" stroke="none" />
          <path d="M24 2v12M24 34v12M2 24h12M34 24h12" />
        </svg>
        <div className="mt-4 font-grotesk text-[18px] font-medium tracking-[0.25em] text-faint">NO SUBJECT DESIGNATED</div>
        <div className="lbl-faint mt-3">SELECT A PERSON ON THE TACTICAL MAP — OR PULL A THREAD:</div>
        <div className="mt-3 grid w-full grid-cols-2 gap-1.5">
          {subjects.map((s) => (
            <button
              key={s.id}
              onClick={() => onPick(s.id)}
              className="panel-surface-2 group flex flex-col gap-0.5 px-2 py-1.5 text-left transition-colors duration-150 ease-tac hover:border-accent/60"
            >
              <span className="truncate text-[11px] uppercase tracking-wide2 text-prim group-hover:text-accent">{s.name}</span>
              <span className="num flex items-center gap-1.5 text-[10px]">
                <span className="text-faint">{s.id}</span>
                <span className="ml-auto" style={{ color: s.risk >= 70 ? C.red : s.risk >= 45 ? C.amber : C.green }}>
                  R:{Math.round(s.risk)}
                </span>
              </span>
            </button>
          ))}
        </div>
        <div className="lbl mt-4 border border-violet/60 px-1 py-px text-violet">ALL IDENTITIES · SOURCE: SIMULATED</div>
      </div>
    </div>
  )
}
