import { beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyData, type PlannerData } from './model'

const state = vi.hoisted(() => ({
  data: null as PlannerData | null,
  baseline: undefined as { id: string; data: PlannerData; sha: string } | undefined,
  identity: undefined as string | undefined,
  revision: 0,
}))
vi.mock('./store', () => ({
  withSyncLock: async (fn: () => Promise<unknown>) => fn(),
  readSyncState: async () => ({ ...state }),
  commitSyncState: async (id: string, revision: number, data: PlannerData, sha: string) => {
    if (revision !== state.revision) return false
    state.data = structuredClone(data); state.baseline = { id, data: structuredClone(data), sha }; state.identity = id
    return true
  },
}))
import { ConnectedGitHubError, readRemote, reconcile, resetRemoteCache, sessionRequest, targetKey, type Target } from './connected'

const target: Target = { owner: 'alice', repo: 'planner', branch: 'main', path: 'data/planner.json' }
const person = (id: string) => ({ id, name: id, colour: '#fff', priority: 'normal' as const, createdAt: '', updatedAt: '' })
const snapshot = (...ids: string[]): PlannerData => ({ ...emptyData(), friends: ids.map(person) })
let remote: { data: PlannerData; sha: string } | null
let onWrite: (() => void) | undefined
let onRead: (() => void) | undefined
let writes = 0
let rejectFirstWrite = false
let reads: { path: string; etag?: string }[] = []
let force304 = false

beforeEach(() => {
  state.data = snapshot(); state.revision = 0; state.identity = targetKey(target)
  state.baseline = { id: targetKey(target), data: snapshot(), sha: 's0' }
  remote = { data: snapshot(), sha: 's0' }; onWrite = undefined; onRead = undefined; writes = 0; rejectFirstWrite = false
  reads = []; force304 = false; resetRemoteCache()
  vi.stubGlobal('fetch', vi.fn(async (_url: string, options: RequestInit) => {
    const request = JSON.parse(String(options.body)) as { path: string; method: string; etag?: string; body?: { content: string; sha?: string } }
    let status = 200, body: unknown
    if (request.path === '/user') body = { login: 'alice' }
    else if (request.path === '/repos/alice/planner') body = { private: true, owner: { login: 'alice' } }
    else if (request.method === 'GET') {
      reads.push({ path: request.path, etag: request.etag })
      if (force304 || (remote && request.etag === `"${remote.sha}"`)) { status = 304; body = null }
      else body = remote && { sha: remote.sha, encoding: 'base64', content: btoa(JSON.stringify(remote.data)) }
      onRead?.(); onRead = undefined
    }
    else {
      writes++
      if (rejectFirstWrite && writes === 1) { status = 409; body = {} }
      else if (request.body?.sha !== remote?.sha) { status = 409; body = {} }
      else {
        remote = { data: JSON.parse(atob(request.body!.content)) as PlannerData, sha: `s${writes}` }
        onWrite?.(); onWrite = undefined
        body = { content: { sha: remote.sha } }
      }
    }
    if (request.method === 'GET' && request.path.includes('/contents/') && !remote) status = 404
    return new Response(JSON.stringify({ status, body, ...(request.method === 'GET' && request.path.includes('/contents/') && remote ? { etag: `"${remote.sha}"` } : {}) }), { status: 200 })
  }))
})

describe('connected reconciliation', () => {
  it('rejects malformed session responses rather than treating them as successful', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('invalid', { status: 200 })))
    await expect(sessionRequest('/logout', {})).rejects.toThrow('Invalid response from connected service.')
  })

  it('does not replace either copy without a trusted baseline', async () => {
    state.baseline = undefined; state.identity = undefined; state.data = snapshot('local'); remote = { data: snapshot('cloud'), sha: 's1' }
    const conflict = await reconcile(target, () => true)
    expect(conflict?.reason).toMatch(/baseline/)
    expect(state.data).toEqual(snapshot('local'))
    expect(writes).toBe(0)
  })

  it('re-reads local edits made during an awaited upload and never marks them synced prematurely', async () => {
    state.data = snapshot('first')
    onWrite = () => { state.data = snapshot('first', 'later'); state.revision++ }
    expect(await reconcile(target, () => true)).toBeNull()
    expect(writes).toBe(2)
    expect(state.data).toEqual(snapshot('first', 'later'))
    expect(state.baseline?.data).toEqual(snapshot('first', 'later'))
    expect(remote?.data).toEqual(snapshot('first', 'later'))
  })

  it('retries rather than overwriting a local edit made while downloading', async () => {
    remote = { data: snapshot('cloud'), sha: 's1' }
    onRead = () => { state.data = snapshot('local'); state.revision++ }
    expect(await reconcile(target, () => true)).toBeNull()
    expect(state.data).toEqual(snapshot('local', 'cloud'))
    expect(remote?.data).toEqual(snapshot('local', 'cloud'))
  })

  it('blocks invalid local snapshots instead of uploading them', async () => {
    state.data = snapshot('duplicate', 'duplicate')
    await expect(reconcile(target, () => true)).rejects.toThrow('invalid')
    expect(writes).toBe(0)
  })

  it('establishes a baseline without replacing identical local and cloud data', async () => {
    state.baseline = undefined; state.identity = undefined
    state.data = snapshot('same'); remote = { data: snapshot('same'), sha: 's1' }
    expect(await reconcile(target, () => true)).toBeNull()
    expect((state.baseline as { sha: string } | undefined)?.sha).toBe('s1')
    expect(writes).toBe(0)
  })

  it('uses a conditional request only for a validated snapshot of the exact target', async () => {
    remote = { data: snapshot('one'), sha: 's1' }
    expect(await readRemote(target)).toEqual(remote)
    expect(await readRemote(target)).toEqual(remote)
    expect(reads[1].etag).toBe('"s1"')
    remote = { data: snapshot('two'), sha: 's2' }
    expect(await readRemote(target)).toEqual(remote)
    expect(reads[2].etag).toBe('"s1"')
    await readRemote({ ...target, branch: 'other' })
    expect(reads[3].etag).toBeUndefined()
    await readRemote({ ...target, owner: 'bob' })
    expect(reads[4].etag).toBeUndefined()
    resetRemoteCache(); force304 = true
    await expect(readRemote(target)).rejects.toThrow('unexpected conditional')
  })

  it('classifies both proxy and upstream 401 as expired sessions', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response('{}', { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 401, body: {} }), { status: 200 })))
    for (let i = 0; i < 2; i++) {
      try { await readRemote(target); expect.fail('Expected an authentication error') }
      catch (error) {
        expect(error).toBeInstanceOf(ConnectedGitHubError)
        expect((error as ConnectedGitHubError).status).toBe(401)
      }
    }
  })

  it('retries a remote compare-and-swap conflict and does not change account silently', async () => {
    state.data = snapshot('local'); rejectFirstWrite = true
    expect(await reconcile(target, () => true)).toBeNull()
    expect(writes).toBe(2)
    state.identity = 'another-account'
    expect((await reconcile(target, () => true))?.reason).toMatch(/account/)
    expect(writes).toBe(2)
  })
})
