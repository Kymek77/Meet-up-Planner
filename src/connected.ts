import { isPlannerData, type PlannerData } from './model'
import { mergePlannerData } from './merge'
import { commitSyncState, readSyncState, saveSyncBackup, withSyncLock } from './store'

export type Target = { owner: string; repo: string; branch: string; path: string }
export type Remote = { data: PlannerData; sha: string }
export type Conflict = { remote: Remote | null; reason: string }
type RemoteCache = { path: string; etag: string; remote: Remote }
let remoteCache: RemoteCache | null = null

export function resetRemoteCache() { remoteCache = null }

function validSnapshot(data: unknown): data is PlannerData {
  return isPlannerData(data) && mergePlannerData(data, data, data).ok
}

export async function sessionRequest(path: string, body?: object, signal?: AbortSignal) {
  const response = await fetch(`/api/session${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal,
  })
  let result: unknown
  try { result = await response.json() } catch { throw new Error('Invalid response from connected service.') }
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Invalid response from connected service.')
  const payload = result as Record<string, unknown>
  if (!response.ok && typeof payload.error !== 'string') throw new Error(`Connected service failed (${response.status}).`)
  return { response, result: payload }
}

export async function logoutConnected() {
  const logout = async () => {
    const { response } = await sessionRequest('/logout', {})
    if (!response.ok && response.status !== 401) throw new Error('Could not sign out of the connected service.')
  }
  if (navigator.locks) await withSyncLock(logout)
  else await logout()
  resetRemoteCache()
}

type ProxyResult = { status: number; body: unknown; etag?: string; retryAfter?: string; rateLimitReset?: string }
export class ConnectedGitHubError extends Error {
  status: number
  retryAt?: number
  constructor(result: ProxyResult) {
    const retrySeconds = Number(result.retryAfter)
    const retryDate = result.retryAfter ? Date.parse(result.retryAfter) : NaN
    const reset = Number(result.rateLimitReset)
    const retryAt = result.retryAfter
      ? Number.isFinite(retrySeconds) ? Date.now() + retrySeconds * 1000 : retryDate
      : Number.isFinite(reset) && reset > 0 ? reset * 1000 : NaN
    const rateLimited = result.status === 429 || Boolean(result.retryAfter)
    super(result.status === 401 ? 'Connected session expired. Sign in again.' :
      result.status === 403 ? rateLimited
        ? 'GitHub rate limit reached. Sync will retry after the limit resets.'
        : 'GitHub denied access. Check the app installation and repository permissions; a rate limit may also be responsible.' :
      result.status === 429 ? 'GitHub rate limit reached. Sync will retry after the limit resets.' :
      `GitHub request failed (${result.status}). Check the app installation and repository permissions.`)
    this.status = result.status
    if ((rateLimited || result.status === 403) && Number.isFinite(retryAt) && retryAt > Date.now()) this.retryAt = retryAt
    else if (rateLimited) this.retryAt = Date.now() + 60000
  }
}
export class MissingInstallationError extends Error {
  constructor() {
    super('Add Meet-up Planner to your personal GitHub account to finish connecting.')
    this.name = 'MissingInstallationError'
  }
}
export async function github(path: string, method = 'GET', body?: object, etag?: string) {
  const response = await fetch('/api/github', {
    method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, method, ...(body === undefined ? {} : { body }), ...(etag ? { etag } : {}) }),
  })
  if (response.status === 401) throw new ConnectedGitHubError({ status: 401, body: null })
  if (!response.ok) throw new Error(`Connected service failed (${response.status}).`)
  const result = await response.json() as ProxyResult
  if (typeof result.status !== 'number') throw new Error('Invalid response from connected service.')
  return result
}

function assertSuccess(result: ProxyResult) {
  if (result.status < 200 || result.status >= 300) throw new ConnectedGitHubError(result)
}

function repoPath(owner: string, repo: string) {
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) throw new Error('Enter a valid repository name.')
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`
}
function filePath(target: Target) {
  const parts = target.path.split('/')
  if (!target.branch.trim() || parts.some(p => !p || p === '.' || p === '..')) throw new Error('Enter a valid branch and file path.')
  return `${repoPath(target.owner, target.repo)}/contents/${parts.map(encodeURIComponent).join('/')}`
}
export function targetKey(target: Target) {
  return JSON.stringify([target.owner.toLowerCase(), target.repo.toLowerCase(), target.branch, target.path])
}

export async function setupRepository(repo: string, slug: string) {
  const user = await github('/user'); assertSuccess(user)
  const owner = (user.body as { login?: unknown })?.login
  if (typeof owner !== 'string' || !owner) throw new Error('Invalid GitHub account.')
  if (slug) {
    let installed = false
    for (let page = 1; ; page++) {
      const result = await github(`/user/installations?per_page=100&page=${page}`); assertSuccess(result)
      const installations = (result.body as { installations?: { account?: { login?: string; type?: string }; app_slug?: string; suspended_at?: string | null }[] })?.installations
      if (!Array.isArray(installations)) throw new Error('Could not verify the GitHub App installation.')
      if (installations.some(i => i.account?.type === 'User' && i.account.login?.toLowerCase() === owner.toLowerCase() && i.app_slug === slug && !i.suspended_at)) { installed = true; break }
      if (installations.length < 100) break
    }
    if (!installed) throw new MissingInstallationError()
  }
  const path = repoPath(owner, repo)
  let result = await github(path)
  if (result.status === 404) result = await github('/user/repos', 'POST', { name: repo, description: 'Private Meet-up Planner data', private: true, auto_init: true })
  assertSuccess(result)
  const repository = result.body as { private?: boolean; owner?: { login?: string }; default_branch?: string }
  if (!repository?.private || repository.owner?.login?.toLowerCase() !== owner.toLowerCase() || !repository.default_branch) throw new Error('The data repository must be private and owned by your signed-in account.')
  return { owner, branch: repository.default_branch }
}

export async function readRemote(target: Target): Promise<Remote | null> {
  const path = `${filePath(target)}?ref=${encodeURIComponent(target.branch)}`
  if (remoteCache?.path !== path) resetRemoteCache()
  const cached = remoteCache
  const response = await github(path, 'GET', undefined, cached?.etag)
  if (response.status === 304) {
    if (!cached || cached !== remoteCache || cached.path !== path) throw new Error('Received an unexpected conditional response. Retry sync.')
    return cached.remote
  }
  resetRemoteCache()
  if (response.status === 404) return null
  assertSuccess(response)
  const file = response.body as { sha?: unknown; content?: unknown; encoding?: unknown }
  if (!file || file.encoding !== 'base64' || typeof file.content !== 'string' || typeof file.sha !== 'string' || !file.sha) throw new Error('Invalid cloud file.')
  let data: unknown
  try {
    const bytes = Uint8Array.from(atob(file.content.replace(/\s/g, '')), c => c.charCodeAt(0))
    data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch { throw new Error('The cloud copy is not valid Meet-up Planner data.') }
  if (!validSnapshot(data)) throw new Error('The cloud copy is not valid Meet-up Planner data.')
  const remote = { data, sha: file.sha }
  if (typeof response.etag === 'string' && response.etag) remoteCache = { path, etag: response.etag, remote }
  return remote
}

async function writeRemote(target: Target, data: PlannerData, sha?: string) {
  if (!validSnapshot(data)) throw new Error('The local planner is invalid and cannot be uploaded.')
  const bytes = new TextEncoder().encode(JSON.stringify(data, null, 2))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  resetRemoteCache()
  const result = await github(filePath(target), 'PUT', { message: 'Update Meet-up Planner', content: btoa(binary), branch: target.branch, ...(sha ? { sha } : {}) })
  if (result.status === 409 || result.status === 422) return null
  assertSuccess(result)
  const newSha = (result.body as { content?: { sha?: unknown } })?.content?.sha
  if (typeof newSha !== 'string' || !newSha) throw new Error('GitHub did not return a file revision.')
  return newSha
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, v]) => [key, canonical(v)]))
  return value
}
const same = (a: PlannerData, b: PlannerData) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))

