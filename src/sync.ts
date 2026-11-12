import { isPlannerData, type PlannerData } from './model'

const API = 'https://api.github.com'
const OAUTH = 'https://github.com/login'
type Repo = { private: boolean; owner: { login: string }; default_branch: string }
type RemoteFile = { sha: string; content: string; encoding: string }
export interface SyncTarget { owner: string; repo: string; branch: string; path: string }
export interface DeviceAuthorization {
  device_code: string
  user_code: string
  verification_uri: string
  expires_in: number
  interval: number
}

export class CloudConflictError extends Error {
  constructor() {
    super('The cloud copy changed since your last sync.')
    this.name = 'CloudConflictError'
  }
}

export class GitHubAuthError extends Error {
  constructor() {
    super('Your GitHub App sign-in expired or was revoked. Connect GitHub again.')
    this.name = 'GitHubAuthError'
  }
}

export class GitHubPermissionError extends Error {
  constructor() {
    super('The GitHub App cannot access this repository. Check that it is installed for the repository and has Contents: Read and write permission.')
    this.name = 'GitHubPermissionError'
  }
}

async function oauthRequest<T>(path: string, body: URLSearchParams, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${OAUTH}${path}`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal,
  })
  if (!response.ok) throw new Error(`GitHub authorization failed (${response.status}).`)
  return response.json() as Promise<T>
}

export async function requestDeviceAuthorization(clientId: string, signal?: AbortSignal): Promise<DeviceAuthorization> {
  if (!clientId.trim()) throw new Error('GitHub App client ID is not configured.')
  const result = await oauthRequest<DeviceAuthorization & { error?: string; error_description?: string }>('/device/code', new URLSearchParams({ client_id: clientId.trim() }), signal)
  if (result.error || !result.device_code || !result.user_code || !result.verification_uri || !result.expires_in) {
    throw new Error(result.error_description ?? 'GitHub did not return a valid device authorization code.')
  }
  return result
}

function wait(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException('Authorization cancelled.', 'AbortError')); return }
    const timer = globalThis.setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, ms)
    const abort = () => { globalThis.clearTimeout(timer); reject(new DOMException('Authorization cancelled.', 'AbortError')) }
    signal.addEventListener('abort', abort, { once: true })
  })
}

export async function pollDeviceAuthorization(clientId: string, authorization: DeviceAuthorization, signal: AbortSignal): Promise<string> {
  let interval = Math.max(authorization.interval, 1)
  const expiresAt = Date.now() + authorization.expires_in * 1000
  while (Date.now() < expiresAt) {
    await wait(interval * 1000, signal)
    const result = await oauthRequest<{ access_token?: string; error?: string; error_description?: string }>('/oauth/access_token', new URLSearchParams({
      client_id: clientId.trim(),
      device_code: authorization.device_code,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    }), signal)
    if (result.access_token) return result.access_token
    if (result.error === 'authorization_pending') continue
    if (result.error === 'slow_down') { interval += 5; continue }
    if (result.error === 'expired_token') throw new Error('The GitHub authorization code expired. Start again.')
    if (result.error === 'access_denied') throw new Error('GitHub authorization was denied.')
    throw new Error(result.error_description ?? 'GitHub authorization failed.')
  }
  throw new Error('The GitHub authorization code expired. Start again.')
}

async function request<T>(path: string, token: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: { Accept: 'application/vnd.github+json', Authorization: ['Bearer', token].join(' '), 'X-GitHub-Api-Version': '2022-11-28', ...options.headers },
  })
  if (response.status === 409) throw new CloudConflictError()
  if (response.status === 401) throw new GitHubAuthError()
  if (response.status === 403) throw new GitHubPermissionError()
  if (!response.ok) throw new Error(`GitHub request failed (${response.status}). Check your GitHub App access and repository settings.`)
  return response.json() as Promise<T>
}

export async function getAuthenticatedUser(token: string, signal?: AbortSignal) {
  return request<{ login: string }>('/user', token, { signal })
}

function repoPath(owner: string, repo: string) {
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) throw new Error('Enter a valid GitHub username and repository name.')
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`
}
function filePath(target: SyncTarget) {
  const parts = target.path.split('/')
  if (!target.branch.trim() || parts.some(p => !p || p === '.' || p === '..')) throw new Error('Enter a valid branch and file path.')
  return `${repoPath(target.owner, target.repo)}/contents/${parts.map(encodeURIComponent).join('/')}`
}

