import { legacyFetch, type Env } from './index'

interface Stub { fetch(request: Request): Promise<Response> }
interface Namespace { idFromName(name: string): unknown; get(id: unknown): Stub }
interface Storage { get<T>(key: string): Promise<T | undefined>; put<T>(key: string, value: T): Promise<void>; deleteAll(): Promise<void>; setAlarm(time: number): Promise<void>; deleteAlarm(): Promise<void> }
interface State { storage: Storage }
export interface ConnectedEnv {
  APP_ORIGIN: string
  CONNECTED_CALLBACK_URL: string
  SESSION_ENCRYPTION_KEY: string
  SESSION_STORE: Namespace
  ASSETS: { fetch(request: Request): Promise<Response> }
}
type AllEnv = Env & ConnectedEnv
type Tokens = { access_token: string; refresh_token?: string; expires_at?: number; refresh_expires_at?: number; session_expires_at: number }
const cookieName = '__Host-planner_session'
const sessionLifetime = 30 * 24 * 60 * 60 * 1000
const maxBody = 2 * 1024 * 1024
const encoder = new TextEncoder()
function hasControl(value: string): boolean {
  return Array.from(value).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
}

function json(body: unknown, status = 200, extra?: HeadersInit): Response {
  const headers = new Headers(extra)
  headers.set('Content-Type', 'application/json')
  headers.set('Cache-Control', 'no-store')
  headers.set('X-Content-Type-Options', 'nosniff')
  return new Response(JSON.stringify(body), { status, headers })
}
function fail(status: number): Response { return json({ error: 'Request could not be completed.' }, status) }
function originConfigured(env: ConnectedEnv, url: URL): boolean {
  try {
    const origin = new URL(env.APP_ORIGIN)
    return origin.protocol === 'https:' && origin.origin === env.APP_ORIGIN && url.origin === origin.origin
  } catch { return false }
}
function cookie(request: Request): string | undefined {
  const matches = (request.headers.get('Cookie') ?? '').split(';').map(x => x.trim()).filter(x => x.startsWith(`${cookieName}=`))
  if (matches.length !== 1) return undefined
  const value = matches[0].slice(cookieName.length + 1)
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : undefined
}
function clearCookie(): string { return `${cookieName}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict` }
function setCookie(value: string): string { return `${cookieName}=${value}; Path=/; Max-Age=${sessionLifetime / 1000}; HttpOnly; Secure; SameSite=Strict` }
async function sessionStub(env: ConnectedEnv, value: string): Promise<Stub> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)))
  const name = Array.from(digest, b => b.toString(16).padStart(2, '0')).join('')
  return env.SESSION_STORE.get(env.SESSION_STORE.idFromName(name))
}
async function internal(stub: Stub, action: string, body?: unknown): Promise<Response> {
  return stub.fetch(new Request(`https://session.internal/${action}`, { method: 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }) }))
}
async function readJson(request: Request, limit: number): Promise<unknown> {
  if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) throw 415
  const length = request.headers.get('Content-Length')
  if (length && (!/^\d+$/.test(length) || Number(length) > limit)) throw 413
  if (!request.body) throw 400
  const reader = request.body.getReader(), chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limit) { await reader.cancel(); throw 413 }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  try { return JSON.parse(new TextDecoder().decode(bytes)) } catch { throw 400 }
}
function validTokens(result: Record<string, unknown>): Tokens | null {
  if (typeof result.access_token !== 'string' || !result.access_token || result.access_token.length > 4096) return null
  if (result.refresh_token !== undefined && (typeof result.refresh_token !== 'string' || !result.refresh_token || result.refresh_token.length > 4096)) return null
  for (const field of ['expires_in', 'refresh_token_expires_in']) {
    if (result[field] !== undefined && (typeof result[field] !== 'number' || !Number.isFinite(result[field]) || (result[field] as number) <= 0 || (result[field] as number) > 315360000)) return null
  }
  const now = Date.now()
  return { access_token: result.access_token, ...(result.refresh_token ? { refresh_token: result.refresh_token as string } : {}),
    ...(result.expires_in !== undefined ? { expires_at: now + (result.expires_in as number) * 1000 } : {}),
    ...(result.refresh_token_expires_in !== undefined ? { refresh_expires_at: now + (result.refresh_token_expires_in as number) * 1000 } : {}), session_expires_at: now + sessionLifetime }
}
function validPath(path: unknown, method: unknown): string | null {
  if (typeof path !== 'string' || path.length > 4096 || typeof method !== 'string' || !['GET', 'POST', 'PUT'].includes(method) || hasControl(path) || /[ \\#]/.test(path)) return null
  if (path === '/user' && method === 'GET') return path
  if (path === '/user/repos' && method === 'POST') return path
  if (/^\/user\/installations\?per_page=100&page=[1-9][0-9]{0,5}$/.test(path) && method === 'GET') return path
  const match = /^\/repos\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\/contents\/([^?]+))?(?:\?([^#]*))?$/.exec(path)
  if (!match || [match[1], match[2]].some(s => s === '.' || s === '..')) return null
  if (!match[3]) return method === 'GET' && !match[4] ? path : null
  if (!['GET', 'PUT'].includes(method)) return null
  const segments = match[3].split('/')
  try {
    for (const segment of segments) {
      const decoded = decodeURIComponent(segment)
      if (!decoded || decoded === '.' || decoded === '..' || hasControl(decoded) || /[/\\%?#]/.test(decoded)) return null
    }
    if (match[4] !== undefined) {
      const params = new URLSearchParams(match[4])
      if (Array.from(params.keys()).length !== 1 || !params.has('ref') || !params.get('ref') || hasControl(params.get('ref')!)) return null
    }
  } catch { return null }
  return path
}
function validProxyBody(path: string, method: string, body: unknown): boolean {
  if (method === 'GET') return body === undefined
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false
  const obj = body as Record<string, unknown>
  if (path === '/user/repos') return Object.keys(obj).every(k => ['name', 'description', 'private', 'auto_init'].includes(k)) &&
    typeof obj.name === 'string' && /^[A-Za-z0-9_.-]{1,100}$/.test(obj.name) && !['.', '..'].includes(obj.name) && obj.private === true &&
    (obj.description === undefined || typeof obj.description === 'string') && (obj.auto_init === undefined || typeof obj.auto_init === 'boolean')
  return Object.keys(obj).every(k => ['message', 'content', 'branch', 'sha'].includes(k)) &&
    typeof obj.message === 'string' && typeof obj.content === 'string' && (obj.branch === undefined || typeof obj.branch === 'string') && (obj.sha === undefined || typeof obj.sha === 'string')
}

export async function connectedFetch(request: Request, env: AllEnv): Promise<Response> {
  const url = new URL(request.url), path = url.pathname
  if (!originConfigured(env, url) || !env.SESSION_STORE || !env.SESSION_ENCRYPTION_KEY) return fail(503)
  if (request.method !== 'GET' && request.headers.get('Origin') !== env.APP_ORIGIN) return fail(403)
  try {
    if (request.method === 'POST' && ['/api/session/exchange', '/api/session/device-code', '/api/session/device-token'].includes(path)) {
      await encryptionKey(env.SESSION_ENCRYPTION_KEY)
      // Reuse the legacy validation and upstream handling without exposing the token to the browser.
      const legacyUrl = new URL(request.url); legacyUrl.pathname = path.slice('/api/session'.length)
      const response = await legacyFetch(new Request(legacyUrl, request), { ...env, PLANNER_ORIGIN: env.APP_ORIGIN, CALLBACK_URL: env.CONNECTED_CALLBACK_URL }, true)
      const data = await response.json() as Record<string, unknown>
      if (!response.ok || path.endsWith('/device-code') || data.error) return json(data, response.status)
      const tokens = validTokens(data)
      if (!tokens) return fail(502)
      const bytes = crypto.getRandomValues(new Uint8Array(32))
      const value = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
      const stored = await internal(await sessionStub(env, value), 'create', tokens)
      if (!stored.ok) return fail(503)
      const old = cookie(request)
      if (old && !(await internal(await sessionStub(env, old), 'logout')).ok) return fail(503)
      return json({ authenticated: true }, 200, { 'Set-Cookie': setCookie(value) })
    }
    if (path === '/api/session/logout' && request.method === 'POST') {
      const value = cookie(request)
      if (value) {
        const result = await internal(await sessionStub(env, value), 'logout')
        if (!result.ok) return fail(503)
      }
      return json({ authenticated: false }, 200, { 'Set-Cookie': clearCookie() })
    }
    if ((path === '/api/session' && request.method === 'GET') || (path === '/api/github' && request.method === 'POST')) {
      const value = cookie(request)
      if (!value) return fail(401)
      const stub = await sessionStub(env, value)
      if (path === '/api/session') return await internal(stub, 'session')
      const input = await readJson(request, maxBody)
      if (!input || typeof input !== 'object' || Array.isArray(input)) return fail(400)
      const { path: githubPath, method, body, etag } = input as Record<string, unknown>
      const safePath = validPath(githubPath, method)
      if (!safePath || !validProxyBody(safePath, method as string, body) ||
        (etag !== undefined && (method !== 'GET' || typeof etag !== 'string' || etag.length > 256 || hasControl(etag)))) return fail(400)
      return await internal(stub, 'github', { path: safePath, method, body, etag })
    }
    return fail(404)
  } catch (error) {
    if (typeof error === 'number') return fail(error)
    console.error('Connected Worker failure', { category: 'unexpected_request_error' })
    return fail(503)
  }
}

type GitHubResult = { status: number; body: unknown; etag?: string; retryAfter?: string; rateLimitReset?: string }
type VerificationCache = { etag: string; body: unknown }
async function githubResult(response: Response): Promise<GitHubResult | null> {
  let body: unknown = null
  if (response.ok && response.status !== 204) {
    try { body = await readJson(responseAsRequest(response), maxBody) } catch { return null }
  } else if (response.status !== 304 && !response.ok) body = { message: 'GitHub request failed.' }
  const result: GitHubResult = { status: response.status, body }
  for (const [header, key] of [['etag', 'etag'], ['retry-after', 'retryAfter'], ['x-ratelimit-reset', 'rateLimitReset']] as const) {
    const value = response.headers.get(header)
    if (value && value.length <= 256 && !hasControl(value)) result[key] = value
  }
  return result
}
function privateOwnedRepository(body: unknown, login: string, requestedOwner?: string): boolean {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false
  const repo = body as { private?: unknown; owner?: { login?: unknown } }
  return repo.private === true && typeof repo.owner?.login === 'string' &&
    repo.owner.login.toLowerCase() === login.toLowerCase() &&
    (requestedOwner === undefined || requestedOwner.toLowerCase() === login.toLowerCase())
}

async function encryptionKey(secret: string): Promise<CryptoKey> {
  const bytes = Uint8Array.from(atob(secret), c => c.charCodeAt(0))
  if (bytes.length !== 32) throw new Error('Invalid encryption key')
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt'])
}
export class SessionStore {
  private state: State
  private env: AllEnv
  private queue: Promise<void> = Promise.resolve()
  private cacheToken: string | undefined
  private userCache: VerificationCache | undefined
  private repoCache: (VerificationCache & { path: string }) | undefined
  constructor(state: State, env: AllEnv) { this.state = state; this.env = env }
  private clearCache(): void {
    this.cacheToken = undefined; this.userCache = undefined; this.repoCache = undefined
  }
  fetch(request: Request): Promise<Response> {
    const result = this.queue.then(() => this.handle(request)).catch(() => {
      console.error('Connected Worker failure', { category: 'session_store_error' })
      return fail(503)
    })
    this.queue = result.then(() => undefined)
    return result
  }
  private async save(tokens: Tokens): Promise<void> {
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await encryptionKey(this.env.SESSION_ENCRYPTION_KEY), encoder.encode(JSON.stringify(tokens))))
    await this.state.storage.put('session', { iv: Array.from(iv), ciphertext: Array.from(ciphertext) })
    await this.state.storage.setAlarm(tokens.session_expires_at)
  }
  private async load(): Promise<Tokens | null> {
    const record = await this.state.storage.get<{ iv: number[]; ciphertext: number[] }>('session')
    if (!record) return null
    const bytes = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(record.iv) }, await encryptionKey(this.env.SESSION_ENCRYPTION_KEY), new Uint8Array(record.ciphertext))
    const tokens = JSON.parse(new TextDecoder().decode(bytes)) as Tokens
    if (tokens.session_expires_at <= Date.now()) { this.clearCache(); await this.state.storage.deleteAll(); return null }
    return tokens
  }
  private async handle(request: Request): Promise<Response> {
    const action = new URL(request.url).pathname
    if (action === '/create') { this.clearCache(); const tokens = await request.json() as Tokens; await this.save(tokens); return json({ ok: true }) }
    if (action === '/logout') { this.clearCache(); await this.state.storage.deleteAll(); await this.state.storage.deleteAlarm(); return json({ ok: true }) }
    let tokens = await this.load()
    if (!tokens) return fail(401)
    if (tokens.expires_at !== undefined && tokens.expires_at <= Date.now() + 60000) {
      if (!tokens.refresh_token || (tokens.refresh_expires_at !== undefined && tokens.refresh_expires_at <= Date.now())) {
        if (tokens.expires_at > Date.now()) { /* Continue using the still-valid access token. */ }
        else { this.clearCache(); await this.state.storage.deleteAll(); return fail(401) }
      } else {
        this.clearCache()
        const parameters = new URLSearchParams({ client_id: this.env.GITHUB_CLIENT_ID, client_secret: this.env.GITHUB_CLIENT_SECRET, grant_type: 'refresh_token', refresh_token: tokens.refresh_token })
        let response: Response
        try { response = await fetch('https://github.com/login/oauth/access_token', { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body: parameters, redirect: 'manual' }) } catch { return fail(502) }
        if (!response.ok) return fail(502)
        let result: Record<string, unknown>
        try { result = await response.json() as Record<string, unknown> } catch { return fail(502) }
        if (result.error === 'bad_refresh_token' || result.error === 'invalid_grant') { this.clearCache(); await this.state.storage.deleteAll(); return fail(401) }
        const refreshed = validTokens(result)
        if (!refreshed || !refreshed.refresh_token) return fail(502)
        refreshed.session_expires_at = tokens.session_expires_at
        await this.save(refreshed)
        tokens = refreshed
      }
    }
    if (action === '/session') return json({ authenticated: true })
    if (action !== '/github') return fail(404)
    const input = await request.json() as { path: string; method: string; body?: unknown; etag?: string }
    const tokenDigest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(tokens.access_token)))
    const tokenKey = Array.from(tokenDigest, b => b.toString(16).padStart(2, '0')).join('')
    if (this.cacheToken !== tokenKey) {
      this.cacheToken = tokenKey
      this.userCache = undefined
      this.repoCache = undefined
    }
    const headers = new Headers({ Accept: 'application/vnd.github+json', Authorization: `Bearer ${tokens.access_token}`, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'meet-up-planner' })
    const call = async (path: string, method = 'GET', body?: unknown, etag?: string): Promise<GitHubResult | null> => {
      const requestHeaders = new Headers(headers)
      if (etag) requestHeaders.set('If-None-Match', etag)
      if (body !== undefined) requestHeaders.set('Content-Type', 'application/json')
      try {
        return await githubResult(await fetch(`https://api.github.com${path}`, {
          method, headers: requestHeaders, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'manual',
        }))
      } catch { return null }
    }
    const repoPath = /^\/repos\/([^/]+)\/([^/?]+)(?:\/contents\/|$)/.exec(input.path)
    const needsIdentity = !!repoPath || input.path === '/user/repos'
    let login: string | undefined
    if (needsIdentity) {
      const cached = this.userCache
      const user = await call('/user', 'GET', undefined, cached?.etag)
      if (!user || (user.status === 304 && !cached)) {
        this.userCache = undefined; this.repoCache = undefined
        return fail(502)
      }
      if (user.status !== 200 && user.status !== 304) {
        this.userCache = undefined; this.repoCache = undefined
        return user.status >= 200 && user.status < 300 ? fail(502) : json(user)
      }
      const body = user.status === 304 ? cached!.body : user.body
      if (!body || typeof body !== 'object' || typeof (body as { login?: unknown }).login !== 'string' ||
        !(body as { login: string }).login) {
        this.userCache = undefined; this.repoCache = undefined
        return fail(502)
      }
      login = (body as { login: string }).login
      if (user.status === 200) {
        if (cached && (cached.body as { login: string }).login.toLowerCase() !== login.toLowerCase()) this.repoCache = undefined
        this.userCache = user.etag ? { etag: user.etag, body } : undefined
      }
    }
    if (repoPath) {
      const path = `/repos/${repoPath[1]}/${repoPath[2]}`
      const cached = this.repoCache?.path === path ? this.repoCache : undefined
      // Only one repository is cached per session; a switch evicts the previous one.
      if (!cached) this.repoCache = undefined
      const repo = await call(path, 'GET', undefined, cached?.etag)
      if (!repo || (repo.status === 304 && !cached)) { this.repoCache = undefined; return fail(502) }
      if (repo.status !== 200 && repo.status !== 304) {
        this.repoCache = undefined
        return repo.status >= 200 && repo.status < 300 ? fail(502) : json(repo)
      }
      const body = repo.status === 304 ? cached!.body : repo.body
      if (!privateOwnedRepository(body, login!, repoPath[1])) {
        this.repoCache = undefined
        return json({ status: 403, body: { message: 'GitHub request failed.' } })
      }
      if (repo.status === 200) this.repoCache = repo.etag ? { path, etag: repo.etag, body } : undefined
      if (input.path === path && !input.etag) {
        return json(repo.status === 304 ? { ...repo, status: 200, body, etag: cached!.etag } : repo)
      }
    }
    const result = await call(input.path, input.method, input.body, input.etag)
    if (!result) { this.clearCache(); return fail(502) }
    if ((result.status < 200 || result.status >= 300) && result.status !== 304) this.clearCache()
    if (result.status >= 200 && result.status < 300 &&
      ((input.path === '/user/repos' && !privateOwnedRepository(result.body, login!)) ||
       (repoPath && input.path === `/repos/${repoPath[1]}/${repoPath[2]}` && !privateOwnedRepository(result.body, login!, repoPath[1])))) {
      this.clearCache()
      return json({ status: 403, body: { message: 'GitHub request failed.' } })
    }
    if (repoPath && input.path === `/repos/${repoPath[1]}/${repoPath[2]}` && result.status === 200) {
      this.repoCache = result.etag ? { path: input.path, etag: result.etag, body: result.body } : undefined
    }
    return json(result)
  }
  async alarm(): Promise<void> {
    this.clearCache()
    await this.state.storage.deleteAll()
  }
}
function responseAsRequest(response: Response): Request {
  return new Request('https://response.internal', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(response.headers.has('content-length') ? { 'Content-Length': response.headers.get('content-length')! } : {}) }, body: response.body, duplex: 'half' } as RequestInit)
}
