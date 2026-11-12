interface Env {
  GITHUB_CLIENT_ID: string
  GITHUB_CLIENT_SECRET: string
  PLANNER_ORIGIN: string
  CALLBACK_URL: string
}

function logGitHubFailure(category: string, response?: Response, errorCode?: string) {
  console.error('GitHub authentication upstream failure', {
    category,
    ...(response ? {
      status: response.status,
      requestId: response.headers.get('x-github-request-id') ?? undefined,
    } : {}),
    ...(errorCode ? { errorCode } : {}),
  })
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get('Origin')
    const headers = new Headers({ 'Cache-Control': 'no-store', 'Vary': 'Origin' })
    if (!env.PLANNER_ORIGIN || origin !== env.PLANNER_ORIGIN) return new Response('Forbidden', { status: 403, headers })
    headers.set('Access-Control-Allow-Origin', env.PLANNER_ORIGIN)
    if (request.method === 'OPTIONS') {
      headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS')
      headers.set('Access-Control-Allow-Headers', 'Content-Type')
      return new Response(null, { status: 204, headers })
    }
    const path = new URL(request.url).pathname
    if (request.method !== 'POST' || !['/exchange', '/device-code', '/device-token'].includes(path)) return new Response('Not found', { status: 404, headers })
    headers.set('Content-Type', 'application/json')
    const error = (status: number) => new Response(JSON.stringify({ error: 'GitHub authorization could not be completed.' }), { status, headers })
    if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET || !env.CALLBACK_URL) return error(503)
    try {
      const callback = new URL(env.CALLBACK_URL)
      if (callback.origin !== env.PLANNER_ORIGIN || callback.search || callback.hash ||
        (callback.protocol !== 'https:' && !(callback.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(callback.hostname)))) return error(503)
    } catch { return error(503) }
    if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) return error(415)
    if (Number(request.headers.get('Content-Length') ?? 0) > 4096) return error(413)
    let input: unknown
    try {
      if (!request.body) return error(400)
      const reader = request.body.getReader(), chunks: Uint8Array[] = []
      let size = 0
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > 4096) { await reader.cancel(); return error(413) }
        chunks.push(value)
      }
      const bytes = new Uint8Array(size)
      let offset = 0
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
      input = JSON.parse(new TextDecoder().decode(bytes))
    } catch { return error(400) }
    if (!input || typeof input !== 'object') return error(400)
    const parameters = new URLSearchParams({ client_id: env.GITHUB_CLIENT_ID })
    let endpoint = 'oauth/access_token'
    if (path === '/exchange') {
      if (!('code' in input) || !('verifier' in input) ||
        typeof input.code !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(input.code) ||
        typeof input.verifier !== 'string' || !/^[A-Za-z0-9_-]{43,128}$/.test(input.verifier)) return error(400)
      parameters.set('client_secret', env.GITHUB_CLIENT_SECRET)
      parameters.set('code', input.code)
      parameters.set('code_verifier', input.verifier)
      parameters.set('redirect_uri', env.CALLBACK_URL)
    } else if (path === '/device-token') {
      if (!('device_code' in input) || typeof input.device_code !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(input.device_code)) return error(400)
      parameters.set('device_code', input.device_code)
      parameters.set('grant_type', 'urn:ietf:params:oauth:grant-type:device_code')
    } else endpoint = 'device/code'
    let response: Response
    try {
      response = await fetch(`https://github.com/login/${endpoint}`, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: parameters,
        redirect: 'manual',
      })
    } catch {
      logGitHubFailure('fetch_failed')
      return error(502)
    }
    if (!response.ok) {
      logGitHubFailure('non_2xx_response', response)
      return error(502)
    }
    let parsed: unknown
    try { parsed = await response.json() } catch {
      logGitHubFailure('invalid_json', response)
      return error(502)
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      logGitHubFailure('invalid_response', response)
      return error(502)
    }
    const result = parsed as Record<string, unknown>
    if (path === '/device-code') {
      if (typeof result.device_code !== 'string' || typeof result.user_code !== 'string' ||
        result.verification_uri !== 'https://github.com/login/device' || typeof result.expires_in !== 'number' ||
        typeof result.interval !== 'number' || result.expires_in <= 0 || result.interval <= 0) {
        logGitHubFailure('invalid_response', response)
        return error(502)
      }
      return new Response(JSON.stringify({ device_code: result.device_code, user_code: result.user_code, verification_uri: result.verification_uri, expires_in: result.expires_in, interval: result.interval }), { headers })
    }
    if (typeof result.error === 'string') {
      if (path !== '/device-token' || !['authorization_pending', 'slow_down', 'expired_token', 'access_denied'].includes(result.error)) {
        const errorCode = /^[a-z][a-z0-9_]{0,63}$/.test(result.error) ? result.error : 'unrecognized'
        logGitHubFailure('oauth_error', response, errorCode)
      }
      if (path === '/device-token' && ['authorization_pending', 'slow_down', 'expired_token', 'access_denied'].includes(result.error)) {
        return new Response(JSON.stringify({ error: result.error }), { headers })
      }
      return error(401)
    }
    if (typeof result.access_token !== 'string' || !result.access_token) {
      logGitHubFailure('invalid_response', response)
      return error(401)
    }
    return new Response(JSON.stringify({ access_token: result.access_token }), { headers })
  },
}
