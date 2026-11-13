import { isPlannerData, meetingFriendIds, type PlannerData } from './model'

export type MergeConflict = { collection: string; id: string; reason: string }
export type MergeResult = { ok: true; data: PlannerData } | { ok: false; conflicts: MergeConflict[] }

const collections = ['friends', 'periods', 'availability', 'meetings'] as const
type Collection = typeof collections[number]
type RecordWithId = { id: string }

// Equality is structural and includes unknown and explicitly undefined properties.
function equal(a: unknown, b: unknown, seen = new Map<object, object>()): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) return false
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false
  if (!Array.isArray(a) && Object.getPrototypeOf(a) !== Object.prototype && Object.getPrototypeOf(a) !== null) return false
  if (seen.has(a)) return seen.get(a) === b
  seen.set(a, b)
  const keysA = Reflect.ownKeys(a), keysB = Reflect.ownKeys(b)
  const matches = keysA.length === keysB.length
    && keysA.every(key => Object.prototype.hasOwnProperty.call(b, key) && equal(Reflect.get(a, key), Reflect.get(b, key), seen))
  seen.delete(a)
  return matches
}

function metadata(data: PlannerData): object {
  const { friends: _friends, periods: _periods, availability: _availability, meetings: _meetings, ...rest } = data
  return rest
}

function mergeCollection<T extends RecordWithId>(
  collection: Collection, base: T[], local: T[], remote: T[], conflicts: MergeConflict[],
): T[] {
  const before = new Map(base.map(record => [record.id, record]))
  const left = new Map(local.map(record => [record.id, record]))
  const right = new Map(remote.map(record => [record.id, record]))
  const ids = new Set([...before.keys(), ...left.keys(), ...right.keys()])
  const merged: T[] = []

  for (const id of ids) {
    const original = before.get(id), l = left.get(id), r = right.get(id)
    let selected: T | undefined
    if (equal(l, r)) selected = l
    else if (equal(l, original)) selected = r
    else if (equal(r, original)) selected = l
    else {
      conflicts.push({
        collection, id,
        reason: original === undefined ? 'add-add' : l === undefined || r === undefined ? 'delete-edit' : 'edit-edit',
      })
      continue
    }
    if (selected !== undefined) merged.push(selected)
  }
  return merged
}

/**
 * Merge whole records by ID. Order is base IDs, then local additions, then remote additions.
 * Invalid inputs and duplicate IDs are reported as conflicts; no input is mutated.
 * Conflict reasons are stable strings, and '$snapshot' identifies snapshot-level errors.
 */
export function mergePlannerData(base: PlannerData, local: PlannerData, remote: PlannerData): MergeResult {
  const conflicts: MergeConflict[] = []
  for (const [name, data] of [['base', base], ['local', local], ['remote', remote]] as const) {
    if (!isPlannerData(data)) {
      conflicts.push({ collection: '$snapshot', id: name, reason: 'invalid-data' })
      continue
    }
    for (const collection of collections) {
      const ids = new Set<string>()
      for (const record of data[collection]) {
        if (ids.has(record.id)) conflicts.push({ collection, id: record.id, reason: `duplicate-id:${name}` })
        ids.add(record.id)
      }
    }
  }
  if (conflicts.length) return { ok: false, conflicts }

  const baseMetadata = metadata(base), localMetadata = metadata(local), remoteMetadata = metadata(remote)
  let root = base
  if (equal(localMetadata, remoteMetadata)) root = local
  else if (equal(localMetadata, baseMetadata)) root = remote
  else if (equal(remoteMetadata, baseMetadata)) root = local
  else conflicts.push({ collection: '$snapshot', id: 'metadata', reason: 'edit-edit' })

  const data: PlannerData = {
    ...root,
    friends: mergeCollection('friends', base.friends, local.friends, remote.friends, conflicts),
    periods: mergeCollection('periods', base.periods, local.periods, remote.periods, conflicts),
    availability: mergeCollection('availability', base.availability, local.availability, remote.availability, conflicts),
    meetings: mergeCollection('meetings', base.meetings, local.meetings, remote.meetings, conflicts),
  }
  if (conflicts.length) return { ok: false, conflicts }

  const friendIds = new Set(data.friends.map(friend => friend.id))
  const periodIds = new Set(data.periods.map(period => period.id))
  for (const collection of ['availability', 'meetings'] as const) {
    for (const record of data[collection]) {
      if (!periodIds.has(record.periodId)) conflicts.push({ collection, id: record.id, reason: `missing-period:${record.periodId}` })
      const participants = 'friendIds' in record ? meetingFriendIds(record) : record.friendId === null ? [] : [record.friendId]
      for (const id of participants) if (!friendIds.has(id)) conflicts.push({ collection, id: record.id, reason: `missing-friend:${id}` })
    }
  }
  if (!isPlannerData(data) && conflicts.length === 0) conflicts.push({ collection: '$snapshot', id: 'merged', reason: 'invalid-data' })
  return conflicts.length ? { ok: false, conflicts } : { ok: true, data }
}
