import { describe, expect, it } from 'vitest'
import { recordTrigger, TRIGGER_FRESH_MS, type TriggerInput } from '../trigger'
import type { Situation, TrackedBox } from '../../types'

const NOW = 1_000_000

function person(identity: TrackedBox['identity'], updatedAt = NOW): TrackedBox {
  return {
    trackId: 1,
    cameraId: 'RCAM-01',
    cls: 'person',
    label: 'PERSON',
    score: 0.9,
    box: [0.4, 0.2, 0.2, 0.6],
    vel: [0, 0, 0, 0],
    updatedAt,
    firstSeen: updatedAt - 5000,
    identity,
    personId: identity === 'known' ? 'P-1' : null,
  }
}

function situation(kind: Situation['kind'], personId: string | null = null, personLabel = 'UNKNOWN'): Situation {
  return { id: `s:${kind}`, kind, cameraId: 'RCAM-01', personId, personLabel, since: NOW - 30_000 }
}

const base = (over: Partial<TriggerInput>): TriggerInput => ({
  now: NOW,
  isWebcam: false,
  faceEngineReady: true,
  tracks: [],
  situations: [],
  ...over,
})

describe('recordTrigger', () => {
  it('arms on a fresh UNKNOWN person', () => {
    expect(recordTrigger(base({ tracks: [person('unknown')] }))).toBe('UNKNOWN PERSON')
  })

  it('ignores stale unknown tracks (person long gone)', () => {
    expect(recordTrigger(base({ tracks: [person('unknown', NOW - TRIGGER_FRESH_MS - 1)] }))).toBeNull()
  })

  it('never arms on a KNOWN household member', () => {
    expect(recordTrigger(base({ tracks: [person('known')] }))).toBeNull()
  })

  it('pending person while the face engine is READY stays un-armed (identity will resolve)', () => {
    expect(recordTrigger(base({ tracks: [person('pending')], faceEngineReady: true }))).toBeNull()
  })

  it('pending person on a BRIDGED camera while the engine cannot judge arms as UNVERIFIED', () => {
    expect(recordTrigger(base({ tracks: [person('pending')], faceEngineReady: false }))).toBe('UNVERIFIED PERSON')
  })

  it('never applies the unverified fallback to the operator webcam', () => {
    expect(recordTrigger(base({ tracks: [person('pending')], faceEngineReady: false, isWebcam: true }))).toBeNull()
  })

  it('arms on a WARN-grade unknown vehicle situation even without person tracks', () => {
    expect(recordTrigger(base({ situations: [situation('LINGERING_AT_VEHICLE')] }))).toBe('UNKNOWN AT VEHICLE')
    expect(recordTrigger(base({ situations: [situation('CROUCHING_AT_VEHICLE')] }))).toBe('UNKNOWN AT VEHICLE')
  })

  it('does not arm on soft situations or known-person situations', () => {
    expect(recordTrigger(base({ situations: [situation('AT_ENTRY')] }))).toBeNull()
    expect(recordTrigger(base({ situations: [situation('LINGERING_AT_VEHICLE', 'P-1', 'Erik')] }))).toBeNull()
  })

  it('UNKNOWN outranks the unverified fallback in the label', () => {
    expect(
      recordTrigger(base({ tracks: [person('unknown'), person('pending')], faceEngineReady: false })),
    ).toBe('UNKNOWN PERSON')
  })

  it('non-person classes never arm', () => {
    const car: TrackedBox = { ...person('pending'), cls: 'vehicle', label: 'CAR', identity: 'pending' }
    expect(recordTrigger(base({ tracks: [car], faceEngineReady: false }))).toBeNull()
  })
})
