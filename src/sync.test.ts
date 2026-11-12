import { afterEach, describe, expect, it, vi } from 'vitest'
import { emptyData } from './model'
import { CloudConflictError, pollDeviceAuthorization, readCloud, requestDeviceAuthorization, writeCloud } from './sync'

const target = { owner: 'me', repo: 'private', branch: 'main', path: 'data/meetup-planner.json' }
const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('GitHub sync', () => {
  it('requests a device code for the configured OAuth app', async () => {
    const authorization = { device_code: 'device', user_code: 'ABCD-EFGH', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 }
    const fetch = vi.fn().mockResolvedValueOnce(ok(authorization))
    vi.stubGlobal('fetch', fetch)
    expect(await requestDeviceAuthorization('client-id')).toEqual(authorization)
    expect(fetch.mock.calls[0][0]).toBe('https://github.com/login/device/code')
    expect(fetch.mock.calls[0][1].body.toString()).toContain('client_id=client-id')
  })
  it('polls through authorization pending until GitHub returns an access token', async () => {
    vi.useFakeTimers()
    const fetch = vi.fn().mockResolvedValueOnce(ok({ error: 'authorization_pending' })).mockResolvedValueOnce(ok({ access_token: 'oauth-token' }))
    vi.stubGlobal('fetch', fetch)
    const authorization = { device_code: 'device', user_code: 'ABCD-EFGH', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 1 }
    const result = pollDeviceAuthorization('client-id', authorization, new AbortController().signal)
    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(1000)
    await expect(result).resolves.toBe('oauth-token')
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
  it('identifies a stale cloud version as a resolvable conflict', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(ok({ login: 'me' })).mockResolvedValueOnce(ok({ private: true, owner: { login: 'me' } })).mockResolvedValueOnce(new Response('', { status: 409 }))
    vi.stubGlobal('fetch', fetch)
    await expect(writeCloud('example', target, emptyData(), 'stale')).rejects.toBeInstanceOf(CloudConflictError)
  })
})
