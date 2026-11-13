import { beforeEach, describe, expect, it, vi } from 'vitest'

const request = vi.hoisted(() => vi.fn())
vi.mock('./connected', () => ({ sessionRequest: request }))
vi.mock('./store', () => ({ withSyncLock: (fn: () => Promise<unknown>) => fn() }))
import { createSessionRestorer } from './connected-session'

beforeEach(() => request.mockReset())
const result = (status: number, authenticated = false) => ({ response: { ok: status === 200, status }, result: authenticated ? { authenticated: true } : { error: 'unavailable' } })

describe('connected session restoration', () => {
  it('retries an offline session request without declaring the user signed out', async () => {
    request.mockRejectedValueOnce(new TypeError('offline')).mockResolvedValueOnce(result(200, true))
    const restore = createSessionRestorer(null)
    await expect(restore()).rejects.toThrow('offline')
    await expect(restore()).resolves.toBe(true)
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('exchanges a callback at most once and checks the session after an ambiguous failure', async () => {
    request.mockRejectedValueOnce(new TypeError('offline')).mockResolvedValueOnce(result(200, true))
    const restore = createSessionRestorer({ code: 'code', verifier: 'verifier' })
    await expect(restore()).rejects.toThrow('offline')
    await expect(restore()).resolves.toBe(true)
    expect(request.mock.calls.map(call => call[0])).toEqual(['/exchange', ''])
  })

  it('reports an unconfirmed callback instead of silently reporting signed out', async () => {
    request.mockRejectedValueOnce(new TypeError('offline')).mockResolvedValueOnce(result(401))
    const restore = createSessionRestorer({ code: 'code', verifier: 'verifier' })
    await expect(restore()).rejects.toThrow('offline')
    await expect(restore()).rejects.toThrow('could not be confirmed')
  })
})
