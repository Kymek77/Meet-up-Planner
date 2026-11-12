import { useState } from 'react'
import { addDays, addMinutes, differenceInMinutes, format, parseISO, startOfWeek } from 'date-fns'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import type { Availability, Friend, Meeting, Period } from './model'

interface Props {
  period: Period
  friends: Friend[]
  blocks: Availability[]
  meetings: Meeting[]
  onCreate: (start: string) => void
  onEditMeeting: (meeting: Meeting) => void
  onEditBlock: (block: Availability) => void
  onMove: (meeting: Meeting) => void
}

export default function Calendar({ period, friends, blocks, meetings, onCreate, onEditMeeting, onEditBlock, onMove }: Props) {
  const [week, setWeek] = useState(() => startOfWeek(parseISO(period.start), { weekStartsOn: 1 }))
  const days = Array.from({ length: 7 }, (_, i) => addDays(week, i))
  const hours = Array.from({ length: 24 }, (_, i) => i)
  const [dragged, setDragged] = useState<Meeting | null>(null)
  const move = (date: string, hour: number) => {
    if (!dragged) return
    const start = `${date}T${String(hour).padStart(2, '0')}:00`
    const end = format(addMinutes(parseISO(start), differenceInMinutes(parseISO(dragged.end), parseISO(dragged.start))), "yyyy-MM-dd'T'HH:mm")
    if (date >= period.start && end.slice(0, 10) <= period.end) onMove({ ...dragged, start, end })
    else window.alert('Move the plan within the planning period.')
    setDragged(null)
  }
  return <section className="calendar"><div className="calendar-toolbar"><div><button className="icon-button" aria-label="Previous week" onClick={() => setWeek(addDays(week, -7))}><ChevronLeft /></button><strong>{format(days[0], 'd MMM')} – {format(days[6], 'd MMM yyyy')}</strong><button className="icon-button" aria-label="Next week" onClick={() => setWeek(addDays(week, 7))}><ChevronRight /></button></div><span>Tap a slot to plan · drag a plan to move it</span></div><div className="calendar-scroll"><div className="calendar-grid"><div className="calendar-header" /><div className="calendar-days">{days.map(day => <div key={day.toISOString()}><span>{format(day, 'EEE')}</span><strong>{format(day, 'd')}</strong></div>)}</div>{hours.map(hour => <div className="calendar-row" key={hour}><div className="calendar-hour">{`${String(hour).padStart(2, '0')}:00`}</div>{days.map(day => {
    const date = format(day, 'yyyy-MM-dd'), prefix = `${date}T${String(hour).padStart(2, '0')}:`
    const inPeriod = date >= period.start && date <= period.end
    return <div key={date} className={`calendar-cell ${!inPeriod ? 'outside' : ''}`} onDragOver={e => { if (inPeriod) e.preventDefault() }} onDrop={e => { e.preventDefault(); move(date, hour) }}><button className="slot-button" aria-label={`Create plan ${date} at ${hour}:00`} disabled={!inPeriod} onClick={() => onCreate(`${date}T${String(hour).padStart(2, '0')}:00`)} />{blocks.filter(b => b.start.startsWith(prefix) && !b.expired).map(b => <button key={b.id} className="calendar-event block-event" style={{ borderColor: b.friendId ? friends.find(f => f.id === b.friendId)?.colour : '#aaa59e' }} onClick={() => onEditBlock(b)}>{b.friendId ? friends.find(f => f.id === b.friendId)?.name : 'You'} · {b.kind ?? b.confidence ?? 'available'}<small>{b.start.slice(11)}–{b.end.slice(11)}</small></button>)}{meetings.filter(m => m.start.startsWith(prefix) && m.status !== 'cancelled').map(m => <button key={m.id} draggable className="calendar-event" style={{ borderColor: friends.find(f => f.id === m.friendId)?.colour }} onDragStart={() => setDragged(m)} onDragEnd={() => setDragged(null)} onClick={() => onEditMeeting(m)}>{friends.find(f => f.id === m.friendId)?.name} · {m.status}<small>{m.start.slice(11)}–{m.end.slice(11)}</small></button>)}</div>
  })}</div>)}</div></div></section>
}
