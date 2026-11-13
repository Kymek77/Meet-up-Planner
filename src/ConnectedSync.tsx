import { useCallback, useEffect, useRef, useState } from 'react'
import { Cloud } from 'lucide-react'
import { beginGitHubAuthorization, beginGitHubInstallation, canReturnFromInstallation, takeGitHubCallback, type DeviceAuthorization } from './auth'
import { ConnectedGitHubError, logoutConnected, MissingInstallationError, reconcile, resetRemoteCache, resolveConnectedConflict, sessionRequest, setupRepository, type Conflict, type Target } from './connected'
import { createSessionRestorer } from './connected-session'
import { withSyncLock } from './store'
import type { PlannerData } from './model'

export default function ConnectedSync({ data, online, onSyncStatus, backup }: { data: PlannerData; online: boolean; onSyncStatus: (status: string) => void; backup: (data: PlannerData, label: string) => void }) {
  const clientId = import.meta.env.VITE_GITHUB_APP_CLIENT_ID?.trim() ?? ''
  const slug = import.meta.env.VITE_GITHUB_APP_SLUG?.trim() ?? ''
  const callbackUrl = new URL(import.meta.env.BASE_URL, window.location.origin).href
  const installationReturnsHere = canReturnFromInstallation(import.meta.env.VITE_GITHUB_APP_SETUP_URL?.trim() ?? '', callbackUrl)
  const [repo, setRepo] = useState(localStorage.getItem('meetup-connected-repo') ?? 'meet-up-planner-data')
  const [path, setPath] = useState(localStorage.getItem('meetup-connected-path') ?? 'data/meetup-planner.json')
  const [branch, setBranch] = useState(localStorage.getItem('meetup-connected-branch') ?? '')
  const [target, setTarget] = useState<Target | null>(null)
  const [authenticated, setAuthenticated] = useState(false)
  const [busy, setBusy] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const [message, setMessage] = useState('')
  const [conflict, setConflict] = useState<Conflict | null>(null)
  const [device, setDevice] = useState<DeviceAuthorization | null>(null)
  const [needsInstallation, setNeedsInstallation] = useState(false)
  const [installationFromDevice, setInstallationFromDevice] = useState(false)
  const active = useRef(true)
  const controller = useRef<AbortController | null>(null)
  const running = useRef(false)
  const queued = useRef(false)
  const retryAt = useRef(0)
  const rateLimited = useRef(false)
  const retryDelay = useRef(5000)
  const retryTimer = useRef<number | undefined>(undefined)
  const targetRef = useRef<Target | null>(null)
  const conflictRef = useRef<Conflict | null>(null)
  const restore = useRef<ReturnType<typeof createSessionRestorer> | null>(null)
  const restoreNeeded = useRef(true)
  const settings = useRef({ repo, path, branch, slug })
  settings.current = { repo, path, branch, slug }
  targetRef.current = target
  conflictRef.current = conflict

  const setup = useCallback(async (valid: () => boolean = () => true) => {
    const repository = settings.current.repo.trim(), file = settings.current.path.trim(), selectedBranch = settings.current.branch.trim()
    if (!repository || !file) throw new Error('Enter a repository and planner file path.')
    const info = await withSyncLock(async () => {
      if (!active.current || !valid()) throw new Error('Sync is paused.')
      return setupRepository(repository, settings.current.slug)
    })
    if (!active.current || !valid()) return
    const resolvedBranch = selectedBranch || info.branch
    localStorage.setItem('meetup-connected-repo', repository)
    localStorage.setItem('meetup-connected-path', file)
    localStorage.setItem('meetup-connected-branch', resolvedBranch)
    setBranch(resolvedBranch)
    resetRemoteCache()
    setTarget({ owner: info.owner, repo: repository, branch: resolvedBranch, path: file })
    localStorage.setItem('meetup-connected-installed', 'yes')
    setNeedsInstallation(false)
    setMessage('')
  }, [])

  const clearRetry = useCallback(() => {
    retryAt.current = 0; rateLimited.current = false; retryDelay.current = 5000
    clearTimeout(retryTimer.current)
  }, [])
  const scheduleRetry = useCallback((e: unknown, action: () => void) => {
    clearTimeout(retryTimer.current)
    const rateUntil = e instanceof ConnectedGitHubError ? e.retryAt ?? 0 : 0
    rateLimited.current = rateUntil > Date.now()
    retryAt.current = Math.max(Date.now() + retryDelay.current, rateUntil)
    retryDelay.current = Math.min(retryDelay.current * 2, 60000)
    const wait = Math.min(retryAt.current - Date.now(), 2147483647)
    retryTimer.current = window.setTimeout(action, Math.max(0, wait))
  }, [])
  const expireSession = useCallback((e: unknown) => {
    if (!(e instanceof ConnectedGitHubError) || e.status !== 401) return false
    clearRetry()
    restoreNeeded.current = false
    targetRef.current = null; conflictRef.current = null
    setTarget(null); setConflict(null); setAuthenticated(false)
    resetRemoteCache()
    setMessage('Connected session expired or was revoked. Connect GitHub again; your local changes are safe.')
    onSyncStatus('Connected session expired · Connect GitHub again.')
    return true
  }, [clearRetry, onSyncStatus])

  const run = useCallback(async (): Promise<void> => {
    if (!active.current || !targetRef.current || conflictRef.current || !navigator.onLine) return
    if (Date.now() < retryAt.current) return
    if (running.current) { queued.current = true; return }
    running.current = true
    onSyncStatus('Syncing changes to GitHub…')
    try {
      do {
        queued.current = false
        const current = targetRef.current
        if (!current) break
        const result = await reconcile(current, () => active.current && localStorage.getItem('meetup-sync-mode') === 'connected' && targetRef.current === current)
        if (!active.current) return
        if (result) {
          conflictRef.current = result
          setConflict(result)
          onSyncStatus('Sync conflict · Choose which planner version to keep in Settings.')
          break
        }
      } while (queued.current)
      if (!conflictRef.current && active.current) { clearRetry(); onSyncStatus('Synced with GitHub'); setMessage('') }
    } catch (e) {
      if (active.current) {
        if (expireSession(e)) return
        const text = e instanceof Error ? e.message : 'Sync failed.'
        scheduleRetry(e, () => void run())
        setMessage(text)
        onSyncStatus('Sync failed · Your changes remain saved locally. Retrying automatically.')
      }
    } finally { running.current = false }
  }, [onSyncStatus, clearRetry, scheduleRetry, expireSession])

  useEffect(() => {
    active.current = true
    const auth = new AbortController()
    controller.current = auth
    let runningRestore = false
    try {
      if (!restore.current) restore.current = createSessionRestorer(takeGitHubCallback(new URL(window.location.href)))
    } catch (e) {
      restoreNeeded.current = false
      setMessage(e instanceof Error ? e.message : 'GitHub sign-in failed.')
    }
    const valid = () => active.current && !auth.signal.aborted && controller.current === auth && restoreNeeded.current
    const attempt = async (): Promise<void> => {
      if (!valid() || runningRestore || Date.now() < retryAt.current) return
      if (!navigator.onLine) {
        setMessage('Offline · Connected session will be restored when you reconnect.')
        onSyncStatus('Offline · Your changes are saved locally.')
        return
      }
      runningRestore = true
      setRestoring(true)
      try {
        const signedIn = await restore.current?.()
        if (!valid()) return
        if (!signedIn) {
          restoreNeeded.current = false
          clearRetry()
          onSyncStatus('Connected sync is signed out.')
          return
        }
        setAuthenticated(true)
        await setup(valid)
        if (!valid()) return
        restoreNeeded.current = false
        clearRetry()
      } catch (e) {
        if (valid()) {
          if (expireSession(e)) return
          if (e instanceof MissingInstallationError) {
            restoreNeeded.current = false
            clearRetry()
            setNeedsInstallation(true)
            setMessage(e.message)
            onSyncStatus('Finish connecting GitHub in Settings.')
            return
          }
          setMessage(e instanceof Error ? e.message : 'Could not restore connected session.')
          onSyncStatus('Connected session unavailable · Your changes remain saved locally. Retrying automatically.')
          scheduleRetry(e, () => void attempt())
        }
      } finally { runningRestore = false; if (active.current && !auth.signal.aborted && controller.current === auth) setRestoring(false) }
    }
    const reconnect = () => {
      if (!rateLimited.current) { retryAt.current = 0; clearTimeout(retryTimer.current) }
      void attempt()
    }
    const focus = () => { if (document.visibilityState === 'visible') void attempt() }
    window.addEventListener('online', reconnect); window.addEventListener('focus', focus); document.addEventListener('visibilitychange', focus)
    void attempt()
    return () => {
      active.current = false; auth.abort(); clearTimeout(retryTimer.current)
      window.removeEventListener('online', reconnect); window.removeEventListener('focus', focus); document.removeEventListener('visibilitychange', focus)
    }
    // Restore only on mount; changing settings must not silently change a live target.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!target || conflict) return
    if (!online) { onSyncStatus('Offline · Changes are saved locally and queued to sync.'); return }
    const timer = window.setTimeout(() => void run(), 2000)
    return () => clearTimeout(timer)
  }, [data, target, conflict, online, run, onSyncStatus])

  useEffect(() => {
    if (!target) return
    const trigger = () => { if (document.visibilityState === 'visible') void run() }
    const reconnect = () => { if (!rateLimited.current) { retryAt.current = 0; clearTimeout(retryTimer.current) }; void run() }
    window.addEventListener('online', reconnect); window.addEventListener('focus', trigger); document.addEventListener('visibilitychange', trigger)
    const timer = window.setInterval(trigger, 30000)
    void run()
    return () => { window.removeEventListener('online', reconnect); window.removeEventListener('focus', trigger); document.removeEventListener('visibilitychange', trigger); clearInterval(timer) }
  }, [target, run])

  const signIn = async (alreadyInstalled = false) => {
    setMessage('')
    try {
      if (installationReturnsHere && !alreadyInstalled && !localStorage.getItem('meetup-connected-installed')) {
        window.location.assign(beginGitHubInstallation(slug))
      } else {
        window.location.assign(await beginGitHubAuthorization(clientId, callbackUrl))
      }
    } catch (e) { setMessage(e instanceof Error ? e.message : 'Sign-in failed.') }
  }
  const deviceSignIn = async () => {
    setInstallationFromDevice(true)
    restoreNeeded.current = false; clearRetry()
    const auth = new AbortController(); controller.current = auth
    setBusy(true); setMessage('')
    try {
      const code = await sessionRequest('/device-code', {}, auth.signal)
      const d = code.result as unknown as DeviceAuthorization
      if (!code.response.ok || typeof d.device_code !== 'string' || typeof d.user_code !== 'string' || d.verification_uri !== 'https://github.com/login/device' || !Number.isFinite(d.expires_in) || d.expires_in <= 0 || !Number.isFinite(d.interval) || d.interval <= 0) throw new Error('Invalid device authorization response.')
      setDevice(d)
      let interval = Math.max(1, d.interval)
      const end = Date.now() + d.expires_in * 1000
      while (Date.now() < end) {
        await new Promise<void>((resolve, reject) => {
          if (auth.signal.aborted) { reject(new DOMException('Cancelled', 'AbortError')); return }
          const timer = window.setTimeout(() => { auth.signal.removeEventListener('abort', abort); resolve() }, interval * 1000)
          const abort = () => { clearTimeout(timer); reject(new DOMException('Cancelled', 'AbortError')) }
          auth.signal.addEventListener('abort', abort, { once: true })
        })
        if (Date.now() >= end) break
        const result = await withSyncLock(() => sessionRequest('/device-token', { device_code: d.device_code }, auth.signal))
        if (result.response.ok && result.result.authenticated === true) {
          if (!active.current) return
          setAuthenticated(true); await setup(() => !auth.signal.aborted); return
        }
        if (result.result.error === 'authorization_pending') continue
        if (result.result.error === 'slow_down') { interval += 5; continue }
        throw new Error(result.result.error === 'access_denied' ? 'GitHub authorization was denied.' : 'Device authorization failed or expired.')
      }
      throw new Error('The GitHub authorization code expired. Start again.')
    } catch (e) {
      if (e instanceof MissingInstallationError) setNeedsInstallation(true)
      if (active.current && !expireSession(e)) setMessage(e instanceof Error && e.name === 'AbortError' ? 'Sign-in cancelled.' : e instanceof Error ? e.message : 'Sign-in failed.')
    } finally { if (active.current) { setBusy(false); setDevice(null) } }
  }
  const signOut = async () => {
    restoreNeeded.current = false; clearRetry()
    setRestoring(false)
    controller.current?.abort()
    setBusy(true)
    try {
      await logoutConnected()
      if (!active.current) return
      setAuthenticated(false); setTarget(null); setConflict(null); setNeedsInstallation(false); setInstallationFromDevice(false); conflictRef.current = null
      setMessage('Signed out. Your planner remains on this device.')
      onSyncStatus('Connected sync is paused.')
    } catch (e) { if (active.current) setMessage(e instanceof Error ? e.message : 'Sign-out failed.') }
    finally { if (active.current) setBusy(false) }
  }
  const resolve = async (choice: 'local' | 'cloud') => {
    if (!target || !conflict || !window.confirm(choice === 'cloud' ? 'Replace the planner on this device with the GitHub copy?' : 'Replace the GitHub copy with the planner on this device?')) return
    setBusy(true)
    try {
      await resolveConnectedConflict(target, conflict, choice, backup, () => active.current && localStorage.getItem('meetup-sync-mode') === 'connected')
      if (!active.current) return
      setConflict(null); conflictRef.current = null; setMessage('Conflict resolved.')
      void run()
    } catch (e) { if (active.current && !expireSession(e)) setMessage(e instanceof Error ? e.message : 'Could not resolve conflict.') }
    finally { if (active.current) setBusy(false) }
  }
  return <section className="settings-card"><div className="settings-icon"><Cloud size={22} /></div><h2>Save and sync</h2>
    <p>Your planner is saved on this device. Connect GitHub to keep a private copy and use it on your other devices. GitHub will ask you to approve access. Choose only the planner repository if possible; access to all repositories also includes your other repositories.</p>
    <div className="form">
      {(!clientId || !slug) && <p className="form-error" role="alert">GitHub connection is not configured for this site. Please contact the site owner.</p>}
      {!authenticated && !restoring && <p role="status" className="form-hint">Not connected · Your planner stays on this device.</p>}
      {restoring && <p role="status" className="form-hint">Connecting your planner…</p>}
      {!authenticated && <div className="sync-actions"><button className="button" disabled={busy || restoring || !clientId || !slug} onClick={() => void signIn()}>Connect GitHub</button>{busy && <button className="button secondary" onClick={() => controller.current?.abort()}>Cancel sign in</button>}</div>}
      {device && <div className="device-code" role="status"><p>Open <a href={device.verification_uri} target="_blank" rel="noreferrer">GitHub device activation</a> and enter:</p><strong>{device.user_code}</strong></div>}
      <details className="advanced-sync"><summary>Advanced connection settings</summary><div className="form"><p className="form-hint">This connection stays signed in after a refresh and checks GitHub for changes while the planner is open.</p>{!authenticated && <div className="sync-actions"><button className="button secondary" disabled={busy || restoring} onClick={() => void deviceSignIn()}>Connect with a device code</button>{installationReturnsHere && <button className="button secondary" disabled={busy || restoring} onClick={() => void signIn(true)}>Already added on GitHub? Sign in</button>}</div>}<label>Private repository<input value={repo} disabled={authenticated || busy || restoring} onChange={e => setRepo(e.target.value)} /></label><label>Branch (leave blank for repository default)<input value={branch} disabled={authenticated || busy || restoring} onChange={e => setBranch(e.target.value)} /></label><label>Planner file path<input value={path} disabled={authenticated || busy || restoring} onChange={e => setPath(e.target.value)} /></label></div></details>
      {authenticated && <div className="sync-actions">{target && <p>Signed in as <strong>@{target.owner}</strong> · {target.repo}/{target.branch}</p>}<button className="button secondary" disabled={busy || !online || Boolean(conflict)} onClick={() => target ? void run() : void setup().catch(e => { if (!expireSession(e)) setMessage(e instanceof Error ? e.message : 'Setup failed.') })}>{target ? 'Sync now' : 'Retry setup'}</button><button className="button secondary" disabled={busy} onClick={() => void signOut()}>Sign out</button></div>}
      {authenticated && !target && needsInstallation && slug && <div className="sync-actions"><p>Choose only the planner repository if possible; choosing all repositories gives the app access to your other repositories too.</p>{installationReturnsHere && !installationFromDevice ? <button className="button" onClick={() => window.location.assign(beginGitHubInstallation(slug))}>Continue on GitHub</button> : <a className="button" href={`https://github.com/apps/${encodeURIComponent(slug)}/installations/new`} target="_blank" rel="noreferrer">Add Meet-up Planner on GitHub</a>}</div>}
      {conflict && <div className="sync-conflict" role="region" aria-label="Sync conflict"><h3>Two versions of your planner</h3><p>These copies cannot be combined safely. Choose a version to keep; you can download a backup of the other first.</p><div className="sync-actions">{conflict.remote && <button className="button secondary" disabled={busy || !online} onClick={() => void resolve('cloud')}>Use GitHub copy</button>}<button className="button" disabled={busy || !online} onClick={() => void resolve('local')}>Keep this device's copy</button><button className="button secondary" disabled={busy || !online} onClick={() => { conflictRef.current = null; setConflict(null); void run() }}>Check again</button></div></div>}
      {message && <p role="alert" className="sync-message">{message}</p>}
    </div>
  </section>
}
