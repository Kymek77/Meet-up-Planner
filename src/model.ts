import { addDays, areIntervalsOverlapping, differenceInCalendarDays, differenceInMinutes, format, isValid, parseISO } from 'date-fns'
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
export interface Period { id: string; name: string; start?: string; end?: string; location?: string }
export interface Availability { id: string; periodId: string; friendId: string | null; start: string; end: string; source?: 'WhatsApp' | 'iMessage' | 'In person' | 'Other'; confidence?: 'firm' | 'likely' | 'maybe'; notes?: string; label?: string; location?: string; kind?: 'available' | 'reserved' | 'busy' | 'unavailable'; expired?: boolean }
export interface Meeting {
  id: string
  periodId: string
  friendId: string
  friendIds?: string[]
  start: string
  end: string
  location: string
  notes: string
  status: 'idea' | 'proposed' | 'awaiting-reply' | 'tentative' | 'confirmed' | 'cancelled'
  title?: string
  travelTimeMinutes?: number
}
export interface PlannerData {
  version: 1 | 2
  friends: Friend[]
  periods: Period[]
  availability: Availability[]
  meetings: Meeting[]
}
export const emptyData = (): PlannerData => ({ version: 1, friends: [], periods: [], availability: [], meetings: [] })
export const meetingFriendIds = (meeting: Meeting) => meeting.friendIds ?? [meeting.friendId]
export const inPeriod = (period: Period, start: string, end: string) =>
  (!period.start || start.slice(0, 10) >= period.start) && (!period.end || end.slice(0, 10) <= period.end)
export const periodsOverlap = (a: Period, b: Period) =>
  (!a.end || !b.start || a.end >= b.start) && (!b.end || !a.start || b.end >= a.start)

export function matchesPeriodLocation(friend: Friend, period: Period, includeUnknown = false) {
  const location = friend.location?.trim().toLocaleLowerCase()
  const target = period.location?.trim().toLocaleLowerCase()
  return !target || (location ? location.includes(target) : includeUnknown)
}

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
  if (!period || !inPeriod(period, meeting.start, meeting.end)) warnings.push('Outside planning period')
  const interval = { start: parseISO(meeting.start), end: parseISO(meeting.end) }
  const otherMeetings = data.meetings.filter(m => m.id !== meeting.id && m.status !== 'cancelled' && validRange(m.start, m.end))
  for (const overlap of otherMeetings.filter(m => areIntervalsOverlapping(interval, { start: parseISO(m.start), end: parseISO(m.end) }))) {
    const names = meetingFriendIds(overlap).map(id => data.friends.find(f => f.id === id)?.name ?? 'Unknown friend').join(', ')
    const where = data.periods.find(p => p.id === overlap.periodId)?.name ?? 'another period'
    warnings.push(`Overlaps ${names} (${overlap.start.slice(0, 10)} ${overlap.start.slice(11)}–${overlap.end.slice(11)}, ${where})`)
  }
  if (otherMeetings.some(m => {
    const gap = m.end <= meeting.start ? differenceInMinutes(parseISO(meeting.start), parseISO(m.end)) : meeting.end <= m.start ? differenceInMinutes(parseISO(m.start), parseISO(meeting.end)) : -1
    return gap >= 0 && gap < Math.max(bufferMinutes, meeting.travelTimeMinutes ?? 0, m.travelTimeMinutes ?? 0)
  })) warnings.push(`Less than ${bufferMinutes} min buffer or travel time`)
  const busyBlocks = data.availability.filter(a => a.friendId === null && a.kind && a.kind !== 'available' && !a.expired && validRange(a.start, a.end) && areIntervalsOverlapping(interval, { start: parseISO(a.start), end: parseISO(a.end) }))
  for (const busy of busyBlocks) warnings.push(`Overlaps ${busy.label || busy.kind || 'a busy block'} (${busy.start.slice(0, 10)} ${busy.start.slice(11)}–${busy.end.slice(11)}, ${data.periods.find(p => p.id === busy.periodId)?.name ?? 'another period'})`)
  const participants: [string | null, string][] = [[null, 'your availability'], ...meetingFriendIds(meeting).map((id): [string, string] => [id, meetingFriendIds(meeting).length === 1 ? 'friend’s availability' : `${data.friends.find(f => f.id === id)?.name ?? 'friend'}’s availability`])]
  for (const [friendId, label] of participants) {
    const blocks = data.availability.filter(a => {
      const owner = data.periods.find(p => p.id === a.periodId)
      return period && owner && periodsOverlap(period, owner) &&
        (!period.start || a.end.slice(0, 10) >= period.start) && (!period.end || a.start.slice(0, 10) <= period.end) &&
        a.friendId === friendId && !a.expired && (!a.kind || a.kind === 'available')
    })
    if (blocks.length && !mergeRanges(blocks).some(a => a.start <= meeting.start && a.end >= meeting.end)) warnings.push(`Outside ${label}`)
  }
  return warnings
}

