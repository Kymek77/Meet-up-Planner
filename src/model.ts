import { areIntervalsOverlapping, isValid, parseISO } from 'date-fns'

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
}
export interface Period { id: string; name: string; start: string; end: string }
export interface Availability { id: string; periodId: string; friendId: string | null; start: string; end: string }
export interface Meeting {
  id: string
  periodId: string
  friendId: string
  start: string
  end: string
  location: string
  notes: string
  status: 'tentative' | 'confirmed'
}
export interface PlannerData {
  version: 1
  friends: Friend[]
  periods: Period[]
  availability: Availability[]
  meetings: Meeting[]
}
export const emptyData = (): PlannerData => ({ version: 1, friends: [], periods: [], availability: [], meetings: [] })

export function validRange(start: string, end: string) {
  const a = parseISO(start), b = parseISO(end)
  return isValid(a) && isValid(b) && a < b
}

export function meetingWarnings(meeting: Meeting, data: PlannerData): string[] {
  const warnings: string[] = []
  if (!validRange(meeting.start, meeting.end)) return ['Invalid time range']
  const period = data.periods.find(p => p.id === meeting.periodId)
  if (!period || meeting.start.slice(0, 10) < period.start || meeting.end.slice(0, 10) > period.end) warnings.push('Outside planning period')
  const interval = { start: parseISO(meeting.start), end: parseISO(meeting.end) }
  if (data.meetings.some(m => m.id !== meeting.id && m.periodId === meeting.periodId && validRange(m.start, m.end) && areIntervalsOverlapping(interval, { start: parseISO(m.start), end: parseISO(m.end) }))) warnings.push('Overlaps another plan')
  for (const [friendId, label] of [[null, 'your availability'], [meeting.friendId, 'friend’s availability']] as const) {
    const blocks = data.availability.filter(a => a.periodId === meeting.periodId && a.friendId === friendId)
    if (blocks.length && !blocks.some(a => a.start <= meeting.start && a.end >= meeting.end)) warnings.push(`Outside ${label}`)
  }
  return warnings
}

export function freeGaps(blocks: Availability[], meetings: Meeting[]): { start: string; end: string }[] {
  const gaps: { start: string; end: string }[] = []
  for (const block of blocks.filter(b => b.friendId === null && validRange(b.start, b.end))) {
    let remaining = [{ start: block.start, end: block.end }]
    for (const meeting of meetings.filter(m => m.periodId === block.periodId && validRange(m.start, m.end))) {
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

export function isPlannerData(value: unknown): value is PlannerData {
  if (!value || typeof value !== 'object') return false
  const d = value as Record<string, unknown>
  const text = (v: unknown) => typeof v === 'string'
  const optionalText = (v: unknown) => v === undefined || text(v)
  const array = (v: unknown, check: (o: Record<string, unknown>) => boolean) =>
    Array.isArray(v) && v.every(item => item && typeof item === 'object' && check(item))
  return d.version === 1 &&
    array(d.friends, f => text(f.id) && text(f.name) && text(f.colour) && ['must-see', 'high', 'normal', 'low'].includes(String(f.priority)) && optionalText(f.location) && optionalText(f.notes) && text(f.createdAt) && text(f.updatedAt)) &&
    array(d.periods, p => text(p.id) && text(p.name) && text(p.start) && text(p.end) && /^\d{4}-\d{2}-\d{2}$/.test(String(p.start)) && /^\d{4}-\d{2}-\d{2}$/.test(String(p.end)) && String(p.start) <= String(p.end)) &&
    array(d.availability, a => text(a.id) && text(a.periodId) && (a.friendId === null || text(a.friendId)) && text(a.start) && text(a.end) && validRange(String(a.start), String(a.end))) &&
    array(d.meetings, m => text(m.id) && text(m.periodId) && text(m.friendId) && text(m.start) && text(m.end) && validRange(String(m.start), String(m.end)) && text(m.location) && text(m.notes) && (m.status === 'tentative' || m.status === 'confirmed'))
}
