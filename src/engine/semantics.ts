/**
 * Shared meaning of rules and demand: the solver encodes these, the validator
 * checks against them. Keeping the interpretation in one place means the two
 * can't silently disagree on what a rule says (they still implement the checks
 * independently).
 */
import { dateRange, matchesDay, matchesStaff, matchesWork, weekendOf } from './calendar';
import type { CountRule, FairnessDimension, ForbidRule, ISODate, MinRestRule, Profile, RotaProblem, Rule, ShareRule, Staff, Tier, WorkSelector } from './types';
import { DEFAULT_TIER_ORDER } from './types';

/** Rules that apply: switched on, and with no example values left to set. */
export function activeRules(profile: Profile): Rule[] {
  return profile.rules.filter(r => r.enabled !== false && !(r.unset?.length));
}

export function tierOrder(profile: Profile): Tier[] {
  return profile.tierOrder ?? DEFAULT_TIER_ORDER;
}

export function softTier(rule: Rule): Tier {
  if (rule.tier) return rule.tier;
  if (rule.type === 'skillMix') return 'coverage'; // as important as filling the shift
  if (rule.type === 'share') return 'fairness';
  return rule.type === 'preference' || rule.type === 'pairPreference' || rule.type === 'continuity' || rule.type === 'workWith' || rule.type === 'fewLeads' ? 'preference' : 'training';
}

/**
 * Whether two shifts (first ends `gapHours` before the second starts; together
 * they span `spanHours`) break a minimum-rest rule. Checked for every pair of a
 * person's shifts, by both the solver and the validator.
 */
export function breaksRest(rule: MinRestRule, gapHours: number, spanHours: number): boolean {
  if (gapHours < 0 || gapHours >= rule.hours - 1e-9) return false;
  const sameDuty = gapHours <= (rule.sameDutyGapHours ?? 1) + 1e-9 && spanHours <= (rule.maxDutyHours ?? 13) + 1e-9;
  return !sameDuty;
}

/**
 * The problem as the engine sees it: each person's days before their start date
 * or after their end date become whole-day unavailability. Idempotent.
 */
export function withEmploymentDates(problem: RotaProblem): RotaProblem {
  const extra: RotaProblem['unavailability'] = [];
  for (const s of problem.profile.staff) {
    if (!s.startDate && !s.endDate) continue;
    for (const d of dateRange(problem.start, problem.end)) {
      if ((s.startDate && d < s.startDate) || (s.endDate && d > s.endDate)) {
        if (!problem.unavailability.some(u => u.staffId === s.id && u.date === d && !u.shiftTypeIds && u.reason === 'Not in post')) {
          extra.push({ staffId: s.id, date: d, kind: 'other', reason: 'Not in post' });
        }
      }
    }
  }
  return extra.length ? { ...problem, unavailability: [...problem.unavailability, ...extra] } : problem;
}

/**
 * Whether a minimum ("at least N a month") applies to this person in these
 * dates: not to a locum, who only works shifts booked for them, nor to
 * someone with no working day in them (not yet started, left, or away
 * throughout).
 */
export function minimumApplies(problem: RotaProblem, staff: Staff, dates: ISODate[]): boolean {
  if (staff.locum) return false;
  return dates.some(d => !(staff.startDate && d < staff.startDate) && !(staff.endDate && d > staff.endDate)
    && !problem.unavailability.some(u => u.staffId === staff.id && u.date === d && !u.shiftTypeIds));
}

/** Rules that can only ever be soft. */
export function isSoft(rule: Rule): boolean {
  return !rule.hard || rule.type === 'preference' || rule.type === 'pairPreference' || rule.type === 'continuity' || rule.type === 'share' || rule.type === 'workWith' || rule.type === 'fewLeads';
}

/**
 * Combined min/max for a role on a shift on a date (several demands add up).
 * A demand listing specific dates is a one-off change: on those dates it
 * replaces the usual weekday demands instead of adding to them.
 */
