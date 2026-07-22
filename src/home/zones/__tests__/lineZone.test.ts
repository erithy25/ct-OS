import { describe, expect, it } from 'vitest'
import {
  extendLineToBorders,
  lineBothPolygons,
  lineSidePolygon,
  pointInPolygon,
  polygonArea,
} from '../geometry'

const close = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps

describe('extendLineToBorders', () => {
  it('extends a horizontal mid line to both side borders', () => {
    const ext = extendLineToBorders([
      [0.2, 0.5],
      [0.8, 0.5],
    ])
    expect(ext[0]).toEqual([0, 0.5])
    expect(ext[ext.length - 1]).toEqual([1, 0.5])
    expect(ext).toHaveLength(4)
  })

  it('keeps interior points and handles diagonals', () => {
    const ext = extendLineToBorders([
      [0.4, 0.4],
      [0.6, 0.6],
    ])
    // backwards along the diagonal → (0,0); forwards → (1,1)
    expect(close(ext[0][0], 0) && close(ext[0][1], 0)).toBe(true)
    const last = ext[ext.length - 1]
    expect(close(last[0], 1) && close(last[1], 1)).toBe(true)
  })

  it('returns a copy for degenerate inputs', () => {
    expect(extendLineToBorders([[0.5, 0.5]])).toEqual([[0.5, 0.5]])
  })
})

describe('lineSidePolygon', () => {
  const horizontal: [number, number][] = [
    [0.1, 0.55],
    [0.9, 0.55],
  ]

  it('closes around the BOTTOM when the side point is below the line', () => {
    const poly = lineSidePolygon(horizontal, [0.5, 0.9])
    expect(pointInPolygon([0.5, 0.8], poly)).toBe(true)
    expect(pointInPolygon([0.5, 0.2], poly)).toBe(false)
    expect(close(polygonArea(poly), 0.45, 1e-3)).toBe(true)
  })

  it('closes around the TOP when the side point is above the line', () => {
    const poly = lineSidePolygon(horizontal, [0.5, 0.1])
    expect(pointInPolygon([0.5, 0.2], poly)).toBe(true)
    expect(pointInPolygon([0.5, 0.9], poly)).toBe(false)
    expect(close(polygonArea(poly), 0.55, 1e-3)).toBe(true)
  })

  it('the two candidates partition the image (areas sum to 1)', () => {
    const { a, b } = lineBothPolygons(horizontal)
    expect(close(polygonArea(a) + polygonArea(b), 1, 1e-3)).toBe(true)
  })

  it('works for a bent (L-shaped) boundary', () => {
    const bent: [number, number][] = [
      [0.1, 0.7],
      [0.5, 0.7],
      [0.5, 0.2],
    ]
    const left = lineSidePolygon(bent, [0.2, 0.3])
    expect(pointInPolygon([0.15, 0.4], left)).toBe(true)
    expect(pointInPolygon([0.8, 0.5], left)).toBe(false)
    const right = lineSidePolygon(bent, [0.8, 0.5])
    expect(pointInPolygon([0.8, 0.5], right)).toBe(true)
    expect(pointInPolygon([0.15, 0.4], right)).toBe(false)
    // together they cover the frame
    expect(close(polygonArea(left) + polygonArea(right), 1, 1e-3)).toBe(true)
  })

  it('vertical line splits left/right', () => {
    const v: [number, number][] = [
      [0.5, 0.1],
      [0.5, 0.9],
    ]
    const left = lineSidePolygon(v, [0.1, 0.5])
    expect(pointInPolygon([0.2, 0.5], left)).toBe(true)
    expect(pointInPolygon([0.8, 0.5], left)).toBe(false)
  })

  it('degenerate line yields empty output, never throws', () => {
    expect(lineSidePolygon([[0.5, 0.5]], [0.1, 0.1])).toEqual([])
  })
})
