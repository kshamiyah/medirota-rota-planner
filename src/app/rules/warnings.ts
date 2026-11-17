/** Warnings for rules that can't currently have any effect. */
import { matchesWork, shiftInterval } from '../../engine/calendar';
import type { Profile, Rule, WorkSelector } from '../../engine/types';
import { describeWork } from './describe';
import { describeRule } from './sentence';

/** Shift types that some staffing need for matching work uses. */
function demandedShifts(p: Profile, work: WorkSelector | undefined): string[] {
  const roles = new Map(p.roles.map(r => [r.id, r]));
  return [...new Set(p.demands.filter(d => d.max > 0 && matchesWork(work, d.roleId, d.shiftTypeId, roles)).map(d => d.shiftTypeId))];
}

function overlap(p: Profile, a: string, b: string): boolean {
  const sa = p.shiftTypes.find(s => s.id === a), sb = p.shiftTypes.find(s => s.id === b);
  if (!sa || !sb) return false;
  const ia = shiftInterval('2026-01-05', sa), ib = shiftInterval('2026-01-05', sb);
  return ia.start < ib.end && ib.start < ia.end;
}

/** Why a rule can't currently have any effect, or undefined if it can. */
export function ruleWarning(p: Profile, r: Rule): string | undefined {
  // Removed things show as "a removed …" in the sentence.
  if (describeRule(p, r).includes('a removed')) return 'Refers to something that no longer exists.';
  const works: WorkSelector[] = r.type === 'notSameDay' || r.type === 'pairPreference' ? [r.a, r.b] : 'work' in r ? [r.work] : [];
  for (const w of works) {
    if (demandedShifts(p, w).length === 0) return `No staffing need covers ${describeWork(p, w)}, so this never applies.`;
  }
  if (r.type === 'notSameDay' || r.type === 'pairPreference') {
    // One person can only do both in a day if some pair of their shifts doesn't overlap.
    const sa = demandedShifts(p, r.a), sb = demandedShifts(p, r.b);
    if (!sa.some(a => sb.some(b => !overlap(p, a, b)))) return 'These shifts overlap, so nobody could do both in one day anyway. It has no effect.';
  }
  if (r.type === 'linkShifts') {
    const place = r.roleId;
    const hasA = p.demands.some(d => d.roleId === place && d.shiftTypeId === r.shiftTypeIds[0] && d.max > 0);
    const hasB = p.demands.some(d => d.roleId === place && d.shiftTypeId === r.shiftTypeIds[1] && d.max > 0);
    if (!hasA || !hasB) return 'This place isn\'t staffed on both of these shifts, so this never applies.';
  }
  return undefined;
}
