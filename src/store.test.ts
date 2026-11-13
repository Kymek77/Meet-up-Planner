import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { beforeAll, beforeEach, afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { emptyData, type PlannerData } from './model'
import { commitSyncState, readSyncState, usePlanner } from './store'

const person = (id: string, name = id) => ({ id, name, colour: '#fff', priority: 'normal' as const, createdAt: '', updatedAt: '' })
const snapshot = (...friends: ReturnType<typeof person>[]): PlannerData => ({ ...emptyData(), friends })
const id = 'alice/planner/main/data'
let inspector: Dexie

beforeAll(async () => {
  vi.stubGlobal('localStorage', { getItem: () => 'connected' })
  inspector = new Dexie('meet-up-planner')
  await usePlanner.getState().load()
  await inspector.open()
})
beforeEach(async () => {
  await inspector.transaction('rw', inspector.table('snapshots'), inspector.table('baselines'), inspector.table('metadata'), async () => {
    await inspector.table('snapshots').clear()
    await inspector.table('baselines').clear()
    await inspector.table('metadata').clear()
  })
  await usePlanner.getState().load()
})
afterEach(() => vi.restoreAllMocks())
afterAll(() => { inspector.close(); vi.unstubAllGlobals() })

describe('IndexedDB connected sync transactions', () => {
  it('rejects an obsolete revision without marking later edits synced', async () => {
    const first = snapshot(person('a'))
    await usePlanner.getState().save(first, emptyData())
    const read = await readSyncState(id)
    const later = snapshot(person('a'), person('b'))
    await usePlanner.getState().save(later, first)
    expect(await commitSyncState(id, read.revision, first, 'sha-old')).toBe(false)
    const after = await readSyncState(id)
    expect(after.data).toEqual(later)
    expect(after.baseline).toBeUndefined()
    expect(after.revision).toBeGreaterThan(read.revision)
  })

  it('rolls back data, baseline and revision if a baseline write fails', async () => {
    const original = snapshot(person('a'))
    const initial = await readSyncState(id)
    expect(await commitSyncState(id, initial.revision, original, 'sha-one')).toBe(true)
    const before = await readSyncState(id)
    const put = IDBObjectStore.prototype.put
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
      if (value && typeof value === 'object' && 'sha' in value) throw new Error('simulated baseline failure')
      return put.call(this, value, key)
    })
    await expect(commitSyncState(id, before.revision, snapshot(person('b')), 'sha-two')).rejects.toThrow()
    expect(await readSyncState(id)).toEqual(before)
  })

  it('rejects stale same-record edits and merges unrelated edits', async () => {
    const base = snapshot(person('a'), person('b'))
    await usePlanner.getState().save(base, emptyData())
    const otherTab = snapshot(person('a', 'other tab'), person('b'))
    await usePlanner.getState().save(otherTab, base)
    await usePlanner.getState().save(snapshot(person('a', 'stale form'), person('b')), base)
    expect(usePlanner.getState().error).toMatch(/changed elsewhere/)
    expect((await readSyncState(id)).data).toEqual(otherTab)
    await usePlanner.getState().save(snapshot(person('a'), person('b', 'my edit')), base)
    expect(usePlanner.getState().error).toBe('')
    expect((await readSyncState(id)).data).toEqual(snapshot(person('a', 'other tab'), person('b', 'my edit')))
  })
})
