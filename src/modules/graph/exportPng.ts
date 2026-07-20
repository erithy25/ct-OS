/**
 * PROFILER — link-chart PNG export. No backend.
 *
 * The live SVG is built entirely with explicit attributes, so export is a
 * straight serialize → rasterize: clone the SVG, stamp explicit dimensions,
 * draw it at 2× onto a void-black canvas under a classification-style header
 * line, and trigger a download.
 */

const BG = '#05070a'
const HEADER_H = 44
const SCALE = 2

/** the SVG image is rasterized outside the document, so only generic families resolve there */
const SVG_FONT = "'JetBrains Mono','IBM Plex Mono',ui-monospace,Menlo,monospace"
/** canvas text renders in-document — the loaded webfont is available */
const CANVAS_FONT = "'JetBrains Mono',ui-monospace,Menlo,monospace"

export function exportLinkChart(svg: SVGSVGElement, rootId: string, rootName: string): void {
  const rect = svg.getBoundingClientRect()
  const w = Math.max(320, Math.round(rect.width))
  const h = Math.max(240, Math.round(rect.height))

  const clone = svg.cloneNode(true) as SVGSVGElement
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  clone.setAttribute('width', String(w))
  clone.setAttribute('height', String(h))
  clone.setAttribute('viewBox', `0 0 ${w} ${h}`)
  clone.setAttribute('font-family', SVG_FONT)
  clone.removeAttribute('class')
  clone.removeAttribute('style')

  const xml = new XMLSerializer().serializeToString(clone)
  const svgUrl = URL.createObjectURL(new Blob([xml], { type: 'image/svg+xml;charset=utf-8' }))

  const img = new Image()
  img.onload = () => {
    try {
      compose(img, w, h, rootId, rootName)
    } finally {
      URL.revokeObjectURL(svgUrl)
    }
  }
  img.onerror = () => URL.revokeObjectURL(svgUrl)
  img.src = svgUrl
}

function compose(img: HTMLImageElement, w: number, h: number, rootId: string, rootName: string): void {
  const canvas = document.createElement('canvas')
  canvas.width = w * SCALE
  canvas.height = (h + HEADER_H) * SCALE
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  ctx.scale(SCALE, SCALE)
  ctx.fillStyle = BG
  ctx.fillRect(0, 0, w, h + HEADER_H)

  // ── header line ──
  ctx.textBaseline = 'middle'
  ctx.font = `600 12px ${CANVAS_FONT}`
  const y = HEADER_H / 2
  let x = 14
  const seg = (text: string, color: string): void => {
    ctx.fillStyle = color
    ctx.fillText(text, x, y)
    x += ctx.measureText(text).width
  }
  seg('PANOPTICON // LINK CHART', '#c9d6e4')
  seg('  ·  ', '#3a4756')
  seg(rootName.toUpperCase(), '#22d3ee')
  seg('  ·  ', '#3a4756')
  seg('SOURCE: SIMULATED', '#8b5cf6')

  ctx.font = `500 10px ${CANVAS_FONT}`
  const meta = `${rootId} · ${new Date().toISOString().slice(0, 16).replace('T', ' ')}Z`
  ctx.fillStyle = '#6b7c8f'
  ctx.fillText(meta, w - 14 - ctx.measureText(meta).width, y)

  ctx.fillStyle = '#1a2430'
  ctx.fillRect(0, HEADER_H - 1, w, 1)

  // ── chart ──
  ctx.drawImage(img, 0, HEADER_H, w, h)

  canvas.toBlob((blob) => {
    if (!blob) return
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `linkchart-${rootId}.png`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 4000)
  }, 'image/png')
}
