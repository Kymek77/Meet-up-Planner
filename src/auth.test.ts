import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { beginGitHubAuthorization, exchangeGitHubCode, takeGitHubCallback } from './auth'
import worker from '../worker/index'

const origin = 'https://planner.example'
const callback = `${origin}/planner/`
const env = { GITHUB_CLIENT_ID: 'client', GITHUB_CLIENT_SECRET: 'example-secret', PLANNER_ORIGIN: origin, CALLBACK_URL: callback }
const verifier = 'a'.repeat(43)
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

beforeEach(() => {
  const storage = new Map<string, string>()
  vi.stubGlobal('sessionStorage', {
    setItem: (key: string, value: string) => storage.set(key, value),
    getItem: (key: string) => storage.get(key) ?? null,
    removeItem: (key: string) => storage.delete(key),
  })
  vi.stubGlobal('history', { replaceState: vi.fn() })
})
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('GitHub web authorization', () => {
  it('creates a PKCE-protected authorization and consumes the matching callback once', async () => {
    const url = new URL(await beginGitHubAuthorization('client', callback))
    expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize')
    expect(url.searchParams.get('redirect_uri')).toBe(callback)
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.has('scope')).toBe(false)
    const pending = JSON.parse(sessionStorage.getItem('meetup-github-auth')!)
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pending.verifier)))
    expect(url.searchParams.get('code_challenge')).toBe(btoa(String.fromCharCode(...digest)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''))
    const result = takeGitHubCallback(new URL(`${callback}?code=example&state=${pending.state}`))
    expect(result).toEqual({ code: 'example', verifier: pending.verifier })
    expect(history.replaceState).toHaveBeenCalledWith(null, '', callback)
    expect(() => takeGitHubCallback(new URL(`${callback}?code=example&state=${pending.state}`))).toThrow('expired or did not match')
  })

  it('rejects mismatched, expired and denied authorization callbacks', async () => {
    await beginGitHubAuthorization('client', callback)
    expect(() => takeGitHubCallback(new URL(`${callback}?code=example&state=wrong`))).toThrow('did not match')
    await beginGitHubAuthorization('client', callback)
    const pending = JSON.parse(sessionStorage.getItem('meetup-github-auth')!)
    pending.created -= 11 * 60 * 1000
    sessionStorage.setItem('meetup-github-auth', JSON.stringify(pending))
    expect(() => takeGitHubCallback(new URL(`${callback}?code=example&state=${pending.state}`))).toThrow('expired')
    await beginGitHubAuthorization('client', callback)
    const state = JSON.parse(sessionStorage.getItem('meetup-github-auth')!).state
    expect(() => takeGitHubCallback(new URL(`${callback}?error=access_denied&state=${state}`))).toThrow('denied')
  })

  it('exchanges the code using the configured service and rejects insecure URLs', async () => {
    const fetch = vi.fn().mockResolvedValue(json({ access_token: 'example-token' }))
    vi.stubGlobal('fetch', fetch)
    await expect(exchangeGitHubCode('https://auth.example', 'code', verifier)).resolves.toBe('example-token')
    expect(fetch.mock.calls[0][0].href).toBe('https://auth.example/exchange')
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ code: 'code', verifier })
    await expect(exchangeGitHubCode('http://auth.example', 'code', verifier)).rejects.toThrow('HTTPS')
    fetch.mockRejectedValueOnce(new TypeError('Load failed'))
    await expect(exchangeGitHubCode('https://auth.example', 'code', verifier)).rejects.toThrow('Could not reach')
  })
})

describe('authentication worker', () => {
  const request = (body: unknown, requestOrigin = origin) => new Request('https://auth.example/exchange', {
    method: 'POST', headers: { Origin: requestOrigin, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  it('exchanges only valid requests for the configured origin and callback', async () => {
    const fetch = vi.fn().mockResolvedValue(json({ access_token: 'example-token', refresh_token: 'not-returned' }))
    vi.stubGlobal('fetch', fetch)
    const response = await worker.fetch(request({ code: 'code', verifier }), env)
    expect(response.status).toBe(200)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(origin)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(await response.json()).toEqual({ access_token: 'example-token' })
    const body = fetch.mock.calls[0][1].body as URLSearchParams
    expect(body.get('client_secret')).toBe(env.GITHUB_CLIENT_SECRET)
    expect(body.get('code_verifier')).toBe(verifier)
    expect(body.get('redirect_uri')).toBe(callback)
  })
  it('rejects other origins and invalid inputs without contacting GitHub', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    expect((await worker.fetch(request({ code: 'code', verifier }, 'https://other.example'), env)).status).toBe(403)
    expect((await worker.fetch(request({ code: 'code', verifier: 'short' }), env)).status).toBe(400)
    expect((await worker.fetch(request({ code: 'code', verifier: 'a'.repeat(5000) }), env)).status).toBe(413)
    expect((await worker.fetch(request({ code: 'code', verifier }), { ...env, CALLBACK_URL: 'https://other.example/' })).status).toBe(503)
    expect(fetch).not.toHaveBeenCalled()
  })
  it('does not expose GitHub errors and handles CORS preflight', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ error: 'bad_verification_code', error_description: 'sensitive details' })))
    const response = await worker.fetch(request({ code: 'code', verifier }), env)
    expect(response.status).toBe(401)
    expect(await response.text()).not.toContain('sensitive details')
    const preflight = await worker.fetch(new Request('https://auth.example/exchange', { method: 'OPTIONS', headers: { Origin: origin } }), env)
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('Access-Control-Allow-Origin')).toBe(origin)
  })
})
