import { afterEach, describe, expect, it, vi } from 'vitest'
import { emptyData } from './model'
import { readCloud, writeCloud } from './sync'

const target = { owner: 'me', repo: 'private', branch: 'main', path: 'data/meetup-planner.json' }
const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
afterEach(() => vi.unstubAllGlobals())

describe('GitHub sync', () => {
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
})
