interface Env {
  GITHUB_CLIENT_ID: string
  GITHUB_CLIENT_SECRET: string
  PLANNER_ORIGIN: string
  CALLBACK_URL: string
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
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/exchange') return new Response('Not found', { status: 404, headers })
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
    if (!input || typeof input !== 'object' || !('code' in input) || !('verifier' in input) ||
      typeof input.code !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(input.code) ||
      typeof input.verifier !== 'string' || !/^[A-Za-z0-9_-]{43,128}$/.test(input.verifier)) return error(400)
    try {
      const response = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code: input.code, code_verifier: input.verifier, redirect_uri: env.CALLBACK_URL }),
        redirect: 'error',
      })
      if (!response.ok) return error(502)
      const result = await response.json() as { access_token?: unknown }
      if (typeof result.access_token !== 'string' || !result.access_token) return error(401)
      return new Response(JSON.stringify({ access_token: result.access_token }), { headers })
    } catch { return error(502) }
  },
}
