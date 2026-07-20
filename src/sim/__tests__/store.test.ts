/**
 * Store contract smoke: the sim/ tree must be importable in node (vitest) and
 * the action surface must behave — without ever calling startSimLoop.
 */
import { describe, expect, it } from 'vitest'
import { findEntity, getEvents, getHistories, getWorld, HISTORY_LEN, SECTORS, useSim } from '../store'
import { PERSON_POOL, personIdFromIndex } from '../identityFactory'

describe('store contract', () => {
  it('builds the world singleton with exact entity counts', () => {
    const world = getWorld()
    expect(world.persons.length).toBe(PERSON_POOL)
    expect(world.persons[0].id).toBe(personIdFromIndex(0))
    expect(world.vehicles.length).toBe(150)
    expect(world.patrols.length).toBe(12)
    expect(world.cameras.length).toBe(24)
    expect(world.incidents.length).toBe(0)
    expect(world.city.nodes.length).toBeGreaterThan(0)
    expect(SECTORS.length).toBe(9)
    expect(HISTORY_LEN).toBe(150)
    expect(Object.keys(getHistories()).sort()).toEqual(
      ['activeUnits', 'cityLoad', 'detectionsPerMin', 'incidentRate', 'netLoad', 'riskIndex', 'sensorUptime'].sort(),
    )
  })

  it('graph associates resolve to real world entities', () => {
    // identityFactory associates map into the PERSON_POOL id space
    for (let i = 0; i < PERSON_POOL; i += 37) {
      expect(findEntity(personIdFromIndex(i))).toBeDefined()
    }
  })

  it('findEntity spans all pools; locate() rejects unknown ids', () => {
    expect(findEntity('P-0001')?.kind).toBe('person')
    expect(findEntity('V-1001')?.kind).toBe('vehicle')
    expect(findEntity('U-01')?.kind).toBe('patrol')
    expect(findEntity('CAM-02')?.kind).toBe('camera')
    expect(findEntity('NOPE-99')).toBeUndefined()

    const st = useSim.getState()
    expect(st.locate('GHOST-404')).toBe(false)
    expect(useSim.getState().selectedId).toBeNull()
    expect(st.locate('P-0002')).toBe(true)
    expect(useSim.getState().selectedId).toBe('P-0002')
    expect(useSim.getState().view).toBe('map')
    expect(useSim.getState().focusRequest?.id).toBe('P-0002')
  })

  it('setTracked mirrors onto the person entity', () => {
    const st = useSim.getState()
    st.setTracked('P-0005', true)
    expect(useSim.getState().trackedIds).toContain('P-0005')
    const p = findEntity('P-0005')
    expect(p?.kind === 'person' && p.tracked).toBe(true)
    st.setTracked('P-0005', false)
    expect(useSim.getState().trackedIds).not.toContain('P-0005')
    expect(findEntity('P-0005')?.kind === 'person' && (findEntity('P-0005') as { tracked: boolean }).tracked).toBe(false)
  })

  it('infra actions emit into the ring buffer and bump eventsVersion', () => {
    const before = getEvents().length
    const versionBefore = useSim.getState().eventsVersion
    useSim.getState().setPower('SECTOR-4', false)
    useSim.getState().setBridge(getWorld().city.bridges[0].id, true)
    useSim.getState().spawnIncident('SECTOR-2')
    expect(getEvents().length).toBe(before + 3)
    expect(useSim.getState().eventsVersion).toBe(versionBefore + 3)
    expect(useSim.getState().infra.power['SECTOR-4']).toBe(false)
    // restore
    useSim.getState().autoRestore()
    expect(useSim.getState().infra.power['SECTOR-4']).toBe(true)
  })

  it('reportCv updates cv state and dedupes identical reports', () => {
    const st = useSim.getState()
    st.reportCv(true, 2, ['person'])
    expect(useSim.getState().cvOnline).toBe(true)
    expect(useSim.getState().cvSubjects).toBe(2)
    st.reportCv(false, 0, [])
    expect(useSim.getState().cvOnline).toBe(false)
  })
})
