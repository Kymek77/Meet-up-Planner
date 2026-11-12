import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { format, parseISO } from 'date-fns'
import { AlertTriangle, ArrowDownToLine, ArrowUpFromLine, CalendarDays, Check, ChevronDown, Clock3, Cloud, Heart, LayoutDashboard, MapPin, Pencil, Plus, Settings, Sparkles, Trash2, Users, X } from 'lucide-react'
import { emptyData, freeGaps, meetingWarnings, validRange, type Availability, type Friend, type Meeting, type Period, type PlannerData, type Priority } from './model'
import { usePlanner } from './store'
import { readCloud, writeCloud } from './sync'

type Page = 'overview' | 'friends' | 'availability' | 'itinerary' | 'settings'
type Dialog = { kind: 'period'; item?: Period } | { kind: 'friend'; item?: Friend } | { kind: 'availability'; item?: Availability } | { kind: 'meeting'; item?: Meeting } | null
const colours = ['#e89882', '#d2a55d', '#87a88b', '#81a9ad', '#9386b1', '#d18eaa', '#829ac1', '#c8a07d']
const uid = () => crypto.randomUUID()
const dateLabel = (date: string, pattern = 'EEE, d MMM') => format(parseISO(date), pattern)
const timeLabel = (date: string) => dateLabel(date, 'h:mm a')
const value = (form: FormData, key: string) => String(form.get(key) ?? '').trim()
const nav: { id: Page; label: string; icon: typeof Heart }[] = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard }, { id: 'friends', label: 'Friends', icon: Users },
  { id: 'availability', label: 'Availability', icon: Clock3 }, { id: 'itinerary', label: 'Itinerary', icon: CalendarDays },
  { id: 'settings', label: 'Settings', icon: Settings },
]

function Avatar({ friend, size = 'normal' }: { friend?: Friend; size?: 'normal' | 'large' }) {
  return <span className={`avatar ${size}`} style={{ backgroundColor: friend?.colour ?? '#ddd' }} aria-hidden="true">{friend?.name.trim().split(/\s+/).slice(0, 2).map(s => s[0]).join('').toUpperCase() ?? '?'}</span>
}
function Button({ children, onClick, secondary = false, type = 'button' }: { children: ReactNode; onClick?: () => void; secondary?: boolean; type?: 'button' | 'submit' }) {
  return <button type={type} onClick={onClick} className={secondary ? 'button secondary' : 'button'}>{children}</button>
}
function Empty({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return <div className="empty"><div className="empty-icon"><Sparkles size={22} /></div><h3>{title}</h3><p>{children}</p>{action}</div>
}
function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])
  return <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}><section className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"><div className="modal-head"><h2 id="modal-title">{title}</h2><button className="icon-button" onClick={onClose} aria-label="Close"><X size={20} /></button></div>{children}</section></div>
}

