import Dexie, { type Table } from 'dexie'
import { create } from 'zustand'
import { emptyData, type PlannerData } from './model'

class PlannerDB extends Dexie {
  snapshots!: Table<{ id: string; data: PlannerData }>
  constructor() {
    super('meet-up-planner')
    this.version(1).stores({ snapshots: 'id' })
  }
}
const db = new PlannerDB()

interface Store {
  data: PlannerData
  ready: boolean
  error: string
  load: () => Promise<void>
  save: (data: PlannerData) => Promise<void>
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
  save: async (data) => {
    try {
      await db.snapshots.put({ id: 'planner', data })
      set({ data, error: '' })
    } catch {
      set({ error: 'Could not save your changes. Check your browser storage and try again.' })
    }
  },
}))
