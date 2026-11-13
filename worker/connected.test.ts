import { afterEach, describe, expect, it, vi } from 'vitest'
import worker, { SessionStore } from './index'

const origin = 'https://planner.example'
const secret = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)))
function setup() {
  const records = new Map<string, Map<string, unknown>>()
  const objects = new Map<string, SessionStore>()
  const env = {
    GITHUB_CLIENT_ID: 'client', GITHUB_CLIENT_SECRET: 'secret', PLANNER_ORIGIN: 'https://legacy.example', CALLBACK_URL: 'https://legacy.example/callback',
    APP_ORIGIN: origin, CONNECTED_CALLBACK_URL: `${origin}/callback`, SESSION_ENCRYPTION_KEY: secret,
    ASSETS: { fetch: vi.fn(async () => new Response('asset')) },
    SESSION_STORE: {
      idFromName: (name: string) => name,
      get: (name: string) => {
        if (!objects.has(name)) {
          const data = new Map<string, unknown>(); records.set(name, data)
          const storage = { get: async (key: string) => data.get(key), put: async (key: string, value: unknown) => { data.set(key, value) }, deleteAll: async () => { data.clear() }, setAlarm: async () => {}, deleteAlarm: async () => {} }
          objects.set(name, new SessionStore({ storage } as never, env as never))
        }
        return objects.get(name)!
      },
    },
  }
  async function send(path: string, method = 'GET', body?: unknown, cookie?: string, requestOrigin = origin) {
    return worker.fetch(new Request(`${origin}${path}`, { method, headers: { Origin: requestOrigin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env as never)
  }
  return { env, records, send }
}
const oauth = (result: unknown) => new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } })
const exchange = { code: 'code', verifier: 'v'.repeat(43) }
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers() })