export function freeGaps(blocks: Availability[], meetings: Meeting[], selectedPeriod?: Period): { start: string; end: string }[] {
  const gaps: { start: string; end: string }[] = []
  const periods = selectedPeriod ? [selectedPeriod.id] : [...new Set(blocks.map(b => b.periodId))]
  for (const periodId of periods) {
    const start = selectedPeriod?.start ? `${selectedPeriod.start}T00:00` : ''
    const end = selectedPeriod?.end ? format(addDays(parseISO(selectedPeriod.end), 1), "yyyy-MM-dd'T'HH:mm") : ''
    const available = blocks.filter(b => (selectedPeriod || b.periodId === periodId) && b.friendId === null && (!b.kind || b.kind === 'available') && !b.expired)
      .map(b => ({ start: start && b.start < start ? start : b.start, end: end && b.end > end ? end : b.end }))
    for (const block of mergeRanges(available)) {
      let remaining = [{ start: block.start, end: block.end }]
      const occupied = [...meetings.filter(m => m.status !== 'cancelled'), ...blocks.filter(b => b.friendId === null && b.kind && b.kind !== 'available' && !b.expired)]
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
  }
  return gaps.sort((a, b) => a.start.localeCompare(b.start))
}

const range = <T extends { start: string; end: string }>(v: T) => validRange(v.start, v.end)
const friendSchema = z.object({ id: z.string(), name: z.string(), colour: z.string(), priority: z.enum(['must-see', 'high', 'normal', 'low']), location: z.string().optional(), notes: z.string().optional(), createdAt: z.string(), updatedAt: z.string(), archived: z.boolean().optional(), lastContacted: z.string().optional() })
const periodSchema = z.object({ id: z.string(), name: z.string(), start: z.iso.date().optional(), end: z.iso.date().optional(), location: z.string().optional() }).refine(p => (!p.start && !p.end) || (!!p.start && !!p.end && p.start <= p.end))
const availabilitySchema = z.object({ id: z.string(), periodId: z.string(), friendId: z.string().nullable(), start: z.string(), end: z.string(), source: z.enum(['WhatsApp', 'iMessage', 'In person', 'Other']).optional(), confidence: z.enum(['firm', 'likely', 'maybe']).optional(), notes: z.string().optional(), label: z.string().optional(), location: z.string().optional(), kind: z.enum(['available', 'reserved', 'busy', 'unavailable']).optional(), expired: z.boolean().optional() }).refine(range)
const meetingSchema = z.object({ id: z.string(), periodId: z.string(), friendId: z.string(), friendIds: z.array(z.string()).min(1).optional(), start: z.string(), end: z.string(), location: z.string(), notes: z.string(), status: z.enum(['idea', 'proposed', 'awaiting-reply', 'tentative', 'confirmed', 'cancelled']), title: z.string().optional(), travelTimeMinutes: z.number().nonnegative().optional() }).refine(range).refine(m => !m.friendIds || (m.friendIds[0] === m.friendId && new Set(m.friendIds).size === m.friendIds.length))
export const plannerSchema = z.object({ version: z.union([z.literal(1), z.literal(2)]), friends: z.array(friendSchema), periods: z.array(periodSchema), availability: z.array(availabilitySchema), meetings: z.array(meetingSchema) }).refine(d => {
  const periods = new Set(d.periods.map(p => p.id)), friends = new Set(d.friends.map(f => f.id))
  return (d.version === 2 || (d.periods.every(p => p.start && p.end && !p.location) && d.meetings.every(m => !m.friendIds))) &&
    d.availability.every(a => periods.has(a.periodId) && (a.friendId === null || friends.has(a.friendId))) &&
    d.meetings.every(m => periods.has(m.periodId) && (m.friendIds ?? [m.friendId]).every(id => friends.has(id)))
})
export function isPlannerData(value: unknown): value is PlannerData { return plannerSchema.safeParse(value).success }