function App() {
  const { data, ready, error, load, save } = usePlanner()
  const [page, setPage] = useState<Page>('overview')
  const [periodId, setPeriodId] = useState('')
  const [dialog, setDialog] = useState<Dialog>(null)
  const [formError, setFormError] = useState('')
  useEffect(() => { void load() }, [load])
  const period = data.periods.find(p => p.id === periodId) ?? data.periods[0]
  const meetings = data.meetings.filter(m => m.periodId === period?.id).sort((a, b) => a.start.localeCompare(b.start))
  const blocks = data.availability.filter(a => a.periodId === period?.id).sort((a, b) => a.start.localeCompare(b.start))
  const unplanned = data.friends.filter(f => !meetings.some(m => m.friendId === f.id))
  const conflictCount = meetings.filter(m => meetingWarnings(m, data).length).length
  const friend = (id: string) => data.friends.find(f => f.id === id)
  const open = (next: Dialog) => { setFormError(''); setDialog(next) }
  const persist = async (next: PlannerData) => { await save(next) }
  const remove = (kind: 'period' | 'friend' | 'availability' | 'meeting', id: string) => {
    if (!window.confirm(`Delete this ${kind}?${kind === 'friend' || kind === 'period' ? ' Related availability and plans will also be deleted.' : ''}`)) return
    const next = { ...data }
    if (kind === 'period') { next.periods = data.periods.filter(x => x.id !== id); next.availability = data.availability.filter(x => x.periodId !== id); next.meetings = data.meetings.filter(x => x.periodId !== id) }
    if (kind === 'friend') { next.friends = data.friends.filter(x => x.id !== id); next.availability = data.availability.filter(x => x.friendId !== id); next.meetings = data.meetings.filter(x => x.friendId !== id) }
    if (kind === 'availability') next.availability = data.availability.filter(x => x.id !== id)
    if (kind === 'meeting') next.meetings = data.meetings.filter(x => x.id !== id)
    void persist(next)
  }
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!dialog) return
    const f = new FormData(e.currentTarget), next = { ...data }
    const id = dialog.item?.id ?? uid()
    if (dialog.kind === 'period') {
      const item = { id, name: value(f, 'name'), start: value(f, 'start'), end: value(f, 'end') }
      if (!item.name || !item.start || !item.end || item.start > item.end) { setFormError('Enter a name and a valid date range.'); return }
      next.periods = [...data.periods.filter(p => p.id !== id), item]
      setPeriodId(id)
    } else if (dialog.kind === 'friend') {
      const now = new Date().toISOString()
      const item: Friend = { id, name: value(f, 'name'), colour: value(f, 'colour'), priority: value(f, 'priority') as Priority, location: value(f, 'location'), notes: value(f, 'notes'), createdAt: dialog.item?.createdAt ?? now, updatedAt: now }
      if (!item.name) { setFormError('Please enter a name.'); return }
      next.friends = [...data.friends.filter(x => x.id !== id), item]
    } else {
      if (!period) return
      const start = value(f, 'start'), end = value(f, 'end')
      if (!validRange(start, end)) { setFormError('The end time must be after the start time.'); return }
      if (start.slice(0, 10) < period.start || end.slice(0, 10) > period.end) { setFormError('Choose times within the planning period.'); return }
      if (dialog.kind === 'availability') {
        const selected = value(f, 'friendId')
        const item: Availability = { id, periodId: period.id, friendId: selected === 'self' ? null : selected, start, end }
        if (item.friendId && !friend(item.friendId)) { setFormError('Choose a friend.'); return }
        next.availability = [...data.availability.filter(x => x.id !== id), item]
      } else {
        const item: Meeting = { id, periodId: period.id, friendId: value(f, 'friendId'), start, end, location: value(f, 'location'), notes: value(f, 'notes'), status: value(f, 'status') as Meeting['status'] }
        if (!friend(item.friendId)) { setFormError('Choose a friend.'); return }
        next.meetings = [...data.meetings.filter(x => x.id !== id), item]
      }
    }
    await persist(next)
    setDialog(null)
  }
  if (!ready) return <div className="loading">Opening Meet-up Planner…</div>

  const planCard = (m: Meeting) => {
    const person = friend(m.friendId), warnings = meetingWarnings(m, data)
    return <article className="plan-card" key={m.id}>
      <div className="plan-time"><strong>{timeLabel(m.start)}</strong><span>to {timeLabel(m.end)}</span></div>
      <div className="plan-divider" style={{ background: person?.colour }} />
      <Avatar friend={person} />
      <div className="plan-content"><div className="plan-title"><strong>{person?.name ?? 'Unknown friend'}</strong><span className={`status ${m.status}`}>{m.status === 'confirmed' && <Check size={12} />}{m.status}</span></div><div className="muted small">{m.location ? <><MapPin size={14} /> {m.location}</> : 'Location to be decided'}</div>{m.notes && <p className="plan-note">{m.notes}</p>}{warnings.length > 0 && <div className="warning"><AlertTriangle size={14} /> {warnings.join(' · ')}</div>}</div>
      <button className="icon-button" aria-label={`Edit plan with ${person?.name ?? 'friend'}`} onClick={() => open({ kind: 'meeting', item: m })}><Pencil size={16} /></button>
      <button className="icon-button" aria-label="Delete plan" onClick={() => remove('meeting', m.id)}><Trash2 size={16} /></button>
    </article>
  }
  const groupedPlans = (list: Meeting[]) => {
    const dates = [...new Set(list.map(m => m.start.slice(0, 10)))]
    return dates.map(date => <div className="day-group" key={date}><h3 className="day-heading">{dateLabel(date, 'EEEE, d MMMM')} <span>{list.filter(m => m.start.startsWith(date)).length} {list.filter(m => m.start.startsWith(date)).length === 1 ? 'plan' : 'plans'}</span></h3>{list.filter(m => m.start.startsWith(date)).map(planCard)}</div>)
  }

  return <div className="app-shell">
    <aside className="sidebar"><div className="brand"><div className="brand-mark"><Heart size={20} fill="currentColor" /></div><div><strong>Meet-up Planner</strong><span>A little time for your people</span></div></div><div className="sidebar-label">YOUR PLANNER</div><nav className="desktop-nav" aria-label="Main navigation">{nav.map(({ id, label, icon: Icon }) => <button key={id} className={page === id ? 'nav-item active' : 'nav-item'} onClick={() => setPage(id)}><Icon size={18} />{label}</button>)}</nav><div className="sidebar-bottom"><div className="side-illustration"><Heart size={19} fill="currentColor" /></div><strong>Make time for<br />the good people.</strong><p>All your plans, together in one happy place.</p></div></aside>
    <div className="main-wrap"><header className="topbar"><div className="mobile-brand"><Heart size={18} fill="currentColor" /> Meet-up Planner</div><div className="topbar-title">YOUR PERSONAL PLANNER <span>✦</span></div><div className="period-control">{period && <><span className="period-dot" /><select aria-label="Planning period" value={period.id} onChange={e => setPeriodId(e.target.value)}>{data.periods.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select><ChevronDown size={15} /></>}<button className="icon-button" aria-label="Add planning period" onClick={() => open({ kind: 'period' })}><Plus size={18} /></button></div></header>
      <main className="content">
        {error && <div className="error-banner" role="alert">{error}</div>}
        {page === 'overview' && <><div className="page-heading"><div><div className="eyebrow">A LITTLE MORE TOGETHER TIME <span>✦</span></div><h1>Good times, made <em>simple.</em></h1><p>Make room for the people who matter most.</p></div>{period && <Button onClick={() => open({ kind: 'meeting' })}><Plus size={17} /> New plan</Button>}</div>
          {!period ? <div className="welcome-panel"><div className="welcome-art"><span>✳</span><Heart size={46} fill="currentColor" /><span>✦</span></div><div><div className="eyebrow">LET'S GET STARTED</div><h2>Make some room for connection.</h2><p>Welcome to Meet-up Planner. Start with a planning period, then bring your favourite people into the picture.</p><Button onClick={() => open({ kind: 'period' })}><Plus size={17} /> Create a planning period</Button></div></div> : <>
            <section className="period-banner"><div><div className="eyebrow">CURRENTLY PLANNING <span>✦</span></div><h2>{period.name}</h2><p><CalendarDays size={16} /> {dateLabel(period.start, 'd MMM')} – {dateLabel(period.end, 'd MMM yyyy')}</p></div><div className="banner-actions"><button className="icon-button" aria-label="Edit period" onClick={() => open({ kind: 'period', item: period })}><Pencil size={17} /></button><button className="icon-button" aria-label="Delete period" onClick={() => remove('period', period.id)}><Trash2 size={17} /></button></div><div className="banner-flower">✳</div></section>
            <div className="stats"><div className="stat"><span>YOUR PEOPLE</span><strong>{data.friends.length.toString().padStart(2, '0')}</strong><small>friends on your list</small><Users size={20} /></div><div className="stat"><span>PLANS MADE</span><strong>{meetings.length.toString().padStart(2, '0')}</strong><small>{meetings.filter(m => m.status === 'confirmed').length} confirmed</small><CalendarDays size={20} /></div><div className="stat"><span>STILL TO PLAN</span><strong>{unplanned.length.toString().padStart(2, '0')}</strong><small>people to catch up with</small><Heart size={20} /></div><div className="stat"><span>NEED A LOOK</span><strong>{conflictCount.toString().padStart(2, '0')}</strong><small>plans with warnings</small><AlertTriangle size={20} /></div></div>
            <div className="overview-grid"><section><div className="section-heading"><div><div className="eyebrow">THE GOOD STUFF</div><h2>Upcoming plans</h2></div><button className="text-button" onClick={() => setPage('itinerary')}>View itinerary →</button></div>{meetings.length ? groupedPlans(meetings.slice(0, 4)) : <Empty title="Nothing on the calendar yet">Your plans will find their place here.<br />Start with a friend and a little free time.<div className="empty-action"><Button secondary onClick={() => open({ kind: 'meeting' })}><Plus size={16} /> Add a plan</Button></div></Empty>}</section>
              <section className="people-panel"><div className="section-heading"><div><div className="eyebrow">DON'T FORGET</div><h2>Still to see</h2></div><button className="text-button" onClick={() => setPage('friends')}>All friends →</button></div>{unplanned.length ? <div className="people-list">{unplanned.slice(0, 5).map(f => <div className="person-row" key={f.id}><Avatar friend={f} /><div><strong>{f.name}</strong><small>{f.location || 'A catch-up awaits'}</small></div><span className="priority">{f.priority}</span></div>)}</div> : <p className="muted small">{data.friends.length ? 'Everyone has a plan. Lovely!' : 'Add friends to start making plans.'}</p>}<button className="add-link" onClick={() => open({ kind: 'friend' })}><Plus size={16} /> Add a friend</button></section></div>
          </>}</>}
        {page === 'friends' && <><div className="page-heading"><div><div className="eyebrow">YOUR FAVOURITE PEOPLE</div><h1>Friends <em>first.</em></h1><p>Keep the people you want to see close at hand.</p></div><Button onClick={() => open({ kind: 'friend' })}><Plus size={17} /> Add friend</Button></div>{data.friends.length ? <div className="friend-grid">{data.friends.map(f => <article className="friend-card" key={f.id}><div className="friend-card-top"><Avatar friend={f} size="large" /><div><button className="icon-button" aria-label={`Edit ${f.name}`} onClick={() => open({ kind: 'friend', item: f })}><Pencil size={16} /></button><button className="icon-button" aria-label={`Delete ${f.name}`} onClick={() => remove('friend', f.id)}><Trash2 size={16} /></button></div></div><h3>{f.name}</h3><span className="priority">{f.priority}</span><p className="muted small">{f.location || 'No location added'}</p>{f.notes && <p className="friend-notes">{f.notes}</p>}</article>)}</div> : <Empty title="Your people go here">Add friends to Meet-up Planner and start making time for them.</Empty>}</>}
        {page === 'availability' && <><div className="page-heading"><div><div className="eyebrow">FIND THE RIGHT MOMENT</div><h1>A little <em>availability.</em></h1><p>Keep track of when you and your friends are free.</p></div>{period && <Button onClick={() => open({ kind: 'availability' })}><Plus size={17} /> Add time block</Button>}</div>{!period ? <Empty title="Start with a planning period">Create a period to add availability.</Empty> : blocks.length ? <><div className="list-panel">{blocks.map(b => <div className="availability-row" key={b.id}><Avatar friend={b.friendId ? friend(b.friendId) : undefined} /><div className="grow"><strong>{b.friendId ? friend(b.friendId)?.name ?? 'Unknown friend' : 'You'}</strong><p className="muted small">{dateLabel(b.start)} · {timeLabel(b.start)} – {b.start.slice(0, 10) !== b.end.slice(0, 10) && `${dateLabel(b.end)} · `}{timeLabel(b.end)}</p></div><button className="icon-button" aria-label="Edit availability" onClick={() => open({ kind: 'availability', item: b })}><Pencil size={16} /></button><button className="icon-button" aria-label="Delete availability" onClick={() => remove('availability', b.id)}><Trash2 size={16} /></button></div>)}</div><div className="gaps"><div className="section-heading"><div><div className="eyebrow">A LITTLE SPACE TO BREATHE</div><h2>Your open gaps</h2></div></div>{freeGaps(blocks, meetings).length ? <div className="list-panel">{freeGaps(blocks, meetings).map((gap, i) => <div className="availability-row" key={`${gap.start}-${gap.end}-${i}`}><Clock3 size={18} color="#c57d63" /><div><strong>{dateLabel(gap.start)}</strong><p className="muted small">{timeLabel(gap.start)} – {gap.start.slice(0, 10) !== gap.end.slice(0, 10) && `${dateLabel(gap.end)} · `}{timeLabel(gap.end)}</p></div></div>)}</div> : <p className="muted small">No open gaps in your recorded availability.</p>}</div></> : <Empty title="Room for possibility">Add your free time and the availability friends have shared with you.</Empty>}</>}
        {page === 'itinerary' && <><div className="page-heading"><div><div className="eyebrow">ALL TOGETHER NOW</div><h1>Your <em>itinerary.</em></h1><p>A little look at the good things ahead.</p></div>{period && <Button onClick={() => open({ kind: 'meeting' })}><Plus size={17} /> New plan</Button>}</div>{!period ? <Empty title="Start with a planning period">Create a period to start your itinerary.</Empty> : meetings.length ? groupedPlans(meetings) : <Empty title="The best plans start here">Add a tentative plan and confirm it when you've agreed the details.</Empty>}</>}
        {page === 'settings' && <SettingsPage data={data} save={persist} />}
      </main><footer>Made for more moments together <span>♥</span></footer>
    </div>
    <nav className="mobile-nav" aria-label="Main navigation">{nav.map(({ id, label, icon: Icon }) => <button key={id} className={page === id ? 'active' : ''} onClick={() => setPage(id)}><Icon size={19} /><span>{label}</span></button>)}</nav>
    {dialog && <Modal title={`${dialog.item ? 'Edit' : 'Add'} ${dialog.kind === 'availability' ? 'availability' : dialog.kind === 'meeting' ? 'a plan' : dialog.kind === 'period' ? 'planning period' : 'a friend'}`} onClose={() => setDialog(null)}><form onSubmit={e => void submit(e)} className="form">
      {dialog.kind === 'period' && <><label>Period name<input name="name" required maxLength={100} defaultValue={dialog.item?.name} placeholder="e.g. Festive trip" /></label><div className="form-grid"><label>Start date<input type="date" name="start" required defaultValue={dialog.item?.start} /></label><label>End date<input type="date" name="end" required defaultValue={dialog.item?.end} /></label></div></>}
      {dialog.kind === 'friend' && <><label>Name<input name="name" required maxLength={100} defaultValue={dialog.item?.name} placeholder="Their name" /></label><div className="form-grid"><label>Priority<select name="priority" defaultValue={dialog.item?.priority ?? 'normal'}><option value="must-see">Must-see</option><option value="high">High</option><option value="normal">Normal</option><option value="low">Low</option></select></label><label>Colour<input type="color" name="colour" defaultValue={dialog.item?.colour ?? colours[data.friends.length % colours.length]} /></label></div><label>Location <span>(optional)</span><input name="location" maxLength={150} defaultValue={dialog.item?.location} placeholder="Where are they based?" /></label><label>Notes <span>(optional)</span><textarea name="notes" maxLength={2000} defaultValue={dialog.item?.notes} placeholder="Anything you'd like to remember" /></label></>}
      {(dialog.kind === 'availability' || dialog.kind === 'meeting') && <><label>{dialog.kind === 'availability' ? 'Whose availability?' : 'Who are you seeing?'}<select name="friendId" required defaultValue={dialog.item?.friendId ?? (dialog.kind === 'availability' ? 'self' : '')}>{dialog.kind === 'availability' ? <option value="self">You</option> : <option value="">Choose a friend</option>}{data.friends.map(f => <option value={f.id} key={f.id}>{f.name}</option>)}</select></label>{!data.friends.length && dialog.kind === 'meeting' && <p className="muted small">Add a friend before creating a plan.</p>}<div className="form-grid"><label>Starts<input name="start" type="datetime-local" required defaultValue={dialog.item?.start} min={`${period?.start}T00:00`} max={`${period?.end}T23:59`} /></label><label>Ends<input name="end" type="datetime-local" required defaultValue={dialog.item?.end} min={`${period?.start}T00:00`} max={`${period?.end}T23:59`} /></label></div></>}
      {dialog.kind === 'meeting' && <><label>Status<select name="status" defaultValue={dialog.item?.status ?? 'tentative'}><option value="tentative">Tentative</option><option value="confirmed">Confirmed</option></select></label><label>Where? <span>(optional)</span><input name="location" maxLength={150} defaultValue={dialog.item?.location} placeholder="A favourite café, perhaps?" /></label><label>Notes <span>(optional)</span><textarea name="notes" maxLength={2000} defaultValue={dialog.item?.notes} /></label><p className="form-hint">We'll flag overlapping plans and times outside recorded availability.</p></>}
      {formError && <p className="form-error" role="alert">{formError}</p>}<div className="form-actions"><Button secondary onClick={() => setDialog(null)}>Cancel</Button><Button type="submit">Save {dialog.kind === 'meeting' ? 'plan' : dialog.kind}</Button></div>
    </form></Modal>}
  </div>
}

function SettingsPage({ data, save }: { data: PlannerData; save: (data: PlannerData) => Promise<void> }) {
  const [token, setToken] = useState('')
  const [owner, setOwner] = useState(localStorage.getItem('meetup-owner') ?? '')
  const [repo, setRepo] = useState(localStorage.getItem('meetup-repo') ?? '')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const sync = async (direction: 'pull' | 'push') => {
    if (!token || !owner || !repo) { setMessage('Enter your GitHub token, username and private repository.'); return }
    if (direction === 'pull' && !window.confirm('Replace all local planner data with the cloud copy? This cannot be undone.')) return
    setBusy(true); setMessage('')
    const key = `meetup-sha:${owner.toLowerCase()}/${repo.toLowerCase()}`
    try {
      if (direction === 'pull') {
        const remote = await readCloud(token, owner, repo)
        if (!remote) throw new Error('No cloud copy found. Push from the device with your data first.')
        await save(remote.data)
        if (usePlanner.getState().error) throw new Error('The cloud copy could not be saved locally.')
        localStorage.setItem(key, remote.sha)
        setMessage('Cloud copy downloaded to this device.')
      } else {
        const sha = await writeCloud(token, owner, repo, data, localStorage.getItem(key) ?? undefined)
        localStorage.setItem(key, sha)
        setMessage('Your planner was saved to GitHub.')
      }
      localStorage.setItem('meetup-owner', owner); localStorage.setItem('meetup-repo', repo)
    } catch (e) { setMessage(e instanceof Error ? e.message : 'Sync failed. Please try again.') }
    finally { setBusy(false) }
  }
  return <><div className="page-heading"><div><div className="eyebrow">YOUR SPACE, YOUR WAY</div><h1>Make it <em>yours.</em></h1><p>Your planner lives on this device, with optional cloud sync.</p></div></div><section className="settings-card"><div className="settings-icon"><Cloud size={22} /></div><h2>GitHub sync</h2><p>Bring your planner to another device using a private repository you own. Create a GitHub personal access token with repository contents read and write access. Your token stays in memory and is cleared when you leave this page.</p><div className="form"><label>GitHub username<input value={owner} onChange={e => setOwner(e.target.value)} autoComplete="username" /></label><label>Private repository name<input value={repo} onChange={e => setRepo(e.target.value)} placeholder="e.g. my-meetup-planner" /></label><label>Personal access token<input type="password" value={token} onChange={e => setToken(e.target.value)} autoComplete="off" /></label><div className="sync-actions"><button className="button" disabled={busy} onClick={() => void sync('push')}><ArrowUpFromLine size={16} /> Push to GitHub</button><button className="button secondary" disabled={busy} onClick={() => void sync('pull')}><ArrowDownToLine size={16} /> Pull from GitHub</button></div>{message && <p role="status" className="sync-message">{message}</p>}<p className="form-hint">Pull replaces local data. Push is protected against overwriting a cloud copy changed since your last sync. Pull first on a new device.</p></div></section><section className="settings-card"><h2>Local data</h2><p>Planner data is stored in this browser's IndexedDB. Clearing browser data will remove it.</p><Button secondary onClick={() => { if (window.confirm('Delete all local Meet-up Planner data? This cannot be undone.')) void save(emptyData()) }}>Clear local data</Button></section></>
}

export default App
