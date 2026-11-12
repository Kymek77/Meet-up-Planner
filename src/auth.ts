const AUTH_KEY = 'meetup-github-auth'

function randomString() {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
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

export async function exchangeGitHubCode(workerUrl: string, code: string, verifier: string, signal?: AbortSignal) {
  let url: URL
  try { url = new URL(workerUrl) } catch { throw new Error('GitHub authentication service is not configured for this deployment.') }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) throw new Error('GitHub authentication service must use HTTPS.')
  url.pathname = '/exchange'; url.search = ''; url.hash = ''
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, verifier }), signal })
  if (!response.ok) throw new Error('GitHub sign-in could not be completed. Check the authentication service configuration and try again.')
  const result = await response.json() as { access_token?: unknown }
  if (typeof result.access_token !== 'string' || !result.access_token) throw new Error('GitHub did not return a valid access token.')
  return result.access_token
}
