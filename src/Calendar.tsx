import { useState } from 'react'
import { addDays, addMinutes, differenceInMinutes, format, parseISO, startOfWeek } from 'date-fns'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { inPeriod, meetingFriendIds, meetingWarnings, type Availability, type Friend, type Meeting, type Period, type PlannerData } from './model'

interface Props {
  period: Period
  friends: Friend[]
  blocks: Availability[]
  meetings: Meeting[]
  data: PlannerData
  buffer: number
  onCreate: (start: string) => void
  onEditMeeting: (meeting: Meeting) => void
  onEditBlock: (block: Availability) => void
  onMove: (meeting: Meeting) => void
}

export default function Calendar({ period, friends, blocks, meetings, data, buffer, onCreate, onEditMeeting, onEditBlock, onMove }: Props) {
  const [week, setWeek] = useState(() => startOfWeek(period.start ? parseISO(period.start) : new Date(), { weekStartsOn: 1 }))
  const days = Array.from({ length: 7 }, (_, i) => addDays(week, i))
  const hours = Array.from({ length: 24 }, (_, i) => i)
  const [dragged, setDragged] = useState<Meeting | null>(null)
  const move = (date: string, hour: number) => {
    if (!dragged) return
    const start = `${date}T${String(hour).padStart(2, '0')}:00`
    const end = format(addMinutes(parseISO(start), differenceInMinutes(parseISO(dragged.end), parseISO(dragged.start))), "yyyy-MM-dd'T'HH:mm")
    if (inPeriod(period, start, end)) onMove({ ...dragged, start, end })
    else window.alert('Move the plan within the planning period.')
    setDragged(null)
  }
  return <section className="calendar"><div className="calendar-toolbar"><div><button className="icon-button" aria-label="Previous week" onClick={() => setWeek(addDays(week, -7))}><ChevronLeft /></button><strong>{format(days[0], 'd MMM')} – {format(days[6], 'd MMM yyyy')}</strong><button className="icon-button" aria-label="Next week" onClick={() => setWeek(addDays(week, 7))}><ChevronRight /></button><button className="text-button" onClick={() => setWeek(startOfWeek(new Date(), { weekStartsOn: 1 }))}>Today</button></div><span>Tap a slot to plan · drag a plan to move it</span></div><div className="calendar-scroll"><div className="calendar-grid"><div className="calendar-header" /><div className="calendar-days">{days.map(day => <div key={day.toISOString()}><span>{format(day, 'EEE')}</span><strong>{format(day, 'd')}</strong></div>)}</div>{hours.map(hour => <div className="calendar-row" key={hour}><div className="calendar-hour">{`${String(hour).padStart(2, '0')}:00`}</div>{days.map(day => {
    const date = format(day, 'yyyy-MM-dd'), prefix = `${date}T${String(hour).padStart(2, '0')}:`
    const allowed = inPeriod(period, date, date)
    return <div key={date} className={`calendar-cell ${!allowed ? 'outside' : ''}`} onDragOver={e => { if (allowed) e.preventDefault() }} onDrop={e => { e.preventDefault(); move(date, hour) }}><button className="slot-button" aria-label={`Create plan ${date} at ${hour}:00`} disabled={!allowed} onClick={() => onCreate(`${date}T${String(hour).padStart(2, '0')}:00`)} />{blocks.filter(b => b.start.startsWith(prefix) && !b.expired).map(b => <button key={b.id} className="calendar-event block-event" style={{ borderColor: b.friendId ? friends.find(f => f.id === b.friendId)?.colour : '#aaa59e' }} onClick={() => onEditBlock(b)}>{b.friendId ? friends.find(f => f.id === b.friendId)?.name : 'You'} · {b.kind ?? b.confidence ?? 'available'}<small>{b.start.slice(11)}–{b.end.slice(11)}</small></button>)}{meetings.filter(m => m.start.startsWith(prefix) && m.status !== 'cancelled').map(m => {
      const warnings = meetingWarnings(m, data, buffer)
      return <button key={m.id} draggable className="calendar-event" title={warnings.join(' · ')} style={{ borderColor: friends.find(f => f.id === m.friendId)?.colour }} onDragStart={() => setDragged(m)} onDragEnd={() => setDragged(null)} onClick={() => onEditMeeting(m)}>{meetingFriendIds(m).map(id => friends.find(f => f.id === id)?.name ?? 'Unknown friend').join(', ')} · {m.status}{warnings.length > 0 && ' · Warning'}<small>{m.start.slice(11)}–{m.end.slice(11)}</small></button>
    })}</div>
  })}</div>)}</div></div></section>
}
