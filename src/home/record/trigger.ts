/**
 * PANOPTICON // HOMEWATCH — recording TRIGGER (pure).
 *
 * Decides whether a camera should be recording RIGHT NOW, and why. The rules
 * mirror the product promise "record only while something worth recording is
 * happening" — and stay strictly observational:
 *
 *   · an UNKNOWN person (face engine judged, matched nobody) is in view;
 *   · a WARN-grade situation involving an unrecognized person is active
 *     (lingering / crouching at a vehicle);
 *   · on a NON-webcam camera while the face engine cannot judge at all
 *     (models unavailable): any person — outdoors, an unverifiable person is
 *     worth keeping footage of. The operator webcam never uses this fallback,
 *     so the owner isn't recorded just because models are still loading.
 *
 * Returns a short human-readable trigger label, or null for "no recording".
 */
import type { Situation, TrackedBox } from '../types'

/** tracks not refreshed within this window don't arm the recorder */
export const TRIGGER_FRESH_MS = 2500

/** WARN-grade situation kinds that arm recording when the person is unknown */
const HOT_SITUATIONS = new Set<Situation['kind']>(['LINGERING_AT_VEHICLE', 'CROUCHING_AT_VEHICLE'])

export interface TriggerInput {
  now: number
  isWebcam: boolean
  faceEngineReady: boolean
  /** tracks of THIS camera */
  tracks: TrackedBox[]
  /** situations of THIS camera (from the brain snapshot) */
  situations: Situation[]
}

export function recordTrigger(input: TriggerInput): string | null {
  const { now, isWebcam, faceEngineReady, tracks, situations } = input

  let sawUnknown = false
  let sawUnverified = false
  for (const t of tracks) {
    if (t.cls !== 'person') continue
    if (now - t.updatedAt >= TRIGGER_FRESH_MS) continue
    if (t.identity === 'unknown') sawUnknown = true
    else if (t.identity === 'pending' && !faceEngineReady && !isWebcam) sawUnverified = true
  }
  if (sawUnknown) return 'UNKNOWN PERSON'

  for (const s of situations) {
    if (HOT_SITUATIONS.has(s.kind) && s.personId === null && s.personLabel === 'UNKNOWN') {
      return 'UNKNOWN AT VEHICLE'
    }
  }

  if (sawUnverified) return 'UNVERIFIED PERSON'
  return null
}