export async function verifyRepository(token: string, owner: string, repo: string) {
  const user = await getAuthenticatedUser(token)
  const repository = await request<Repo>(repoPath(owner, repo), token)
  if (!repository.private || repository.owner.login.toLowerCase() !== user.login.toLowerCase()) {
    throw new Error('Use a private repository owned by your signed-in GitHub account.')
  }
}

export async function ensurePrivateRepository(token: string, owner: string, repo: string) {
  const path = repoPath(owner, repo)
  const headers = { Accept: 'application/vnd.github+json', Authorization: ['Bearer', token].join(' '), 'X-GitHub-Api-Version': '2022-11-28' }
  const existing = await fetch(`${API}${path}`, { headers })
  if (existing.ok) {
    const repository = await existing.json() as Repo
    if (!repository.private || repository.owner.login.toLowerCase() !== owner.toLowerCase() || !repository.default_branch) {
      throw new Error('The selected data repository must be private and owned by your signed-in account.')
    }
    return { branch: repository.default_branch, created: false }
  }
  if (existing.status === 401) throw new GitHubAuthError()
  if (existing.status !== 404) throw new Error(`Could not check the data repository (${existing.status}). Check that the GitHub App is installed on your account.`)

  const created = await fetch(`${API}/user/repos`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: repo, description: 'Private Meet-up Planner data', private: true, auto_init: true }),
  })
  if (created.status === 401) throw new GitHubAuthError()
  if (!created.ok) throw new Error(`Could not create the private data repository (${created.status}). Ensure the GitHub App is installed on your account with Repository creation: Read and write permission, or create the private repository manually and grant the app access.`)
  const repository = await created.json() as Repo
  if (!repository.private || repository.owner.login.toLowerCase() !== owner.toLowerCase() || !repository.default_branch) {
    throw new Error('GitHub did not create a private repository owned by your account.')
  }
  return { branch: repository.default_branch, created: true }
}

export async function readCloud(token: string, target: SyncTarget): Promise<{ data: PlannerData; sha: string } | null> {
  await verifyRepository(token, target.owner, target.repo)
  const path = `${filePath(target)}?ref=${encodeURIComponent(target.branch)}`
  const response = await fetch(`${API}${path}`, { headers: { Accept: 'application/vnd.github+json', Authorization: ['Bearer', token].join(' '), 'X-GitHub-Api-Version': '2022-11-28' } })
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`Could not read the cloud copy (${response.status}).`)
  const file = await response.json() as RemoteFile
  if (file.encoding !== 'base64' || typeof file.content !== 'string' || typeof file.sha !== 'string') throw new Error('Invalid cloud file.')
  const bytes = Uint8Array.from(atob(file.content.replace(/\s/g, '')), c => c.charCodeAt(0))
  const data: unknown = JSON.parse(new TextDecoder().decode(bytes))
  if (!isPlannerData(data)) throw new Error('The cloud copy is not valid Meet-up Planner data.')
  return { data, sha: file.sha }
}

export async function writeCloud(token: string, target: SyncTarget, data: PlannerData, sha?: string) {
  await verifyRepository(token, target.owner, target.repo)
  const bytes = new TextEncoder().encode(JSON.stringify(data, null, 2))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  const result = await request<{ content: { sha: string } }>(filePath(target), token, {
    method: 'PUT',
    body: JSON.stringify({ message: 'Update Meet-up Planner', content: btoa(binary), branch: target.branch, ...(sha ? { sha } : {}) }),
  })
  return result.content.sha
}
