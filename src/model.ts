import { areIntervalsOverlapping, differenceInCalendarDays, differenceInMinutes, format, isValid, parseISO } from 'date-fns'
import { z } from 'zod'

export type Priority = 'must-see' | 'high' | 'normal' | 'low'
export interface Friend {
  id: string
  name: string
  colour: string
  priority: Priority
  location?: string
  notes?: string
  createdAt: string
  updatedAt: string
  archived?: boolean
  lastContacted?: string
}
export interface Period { id: string; name: string; start: string; end: string }
export interface Availability { id: string; periodId: string; friendId: string | null; start: string; end: string; source?: 'WhatsApp' | 'iMessage' | 'In person' | 'Other'; confidence?: 'firm' | 'likely' | 'maybe'; notes?: string; label?: string; location?: string; kind?: 'available' | 'reserved' | 'busy' | 'unavailable'; expired?: boolean }
export interface Meeting {
  id: string
  periodId: string
  friendId: string
  start: string
  end: string
  location: string
  notes: string
  status: 'idea' | 'proposed' | 'awaiting-reply' | 'tentative' | 'confirmed' | 'cancelled'
  title?: string
  travelTimeMinutes?: number
}
export interface PlannerData {
  version: 1
  friends: Friend[]
  periods: Period[]
  availability: Availability[]
  meetings: Meeting[]
}
export const emptyData = (): PlannerData => ({ version: 1, friends: [], periods: [], availability: [], meetings: [] })

export function getDashboardHighlights(meetings: Meeting[], friends: Friend[], now = new Date()) {
  const today = format(now, 'yyyy-MM-dd')
  const validMeetings = meetings.flatMap(meeting => {
    const start = parseISO(meeting.start)
    return isValid(start) ? [{ meeting, start }] : []
  })
  const staleContacts = friends.flatMap(friend => {
    if (friend.archived || !friend.lastContacted) return []
    const lastContacted = parseISO(friend.lastContacted)
    if (!isValid(lastContacted)) return []
    const daysSinceContact = differenceInCalendarDays(now, lastContacted)
    return daysSinceContact >= 30 ? [{ friend, daysSinceContact }] : []
  }).sort((a, b) => b.daysSinceContact - a.daysSinceContact)

  return {
    today: validMeetings.filter(({ meeting, start }) => format(start, 'yyyy-MM-dd') === today && meeting.status !== 'cancelled')
      .sort((a, b) => a.start.getTime() - b.start.getTime()).map(({ meeting }) => meeting),
    nextConfirmed: validMeetings.filter(({ meeting, start }) => meeting.status === 'confirmed' && start >= now)
      .sort((a, b) => a.start.getTime() - b.start.getTime())[0]?.meeting ?? null,
    staleContacts,
  }
}

export function validRange(start: string, end: string) {
  const a = parseISO(start), b = parseISO(end)
  return isValid(a) && isValid(b) && a < b
}

export function mergeRanges(ranges: { start: string; end: string }[]) {
  const merged: { start: string; end: string }[] = []
  for (const range of ranges.filter(r => validRange(r.start, r.end)).sort((a, b) => a.start.localeCompare(b.start))) {
    const last = merged[merged.length - 1]
    if (last && range.start <= last.end) last.end = range.end > last.end ? range.end : last.end
    else merged.push({ start: range.start, end: range.end })
  }
  return merged
}

export function meetingWarnings(meeting: Meeting, data: PlannerData, bufferMinutes = 30): string[] {
  const warnings: string[] = []
  if (!validRange(meeting.start, meeting.end)) return ['Invalid time range']
  if (meeting.status === 'cancelled') return warnings
  const period = data.periods.find(p => p.id === meeting.periodId)
  if (!period || meeting.start.slice(0, 10) < period.start || meeting.end.slice(0, 10) > period.end) warnings.push('Outside planning period')
  const interval = { start: parseISO(meeting.start), end: parseISO(meeting.end) }
  const otherMeetings = data.meetings.filter(m => m.id !== meeting.id && m.periodId === meeting.periodId && m.status !== 'cancelled' && validRange(m.start, m.end))
  if (otherMeetings.some(m => areIntervalsOverlapping(interval, { start: parseISO(m.start), end: parseISO(m.end) }))) warnings.push('Overlaps another plan')
  if (otherMeetings.some(m => {
    const gap = m.end <= meeting.start ? differenceInMinutes(parseISO(meeting.start), parseISO(m.end)) : meeting.end <= m.start ? differenceInMinutes(parseISO(m.start), parseISO(meeting.end)) : -1
    return gap >= 0 && gap < Math.max(bufferMinutes, meeting.travelTimeMinutes ?? 0, m.travelTimeMinutes ?? 0)
  })) warnings.push(`Less than ${bufferMinutes} min buffer or travel time`)
  if (data.availability.some(a => a.periodId === meeting.periodId && a.friendId === null && a.kind && a.kind !== 'available' && !a.expired && validRange(a.start, a.end) && areIntervalsOverlapping(interval, { start: parseISO(a.start), end: parseISO(a.end) }))) warnings.push('Overlaps a busy or unavailable block')
  for (const [friendId, label] of [[null, 'your availability'], [meeting.friendId, 'friend’s availability']] as const) {
    const blocks = data.availability.filter(a => a.periodId === meeting.periodId && a.friendId === friendId && !a.expired && (!a.kind || a.kind === 'available'))
    if (blocks.length && !mergeRanges(blocks).some(a => a.start <= meeting.start && a.end >= meeting.end)) warnings.push(`Outside ${label}`)
  }
  return warnings
}