export function demandFor(profile: Profile, roleId: string, shiftTypeId: string, date: ISODate): { min: number; max: number; importance: number } {
  let min = 0, max = 0, importance = 0;
  const matching = profile.demands.filter(d => d.roleId === roleId && d.shiftTypeId === shiftTypeId && matchesDay(d.days, date));
  const oneOff = matching.filter(d => d.days.dates && d.days.dates.length > 0);
  for (const d of oneOff.length > 0 ? oneOff : matching) {
    min += d.min;
    max += d.max;
    importance = Math.max(importance, d.importance ?? 1);
  }
  return { min, max, importance: importance || 1 };
}

/**
 * Effective bounds of a count rule for one person in one period bucket.
 * Partial periods (e.g. a week cut by the horizon) scale the minimum by the share
 * of days inside the horizon; the maximum stays as written. Hard minimums round
 * down so a partial period never demands more than is fair.
 */
export function countBounds(rule: CountRule, staff: Staff, fraction: number, bucketDays = 7): { min?: number; max?: number } {
  const f = (rule.scaleByFte ? staff.fte : 1) * (rule.perWeekAverage ? bucketDays / 7 : 1);
  let min = rule.min !== undefined ? rule.min * f * fraction : undefined;
  if (min !== undefined && rule.hard) min = Math.floor(min + 1e-9);
  const max = rule.max !== undefined ? rule.max * f : undefined;
  return { min, max };
}

/**
 * Whether a person could ever do some of the selected work in this rota: it is
 * demanded, they are not hard-forbidden from it and not unavailable for all of
 * it. Fairness only compares people who are eligible for that kind of work.
 */
export function canEverDo(problem: RotaProblem, staff: Staff, work: WorkSelector | undefined, weekendsOnly = false): boolean {
  const { profile } = problem;
  const roles = new Map(profile.roles.map(r => [r.id, r]));
  const hardForbids = activeRules(profile).filter((r): r is ForbidRule => r.type === 'forbid' && !isSoft(r) && matchesStaff(r.who, staff));
  for (const date of dateRange(problem.start, problem.end)) for (const role of profile.roles) for (const st of profile.shiftTypes) {
    if (!matchesWork(work, role.id, st.id, roles)) continue;
    if (weekendsOnly && !weekendOf(date, st)) continue;
    if (demandFor(profile, role.id, st.id, date).max <= 0) continue;
    if (problem.unavailability.some(u => u.staffId === staff.id && u.date === date && (!u.shiftTypeIds || u.shiftTypeIds.includes(st.id)))) continue;
    if (hardForbids.some(r => matchesDay(r.days, date) && matchesWork(r.work, role.id, st.id, roles))) continue;
    return true;
  }
  return problem.fixed.some(f => f.staffId === staff.id && matchesWork(work, f.roleId, f.shiftTypeId, roles));
}

/**
 * Capacity used for fairness: FTE × share of their usual working days not lost
 * to leave. Someone at 60% on leave for half their working days has capacity
 * 0.3. Regular non-working days are excluded from the count, since the FTE
 * already accounts for them.
 */
export function capacity(problem: RotaProblem, staff: Staff): number {
  const dates = dateRange(problem.start, problem.end);
  const mine = problem.unavailability.filter(u => u.staffId === staff.id && !u.shiftTypeIds);
  const nonWorking = new Set(mine.filter(u => u.kind === 'nonWorking').map(u => u.date));
  const off = new Set(mine.filter(u => u.kind !== 'nonWorking').map(u => u.date));
  const usual = dates.filter(d => !nonWorking.has(d));
  if (usual.length === 0) return 0;
  return staff.fte * (usual.filter(d => !off.has(d)).length / usual.length);
}

/** Fairness dimensions: the department's own plus one for each "share evenly" rule. */
export function fairnessDimensions(profile: Profile): FairnessDimension[] {
  const shares = activeRules(profile).filter((r): r is ShareRule => r.type === 'share')
    .map(r => ({ id: r.id, name: r.name, work: r.work, who: r.who, favour: r.favour, unit: 'shifts' as const, weight: r.weight ?? 1 }));
  return [...profile.fairness, ...shares];
}

/** How many times the usual share this person should get on a fairness dimension. */
export function shareFactor(dim: FairnessDimension, staff: Staff): number {
  const specified = dim.factorsByStaff?.[staff.id];
  if (specified !== undefined) return Math.max(0, specified);
  return dim.favour && dim.favour.times > 0 && matchesStaff(dim.favour.who, staff) ? dim.favour.times : 1;
}
