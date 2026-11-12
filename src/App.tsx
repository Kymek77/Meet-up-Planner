import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { addHours, format, parseISO } from 'date-fns'
import { AlertTriangle, ArrowDownToLine, ArrowUpFromLine, CalendarDays, Check, ChevronDown, Clock3, Cloud, Heart, LayoutDashboard, MapPin, Pencil, Plus, Settings, Sparkles, Trash2, Users, X } from 'lucide-react'
import { emptyData, freeGaps, getDashboardHighlights, isPlannerData, meetingWarnings, validRange, type Availability, type Friend, type Meeting, type Period, type PlannerData, type Priority } from './model'
import { usePlanner } from './store'
import { CloudConflictError, ensurePrivateRepository, getAuthenticatedUser, GitHubAuthError, GitHubPermissionError, readCloud, writeCloud } from './sync'
import { beginGitHubAuthorization, exchangeGitHubCode, takeGitHubCallback } from './auth'
import Calendar from './Calendar'
import './sync.css'

type Page = 'overview' | 'friends' | 'availability' | 'calendar' | 'itinerary' | 'settings'
type Dialog = { kind: 'period'; item?: Period } | { kind: 'friend'; item?: Friend } | { kind: 'availability'; item?: Availability } | { kind: 'meeting'; item?: Meeting; seed?: Partial<Meeting> & { start: string; end: string } } | null
const colours = ['#e89882', '#d2a55d', '#87a88b', '#81a9ad', '#9386b1', '#d18eaa', '#829ac1', '#c8a07d']
const uid = () => crypto.randomUUID()
const dateLabel = (date: string, pattern = 'EEE, d MMM') => format(parseISO(date), pattern)
const timeLabel = (date: string) => dateLabel(date, 'h:mm a')
const value = (form: FormData, key: string) => String(form.get(key) ?? '').trim()
const nav: { id: Page; label: string; icon: typeof Heart }[] = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard }, { id: 'friends', label: 'Friends', icon: Users },
  { id: 'availability', label: 'Availability', icon: Clock3 }, { id: 'calendar', label: 'Calendar', icon: CalendarDays }, { id: 'itinerary', label: 'Itinerary', icon: CalendarDays },
  { id: 'settings', label: 'Settings', icon: Settings },
]

function Avatar({ friend, size = 'normal' }: { friend?: Friend; size?: 'normal' | 'large' }) {
  return <span className={`avatar ${size}`} style={{ backgroundColor: friend?.colour ?? '#ddd' }} aria-hidden="true">{friend?.name.trim().split(/\s+/).slice(0, 2).map(s => s[0]).join('').toUpperCase() ?? '?'}</span>
}
function Button({ children, onClick, secondary = false, type = 'button' }: { children: ReactNode; onClick?: () => void; secondary?: boolean; type?: 'button' | 'submit' }) {
  return <button type={type} onClick={onClick} className={secondary ? 'button secondary' : 'button'}>{children}</button>
}
function Empty({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return <div className="empty"><div className="empty-icon"><Sparkles size={22} /></div><h3>{title}</h3><div className="empty-description">{children}</div>{action}</div>
}
function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const modal = useRef<HTMLElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    modal.current?.querySelector<HTMLElement>('input, select, textarea, button')?.focus()
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if (e.key !== 'Tab') return
      const controls = modal.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [href]')
      if (!controls?.length) return
      const first = controls[0], last = controls[controls.length - 1]
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
      if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
    }
    window.addEventListener('keydown', handler)
    return () => { window.removeEventListener('keydown', handler); previous?.focus() }
  }, [onClose])
  return <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}><section ref={modal} className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"><div className="modal-head"><h2 id="modal-title">{title}</h2><button className="icon-button" onClick={onClose} aria-label="Close"><X size={20} /></button></div>{children}</section></div>
}

