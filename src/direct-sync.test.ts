import { beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyData, type PlannerData } from './model'
import type { PendingUpload } from './store'

const state = vi.hoisted(() => ({
  data: null as PlannerData | null,
  pending: undefined as PendingUpload | undefined,
  remote: null as { data: PlannerData; sha: string } | null,
  known: undefined as string | undefined,
  written: [] as { data: PlannerData; sha?: string }[],
}))

vi.mock('./store', () => ({
  readSyncState: async () => ({ data: state.data, pending: state.pending }),
  savePendingUpload: async (upload: PendingUpload) => { state.pending = structuredClone(upload) },
  clearPendingUpload: async () => { state.pending = undefined },
}))
vi.mock('./sync', async importOriginal => {
  const actual = await importOriginal<typeof import('./sync')>()
  return {
    ...actual,
    readCloud: async () => state.remote,
    writeCloud: async (_token: string, _target: unknown, data: PlannerData, sha?: string) => {
      state.written.push({ data, sha })
      if (sha !== state.remote?.sha) throw new actual.CloudConflictError()
      state.remote = { data: structuredClone(data), sha: 'next-sha' }
      return 'next-sha'
    },
  }
})

import { acknowledgeDirectUpload, pushDirect } from './direct-sync'
import { CloudConflictError } from './sync'

const target = { owner: 'alice', repo: 'planner', branch: 'main', path: 'data.json' }
const person = (name: string) => ({ id: 'f', name, colour: '#fff', priority: 'normal' as const, createdAt: '', updatedAt: '' })
const snapshot = (name: string): PlannerData => ({ ...emptyData(), friends: [person(name)] })

beforeEach(() => {
  state.data = snapshot('later')
  state.remote = { data: snapshot('base'), sha: 'base-sha' }
  state.known = 'base-sha'; state.pending = undefined; state.written = []
  vi.stubGlobal('localStorage', {
    getItem: () => state.known ?? null,
    setItem: (_key: string, value: string) => { state.known = value },
  })
})

describe('direct sync upload recovery', () => {
  it('recognizes a prior successful upload before sending the newer edit', async () => {
    const uploaded = snapshot('first')
    state.pending = { id: 'direct:key', localBase: uploaded, data: uploaded, baselineSha: 'base-sha' }
    state.remote = { data: uploaded, sha: 'uploaded-sha' }
    expect(await pushDirect('token', target, 'key', state.data!)).toBe('next-sha')
    expect(state.written[0].sha).toBe('uploaded-sha')
    expect(state.remote?.data).toEqual(snapshot('later'))
  })

  it('does not acknowledge independently changed cloud data', async () => {
    const uploaded = snapshot('first')
    state.pending = { id: 'direct:key', localBase: uploaded, data: uploaded, baselineSha: 'base-sha' }
    state.remote = { data: snapshot('other device'), sha: 'other-sha' }
    expect(await acknowledgeDirectUpload('key', state.remote)).toBe(false)
    await expect(pushDirect('token', target, 'key', state.data!)).rejects.toBeInstanceOf(CloudConflictError)
    expect(state.remote?.data).toEqual(snapshot('other device'))
  })

  it('refuses to upload an obsolete local snapshot', async () => {
    await expect(pushDirect('token', target, 'key', snapshot('old'))).rejects.toThrow('Local data changed')
    expect(state.written).toHaveLength(0)
  })
})
