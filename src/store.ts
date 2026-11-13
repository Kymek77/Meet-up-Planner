import Dexie, { liveQuery, type Table } from 'dexie'
import { create } from 'zustand'
import { emptyData, isPlannerData, type PlannerData } from './model'
import { mergeLocalEdit } from './connected-edit'

export interface SyncBaseline { id: string; data: PlannerData; sha: string }

class PlannerDB extends Dexie {
  snapshots!: Table<{ id: string; data: PlannerData }>
  baselines!: Table<SyncBaseline>
  metadata!: Table<{ id: string; value: string }>
  constructor() {
    super('meet-up-planner')
    this.version(1).stores({ snapshots: 'id' })
    this.version(2).stores({ snapshots: 'id', baselines: 'id', metadata: 'id' })
  }
}
const db = new PlannerDB()

interface Store {
  data: PlannerData
  ready: boolean
  error: string
  load: () => Promise<void>
  save: (data: PlannerData, base?: PlannerData) => Promise<void>
}

export const usePlanner = create<Store>((set) => ({
  data: emptyData(), ready: false, error: '',
  load: async () => {
    try {
      const saved = await db.snapshots.get('planner')
      set({ data: saved?.data ?? emptyData(), ready: true })
    } catch {
      set({ ready: true, error: 'Could not open local storage. Your changes cannot be saved.' })
    }
  },
  save: async (data, base) => {
    try {
      const saved = await db.transaction('rw', db.snapshots, db.metadata, async () => {
        const current = (await db.snapshots.get('planner'))?.data ?? emptyData()
        let next = data
        if (localStorage.getItem('meetup-sync-mode') === 'connected' && base && JSON.stringify(base) !== JSON.stringify(current)) {
          next = mergeLocalEdit(base, data, current)
        }
        if (JSON.stringify(current) !== JSON.stringify(next)) {
          await db.snapshots.put({ id: 'planner', data: next })
          const revision = Number((await db.metadata.get('local-revision'))?.value ?? '0')
          await db.metadata.put({ id: 'local-revision', value: String(revision + 1) })
        }
        return next
      })
      set({ data: saved, error: '' })
    } catch (e) {
      set({ error: e instanceof Error && e.message.startsWith('This item changed elsewhere') ? e.message : 'Could not save your changes. Check your browser storage and try again.' })
    }
  },
}))

liveQuery(() => db.snapshots.get('planner')).subscribe({
  next: saved => {
    if (usePlanner.getState().ready && saved && isPlannerData(saved.data) && JSON.stringify(saved.data) !== JSON.stringify(usePlanner.getState().data)) usePlanner.setState({ data: saved.data })
  },
  error: () => usePlanner.setState({ error: 'Could not read local storage updates.' }),
})

export async function readSyncState(id: string) {
  return db.transaction('r', db.snapshots, db.baselines, db.metadata, async () => ({
    data: (await db.snapshots.get('planner'))?.data ?? emptyData(),
    baseline: await db.baselines.get(id),
    identity: (await db.metadata.get('sync-identity'))?.value,
    revision: Number((await db.metadata.get('local-revision'))?.value ?? '0'),
  }))
}

export async function saveSyncBackup(data: PlannerData) {
  if (!isPlannerData(data)) throw new Error('Cannot back up invalid planner data.')
  await db.snapshots.put({ id: `backup:${new Date().toISOString()}:${crypto.randomUUID()}`, data })
}

// Commit only if no local save occurred since the snapshot was read.
export async function commitSyncState(id: string, revision: number, data: PlannerData, sha: string) {
  if (!isPlannerData(data) || !sha) throw new Error('Invalid sync snapshot.')
  return db.transaction('rw', db.snapshots, db.baselines, db.metadata, async () => {
    const currentRevision = Number((await db.metadata.get('local-revision'))?.value ?? '0')
    if (currentRevision !== revision) return false
    const current = (await db.snapshots.get('planner'))?.data ?? emptyData()
    if (JSON.stringify(current) !== JSON.stringify(data)) {
      await db.snapshots.put({ id: 'planner', data })
      await db.metadata.put({ id: 'local-revision', value: String(currentRevision + 1) })
    }
    await db.baselines.put({ id, data, sha })
    await db.metadata.put({ id: 'sync-identity', value: id })
    return true
  })
}

export async function withSyncLock<T>(task: () => Promise<T>): Promise<T> {
  if (navigator.locks) return navigator.locks.request('meetup-connected-sync', () => task())
  throw new Error('Connected sync is paused: this browser does not support Web Locks, which are required for safe multi-tab syncing.')
}
