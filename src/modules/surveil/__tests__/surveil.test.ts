import { describe, expect, it } from 'vitest'
import { camUptime, feedSignal, type FeedSignal } from '../simFeed'
import { mergeDetections, type TrackedBox } from '../webcamCV'

describe('simFeed seeded behavior', () => {
  it('camUptime is deterministic and in the 97.4–99.9 band', () => {
    const a = camUptime('CAM-07')
    expect(camUptime('CAM-07')).toBe(a)
    const v = Number(a)
    expect(v).toBeGreaterThanOrEqual(97.4)
    expect(v).toBeLessThanOrEqual(99.9)
    expect(camUptime('CAM-08')).not.toBe(undefined)
  })

  it('dropout cycle produces lost → reacq → live phases deterministically', () => {
    const seen = new Set<FeedSignal>()
    for (let t = 0; t < 180_000; t += 250) seen.add(feedSignal('CAM-05', t))
    expect(seen.has('lost')).toBe(true)
    expect(seen.has('reacq')).toBe(true)
    expect(seen.has('live')).toBe(true)
    // deterministic replay
    for (let t = 0; t < 20_000; t += 500) {
      expect(feedSignal('CAM-05', t)).toBe(feedSignal('CAM-05', t))
    }
  })

  it('dropouts last 4–8 s and mostly stay live', () => {
    let lostMs = 0
    const step = 100
    for (let t = 0; t < 300_000; t += step) {
      if (feedSignal('CAM-09', t) !== 'live') lostMs += step
    }
    // 4–8 s outage per 40–90 s cycle → between ~4% and ~20% downtime
    const frac = lostMs / 300_000
    expect(frac).toBeGreaterThan(0.02)
    expect(frac).toBeLessThan(0.25)
  })
})

describe('webcamCV track smoothing', () => {
  it('ease-follows matched detections (~0.4 lerp) instead of jumping', () => {
    const tracks: TrackedBox[] = []
    mergeDetections(tracks, [{ bbox: [100, 100, 50, 80], class: 'person', score: 0.9 }], 1000)
    expect(tracks).toHaveLength(1)
    mergeDetections(tracks, [{ bbox: [120, 100, 50, 80], class: 'person', score: 0.9 }], 1100)
    expect(tracks).toHaveLength(1)
    expect(tracks[0].x).toBeCloseTo(108, 5) // 100 + (120-100)*0.4
  })

  it('drops tracks unseen past the TTL and keeps classes separate', () => {
    const tracks: TrackedBox[] = []
    mergeDetections(tracks, [{ bbox: [10, 10, 20, 20], class: 'person', score: 0.8 }], 0)
    mergeDetections(tracks, [{ bbox: [200, 200, 40, 40], class: 'chair', score: 0.6 }], 100)
    expect(tracks).toHaveLength(2)
    // person unseen for > 420 ms is pruned on the next merge
    mergeDetections(tracks, [{ bbox: [205, 200, 40, 40], class: 'chair', score: 0.65 }], 600)
    expect(tracks).toHaveLength(1)
    expect(tracks[0].cls).toBe('chair')
  })
})
