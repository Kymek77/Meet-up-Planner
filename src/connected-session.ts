import { sessionRequest } from './connected'
import { withSyncLock } from './store'

type Callback = { code: string; verifier: string }

export function createSessionRestorer(callback: Callback | null) {
  let exchangePending = callback
  let exchangeFailed = false
  let pending: Promise<boolean> | null = null
  return () => {
    if (pending) return pending
    pending = (async () => {
      if (exchangePending) {
        const credentials = exchangePending
        exchangePending = null
        try {
          const result = await withSyncLock(() => sessionRequest('/exchange', credentials))
          if (!result.response.ok || result.result.authenticated !== true) throw new Error('Connected sign-in could not be completed. Sign in again.')
          return true
        } catch (e) {
          exchangeFailed = true
          throw e
        }
      }
      const result = await sessionRequest('')
      if (result.response.status === 401) {
        if (exchangeFailed) throw new Error('Connected sign-in could not be confirmed. Sign in again.')
        return false
      }
      if (!result.response.ok || result.result.authenticated !== true) throw new Error('Could not restore the connected session.')
      return true
    })().finally(() => { pending = null })
    return pending
  }
}
