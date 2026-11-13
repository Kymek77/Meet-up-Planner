import { isPlannerData, type PlannerData } from './model'
import { mergePlannerData } from './merge'

export function mergeLocalEdit(base: PlannerData, edited: PlannerData, current: PlannerData) {
  const merged = mergePlannerData(base, edited, current)
  if (!merged.ok || !isPlannerData(merged.data)) throw new Error('This item changed elsewhere while you were editing it. Copy your changes, then close and reopen the form to review the latest version.')
  return merged.data
}