export function freeGaps(blocks: Availability[], meetings: Meeting[]): { start: string; end: string }[] {
  const gaps: { start: string; end: string }[] = []
  const periods = [...new Set(blocks.map(b => b.periodId))]
  for (const periodId of periods) for (const block of mergeRanges(blocks.filter(b => b.periodId === periodId && b.friendId === null && (!b.kind || b.kind === 'available') && !b.expired))) {
    let remaining = [{ start: block.start, end: block.end }]
    const occupied = [...meetings.filter(m => m.periodId === periodId && m.status !== 'cancelled'), ...blocks.filter(b => b.periodId === periodId && b.friendId === null && b.kind && b.kind !== 'available' && !b.expired)]
    for (const meeting of occupied.filter(m => validRange(m.start, m.end))) {
      remaining = remaining.flatMap(gap => {
        if (meeting.end <= gap.start || meeting.start >= gap.end) return [gap]
        const parts = []
        if (meeting.start > gap.start) parts.push({ start: gap.start, end: meeting.start })
        if (meeting.end < gap.end) parts.push({ start: meeting.end, end: gap.end })
        return parts
      })
    }
    gaps.push(...remaining)
  }
  return gaps.sort((a, b) => a.start.localeCompare(b.start))
}

const range = <T extends { start: string; end: string }>(v: T) => validRange(v.start, v.end)
const friendSchema = z.object({ id: z.string(), name: z.string(), colour: z.string(), priority: z.enum(['must-see', 'high', 'normal', 'low']), location: z.string().optional(), notes: z.string().optional(), createdAt: z.string(), updatedAt: z.string(), archived: z.boolean().optional(), lastContacted: z.string().optional() })
const periodSchema = z.object({ id: z.string(), name: z.string(), start: z.iso.date(), end: z.iso.date() }).refine(p => p.start <= p.end)
const availabilitySchema = z.object({ id: z.string(), periodId: z.string(), friendId: z.string().nullable(), start: z.string(), end: z.string(), source: z.enum(['WhatsApp', 'iMessage', 'In person', 'Other']).optional(), confidence: z.enum(['firm', 'likely', 'maybe']).optional(), notes: z.string().optional(), label: z.string().optional(), location: z.string().optional(), kind: z.enum(['available', 'reserved', 'busy', 'unavailable']).optional(), expired: z.boolean().optional() }).refine(range)
const meetingSchema = z.object({ id: z.string(), periodId: z.string(), friendId: z.string(), start: z.string(), end: z.string(), location: z.string(), notes: z.string(), status: z.enum(['idea', 'proposed', 'awaiting-reply', 'tentative', 'confirmed', 'cancelled']), title: z.string().optional(), travelTimeMinutes: z.number().nonnegative().optional() }).refine(range)
export const plannerSchema = z.object({ version: z.literal(1), friends: z.array(friendSchema), periods: z.array(periodSchema), availability: z.array(availabilitySchema), meetings: z.array(meetingSchema) }).refine(d => {
  const periods = new Set(d.periods.map(p => p.id)), friends = new Set(d.friends.map(f => f.id))
  return d.availability.every(a => periods.has(a.periodId) && (a.friendId === null || friends.has(a.friendId))) && d.meetings.every(m => periods.has(m.periodId) && friends.has(m.friendId))
})
export function isPlannerData(value: unknown): value is PlannerData { return plannerSchema.safeParse(value).success }