function App() {
  const { data, ready, error, load, save } = usePlanner()
  const [page, setPage] = useState<Page>(() => {
    const query = new URLSearchParams(window.location.search)
    return query.has('state') && (query.has('code') || query.has('error')) ? 'settings' : 'overview'
  })
  const [periodId, setPeriodId] = useState('')
  const [dialog, setDialog] = useState<Dialog>(null)
  const [formError, setFormError] = useState('')
  const [friendFilter, setFriendFilter] = useState('active')
  const [buffer, setBuffer] = useState(Number(localStorage.getItem('meetup-buffer') ?? 30))
  const [online, setOnline] = useState(navigator.onLine)
  const [syncStatus, setSyncStatus] = useState('')
  useEffect(() => { void load() }, [load])
  useEffect(() => { const update = () => setOnline(navigator.onLine); window.addEventListener('online', update); window.addEventListener('offline', update); return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update) } }, [])
  const period = data.periods.find(p => p.id === periodId) ?? data.periods[0]
  const meetings = data.meetings.filter(m => m.periodId === period?.id).sort((a, b) => a.start.localeCompare(b.start))
  const blocks = data.availability.filter(a => a.periodId === period?.id).sort((a, b) => a.start.localeCompare(b.start))
  const unplanned = data.friends.filter(f => !f.archived && !meetings.some(m => m.friendId === f.id && m.status === 'confirmed'))
  const conflictCount = meetings.filter(m => meetingWarnings(m, data, buffer).length).length
  const dashboard = getDashboardHighlights(meetings, data.friends)
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
      const item: Friend = { ...dialog.item, id, name: value(f, 'name'), colour: value(f, 'colour'), priority: value(f, 'priority') as Priority, location: value(f, 'location'), notes: value(f, 'notes'), lastContacted: value(f, 'lastContacted'), createdAt: dialog.item?.createdAt ?? now, updatedAt: now }
      if (!item.name) { setFormError('Please enter a name.'); return }
      next.friends = [...data.friends.filter(x => x.id !== id), item]
    } else {
      if (!period) return
      const start = value(f, 'start'), end = value(f, 'end')
      if (!validRange(start, end)) { setFormError('The end time must be after the start time.'); return }
      if (start.slice(0, 10) < period.start || end.slice(0, 10) > period.end) { setFormError('Choose times within the planning period.'); return }
      if (dialog.kind === 'availability') {
        const selected = value(f, 'friendId')
        const item: Availability = { id, periodId: period.id, friendId: selected === 'self' ? null : selected, start, end, source: value(f, 'source') as Availability['source'], confidence: value(f, 'confidence') as Availability['confidence'], kind: selected === 'self' ? value(f, 'kind') as Availability['kind'] : 'available', label: value(f, 'label'), location: value(f, 'location'), notes: value(f, 'notes'), expired: f.has('expired') }
        if (item.friendId && !friend(item.friendId)) { setFormError('Choose a friend.'); return }
        next.availability = [...data.availability.filter(x => x.id !== id), item]
      } else {
        const item: Meeting = { id, periodId: period.id, friendId: value(f, 'friendId'), start, end, location: value(f, 'location'), notes: value(f, 'notes'), status: value(f, 'status') as Meeting['status'], title: value(f, 'title'), travelTimeMinutes: Number(value(f, 'travelTimeMinutes') || 0) }
        if (!friend(item.friendId)) { setFormError('Choose a friend.'); return }
        next.meetings = [...data.meetings.filter(x => x.id !== id), item]
      }
    }
    await persist(next)
    if (!usePlanner.getState().error) setDialog(null)
  }
  if (!ready) return <div className="loading">Opening Meet-up Planner…</div>

  const planCard = (m: Meeting) => {
    const person = friend(m.friendId), warnings = meetingWarnings(m, data, buffer)
    return <article className="plan-card" key={m.id}>
      <div className="plan-time"><strong>{timeLabel(m.start)}</strong><span>to {timeLabel(m.end)}</span></div>
      <div className="plan-divider" style={{ background: person?.colour }} />
      <Avatar friend={person} />
      <div className="plan-content"><div className="plan-title"><strong>{person?.name ?? 'Unknown friend'}{m.title && ` · ${m.title}`}</strong><span className={`status ${m.status}`}>{m.status === 'confirmed' && <Check size={12} />}{m.status.replace('-', ' ')}</span></div><div className="muted small">{m.location ? <><MapPin size={14} /> {m.location}</> : 'Location to be decided'}{m.travelTimeMinutes ? ` · ${m.travelTimeMinutes} min travel` : ''}</div>{m.notes && <p className="plan-note">{m.notes}</p>}{warnings.length > 0 && <div className="warning"><AlertTriangle size={14} /> {warnings.join(' · ')}</div>}</div>
      <button className="icon-button" aria-label="Duplicate plan" onClick={() => open({ kind: 'meeting', seed: m })}><Plus size={16} /></button>
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
        {!online && <div className="offline-banner" role="status">Offline · Your changes are saved on this device.</div>}
        {syncStatus && <div className="sync-status-banner" role="status">{syncStatus}</div>}
        {error && <div className="error-banner" role="alert">{error}</div>}
        {page === 'overview' && <><div className="page-heading"><div><div className="eyebrow">A LITTLE MORE TOGETHER TIME <span>✦</span></div><h1>Good times, made <em>simple.</em></h1><p>Make room for the people who matter most.</p></div>{period && <Button onClick={() => open({ kind: 'meeting' })}><Plus size={17} /> New plan</Button>}</div>
          {!period ? <div className="welcome-panel"><div className="welcome-art"><span>✳</span><Heart size={46} fill="currentColor" /><span>✦</span></div><div><div className="eyebrow">LET'S GET STARTED</div><h2>Make some room for connection.</h2><p>Welcome to Meet-up Planner. Start with a planning period, then bring your favourite people into the picture.</p><Button onClick={() => open({ kind: 'period' })}><Plus size={17} /> Create a planning period</Button></div></div> : <>
            <section className="period-banner"><div><div className="eyebrow">CURRENTLY PLANNING <span>✦</span></div><h2>{period.name}</h2><p><CalendarDays size={16} /> {dateLabel(period.start, 'd MMM')} – {dateLabel(period.end, 'd MMM yyyy')}</p></div><div className="banner-actions"><button className="icon-button" aria-label="Edit period" onClick={() => open({ kind: 'period', item: period })}><Pencil size={17} /></button><button className="icon-button" aria-label="Delete period" onClick={() => remove('period', period.id)}><Trash2 size={17} /></button></div><div className="banner-flower">✳</div></section>
            <div className="stats"><div className="stat"><span>YOUR PEOPLE</span><strong>{data.friends.length.toString().padStart(2, '0')}</strong><small>friends on your list</small><Users size={20} /></div><div className="stat"><span>PLANS MADE</span><strong>{meetings.length.toString().padStart(2, '0')}</strong><small>{meetings.filter(m => m.status === 'confirmed').length} confirmed</small><CalendarDays size={20} /></div><div className="stat"><span>STILL TO PLAN</span><strong>{unplanned.length.toString().padStart(2, '0')}</strong><small>people to catch up with</small><Heart size={20} /></div><div className="stat"><span>NEED A LOOK</span><strong>{conflictCount.toString().padStart(2, '0')}</strong><small>plans with warnings</small><AlertTriangle size={20} /></div></div>
            <div className="overview-grid dashboard-agenda">
              <section className="dashboard-panel"><div className="section-heading"><div><div className="eyebrow">ON THE CALENDAR</div><h2>Today</h2></div></div>{dashboard.today.length ? dashboard.today.map(planCard) : <p className="muted small">No meet-ups planned for today.</p>}
                <div className="section-heading dashboard-next"><div><div className="eyebrow">COMING UP</div><h2>Next confirmed meet-up</h2></div></div>{dashboard.nextConfirmed ? planCard(dashboard.nextConfirmed) : <p className="muted small">No upcoming confirmed meet-up in this period.</p>}
              </section>
              <section className="people-panel"><div className="section-heading"><div><div className="eyebrow">A GENTLE NUDGE</div><h2>Friends to contact</h2></div></div>{dashboard.staleContacts.length ? <div className="people-list">{dashboard.staleContacts.slice(0, 5).map(({ friend: f, daysSinceContact }) => <div className="person-row" key={f.id}><Avatar friend={f} /><div><strong>{f.name}</strong><small>Last contacted {f.lastContacted && dateLabel(f.lastContacted)} · {daysSinceContact} days ago</small></div><button className="icon-button" aria-label={`Update ${f.name}`} onClick={() => open({ kind: 'friend', item: f })}><Pencil size={15} /></button></div>)}</div> : <p className="muted small">No friends with a last-contacted date older than 30 days.</p>}</section>
            </div>
            <div className="overview-grid"><section><div className="section-heading"><div><div className="eyebrow">THE GOOD STUFF</div><h2>Upcoming plans</h2></div><button className="text-button" onClick={() => setPage('itinerary')}>View itinerary →</button></div>{meetings.length ? groupedPlans(meetings.slice(0, 4)) : <Empty title="Nothing on the calendar yet">Your plans will find their place here.<br />Start with a friend and a little free time.<div className="empty-action"><Button secondary onClick={() => open({ kind: 'meeting' })}><Plus size={16} /> Add a plan</Button></div></Empty>}</section>
              <section className="people-panel"><div className="section-heading"><div><div className="eyebrow">DON'T FORGET</div><h2>Still to see</h2></div><button className="text-button" onClick={() => setPage('friends')}>All friends →</button></div>{unplanned.length ? <div className="people-list">{unplanned.slice(0, 5).map(f => <div className="person-row" key={f.id}><Avatar friend={f} /><div><strong>{f.name}</strong><small>{f.location || 'A catch-up awaits'}</small></div><span className="priority">{f.priority}</span></div>)}</div> : <p className="muted small">{data.friends.length ? 'Everyone has a plan. Lovely!' : 'Add friends to start making plans.'}</p>}<button className="add-link" onClick={() => open({ kind: 'friend' })}><Plus size={16} /> Add a friend</button></section></div>
          </>}</>}
        {page === 'friends' && <><div className="page-heading"><div><div className="eyebrow">YOUR FAVOURITE PEOPLE</div><h1>Friends <em>first.</em></h1><p>Keep the people you want to see close at hand.</p></div><Button onClick={() => open({ kind: 'friend' })}><Plus size={17} /> Add friend</Button></div><label className="filter-label">Show <select value={friendFilter} onChange={e => setFriendFilter(e.target.value)}><option value="active">Active friends</option><option value="unbooked">Not confirmed</option><option value="confirmed">Confirmed</option><option value="awaiting-reply">Awaiting reply</option><option value="must-see">Must-see</option><option value="high">High priority</option><option value="normal">Normal priority</option><option value="low">Low priority</option><option value="archived">Archived</option></select></label>{data.friends.length ? <div className="friend-grid">{data.friends.filter(f => {
          const own = meetings.filter(m => m.friendId === f.id)
          if (friendFilter === 'archived') return f.archived
          if (f.archived) return false
          if (friendFilter === 'active') return true
          if (friendFilter === 'unbooked') return !own.some(m => m.status === 'confirmed')
          if (friendFilter === 'confirmed' || friendFilter === 'awaiting-reply') return own.some(m => m.status === friendFilter)
          return f.priority === friendFilter
        }).map(f => { const own = meetings.filter(m => m.friendId === f.id); const confirmed = own.filter(m => m.status === 'confirmed').length; return <article className="friend-card" key={f.id}><div className="friend-card-top"><Avatar friend={f} size="large" /><div><button className="icon-button" aria-label={`Edit ${f.name}`} onClick={() => open({ kind: 'friend', item: f })}><Pencil size={16} /></button><button className="icon-button" aria-label={`Delete ${f.name}`} onClick={() => remove('friend', f.id)}><Trash2 size={16} /></button></div></div><h3>{f.name}</h3><span className="priority">{f.priority}</span> <span className="priority">{confirmed ? 'Confirmed' : 'Not confirmed'}</span><p className="muted small">{f.location || 'No location added'}</p><p className="muted small">{confirmed} confirmed · {own.filter(m => m.status === 'tentative').length} tentative · {own.filter(m => ['idea', 'proposed', 'awaiting-reply'].includes(m.status)).length} options</p>{f.notes && <p className="friend-notes">{f.notes}</p>}<button className="add-link" onClick={() => void persist({ ...data, friends: data.friends.map(person => person.id === f.id ? { ...person, archived: !person.archived, updatedAt: new Date().toISOString() } : person) })}>{f.archived ? 'Restore friend' : 'Archive friend'}</button></article> })}</div> : <Empty title="Your people go here">Add friends to Meet-up Planner and start making time for them.</Empty>}</>}
        {page === 'availability' && <><div className="page-heading"><div><div className="eyebrow">FIND THE RIGHT MOMENT</div><h1>A little <em>availability.</em></h1><p>Keep track of when you and your friends are free.</p></div>{period && <Button onClick={() => open({ kind: 'availability' })}><Plus size={17} /> Add time block</Button>}</div>
          {!period ? <Empty title="Start with a planning period">Create a period to add availability.</Empty> : blocks.length ? <>
            <div className="list-panel">{blocks.map(b => <div className="availability-row" key={b.id}><Avatar friend={b.friendId ? friend(b.friendId) : undefined} /><div className="grow">
              <strong>{b.friendId ? friend(b.friendId)?.name ?? 'Unknown friend' : 'You'} {b.label && `· ${b.label}`}</strong>
              <p className="muted small">{dateLabel(b.start)} · {timeLabel(b.start)} – {b.start.slice(0, 10) !== b.end.slice(0, 10) && `${dateLabel(b.end)} · `}{timeLabel(b.end)}</p>
              <p className="muted small">{b.expired ? 'No longer relevant' : b.friendId ? `${b.confidence ?? 'likely'} · ${b.source ?? 'Other'}` : b.kind ?? 'available'}{b.notes && ` · ${b.notes}`}</p>
            </div>{!b.expired && (!b.kind || b.kind === 'available') && <button className="icon-button" aria-label="Create plan from availability" onClick={() => open({ kind: 'meeting', seed: { start: b.start, end: b.end, friendId: b.friendId ?? undefined } })}><Plus size={16} /></button>}<button className="icon-button" aria-label="Edit availability" onClick={() => open({ kind: 'availability', item: b })}><Pencil size={16} /></button><button className="icon-button" aria-label="Delete availability" onClick={() => remove('availability', b.id)}><Trash2 size={16} /></button></div>)}</div>
            <div className="gaps"><div className="section-heading"><div><div className="eyebrow">A LITTLE SPACE TO BREATHE</div><h2>Your open gaps</h2></div></div>{freeGaps(blocks, meetings).length ? <div className="list-panel">{freeGaps(blocks, meetings).map((gap, i) => <div className="availability-row" key={`${gap.start}-${gap.end}-${i}`}><Clock3 size={18} color="#c57d63" /><div><strong>{dateLabel(gap.start)}</strong><p className="muted small">{timeLabel(gap.start)} – {gap.start.slice(0, 10) !== gap.end.slice(0, 10) && `${dateLabel(gap.end)} · `}{timeLabel(gap.end)}</p></div></div>)}</div> : <p className="muted small">No open gaps in your recorded availability.</p>}</div>
          </> : <Empty title="Room for possibility">Add your free time and the availability friends have shared with you.</Empty>}
        </>}
        {page === 'calendar' && <><div className="page-heading"><div><div className="eyebrow">A WEEK AT A TIME</div><h1>Your <em>calendar.</em></h1><p>See your time, their time and your plans together.</p></div></div>{period ? <Calendar key={period.id} period={period} friends={data.friends} blocks={blocks} meetings={meetings} onCreate={start => open({ kind: 'meeting', seed: { start, end: format(addHours(parseISO(start), 1), "yyyy-MM-dd'T'HH:mm") } })} onEditMeeting={item => open({ kind: 'meeting', item })} onEditBlock={item => open({ kind: 'availability', item })} onMove={item => void persist({ ...data, meetings: data.meetings.map(m => m.id === item.id ? item : m) })} /> : <Empty title="Start with a planning period">Create a period to see your calendar.</Empty>}</>}
        {page === 'itinerary' && <><div className="page-heading"><div><div className="eyebrow">ALL TOGETHER NOW</div><h1>Your <em>itinerary.</em></h1><p>Confirmed plans, all in one place.</p></div>{period && <Button secondary onClick={() => void navigator.clipboard.writeText(itineraryText(meetings, data))}>Copy itinerary</Button>}</div>{!period ? <Empty title="Start with a planning period">Create a period to start your itinerary.</Empty> : meetings.some(m => m.status === 'confirmed') ? groupedPlans(meetings.filter(m => m.status === 'confirmed')) : <Empty title="The best plans start here">Confirmed plans will appear here.</Empty>}</>}
        <div hidden={page !== 'settings'}><SettingsPage data={data} save={persist} buffer={buffer} setBuffer={setBuffer} online={online} onSyncStatus={setSyncStatus} /></div>
      </main><footer>Made for more moments together <span>♥</span></footer>
    </div>
    <nav className="mobile-nav" aria-label="Main navigation">{nav.map(({ id, label, icon: Icon }) => <button key={id} className={page === id ? 'active' : ''} onClick={() => setPage(id)}><Icon size={19} /><span>{label}</span></button>)}</nav>
    {dialog && <Modal title={`${dialog.item ? 'Edit' : 'Add'} ${dialog.kind === 'availability' ? 'availability' : dialog.kind === 'meeting' ? 'a plan' : dialog.kind === 'period' ? 'planning period' : 'a friend'}`} onClose={() => setDialog(null)}><form onSubmit={e => void submit(e)} className="form">
      {dialog.kind === 'period' && <><label>Period name<input name="name" required maxLength={100} defaultValue={dialog.item?.name} placeholder="e.g. Festive trip" /></label><div className="form-grid"><label>Start date<input type="date" name="start" required defaultValue={dialog.item?.start} /></label><label>End date<input type="date" name="end" required defaultValue={dialog.item?.end} /></label></div></>}
      {dialog.kind === 'friend' && <><label>Name<input name="name" required maxLength={100} defaultValue={dialog.item?.name} placeholder="Their name" /></label><div className="form-grid"><label>Priority<select name="priority" defaultValue={dialog.item?.priority ?? 'normal'}><option value="must-see">Must-see</option><option value="high">High</option><option value="normal">Normal</option><option value="low">Low</option></select></label><label>Colour<input type="color" name="colour" defaultValue={dialog.item?.colour ?? colours[data.friends.length % colours.length]} /></label></div><label>Location <span>(optional)</span><input name="location" maxLength={150} defaultValue={dialog.item?.location} placeholder="Where are they based?" /></label><label>Last contacted <span>(optional)</span><input name="lastContacted" type="date" defaultValue={dialog.item?.lastContacted} /></label><label>Notes <span>(optional)</span><textarea name="notes" maxLength={2000} defaultValue={dialog.item?.notes} placeholder="Anything you'd like to remember" /></label></>}
      {(dialog.kind === 'availability' || dialog.kind === 'meeting') && <><label>{dialog.kind === 'availability' ? 'Whose availability?' : 'Who are you seeing?'}<select name="friendId" required defaultValue={dialog.item?.friendId ?? (dialog.kind === 'meeting' ? dialog.seed?.friendId ?? '' : 'self')}>{dialog.kind === 'availability' ? <option value="self">You</option> : <option value="">Choose a friend</option>}{data.friends.filter(f => !f.archived || f.id === dialog.item?.friendId).map(f => <option value={f.id} key={f.id}>{f.name}</option>)}</select></label>{!data.friends.length && dialog.kind === 'meeting' && <p className="muted small">Add a friend before creating a plan.</p>}<div className="form-grid"><label>Starts<input name="start" type="datetime-local" required defaultValue={dialog.item?.start ?? (dialog.kind === 'meeting' ? dialog.seed?.start : undefined)} min={`${period?.start}T00:00`} max={`${period?.end}T23:59`} /></label><label>Ends<input name="end" type="datetime-local" required defaultValue={dialog.item?.end ?? (dialog.kind === 'meeting' ? dialog.seed?.end : undefined)} min={`${period?.start}T00:00`} max={`${period?.end}T23:59`} /></label></div></>}
      {dialog.kind === 'availability' && <><div className="form-grid"><label>Source<select name="source" defaultValue={dialog.item?.source ?? 'Other'}><option>WhatsApp</option><option>iMessage</option><option>In person</option><option>Other</option></select></label><label>Confidence<select name="confidence" defaultValue={dialog.item?.confidence ?? 'likely'}><option value="firm">Firm</option><option value="likely">Likely</option><option value="maybe">Maybe</option></select></label></div><label>My block type<select name="kind" defaultValue={dialog.item?.kind ?? 'available'}><option value="available">Available</option><option value="reserved">Reserved</option><option value="busy">Busy</option><option value="unavailable">Unavailable</option></select></label><label>Label<input name="label" defaultValue={dialog.item?.label} placeholder="e.g. Tuesday evening" /></label><label>Location<input name="location" defaultValue={dialog.item?.location} /></label><label>Notes<textarea name="notes" defaultValue={dialog.item?.notes} /></label><label className="checkbox-label"><input type="checkbox" name="expired" defaultChecked={dialog.item?.expired} /> No longer relevant</label></>}
      {dialog.kind === 'meeting' && <><label>Activity<input name="title" defaultValue={dialog.item?.title ?? dialog.seed?.title} placeholder="Coffee, lunch, a walk…" /></label><label>Status<select name="status" defaultValue={dialog.item?.status ?? dialog.seed?.status ?? 'tentative'}><option value="idea">Idea</option><option value="proposed">Proposed</option><option value="awaiting-reply">Awaiting reply</option><option value="tentative">Tentative</option><option value="confirmed">Confirmed</option><option value="cancelled">Cancelled</option></select></label><label>Where? <span>(optional)</span><input name="location" maxLength={150} defaultValue={dialog.item?.location ?? dialog.seed?.location} placeholder="A favourite café, perhaps?" /></label><label>Travel time in minutes<input name="travelTimeMinutes" type="number" min="0" max="1440" defaultValue={dialog.item?.travelTimeMinutes ?? dialog.seed?.travelTimeMinutes ?? 0} /></label><label>Notes <span>(optional)</span><textarea name="notes" maxLength={2000} defaultValue={dialog.item?.notes ?? dialog.seed?.notes} /></label><p className="form-hint">We'll flag overlapping plans, travel buffers, and times outside recorded availability.</p></>}
      {formError && <p className="form-error" role="alert">{formError}</p>}<div className="form-actions"><Button secondary onClick={() => setDialog(null)}>Cancel</Button><Button type="submit">Save {dialog.kind === 'meeting' ? 'plan' : dialog.kind}</Button></div>
    </form></Modal>}
  </div>
}

function itineraryText(meetings: Meeting[], data: PlannerData) {
  return meetings.filter(m => m.status === 'confirmed').sort((a, b) => a.start.localeCompare(b.start)).map(m => `${dateLabel(m.start, 'EEEE, d MMMM yyyy')} · ${timeLabel(m.start)}–${timeLabel(m.end)}\n${data.friends.find(f => f.id === m.friendId)?.name ?? 'Unknown friend'}${m.title ? ` · ${m.title}` : ''}${m.location ? ` · ${m.location}` : ''}${m.travelTimeMinutes ? ` · ${m.travelTimeMinutes} min travel` : ''}${m.notes ? `\n${m.notes}` : ''}`).join('\n\n')
}

function download(content: string, name: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }))
  const link = document.createElement('a')
  link.href = url; link.download = name; link.click()
  globalThis.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function downloadPlannerBackup(data: PlannerData, label: string) {
  const timestamp = format(new Date(), 'yyyy-MM-dd-HHmmss')
  download(JSON.stringify(data, null, 2), `meet-up-planner-${label}-${timestamp}.json`, 'application/json')
}

