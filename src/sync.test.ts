import { afterEach, describe, expect, it, vi } from 'vitest'
import { emptyData } from './model'
import { CloudConflictError, ensurePrivateRepository, GitHubPermissionError, hasPersonalInstallation, readCloud, writeCloud } from './sync'

const target = { owner: 'me', repo: 'private', branch: 'main', path: 'data/meetup-planner.json' }
const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('GitHub sync', () => {
  it('finds the authenticated user’s installation across pages, ignoring unrelated or suspended installations', async () => {
    const other = { account: { login: 'other', type: 'User' }, app_slug: 'planner', suspended_at: null }
    const fetch = vi.fn()
      .mockResolvedValueOnce(ok({ installations: Array.from({ length: 100 }, () => other) }))
      .mockResolvedValueOnce(ok({ installations: [
        { account: { login: 'ME', type: 'Organization' }, app_slug: 'planner', suspended_at: null },
        { account: { login: 'me', type: 'User' }, app_slug: 'planner', suspended_at: '2026-01-01' },
        { account: { login: 'Me', type: 'User' }, app_slug: 'planner', suspended_at: null },
      ] }))
    vi.stubGlobal('fetch', fetch)
    await expect(hasPersonalInstallation('example', 'me', 'planner')).resolves.toBe(true)
    expect(fetch.mock.calls[1][0]).toContain('page=2')
  })
  it('reports absent installations and does not treat errors as missing installations', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(ok({ installations: [] })).mockResolvedValueOnce(new Response('', { status: 401 }))
    vi.stubGlobal('fetch', fetch)
    await expect(hasPersonalInstallation('example', 'me', 'planner')).resolves.toBe(false)
    await expect(hasPersonalInstallation('example', 'me', 'planner')).rejects.toThrow('expired or was revoked')
  })
  it('serializes Unicode data and includes the last known SHA', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(ok({ login: 'me' })).mockResolvedValueOnce(ok({ private: true, owner: { login: 'me' } })).mockResolvedValueOnce(ok({ content: { sha: 'new' } }))
    vi.stubGlobal('fetch', fetch)
    const data = { ...emptyData(), periods: [{ id: '1', name: 'Café ☕', start: '2026-12-20', end: '2026-12-30' }] }
    expect(await writeCloud('example', target, data, 'old')).toBe('new')
    const body = JSON.parse(fetch.mock.calls[2][1].body)
    expect(body.sha).toBe('old')
    expect(body.branch).toBe('main')
    expect(JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(body.content), c => c.charCodeAt(0))))).toEqual(data)
  })
  it('initializes the planner file without a SHA when creating it', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(ok({ login: 'me' })).mockResolvedValueOnce(ok({ private: true, owner: { login: 'me' } })).mockResolvedValueOnce(ok({ content: { sha: 'created' } }))
    vi.stubGlobal('fetch', fetch)

    await expect(writeCloud('example', target, emptyData())).resolves.toBe('created')
    const body = JSON.parse(fetch.mock.calls[2][1].body)
    expect(body).not.toHaveProperty('sha')
    expect(body.branch).toBe('main')
  })
  it('reads and validates the remote copy', async () => {
    const data = emptyData(), content = btoa(JSON.stringify(data))
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(ok({ login: 'me' })).mockResolvedValueOnce(ok({ private: true, owner: { login: 'me' } })).mockResolvedValueOnce(ok({ sha: 'abc', encoding: 'base64', content })))
    expect(await readCloud('example', target)).toEqual({ data, sha: 'abc' })
  })
  it('refuses public repositories', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(ok({ login: 'me' })).mockResolvedValueOnce(ok({ private: false, owner: { login: 'me' } }))
    vi.stubGlobal('fetch', fetch)
    await expect(writeCloud('example', target, emptyData())).rejects.toThrow('private repository')
    expect(fetch).toHaveBeenCalledTimes(2)
  })
  it('explains when GitHub App repository permissions are insufficient', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(ok({ login: 'me' }))
      .mockResolvedValueOnce(ok({ private: true, owner: { login: 'me' } }))
      .mockResolvedValueOnce(new Response('', { status: 403 })))

    await expect(writeCloud('example', target, emptyData())).rejects.toBeInstanceOf(GitHubPermissionError)
  })
  it('creates a private initialized repository when it does not exist', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 404 }))
      .mockResolvedValueOnce(ok({ private: true, owner: { login: 'me' }, default_branch: 'main' }, 201))
    vi.stubGlobal('fetch', fetch)

    await expect(ensurePrivateRepository('example', 'me', 'planner-data')).resolves.toEqual({ branch: 'main', created: true })
    expect(fetch.mock.calls[1][0]).toBe('https://api.github.com/user/repos')
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toMatchObject({ name: 'planner-data', private: true, auto_init: true })
  })
  it('reuses an existing private repository and refuses a public one', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(ok({ private: true, owner: { login: 'me' }, default_branch: 'main' }))
      .mockResolvedValueOnce(ok({ private: false, owner: { login: 'me' }, default_branch: 'main' })))

    await expect(ensurePrivateRepository('example', 'me', 'planner-data')).resolves.toEqual({ branch: 'main', created: false })
    await expect(ensurePrivateRepository('example', 'me', 'public-data')).rejects.toThrow('must be private')
  })
  it('identifies a stale cloud version as a resolvable conflict', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(ok({ login: 'me' })).mockResolvedValueOnce(ok({ private: true, owner: { login: 'me' } })).mockResolvedValueOnce(new Response('', { status: 409 }))
    vi.stubGlobal('fetch', fetch)
    await expect(writeCloud('example', target, emptyData(), 'stale')).rejects.toBeInstanceOf(CloudConflictError)
  })
})
