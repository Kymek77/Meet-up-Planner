import { describe, expect, it } from 'vitest'
import { emptyData, isPlannerData, type Availability, type Friend, type Meeting, type Period, type PlannerData } from './model'
import { mergePlannerData } from './merge'

const friend = (id: string): Friend => ({ id, name: id, colour: '#123456', priority: 'normal', createdAt: '', updatedAt: '' })
const period = (id: string): Period => ({ id, name: id, start: '2026-01-01', end: '2026-01-31' })
const availability = (id: string, friendId: string | null = 'f'): Availability => ({
  id, periodId: 'p', friendId, start: '2026-01-02T10:00', end: '2026-01-02T11:00',
})
const meeting = (id: string): Meeting => ({
  id, periodId: 'p', friendId: 'f', start: '2026-01-02T10:00', end: '2026-01-02T11:00',
  location: '', notes: '', status: 'idea',
})
const snapshot = (): PlannerData => ({ ...emptyData(), friends: [friend('f')], periods: [period('p')] })

describe('mergePlannerData', () => {
  it('merges independent additions, edits and deletions in deterministic base/local/remote order', () => {
    const base = { ...snapshot(), friends: [friend('f'), friend('delete'), friend('keep')] }
    const local = { ...base, friends: [{ ...friend('f'), name: 'Local' }, friend('keep'), friend('local')], availability: [availability('a', null)] }
    const remote = { ...base, friends: [friend('keep'), friend('f'), friend('delete'), friend('remote')], meetings: [meeting('m')] }
    const original = structuredClone({ base, local, remote })
    const result = mergePlannerData(base, local, remote)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.friends.map(f => f.id)).toEqual(['f', 'keep', 'local', 'remote'])
    expect(result.data.friends[0].name).toBe('Local')
    expect(result.data.availability).toEqual(local.availability)
    expect(result.data.meetings).toEqual(remote.meetings)
    expect(isPlannerData(result.data)).toBe(true)
    expect({ base, local, remote }).toEqual(original)
  })

  it('coalesces identical additions, edits, and deletions without changing object shapes', () => {
    const base = { ...snapshot(), friends: [friend('f'), friend('gone')] }
    const changed = { ...friend('f'), notes: '' }
    const addition = { ...period('new'), extra: { y: 1, x: 2 } }
    const local = { ...base, friends: [changed], periods: [period('p'), addition] }
    const remote = { ...base, friends: [{ ...changed }], periods: [period('p'), { ...period('new'), extra: { x: 2, y: 1 } }] }
    const result = mergePlannerData(base, local, remote)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.friends).toEqual([changed])
    expect(result.data.periods[1]).toBe(addition)
    expect(result.data.friends[0]).toBe(changed)
    expect(result.data.friends[0]).not.toHaveProperty('location')
  })

  it('reports divergent additions and edits, even when changes affect different fields', () => {
    const base = snapshot()
    const local = { ...base, friends: [{ ...friend('f'), name: 'Changed' }, friend('new')] }
    const remote = { ...base, friends: [{ ...friend('f'), notes: 'Changed' }, { ...friend('new'), name: 'Other' }] }
    expect(mergePlannerData(base, local, remote)).toEqual({ ok: false, conflicts: [
      { collection: 'friends', id: 'f', reason: 'edit-edit' },
      { collection: 'friends', id: 'new', reason: 'add-add' },
    ] })
  })

  it.each(['local', 'remote'] as const)('reports delete/edit conflicts when %s deletes', side => {
    const base = { ...snapshot(), meetings: [meeting('m')] }
    const deleted = { ...base, meetings: [] }
    const edited = { ...base, meetings: [{ ...meeting('m'), notes: 'changed' }] }
    expect(mergePlannerData(base, side === 'local' ? deleted : edited, side === 'local' ? edited : deleted))
      .toEqual({ ok: false, conflicts: [{ collection: 'meetings', id: 'm', reason: 'delete-edit' }] })
  })

  it('reports foreign reference collisions for independently deleted entities and created or edited records', () => {
    const base = { ...snapshot(), availability: [availability('a')] }
    const local = { ...base, friends: [], periods: [], availability: [] }
    const remote = { ...base, availability: [{ ...availability('a'), notes: 'updated' }], meetings: [meeting('m')] }
    // The availability deletion itself conflicts, so test the new reference separately.
    const created = mergePlannerData(snapshot(), { ...snapshot(), friends: [], periods: [] }, { ...snapshot(), meetings: [meeting('m')] })
    expect(created).toEqual({ ok: false, conflicts: [
      { collection: 'meetings', id: 'm', reason: 'missing-period:p' },
      { collection: 'meetings', id: 'm', reason: 'missing-friend:f' },
    ] })
    expect(mergePlannerData(base, local, remote)).toEqual({ ok: false, conflicts: [
      { collection: 'availability', id: 'a', reason: 'delete-edit' },
    ] })
    // A changed record can be moved to a reference independently deleted on the other side.
    const otherBase = { ...snapshot(), friends: [friend('f'), friend('other')], availability: [availability('a', 'other')] }
    const left = { ...otherBase, friends: [friend('other')] }
    const right = { ...otherBase, availability: [availability('a', 'f')] }
    expect(mergePlannerData(otherBase, left, right)).toEqual({ ok: false, conflicts: [
      { collection: 'availability', id: 'a', reason: 'missing-friend:f' },
    ] })
  })

  it('allows coordinated deletions and null friend references', () => {
    const base = { ...snapshot(), availability: [availability('a')] }
    const local = { ...base, friends: [], availability: [availability('a', null)] }
    const result = mergePlannerData(base, local, base)
    expect(result).toEqual({ ok: true, data: local })
  })

  it.each(['base', 'local', 'remote'] as const)('rejects duplicate IDs in %s even if the schema accepts them', side => {
    const data = snapshot()
    const duplicate = { ...data, periods: [period('p'), period('p')] }
    expect(isPlannerData(duplicate)).toBe(true)
    const inputs = { base: data, local: data, remote: data, [side]: duplicate }
    expect(mergePlannerData(inputs.base, inputs.local, inputs.remote)).toEqual({ ok: false, conflicts: [
      { collection: 'periods', id: 'p', reason: `duplicate-id:${side}` },
    ] })
  })

  it('rejects invalid snapshots, including orphaned references and malformed values', () => {
    const base = snapshot()
    const invalid = { ...base, meetings: [{ ...meeting('m'), friendId: 'missing' }] }
    expect(mergePlannerData(base, invalid, null as unknown as PlannerData)).toEqual({ ok: false, conflicts: [
      { collection: '$snapshot', id: 'local', reason: 'invalid-data' },
      { collection: '$snapshot', id: 'remote', reason: 'invalid-data' },
    ] })
  })

  it('preserves unknown snapshot metadata and refuses divergent metadata edits', () => {
    const base = { ...snapshot(), extra: 'base' }
    const local = { ...base, extra: 'local' }
    expect(mergePlannerData(base, local, base)).toEqual({ ok: true, data: local })
    const remote = { ...base, extra: 'remote' }
    expect(mergePlannerData(base, local, remote)).toEqual({ ok: false, conflicts: [
      { collection: '$snapshot', id: 'metadata', reason: 'edit-edit' },
    ] })
  })
})
