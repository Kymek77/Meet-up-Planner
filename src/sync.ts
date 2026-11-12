import { isPlannerData, type PlannerData } from './model'

const API = 'https://api.github.com'
const FILE = 'meet-up-planner.json'
type Repo = { private: boolean; owner: { login: string } }
type RemoteFile = { sha: string; content: string; encoding: string }

async function request<T>(path: string, token: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: { Accept: 'application/vnd.github+json', Authorization: ['Bearer', token].join(' '), 'X-GitHub-Api-Version': '2022-11-28', ...options.headers },
  })
  if (!response.ok) throw new Error(response.status === 409 ? 'The cloud copy changed. Pull it before pushing again.' : `GitHub request failed (${response.status}). Check your token and repository permissions.`)
  return response.json() as Promise<T>
}

function repoPath(owner: string, repo: string) {
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) throw new Error('Enter a valid GitHub username and repository name.')
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`
}

export async function verifyRepository(token: string, owner: string, repo: string) {
  const user = await request<{ login: string }>('/user', token)
  const repository = await request<Repo>(repoPath(owner, repo), token)
  if (!repository.private || repository.owner.login.toLowerCase() !== user.login.toLowerCase()) {
    throw new Error('Use a private repository owned by your signed-in GitHub account.')
  }
}

export async function readCloud(token: string, owner: string, repo: string): Promise<{ data: PlannerData; sha: string } | null> {
  await verifyRepository(token, owner, repo)
  const path = `${repoPath(owner, repo)}/contents/${FILE}`
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

export async function writeCloud(token: string, owner: string, repo: string, data: PlannerData, sha?: string) {
  await verifyRepository(token, owner, repo)
  const bytes = new TextEncoder().encode(JSON.stringify(data, null, 2))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  const result = await request<{ content: { sha: string } }>(`${repoPath(owner, repo)}/contents/${FILE}`, token, {
    method: 'PUT',
    body: JSON.stringify({ message: 'Update Meet-up Planner', content: btoa(binary), ...(sha ? { sha } : {}) }),
  })
  return result.content.sha
}
