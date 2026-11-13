import type { PlannerData } from './model'
import { clearPendingUpload, readSyncState, savePendingUpload } from './store'
import { CloudConflictError, readCloud, writeCloud, type SyncTarget } from './sync'

export async function acknowledgeDirectUpload(key: string, remote: { data: PlannerData; sha: string } | null) {
  const id = `direct:${key}`
  const pending = (await readSyncState(id)).pending
  if (!pending || !remote) return false
  const known = localStorage.getItem(key) ?? undefined
  if (remote.sha === known || (pending.baselineSha === known && JSON.stringify(pending.data) === JSON.stringify(remote.data))) {
    localStorage.setItem(key, remote.sha)
    await clearPendingUpload(id)
    return true
  }
  return false
}

export async function pushDirect(token: string, target: SyncTarget, key: string, data: PlannerData) {
  const id = `direct:${key}`
  if ((await readSyncState(id)).pending) await acknowledgeDirectUpload(key, await readCloud(token, target))
  for (let attempt = 0; attempt < 2; attempt++) {
    const baselineSha = localStorage.getItem(key) ?? undefined
    const current = (await readSyncState(id)).data
    if (JSON.stringify(current) !== JSON.stringify(data)) throw new Error('Local data changed during sync. The latest changes will be synced shortly.')
    await savePendingUpload({ id, localBase: data, data, baselineSha })
    try {
      const sha = await writeCloud(token, target, data, baselineSha)
      localStorage.setItem(key, sha)
      await clearPendingUpload(id)
      return sha
    } catch (error) {
      if (!(error instanceof CloudConflictError) || !await acknowledgeDirectUpload(key, await readCloud(token, target))) throw error
    }
  }
  throw new CloudConflictError()
}
