import { describe, expect, it } from 'vitest'
import { emptyData, freeGaps, getDashboardHighlights, isPlannerData, matchesPeriodLocation, meetingWarnings, mergeRanges, type Availability, type Meeting } from './model'

const period = { id: 'p', name: 'Trip', start: '2026-12-20', end: '2026-12-30' }
const person = { id: 'f', name: 'Sam', colour: '#abcdef', priority: 'normal' as const, createdAt: '', updatedAt: '' }
const meeting = (id: string, start: string, end: string): Meeting => ({ id, periodId: 'p', friendId: 'f', start: `2026-12-21T${start}`, end: `2026-12-21T${end}`, location: '', notes: '', status: 'confirmed' })
const block = (start: string, end: string): Availability => ({ id: 'b', periodId: 'p', friendId: null, start: `2026-12-21T${start}`, end: `2026-12-21T${end}` })
const base = () => ({ ...emptyData(), periods: [period], friends: [person] })

describe('scheduling', () => {
  it('detects overlapping plans but not adjacent ones', () => {
    const first = meeting('1', '10:00', '11:00')
    const overlap = meeting('2', '10:30', '11:30')
    expect(meetingWarnings(first, { ...base(), meetings: [first, overlap] }).some(w => w.startsWith('Overlaps Sam'))).toBe(true)
    expect(meetingWarnings(first, { ...base(), meetings: [first, meeting('2', '11:00', '12:00')] }, 0).some(w => w.startsWith('Overlaps Sam'))).toBe(false)
  })
  it('warns about travel buffers and busy blocks', () => {
    const first = meeting('1', '10:00', '11:00')
    const later = { ...meeting('2', '11:20', '12:00'), travelTimeMinutes: 45 }
    const busy = { ...block('10:15', '10:30'), kind: 'busy' as const }
    const warnings = meetingWarnings(first, { ...base(), meetings: [first, later], availability: [busy] })
    expect(warnings).toContain('Less than 30 min buffer or travel time')
    expect(warnings.some(w => w.startsWith('Overlaps busy'))).toBe(true)
  })
  it('subtracts plans and busy blocks from free time', () => {
    const available = block('09:00', '15:00')
    const busy = { ...block('13:00', '14:00'), kind: 'unavailable' as const }
    expect(freeGaps([available, busy], [meeting('1', '10:00', '12:00')])).toEqual([
      { start: '2026-12-21T09:00', end: '2026-12-21T10:00' },
      { start: '2026-12-21T12:00', end: '2026-12-21T13:00' },
      { start: '2026-12-21T14:00', end: '2026-12-21T15:00' },
    ])
  })
  it('validates backups and rejects orphaned or malformed records', () => {
    expect(isPlannerData({ ...base(), meetings: [meeting('1', '10:00', '11:00')] })).toBe(true)
    expect(isPlannerData({ ...base(), meetings: [{ ...meeting('1', '10:00', '11:00'), friendId: 'missing' }] })).toBe(false)
    expect(isPlannerData({ ...base(), availability: [block('12:00', '10:00')] })).toBe(false)
  })
  it('merges overlapping or adjacent availability without mutating input', () => {
    const ranges = [block('10:00', '11:00'), block('09:00', '10:00'), block('10:30', '12:00')]
    expect(mergeRanges(ranges)).toEqual([{ start: '2026-12-21T09:00', end: '2026-12-21T12:00' }])
    expect(ranges[0].end).toBe('2026-12-21T11:00')
  })
  it('checks plans, busy blocks, gaps and availability across overlapping periods', () => {
    const otherPeriod = { id: 'other', name: 'Other trip', start: '2026-12-21', end: '2026-12-25' }
    const plan = meeting('1', '10:00', '11:00')
    const other = { ...meeting('2', '10:30', '11:30'), periodId: 'other' }
    const busy = { ...block('10:15', '10:30'), id: 'busy', periodId: 'other', kind: 'busy' as const }
    const friendFree = { ...block('10:00', '11:00'), id: 'friend-free', periodId: 'other', friendId: 'f' }
    const data = { ...base(), periods: [period, otherPeriod], meetings: [plan, other], availability: [busy, friendFree] }
    expect(meetingWarnings(plan, data)).toContain('Overlaps Sam (2026-12-21 10:30–11:30, Other trip)')
    expect(meetingWarnings(plan, data)).toContain('Overlaps busy (2026-12-21 10:15–10:30, Other trip)')
    expect(meetingWarnings(plan, data)).not.toContain('Outside friend’s availability')
    const free = { ...block('09:00', '12:00'), periodId: 'other' }
    expect(freeGaps([free, busy], [plan], period)).toEqual([
      { start: '2026-12-21T09:00', end: '2026-12-21T10:00' },
      { start: '2026-12-21T11:00', end: '2026-12-21T12:00' },
    ])
  })

  it('validates indefinite periods and group plans while rejecting invalid participant references', () => {
    const data = { ...base(), version: 2 as const, periods: [{ id: 'p', name: 'Any time', location: 'Slovakia' }], friends: [person, { ...person, id: 'g', name: 'Alex' }] }
    const group = { ...meeting('1', '10:00', '11:00'), friendIds: ['f', 'g'] }
    expect(isPlannerData({ ...data, meetings: [group] })).toBe(true)
    expect(isPlannerData({ ...data, version: 1, meetings: [group] })).toBe(false)
    expect(isPlannerData({ ...data, meetings: [{ ...group, friendIds: ['f', 'missing'] }] })).toBe(false)
    expect(isPlannerData({ ...data, meetings: [{ ...group, friendIds: ['f', 'f'] }] })).toBe(false)
    expect(isPlannerData({ ...data, periods: [{ id: 'p', name: 'Bad', start: '2026-01-01' }] })).toBe(false)
    expect(meetingWarnings(group, { ...data, meetings: [group] })).not.toContain('Outside planning period')
  })

  it('warns for each group participant outside their shared availability', () => {
    const group = { ...meeting('1', '10:00', '11:00'), friendIds: ['f', 'g'] }
    const alex = { ...person, id: 'g', name: 'Alex' }
    const unavailableTime = { ...block('12:00', '13:00'), friendId: 'g' }
    expect(meetingWarnings(group, { ...base(), version: 2, friends: [person, alex], availability: [unavailableTime] })).toContain('Outside Alex’s availability')
  })

  it('matches locations without inferring geography and can include unknown locations', () => {
    const trip = { ...period, location: 'Slovakia' }
    expect(matchesPeriodLocation({ ...person, location: 'Bratislava, SLOVAKIA' }, trip)).toBe(true)
    expect(matchesPeriodLocation({ ...person, location: 'Bratislava' }, trip)).toBe(false)
    expect(matchesPeriodLocation(person, trip, true)).toBe(true)
    expect(matchesPeriodLocation(person, trip)).toBe(false)
  })
  it('summarizes today, the next confirmed plan, and stale contact dates', () => {
    const now = new Date('2026-12-21T09:00:00')
    const today = { ...meeting('today', '10:00', '11:00'), status: 'tentative' as const }
    const cancelled = { ...meeting('cancelled', '11:00', '12:00'), status: 'cancelled' as const }
    const next = { ...meeting('next', '12:00', '13:00'), start: '2026-12-22T12:00', end: '2026-12-22T13:00' }
    const recent = { ...person, id: 'recent', lastContacted: '2026-11-22' }
    const stale = { ...person, id: 'stale', lastContacted: '2026-11-20' }
    const archived = { ...person, id: 'archived', lastContacted: '2026-10-01', archived: true }
    const highlights = getDashboardHighlights([next, cancelled, today], [recent, stale, archived], now)

    expect(highlights.today.map(item => item.id)).toEqual(['today'])
    expect(highlights.nextConfirmed?.id).toBe('next')
    expect(highlights.staleContacts.map(({ friend: item }) => item.id)).toEqual(['stale'])
  })
})