function SettingsPage({ data, save, buffer, setBuffer, online, onSyncStatus }: { data: PlannerData; save: (data: PlannerData) => Promise<void>; buffer: number; setBuffer: (value: number) => void; online: boolean; onSyncStatus: (status: string) => void }) {
  const [token, setToken] = useState('')
  const clientId = import.meta.env.VITE_GITHUB_APP_CLIENT_ID?.trim() ?? ''
  const appSlug = import.meta.env.VITE_GITHUB_APP_SLUG?.trim() ?? ''
  const workerUrl = import.meta.env.VITE_GITHUB_AUTH_URL?.trim() ?? ''
  const [authenticating, setAuthenticating] = useState(false)
  const authController = useRef<AbortController | null>(null)
  const callbackHandled = useRef(false)
  const [owner, setOwner] = useState(localStorage.getItem('meetup-owner') ?? '')
  const [repo, setRepo] = useState(localStorage.getItem('meetup-repo') ?? 'meet-up-planner-data')
  const [branch, setBranch] = useState(localStorage.getItem('meetup-branch') ?? 'main')
  const [path, setPath] = useState(localStorage.getItem('meetup-path') ?? 'data/meetup-planner.json')
  const [message, setMessage] = useState('')
  const [conflict, setConflict] = useState<{ data: PlannerData; sha: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const syncedData = useRef('')
  const syncing = useRef(false)
  const retryDelay = useRef(5000)
  const signIn = async () => {
    if (!clientId || !workerUrl) { setMessage('GitHub App sign-in is not configured for this deployment.'); return }
    setBusy(true); setAuthenticating(true); setMessage('')
    try {
      const callbackUrl = new URL(import.meta.env.BASE_URL, window.location.origin).href
      window.location.assign(await beginGitHubAuthorization(clientId, callbackUrl))
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'GitHub sign-in failed.')
      setBusy(false); setAuthenticating(false)
    }
  }
  const completeSignIn = async (code: string, verifier: string) => {
    const controller = new AbortController()
    authController.current = controller
    setBusy(true); setAuthenticating(true); setMessage(''); setConflict(null)
    try {
      const accessToken = await exchangeGitHubCode(workerUrl, code, verifier, controller.signal)
      const user = await getAuthenticatedUser(accessToken, controller.signal)
      if (controller.signal.aborted) return
      const repositoryName = repo.trim() || 'meet-up-planner-data'
      const repository = await ensurePrivateRepository(accessToken, user.login, repositoryName)
      const syncTarget = { owner: user.login, repo: repositoryName, branch: repository.branch, path: path.trim() || 'data/meetup-planner.json' }
      const key = shaKey(syncTarget)
      const remote = await readCloud(accessToken, syncTarget)
      let foundConflict = false
      if (!remote) {
        const sha = await writeCloud(accessToken, syncTarget, data)
        localStorage.setItem(key, sha)
        syncedData.current = JSON.stringify(data)
        setMessage(repository.created ? 'Private repository created and your planner initialized.' : 'Your private repository is ready and the planner file was initialized.')
      } else {
        const knownSha = localStorage.getItem(key)
        const localEmpty = !data.friends.length && !data.periods.length && !data.availability.length && !data.meetings.length
        const remoteEmpty = !remote.data.friends.length && !remote.data.periods.length && !remote.data.availability.length && !remote.data.meetings.length
        if (knownSha && knownSha !== remote.sha) {
          setConflict(remote)
          foundConflict = true
          setMessage('The cloud copy changed since your last sync. Choose which version to keep.')
          onSyncStatus('Sync conflict · Choose which planner version to keep in Settings.')
        } else if (localEmpty && !remoteEmpty) {
          await save(remote.data)
          if (usePlanner.getState().error) throw new Error('The cloud copy could not be saved locally.')
          localStorage.setItem(key, remote.sha)
          syncedData.current = JSON.stringify(remote.data)
          setMessage('Your existing planner was loaded from GitHub.')
        } else if (!knownSha && JSON.stringify(data) !== JSON.stringify(remote.data)) {
          setConflict(remote)
          foundConflict = true
          setMessage('A planner already exists in this repository. Choose which version to keep.')
          onSyncStatus('Sync conflict · Choose which planner version to keep in Settings.')
        } else {
          localStorage.setItem(key, remote.sha)
          syncedData.current = JSON.stringify(remote.data)
          setMessage('Signed in and your planner is up to date.')
        }
      }
      setToken(accessToken)
      setOwner(user.login)
      setRepo(repositoryName)
      setBranch(repository.branch)
      localStorage.setItem('meetup-owner', user.login)
      localStorage.setItem('meetup-repo', repositoryName)
      localStorage.setItem('meetup-branch', repository.branch)
      localStorage.setItem('meetup-path', syncTarget.path)
      if (!foundConflict) onSyncStatus(navigator.onLine ? 'Synced with GitHub' : 'Offline · Changes are saved locally and queued to sync.')
    } catch (e) {
      setMessage(e instanceof Error && e.name === 'AbortError' ? 'GitHub sign-in cancelled.' : e instanceof Error ? e.message : 'GitHub sign-in failed.')
    } finally {
      if (authController.current === controller) authController.current = null
      setBusy(false); setAuthenticating(false)
    }
  }
  const signOut = () => {
    authController.current?.abort()
    authController.current = null
    setToken(''); setConflict(null); setAuthenticating(false); setMessage('Signed out of GitHub.')
    onSyncStatus('GitHub sync is paused. Your planner remains saved on this device.')
  }
  const target = useCallback(() => ({ owner: owner.trim(), repo: repo.trim(), branch: branch.trim(), path: path.trim() }), [owner, repo, branch, path])
  const shaKey = useCallback((remote = target()) => `meetup-sha:${remote.owner.toLowerCase()}/${remote.repo.toLowerCase()}/${remote.branch}/${remote.path}`, [target])
  useEffect(() => {
    if (callbackHandled.current) return
    callbackHandled.current = true
    try {
      const callback = takeGitHubCallback(new URL(window.location.href))
      if (callback) void completeSignIn(callback.code, callback.verifier)
    } catch (e) { setMessage(e instanceof Error ? e.message : 'GitHub sign-in failed.') }
  })
  const rememberTarget = useCallback(() => {
    localStorage.setItem('meetup-owner', owner.trim()); localStorage.setItem('meetup-repo', repo.trim()); localStorage.setItem('meetup-branch', branch.trim()); localStorage.setItem('meetup-path', path.trim())
  }, [owner, repo, branch, path])
  const showLatestConflict = useCallback(async (syncTarget: ReturnType<typeof target>) => {
    const remote = await readCloud(token, syncTarget)
    if (!remote) throw new Error('The cloud copy could not be found. It may have been deleted.')
    setConflict(remote)
    setMessage('The cloud copy changed since your last sync. Choose which version to keep.')
  }, [token])
  const sync = async (direction: 'pull' | 'push') => {
    if (!token || !owner || !repo) { setMessage('Connect the GitHub App before syncing.'); return }
    if (direction === 'pull' && !window.confirm('Replace all local planner data with the cloud copy? A dated backup will be downloaded first.')) return
    if (direction === 'pull') downloadPlannerBackup(data, 'before-pull')
    setBusy(true); setMessage('')
    setConflict(null)
    const syncTarget = target(), key = shaKey(syncTarget)
    try {
      if (direction === 'pull') {
        const remote = await readCloud(token, syncTarget)
        if (!remote) throw new Error('No cloud copy found. Push from the device with your data first.')
        const knownSha = localStorage.getItem(key)
        if (knownSha && remote.sha !== knownSha) {
          setConflict(remote)
          onSyncStatus('Sync conflict · Choose which planner version to keep in Settings.')
          setMessage('The cloud copy changed since your last sync. Choose which version to keep.')
          return
        }
        await save(remote.data)
        if (usePlanner.getState().error) throw new Error('The cloud copy could not be saved locally.')
        localStorage.setItem(key, remote.sha)
        syncedData.current = JSON.stringify(remote.data)
        onSyncStatus('Synced with GitHub')
        setMessage('Cloud copy downloaded to this device.')
      } else {
        const sha = await writeCloud(token, syncTarget, data, localStorage.getItem(key) ?? undefined)
        localStorage.setItem(key, sha)
        syncedData.current = JSON.stringify(data)
        onSyncStatus('Synced with GitHub')
        setMessage('Your planner was saved to GitHub.')
      }
      rememberTarget()
    } catch (e) {
      if (e instanceof GitHubAuthError) {
        setToken('')
        setMessage(e.message)
        onSyncStatus('GitHub session expired · Connect GitHub again to resume syncing.')
      } else if (direction === 'push' && e instanceof CloudConflictError) {
        try {
          await showLatestConflict(syncTarget)
          onSyncStatus('Sync conflict · Choose which planner version to keep in Settings.')
        }
        catch (readError) { setMessage(readError instanceof Error ? readError.message : 'Could not load the latest cloud copy.') }
      } else {
        setMessage(e instanceof Error ? e.message : 'Sync failed. Please try again.')
        onSyncStatus(e instanceof GitHubPermissionError ? 'GitHub permission issue · Check the app installation and permissions.' : 'Sync failed · Your changes remain saved locally.')
      }
    }
    finally { setBusy(false) }
  }
  const resolveConflict = async (choice: 'cloud' | 'local') => {
    if (!conflict || !token) return
    if (choice === 'local' && !window.confirm('Replace the newer cloud copy with the data on this device?')) return
    setBusy(true); setMessage('')
    const syncTarget = target(), key = shaKey(syncTarget)
    try {
      if (choice === 'cloud') {
        downloadPlannerBackup(data, 'before-cloud-pull')
        await save(conflict.data)
        if (usePlanner.getState().error) throw new Error('The cloud copy could not be saved locally.')
        localStorage.setItem(key, conflict.sha)
        syncedData.current = JSON.stringify(conflict.data)
        setMessage('The latest cloud copy is now saved on this device.')
        onSyncStatus('Synced with GitHub')
      } else {
        downloadPlannerBackup(conflict.data, 'before-cloud-overwrite')
        const sha = await writeCloud(token, syncTarget, data, conflict.sha)
        localStorage.setItem(key, sha)
        syncedData.current = JSON.stringify(data)
        setMessage('Your device copy replaced the cloud copy.')
        onSyncStatus('Synced with GitHub')
      }
      rememberTarget()
      setConflict(null)
    } catch (e) {
      if (e instanceof GitHubAuthError) {
        setToken('')
        setMessage(e.message)
        onSyncStatus('GitHub session expired · Connect GitHub again to resume syncing.')
      } else if (e instanceof CloudConflictError) {
        try {
          await showLatestConflict(syncTarget)
          onSyncStatus('Sync conflict · Choose which planner version to keep in Settings.')
        }
        catch (readError) { setMessage(readError instanceof Error ? readError.message : 'Could not load the latest cloud copy.') }
      } else {
        setMessage(e instanceof Error ? e.message : 'Could not resolve the sync conflict.')
        if (e instanceof GitHubPermissionError) onSyncStatus('GitHub permission issue · Check the app installation and permissions.')
      }
    } finally { setBusy(false) }
  }
  useEffect(() => {
    if (!token || !owner || !repo) return
    if (conflict) {
      onSyncStatus('Sync conflict · Choose which planner version to keep in Settings.')
      return
    }
    const snapshot = JSON.stringify(data)
    if (snapshot === syncedData.current) return
    if (!online) {
      onSyncStatus('Offline · Changes are saved locally and queued to sync.')
      return
    }

    let timer: number
    const syncTarget = target(), key = shaKey(syncTarget)
    const attemptSync = async () => {
      if (syncing.current) {
        timer = window.setTimeout(() => void attemptSync(), 1000)
        return
      }
      syncing.current = true
      setBusy(true)
      onSyncStatus('Syncing changes to GitHub…')
      try {
        const sha = await writeCloud(token, syncTarget, data, localStorage.getItem(key) ?? undefined)
        localStorage.setItem(key, sha)
        syncedData.current = snapshot
        retryDelay.current = 5000
        rememberTarget()
        onSyncStatus('Synced with GitHub')
      } catch (e) {
        if (e instanceof GitHubAuthError) {
          setToken('')
          setMessage(e.message)
          onSyncStatus('GitHub session expired · Connect GitHub again to resume syncing.')
        } else if (e instanceof GitHubPermissionError) {
          setMessage(e.message)
          onSyncStatus('GitHub permission issue · Check the app installation and permissions.')
        } else if (e instanceof CloudConflictError) {
          try {
            await showLatestConflict(syncTarget)
            onSyncStatus('Sync conflict · Choose which planner version to keep in Settings.')
          } catch (readError) {
            const delay = retryDelay.current
            retryDelay.current = Math.min(delay * 2, 60000)
            onSyncStatus(`Sync failed · Retrying in ${Math.round(delay / 1000)} seconds. Your changes remain saved locally.`)
            timer = window.setTimeout(() => void attemptSync(), delay)
            setMessage(readError instanceof Error ? readError.message : 'Could not load the latest cloud copy.')
          }
        } else {
          const delay = retryDelay.current
          retryDelay.current = Math.min(delay * 2, 60000)
          onSyncStatus(`Sync failed · Retrying in ${Math.round(delay / 1000)} seconds. Your changes remain saved locally.`)
          timer = window.setTimeout(() => void attemptSync(), delay)
        }
      } finally {
        syncing.current = false
        setBusy(false)
      }
    }
    onSyncStatus('Saved locally · Syncing shortly…')
    timer = window.setTimeout(() => void attemptSync(), 2000)
    return () => window.clearTimeout(timer)
  }, [data, token, owner, repo, branch, path, online, conflict, target, shaKey, showLatestConflict, rememberTarget, onSyncStatus])
  return <><div className="page-heading"><div><div className="eyebrow">YOUR SPACE, YOUR WAY</div><h1>Make it <em>yours.</em></h1><p>Your planner lives on this device, with optional cloud sync.</p></div></div>
    <section className="settings-card"><div className="settings-icon"><Cloud size={22} /></div><h2>GitHub sync</h2><p>Install the GitHub App, then sign in to connect a private data repository. Choose all repositories to allow automatic creation, or create a private repository first and select only that repository. The access token stays in memory and is cleared when you reload or sign out.</p>
      <div className="form">
        {(!clientId || !workerUrl) && <p className="form-error" role="alert">GitHub sign-in is not configured for this deployment. The site owner must configure the GitHub App and authentication service.</p>}
        {appSlug ? <a className="button secondary" href={`https://github.com/apps/${encodeURIComponent(appSlug)}/installations/new`} target="_blank" rel="noreferrer">Install GitHub App</a> : <p className="form-hint">Before connecting, install the GitHub App from its GitHub page and grant it access to the private planner repository.</p>}
        {!token ? <div className="sync-actions"><button className="button" disabled={busy || !clientId || !workerUrl} onClick={() => void signIn()}>{authenticating ? 'Connecting to GitHub…' : 'Connect GitHub'}</button>{authenticating && <button className="button secondary" onClick={signOut}>Cancel sign in</button>}</div> : <div className="sync-actions"><p className="signed-in">Signed in as <strong>@{owner}</strong></p><button className="button secondary" onClick={() => void sync('push')} disabled={busy || !online || Boolean(conflict)}>Sync now</button><button className="button secondary" onClick={signOut}>Sign out</button></div>}
        <label>Private data repository<input value={repo} disabled={Boolean(token)} onChange={e => { setRepo(e.target.value); localStorage.setItem('meetup-repo', e.target.value) }} placeholder="meet-up-planner-data" /></label>
        <details className="advanced-sync"><summary>Advanced repository settings</summary><div className="form"><label>Branch<input value={branch} disabled={Boolean(token)} onChange={e => { setBranch(e.target.value); localStorage.setItem('meetup-branch', e.target.value) }} /></label><label>Planner file path<input value={path} disabled={Boolean(token)} onChange={e => { setPath(e.target.value); localStorage.setItem('meetup-path', e.target.value) }} /></label></div></details>
        {token && <div className="sync-actions"><button className="button" disabled={busy || !online || Boolean(conflict)} onClick={() => void sync('push')}><ArrowUpFromLine size={16} /> Push now</button><button className="button secondary" disabled={busy || !online || Boolean(conflict)} onClick={() => void sync('pull')}><ArrowDownToLine size={16} /> Pull from GitHub</button></div>}
        {conflict && <div className="sync-conflict" role="region" aria-labelledby="sync-conflict-title"><h3 id="sync-conflict-title">Two versions of your planner</h3><p>This cloud copy was updated elsewhere. Choose one version to keep; records are not automatically merged.</p><div className="conflict-summary"><div><strong>This device</strong><span>{data.friends.length} friends · {data.periods.length} periods · {data.meetings.length} plans</span></div><div><strong>GitHub</strong><span>{conflict.data.friends.length} friends · {conflict.data.periods.length} periods · {conflict.data.meetings.length} plans</span></div></div><div className="sync-actions"><button className="button secondary" disabled={busy || !token} onClick={() => void resolveConflict('cloud')}>Use cloud copy</button><button className="button" disabled={busy || !token} onClick={() => void resolveConflict('local')}>Keep this device and overwrite cloud</button></div></div>}
        {message && <p role="status" className="sync-message">{message}</p>}<p className="form-hint">Changes save locally immediately, then sync automatically after a short pause. Offline changes stay queued on this device and sync after reconnecting. Conflicts never overwrite data silently; replacing either copy downloads a dated backup first.</p>
      </div>
    </section>
    <section className="settings-card"><h2>Planning preferences</h2><div className="form"><label>Buffer between plans (minutes)<input type="number" min="0" max="1440" value={buffer} onChange={e => { const n = Math.max(0, Math.min(1440, Number(e.target.value))); setBuffer(n); localStorage.setItem('meetup-buffer', String(n)) }} /></label></div></section>
    <section className="settings-card"><h2>Backups</h2><p>Export a copy before importing or clearing data. Import replaces everything on this device.</p><div className="sync-actions"><Button secondary onClick={() => download(JSON.stringify(data, null, 2), 'meet-up-planner.json', 'application/json')}>Export JSON</Button><Button secondary onClick={() => download(itineraryText(data.meetings, data), 'meet-up-itinerary.txt', 'text/plain')}>Export confirmed itinerary</Button><label className="button secondary file-button">Import JSON<input type="file" accept=".json,application/json" onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; if (!file) return; void file.text().then(text => { const parsed: unknown = JSON.parse(text); if (!isPlannerData(parsed)) throw new Error('Invalid planner backup.'); if (window.confirm('Replace all local planner data with this backup?')) void save(parsed) }).catch(() => window.alert('This file is not a valid Meet-up Planner backup.')) }} /></label></div></section>
    <section className="settings-card"><h2>Local data</h2><p>Planner data is stored in this browser's IndexedDB. Clearing browser data will remove it.</p><Button secondary onClick={() => { if (window.confirm('Delete all local Meet-up Planner data? This cannot be undone.')) void save(emptyData()) }}>Clear local data</Button></section>
  </>
}

export default App