export async function reconcile(target: Target, active: () => boolean): Promise<Conflict | null> {
  return withSyncLock(async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      if (!active()) return null
      const id = targetKey(target), state = await readSyncState(id), remote = await readRemote(target)
      if (!active()) return null
      if (!validSnapshot(state.data)) throw new Error('The local planner is invalid and cannot be synced.')
      const baseline = state.baseline && validSnapshot(state.baseline.data) && state.baseline.sha ? state.baseline : undefined
      if (state.baseline && !baseline) return { remote, reason: 'The trusted baseline is invalid.' }
      if (state.identity && state.identity !== id) return { remote, reason: 'This account or repository has no trusted baseline for this device.' }
      if (!baseline && remote && !same(state.data, remote.data)) return { remote, reason: 'This account or repository has no trusted baseline for this device.' }
      if (!baseline && !remote && state.identity === id) return { remote, reason: 'The trusted baseline is missing.' }
      if (baseline && !remote) return { remote, reason: 'The cloud copy was deleted. Choose whether to restore it.' }
      let merged = state.data
      if (baseline && remote) {
        const result = mergePlannerData(baseline.data, state.data, remote.data)
        if (!result.ok || !isPlannerData(result.data)) return { remote, reason: 'Both copies contain conflicting changes.' }
        merged = result.data
      }
      let sha = remote?.sha
      if (!remote || !same(merged, remote.data)) {
        if (!active()) return null
        sha = await writeRemote(target, merged, remote?.sha) ?? undefined
        if (!sha) continue
      }
      if (!sha) throw new Error('Missing cloud revision.')
      if (await commitSyncState(id, state.revision, merged, sha)) return null
    }
    throw new Error('Sync is busy with other changes. Retrying shortly.')
  })
}

export async function resolveConnectedConflict(target: Target, conflict: Conflict, choice: 'local' | 'cloud', backup: (data: PlannerData, label: string) => void, active: () => boolean) {
  return withSyncLock(async () => {
    if (!active()) throw new Error('Sync is paused.')
    const id = targetKey(target), state = await readSyncState(id), latest = await readRemote(target)
    if (!validSnapshot(state.data)) throw new Error('The local planner is invalid. Export it before resolving this conflict.')
    if (latest?.sha !== conflict.remote?.sha) throw new Error('The cloud copy changed again. Sync to review the latest version.')
    if (choice === 'cloud') {
      if (!latest) throw new Error('There is no cloud copy to use.')
      await saveSyncBackup(state.data)
      backup(state.data, 'before-cloud-pull')
      if (!active() || !await commitSyncState(id, state.revision, latest.data, latest.sha)) throw new Error('Local data changed. Review the conflict again.')
    } else {
      await saveSyncBackup(latest?.data ?? state.data)
      if (latest) backup(latest.data, 'before-cloud-overwrite')
      else backup(state.data, 'before-cloud-restore')
      if (!active()) throw new Error('Sync is paused.')
      const sha = await writeRemote(target, state.data, latest?.sha)
      if (!sha) throw new Error('The cloud copy changed again. Sync to review the latest version.')
      if (!await commitSyncState(id, state.revision, state.data, sha)) throw new Error('Local data changed during sync. Review the conflict again.')
    }
  })
}