describe('connected sessions', () => {
  it('encrypts tokens, uses a strict host cookie, and deletes the session on logout', async () => {
    const { send, records } = setup()
    vi.stubGlobal('fetch', vi.fn(async () => oauth({ access_token: 'secret-access', refresh_token: 'secret-refresh', expires_in: 3600 })))
    const response = await send('/api/session/exchange', 'POST', exchange)
    expect(await response.json()).toEqual({ authenticated: true })
    const cookie = response.headers.get('set-cookie')!
    expect(cookie).toMatch(/^__Host-planner_session=[\w-]{43}; Path=\/; Max-Age=2592000; HttpOnly; Secure; SameSite=Strict$/)
    expect(JSON.stringify([...records.values()].map(m => [...m.values()]))).not.toContain('secret-')
    expect(await (await send('/api/session', 'GET', undefined, cookie)).json()).toEqual({ authenticated: true })
    expect((await send('/api/session/logout', 'POST', undefined, cookie, 'https://evil.example')).status).toBe(403)
    const logout = await send('/api/session/logout', 'POST', undefined, cookie)
    expect(logout.headers.get('set-cookie')).toContain('Max-Age=0')
    expect((await send('/api/session', 'GET', undefined, cookie)).status).toBe(401)
  })
  it('retains device pending responses and legacy token responses with exact configured callback', async () => {
    const { send, env } = setup()
    const fetch = vi.fn(async () => oauth({ error: 'authorization_pending' })); vi.stubGlobal('fetch', fetch)
    const pending = await send('/api/session/device-token', 'POST', { device_code: 'abc' })
    expect(await pending.json()).toEqual({ error: 'authorization_pending' })
    expect(pending.headers.get('set-cookie')).toBeNull()
    fetch.mockResolvedValueOnce(oauth({ access_token: 'legacy-token', refresh_token: 'hidden' }))
    const legacy = await worker.fetch(new Request('https://auth.example/exchange', { method: 'POST', headers: { Origin: env.PLANNER_ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify(exchange) }), env as never)
    expect(await legacy.json()).toEqual({ access_token: 'legacy-token' })
    expect((fetch.mock.calls[1][1]!.body as URLSearchParams).get('redirect_uri')).toBe(env.CALLBACK_URL)
  })
  it('only proxies permitted paths, does not follow redirects, and preserves conditional 304', async () => {
    const { send } = setup()
    const fetch = vi.fn().mockResolvedValueOnce(oauth({ access_token: 'token' }))
      .mockResolvedValueOnce(oauth({ login: 'A' }))
      .mockResolvedValueOnce(oauth({ private: true, owner: { login: 'a' } }))
      .mockResolvedValueOnce(new Response(null, { status: 304, headers: { etag: '"v1"', 'x-ratelimit-reset': '123' } }))
    vi.stubGlobal('fetch', fetch)
    const login = await send('/api/session/exchange', 'POST', exchange); const cookie = login.headers.get('set-cookie')!
    for (const path of ['https://evil.example/user', '/repos/a/b/contents/%2e%2e/x', '/repos/a/b/contents/%252e%252e/x', '/repos/a/b/contents/a%2fb', '/user?x=1', '/repos/a/b/hooks', '/user/installations?per_page=100&page=0']) {
      expect((await send('/api/github', 'POST', { path, method: 'GET' }, cookie)).status).toBe(400)
    }
    expect((await send('/api/github', 'POST', { path: '/user/repos', method: 'POST', body: { name: 'data', private: false } }, cookie)).status).toBe(400)
    const proxy = await send('/api/github', 'POST', { path: '/repos/a/b/contents/data.json?ref=main', method: 'GET', etag: '"v1"' }, cookie)
    expect(await proxy.json()).toEqual({ status: 304, body: null, etag: '"v1"', rateLimitReset: '123' })
    expect(fetch).toHaveBeenCalledTimes(4)
    expect(fetch.mock.calls[3][1].redirect).toBe('manual')
    expect(fetch.mock.calls[3][1].headers.get('Authorization')).toBe('Bearer token')
  })
  it.each([
    ['public', { private: false, owner: { login: 'a' } }],
    ['other-owned', { private: true, owner: { login: 'other' } }],
  ])('refuses %s repository metadata, contents reads and writes', async (_label, repository) => {
    const { send } = setup()
    const fetch = vi.fn().mockResolvedValueOnce(oauth({ access_token: 'token' }))
      .mockImplementation(async (url: string) => url.endsWith('/user') ? oauth({ login: 'A' }) : oauth(repository))
    vi.stubGlobal('fetch', fetch)
    const login = await send('/api/session/exchange', 'POST', exchange); const cookie = login.headers.get('set-cookie')!
    for (const [path, method, body] of [
      ['/repos/a/b', 'GET', undefined],
      ['/repos/a/b/contents/file?ref=main', 'GET', undefined],
      ['/repos/a/b/contents/file', 'PUT', { message: 'update', content: 'eA==' }],
    ] as const) {
      const response = await send('/api/github', 'POST', { path, method, body }, cookie)
      expect(await response.json()).toEqual({ status: 403, body: { message: 'GitHub request failed.' } })
    }
    expect(fetch).toHaveBeenCalledTimes(7)
    expect(fetch.mock.calls.slice(1).map(call => call[0])).toEqual([
      'https://api.github.com/user', 'https://api.github.com/repos/a/b',
      'https://api.github.com/user', 'https://api.github.com/repos/a/b',
      'https://api.github.com/user', 'https://api.github.com/repos/a/b',
    ])
  })
  it('validates the signed-in owner and preserves write conflicts', async () => {
    const { send } = setup()
    const fetch = vi.fn().mockResolvedValueOnce(oauth({ access_token: 'token' }))
      .mockResolvedValueOnce(oauth({ login: 'Alice' })).mockResolvedValueOnce(oauth({ private: true, owner: { login: 'alice' } }))
      .mockResolvedValueOnce(new Response('secret conflict details', { status: 409 }))
      .mockResolvedValueOnce(oauth({ login: 'alice' })).mockResolvedValueOnce(oauth({ private: true, owner: { login: 'alice' } }))
    vi.stubGlobal('fetch', fetch)
    const login = await send('/api/session/exchange', 'POST', exchange); const cookie = login.headers.get('set-cookie')!
    const write = await send('/api/github', 'POST', { path: '/repos/ALICE/b/contents/file', method: 'PUT', body: { message: 'update', content: 'eA==' } }, cookie)
    expect(await write.json()).toEqual({ status: 409, body: { message: 'GitHub request failed.' } })
    const mismatch = await send('/api/github', 'POST', { path: '/repos/other/b/contents/file', method: 'GET' }, cookie)
    expect(await mismatch.json()).toEqual({ status: 403, body: { message: 'GitHub request failed.' } })
    expect(fetch).toHaveBeenCalledTimes(6)
  })
  it.each([401, 403, 404, 429])('preserves sanitized verification failure %i', async status => {
    for (const stage of ['user', 'repo']) {
      const { send } = setup()
      const fetch = vi.fn().mockResolvedValueOnce(oauth({ access_token: 'token' }))
      if (stage === 'repo') fetch.mockResolvedValueOnce(oauth({ login: 'a' }))
      fetch.mockResolvedValueOnce(new Response('upstream secret', { status, headers: { 'retry-after': '5', 'x-ratelimit-reset': '42' } }))
      vi.stubGlobal('fetch', fetch)
      const login = await send('/api/session/exchange', 'POST', exchange); const cookie = login.headers.get('set-cookie')!
      const result = await send('/api/github', 'POST', { path: '/repos/a/b/contents/file', method: 'GET' }, cookie)
      expect(await result.json()).toEqual({ status, body: { message: 'GitHub request failed.' }, retryAfter: '5', rateLimitReset: '42' })
      expect(fetch).toHaveBeenCalledTimes(stage === 'user' ? 2 : 3)
    }
  })
  it('fails closed on network errors and invalid user verification responses', async () => {
    for (const badUser of [null, { login: 42 }]) {
      const { send } = setup()
      const fetch = vi.fn().mockResolvedValueOnce(oauth({ access_token: 'token' }))
      if (badUser === null) fetch.mockRejectedValueOnce(new Error('secret network error'))
      else fetch.mockResolvedValueOnce(oauth(badUser))
      vi.stubGlobal('fetch', fetch)
      const login = await send('/api/session/exchange', 'POST', exchange); const cookie = login.headers.get('set-cookie')!
      const result = await send('/api/github', 'POST', { path: '/repos/a/b/contents/file', method: 'GET' }, cookie)
      expect(result.status).toBe(502)
      expect(await result.json()).toEqual({ error: 'Request could not be completed.' })
      expect(fetch).toHaveBeenCalledTimes(2)
    }
  })
  it('fails closed if repository verification is unavailable or malformed', async () => {
    for (const repository of [null, { owner: { login: 'a' } }]) {
      const { send } = setup()
      const fetch = vi.fn().mockResolvedValueOnce(oauth({ access_token: 'token' })).mockResolvedValueOnce(oauth({ login: 'a' }))
      if (repository === null) fetch.mockRejectedValueOnce(new Error('secret network error'))
      else fetch.mockResolvedValueOnce(oauth(repository))
      vi.stubGlobal('fetch', fetch)
      const login = await send('/api/session/exchange', 'POST', exchange); const cookie = login.headers.get('set-cookie')!
      const result = await send('/api/github', 'POST', { path: '/repos/a/b/contents/file', method: 'PUT', body: { message: 'update', content: 'eA==' } }, cookie)
      if (repository === null) expect(result.status).toBe(502)
      else expect((await result.json()).status).toBe(403)
      expect(fetch).toHaveBeenCalledTimes(3)
    }
  })
  it('verifies metadata before honoring a conditional repository request', async () => {
    const { send } = setup()
    const fetch = vi.fn().mockResolvedValueOnce(oauth({ access_token: 'token' }))
      .mockResolvedValueOnce(oauth({ login: 'a' })).mockResolvedValueOnce(oauth({ private: true, owner: { login: 'a' } }))
      .mockResolvedValueOnce(new Response(null, { status: 304, headers: { etag: '"v1"' } }))
    vi.stubGlobal('fetch', fetch)
    const login = await send('/api/session/exchange', 'POST', exchange); const cookie = login.headers.get('set-cookie')!
    const response = await send('/api/github', 'POST', { path: '/repos/a/b', method: 'GET', etag: '"v1"' }, cookie)
    expect(await response.json()).toEqual({ status: 304, body: null, etag: '"v1"' })
    expect(fetch.mock.calls[2][1].headers.get('If-None-Match')).toBeNull()
    expect(fetch.mock.calls[3][1].headers.get('If-None-Match')).toBe('"v1"')
  })
  it('conditionally revalidates exact user and repository per session, falling back without ETags', async () => {
    const { send } = setup()
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      if (url.startsWith('https://github.com/')) return oauth({ access_token: 'token' })
      const conditional = (init.headers as Headers).get('If-None-Match')
      if (url.endsWith('/user')) return conditional ? new Response(null, { status: 304 }) : new Response(JSON.stringify({ login: 'a' }), { headers: { etag: '"user"' } })
      if (url.endsWith('/repos/a/b')) return conditional ? new Response(null, { status: 304 }) : new Response(JSON.stringify({ private: true, owner: { login: 'a' } }), { headers: { etag: '"repo"' } })
      if (url.endsWith('/repos/a/c')) return oauth({ private: true, owner: { login: 'a' } })
      return oauth({ sha: 'file' })
    })
    vi.stubGlobal('fetch', fetch)
    const first = await send('/api/session/exchange', 'POST', exchange); const cookie = first.headers.get('set-cookie')!
    const request = (repo: string, value = cookie) => send('/api/github', 'POST', { path: `/repos/a/${repo}/contents/file`, method: 'GET' }, value)
    expect((await (await request('b')).json()).body).toEqual({ sha: 'file' })
    expect((await (await request('b')).json()).body).toEqual({ sha: 'file' })
    expect(fetch.mock.calls[4][1].headers.get('If-None-Match')).toBe('"user"')
    expect(fetch.mock.calls[5][1].headers.get('If-None-Match')).toBe('"repo"')
    await request('c'); await request('c')
    const cChecks = fetch.mock.calls.filter(([url]) => url.endsWith('/repos/a/c'))
    expect(cChecks).toHaveLength(2)
    expect(cChecks.every(([, options]) => options.headers.get('If-None-Match') === null)).toBe(true)
    const second = await send('/api/session/exchange', 'POST', exchange)
    await request('b', second.headers.get('set-cookie')!)
    const checks = fetch.mock.calls.filter(([url]) => url.endsWith('/repos/a/b'))
    expect(checks).toHaveLength(3)
    expect(checks[2][1].headers.get('If-None-Match')).toBeNull()
  })
  it('clears cached validators after refresh token rotation', async () => {
    const { send } = setup()
    vi.useFakeTimers()
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      if (url.startsWith('https://github.com/')) {
        const refresh = (init.body as URLSearchParams).get('grant_type') === 'refresh_token'
        return oauth({ access_token: refresh ? 'new' : 'old', refresh_token: refresh ? 'new-refresh' : 'old-refresh', expires_in: 120 })
      }
      if (url.endsWith('/user')) return new Response(JSON.stringify({ login: 'a' }), { headers: { etag: '"user"' } })
      if (url.endsWith('/repos/a/b')) return new Response(JSON.stringify({ private: true, owner: { login: 'a' } }), { headers: { etag: '"repo"' } })
      return oauth({ sha: 'file' })
    })
    vi.stubGlobal('fetch', fetch)
    const first = await send('/api/session/exchange', 'POST', exchange); const cookie = first.headers.get('set-cookie')!
    const request = () => send('/api/github', 'POST', { path: '/repos/a/b/contents/file', method: 'GET' }, cookie)
    expect((await request()).status).toBe(200)
    vi.advanceTimersByTime(61000)
    expect((await request()).status).toBe(200)
    const users = fetch.mock.calls.filter(([url]) => url.endsWith('/user'))
    const repos = fetch.mock.calls.filter(([url]) => url.endsWith('/repos/a/b'))
    expect(users[1][1].headers.get('Authorization')).toBe('Bearer new')
    expect(users[1][1].headers.get('If-None-Match')).toBeNull()
    expect(repos[1][1].headers.get('If-None-Match')).toBeNull()
  })
  it.each([401, 403, 404, 429])('does not reuse cached repository on verification failure %i', async status => {
    const { send } = setup()
    let repoChecks = 0
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      if (url.startsWith('https://github.com/')) return oauth({ access_token: 'token' })
      if (url.endsWith('/user')) return (init.headers as Headers).has('If-None-Match') ? new Response(null, { status: 304 }) : new Response(JSON.stringify({ login: 'a' }), { headers: { etag: '"user"' } })
      if (url.endsWith('/repos/a/b')) {
        repoChecks++
        return repoChecks === 1 ? new Response(JSON.stringify({ private: true, owner: { login: 'a' } }), { headers: { etag: '"repo"' } }) : new Response('secret', { status })
      }
      return oauth({ sha: 'file' })
    })
    vi.stubGlobal('fetch', fetch)
    const first = await send('/api/session/exchange', 'POST', exchange); const cookie = first.headers.get('set-cookie')!
    const request = () => send('/api/github', 'POST', { path: '/repos/a/b/contents/file', method: 'GET' }, cookie)
    await request()
    expect((await (await request()).json()).status).toBe(status)
    expect((await (await request()).json()).status).toBe(status)
    const repos = fetch.mock.calls.filter(([url]) => url.endsWith('/repos/a/b'))
    expect(repos[1][1].headers.get('If-None-Match')).toBe('"repo"')
    expect(repos[2][1].headers.get('If-None-Match')).toBeNull()
    expect(fetch.mock.calls.filter(([url]) => url.endsWith('/contents/file'))).toHaveLength(1)
  })
  it('discards both caches after user authorization is revoked', async () => {
    const { send } = setup()
    let userChecks = 0
    const fetch = vi.fn(async (url: string) => {
      if (url.startsWith('https://github.com/')) return oauth({ access_token: 'token' })
      if (url.endsWith('/user')) {
        userChecks++
        return userChecks === 2 ? new Response('secret', { status: 401 }) : new Response(JSON.stringify({ login: 'a' }), { headers: { etag: '"user"' } })
      }
      if (url.endsWith('/repos/a/b')) return new Response(JSON.stringify({ private: true, owner: { login: 'a' } }), { headers: { etag: '"repo"' } })
      return oauth({ sha: 'file' })
    })
    vi.stubGlobal('fetch', fetch)
    const first = await send('/api/session/exchange', 'POST', exchange); const cookie = first.headers.get('set-cookie')!
    const request = () => send('/api/github', 'POST', { path: '/repos/a/b/contents/file', method: 'GET' }, cookie)
    await request()
    expect((await (await request()).json()).status).toBe(401)
    await request()
    const users = fetch.mock.calls.filter(([url]) => url.endsWith('/user'))
    const repos = fetch.mock.calls.filter(([url]) => url.endsWith('/repos/a/b'))
    expect(users[1][1].headers.get('If-None-Match')).toBe('"user"')
    expect(users[2][1].headers.get('If-None-Match')).toBeNull()
    expect(repos[1][1].headers.get('If-None-Match')).toBeNull()
  })
  it('rejects unsolicited 304 verification responses without cached validation', async () => {
    const { send } = setup()
    const fetch = vi.fn().mockResolvedValueOnce(oauth({ access_token: 'token' }))
      .mockResolvedValueOnce(new Response(null, { status: 304 }))
    vi.stubGlobal('fetch', fetch)
    const first = await send('/api/session/exchange', 'POST', exchange); const cookie = first.headers.get('set-cookie')!
    const result = await send('/api/github', 'POST', { path: '/repos/a/b/contents/file', method: 'GET' }, cookie)
    expect(result.status).toBe(502)
    expect(fetch).toHaveBeenCalledTimes(2)
  })
  it('rejects a repository that becomes public after being cached', async () => {
    const { send } = setup()
    let repoChecks = 0
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      if (url.startsWith('https://github.com/')) return oauth({ access_token: 'token' })
      if (url.endsWith('/user')) return (init.headers as Headers).has('If-None-Match') ? new Response(null, { status: 304 }) : new Response(JSON.stringify({ login: 'a' }), { headers: { etag: '"user"' } })
      if (url.endsWith('/repos/a/b')) {
        repoChecks++
        return new Response(JSON.stringify({ private: repoChecks === 1, owner: { login: 'a' } }), { headers: { etag: repoChecks === 1 ? '"old"' : '"new"' } })
      }
      return oauth({ sha: 'file' })
    })
    vi.stubGlobal('fetch', fetch)
    const first = await send('/api/session/exchange', 'POST', exchange); const cookie = first.headers.get('set-cookie')!
    const request = () => send('/api/github', 'POST', { path: '/repos/a/b/contents/file', method: 'GET' }, cookie)
    await request()
    expect((await (await request()).json()).status).toBe(403)
    expect((await (await request()).json()).status).toBe(403)
    const repos = fetch.mock.calls.filter(([url]) => url.endsWith('/repos/a/b'))
    expect(repos[1][1].headers.get('If-None-Match')).toBe('"old"')
    expect(repos[2][1].headers.get('If-None-Match')).toBeNull()
    expect(fetch.mock.calls.filter(([url]) => url.endsWith('/contents/file'))).toHaveLength(1)
  })
  it('validates repository creation results before exposing them', async () => {
    const { send } = setup()
    const fetch = vi.fn().mockResolvedValueOnce(oauth({ access_token: 'token' }))
      .mockResolvedValueOnce(oauth({ login: 'a' })).mockResolvedValueOnce(oauth({ private: false, owner: { login: 'a' }, secret: 'do not expose' }))
      .mockResolvedValueOnce(oauth({ login: 'a' })).mockResolvedValueOnce(oauth({ private: true, owner: { login: 'A' }, default_branch: 'main' }))
    vi.stubGlobal('fetch', fetch)
    const login = await send('/api/session/exchange', 'POST', exchange); const cookie = login.headers.get('set-cookie')!
    const input = { path: '/user/repos', method: 'POST', body: { name: 'b', private: true } }
    expect(await (await send('/api/github', 'POST', input, cookie)).json()).toEqual({ status: 403, body: { message: 'GitHub request failed.' } })
    expect(await (await send('/api/github', 'POST', input, cookie)).json()).toEqual({ status: 200, body: { private: true, owner: { login: 'A' }, default_branch: 'main' } })
  })
  it('logs only a sanitized category for unexpected connected errors', async () => {
    const { env, send } = setup()
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    env.SESSION_STORE.idFromName = () => { throw new Error('sensitive exception') }
    const result = await send('/api/session', 'GET', undefined, `__Host-planner_session=${'a'.repeat(43)}`)
    expect(result.status).toBe(503)
    expect(log).toHaveBeenCalledWith('Connected Worker failure', { category: 'unexpected_request_error' })
    expect(JSON.stringify(log.mock.calls)).not.toContain('sensitive')
  })
  it('serializes refresh rotation across concurrent requests', async () => {
    const { send } = setup()
    const fetch = vi.fn().mockResolvedValueOnce(oauth({ access_token: 'old', refresh_token: 'refresh-old', expires_in: 1 }))
      .mockResolvedValueOnce(oauth({ access_token: 'new', refresh_token: 'refresh-new', expires_in: 3600 }))
      .mockImplementation(async () => oauth({ login: 'user' }))
    vi.stubGlobal('fetch', fetch)
    const login = await send('/api/session/exchange', 'POST', exchange); const cookie = login.headers.get('set-cookie')!
    const responses = await Promise.all([send('/api/github', 'POST', { path: '/user', method: 'GET' }, cookie), send('/api/github', 'POST', { path: '/user', method: 'GET' }, cookie)])
    expect(await Promise.all(responses.map(r => r.json()))).toEqual([{ status: 200, body: { login: 'user' } }, { status: 200, body: { login: 'user' } }])
    expect(fetch).toHaveBeenCalledTimes(4)
    expect(fetch.mock.calls[1][1].body.get('refresh_token')).toBe('refresh-old')
    expect(fetch.mock.calls[2][1].headers.get('Authorization')).toBe('Bearer new')
    expect(fetch.mock.calls[3][1].headers.get('Authorization')).toBe('Bearer new')
  })
  it('sanitizes GitHub failures and rejects cross-origin mutations without CORS', async () => {
    const { send } = setup()
    const fetch = vi.fn().mockResolvedValueOnce(oauth({ access_token: 'token' }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: 'secret upstream details' }), { status: 403, headers: { 'retry-after': '5' } }))
    vi.stubGlobal('fetch', fetch)
    const login = await send('/api/session/exchange', 'POST', exchange); const cookie = login.headers.get('set-cookie')!
    const denied = await send('/api/github', 'POST', { path: '/user', method: 'GET' }, cookie, 'https://evil.example')
    expect(denied.status).toBe(403)
    expect(denied.headers.get('access-control-allow-origin')).toBeNull()
    const result = await send('/api/github', 'POST', { path: '/user', method: 'GET' }, cookie)
    expect(await result.json()).toEqual({ status: 403, body: { message: 'GitHub request failed.' }, retryAfter: '5' })
    expect(result.headers.get('cache-control')).toBe('no-store')
  })
  it('expires tokens without refresh and revokes rejected refresh tokens', async () => {
    const { send } = setup()
    vi.useFakeTimers()
    const fetch = vi.fn().mockResolvedValueOnce(oauth({ access_token: 'short-lived', expires_in: 1 }))
      .mockResolvedValueOnce(oauth({ access_token: 'old', refresh_token: 'invalid', expires_in: 1 }))
      .mockResolvedValueOnce(oauth({ error: 'bad_refresh_token' }))
    vi.stubGlobal('fetch', fetch)
    const first = await send('/api/session/exchange', 'POST', exchange)
    vi.advanceTimersByTime(2000)
    expect((await send('/api/session', 'GET', undefined, first.headers.get('set-cookie')!)).status).toBe(401)
    const second = await send('/api/session/exchange', 'POST', exchange)
    expect((await send('/api/session', 'GET', undefined, second.headers.get('set-cookie')!)).status).toBe(401)
    expect((await send('/api/session', 'GET', undefined, second.headers.get('set-cookie')!)).status).toBe(401)
    expect(fetch).toHaveBeenCalledTimes(3)
  })
  it('selects only configured legacy callback origins', async () => {
    const { env } = setup()
    const fetch = vi.fn(async () => oauth({ access_token: 'token' }))
    vi.stubGlobal('fetch', fetch)
    const opts = { ...env, LEGACY_PLANNER_ORIGIN: 'https://older.example', LEGACY_CALLBACK_URL: 'https://older.example/callback' }
    const request = (origin: string) => new Request('https://auth.example/exchange', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(exchange) })
    expect((await worker.fetch(request('https://older.example'), opts as never)).status).toBe(200)
    expect((fetch.mock.calls[0][1]!.body as URLSearchParams).get('redirect_uri')).toBe('https://older.example/callback')
    expect((await worker.fetch(request('https://evil.example'), opts as never)).status).toBe(403)
  })
})
