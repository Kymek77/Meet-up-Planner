const AUTH_KEY = 'meetup-github-auth'
const INSTALL_KEY = 'meetup-github-install'

function randomString() {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function beginGitHubInstallation(appSlug: string) {
  if (!appSlug) throw new Error('GitHub connection is not configured for this site.')
  const state = randomString()
  sessionStorage.setItem(INSTALL_KEY, JSON.stringify({ state, created: Date.now() }))
  const url = new URL(`https://github.com/apps/${encodeURIComponent(appSlug)}/installations/new`)
  url.searchParams.set('state', state)
  return url.href
}

export function takeGitHubInstallationCallback(url: URL) {
  if (!url.searchParams.has('installation_id') && !url.searchParams.has('setup_action')) return false
  const stored = sessionStorage.getItem(INSTALL_KEY)
  sessionStorage.removeItem(INSTALL_KEY)
  const state = url.searchParams.get('state')
  for (const key of ['state', 'installation_id', 'setup_action']) url.searchParams.delete(key)
  history.replaceState(null, '', url.href)
  let pending: { state?: unknown; created?: unknown }
  try { pending = JSON.parse(stored ?? 'null') } catch { throw new Error('This connection attempt could not be verified. Please try again.') }
  if (!pending || typeof pending.state !== 'string' || state !== pending.state ||
    typeof pending.created !== 'number' || pending.created > Date.now() || Date.now() - pending.created > 30 * 60 * 1000) {
    throw new Error('This connection attempt expired or could not be verified. Please try again on the same device and browser.')
  }
  return true
}

export function canReturnFromInstallation(setupUrl: string, callbackUrl: string) {
  if (!setupUrl) return false
  try { return new URL(setupUrl).href === new URL(callbackUrl).href } catch { return false }
}

export async function beginGitHubAuthorization(clientId: string, callbackUrl: string) {
  if (!clientId) throw new Error('GitHub App sign-in is not configured for this deployment.')
  const state = randomString(), verifier = randomString()
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))
  const challenge = btoa(String.fromCharCode(...digest)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  sessionStorage.setItem(AUTH_KEY, JSON.stringify({ state, verifier, created: Date.now() }))
  const url = new URL('https://github.com/login/oauth/authorize')
  url.search = new URLSearchParams({ client_id: clientId, redirect_uri: callbackUrl, state, code_challenge: challenge, code_challenge_method: 'S256' }).toString()
  return url.href
}

export function takeGitHubCallback(url: URL) {
  if (!url.searchParams.has('state') || (!url.searchParams.has('code') && !url.searchParams.has('error'))) return null
  const stored = sessionStorage.getItem(AUTH_KEY)
  sessionStorage.removeItem(AUTH_KEY)
  const state = url.searchParams.get('state'), code = url.searchParams.get('code'), error = url.searchParams.get('error')
  for (const key of ['state', 'code', 'error', 'error_description', 'error_uri']) url.searchParams.delete(key)
  history.replaceState(null, '', url.href)
  let pending: { state?: unknown; verifier?: unknown; created?: unknown }
  try { pending = JSON.parse(stored ?? 'null') } catch { throw new Error('GitHub sign-in session is invalid. Please try again.') }
  if (!pending || typeof pending.state !== 'string' || state !== pending.state ||
    typeof pending.verifier !== 'string' || !/^[A-Za-z0-9_-]{43,128}$/.test(pending.verifier) ||
    typeof pending.created !== 'number' || Date.now() - pending.created > 10 * 60 * 1000 || pending.created > Date.now()) {
    throw new Error('GitHub sign-in session expired or did not match. Please try again.')
  }
  if (error || !code) throw new Error('GitHub authorization was denied or could not be completed.')
  return { code, verifier: pending.verifier }
}

async function authRequest(workerUrl: string, path: string, body: object, signal?: AbortSignal) {
  let url: URL
  try { url = new URL(workerUrl) } catch { throw new Error('GitHub authentication service is not configured for this deployment.') }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) throw new Error('GitHub authentication service must use HTTPS.')
  url.pathname = path; url.search = ''; url.hash = ''
  let response: Response
  try {
    response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal })
  } catch (e) {
    if (signal?.aborted) throw e
    throw new Error('Could not reach the GitHub authentication service. Check your connection and try again.')
  }
  if (!response.ok) throw new Error('GitHub sign-in could not be completed. Check the authentication service configuration and try again.')
  return response.json() as Promise<Record<string, unknown>>
}

export async function exchangeGitHubCode(workerUrl: string, code: string, verifier: string, signal?: AbortSignal) {
  const result = await authRequest(workerUrl, '/exchange', { code, verifier }, signal)
  if (typeof result.access_token !== 'string' || !result.access_token) throw new Error('GitHub did not return a valid access token.')
  return result.access_token
}

export interface DeviceAuthorization {
  device_code: string
  user_code: string
  verification_uri: string
  expires_in: number
  interval: number
}

export async function requestDeviceAuthorization(workerUrl: string, signal: AbortSignal): Promise<DeviceAuthorization> {
  const result = await authRequest(workerUrl, '/device-code', {}, signal)
  if (typeof result.device_code !== 'string' || typeof result.user_code !== 'string' ||
    result.verification_uri !== 'https://github.com/login/device' || typeof result.expires_in !== 'number' ||
    !Number.isFinite(result.expires_in) || result.expires_in <= 0 ||
    typeof result.interval !== 'number' || !Number.isFinite(result.interval) || result.interval <= 0) {
    throw new Error('GitHub did not return a valid device authorization code.')
  }
  return result as unknown as DeviceAuthorization
}

export async function pollDeviceAuthorization(workerUrl: string, authorization: DeviceAuthorization, signal: AbortSignal) {
  let interval = Math.max(authorization.interval, 1)
  const expiresAt = Date.now() + authorization.expires_in * 1000
  while (Date.now() < expiresAt) {
    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) { reject(new DOMException('Authorization cancelled.', 'AbortError')); return }
      const timer = globalThis.setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, interval * 1000)
      const abort = () => { globalThis.clearTimeout(timer); reject(new DOMException('Authorization cancelled.', 'AbortError')) }
      signal.addEventListener('abort', abort, { once: true })
    })
    if (Date.now() >= expiresAt) break
    const result = await authRequest(workerUrl, '/device-token', { device_code: authorization.device_code }, signal)
    if (typeof result.access_token === 'string' && result.access_token) return result.access_token
    if (result.error === 'authorization_pending') continue
    if (result.error === 'slow_down') { interval += 5; continue }
    if (result.error === 'access_denied') throw new Error('GitHub authorization was denied.')
    if (result.error === 'expired_token') break
    throw new Error('GitHub authorization could not be completed.')
  }
  throw new Error('The GitHub authorization code expired. Start again.')
}
