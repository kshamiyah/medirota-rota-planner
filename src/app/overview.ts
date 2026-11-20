import { addDays, dateRange, weekday } from '../engine/calendar';
import { activeRules, demandFor } from '../engine/semantics';
import { isCountedWork, snapshotAssignments, type RotaSnapshot, type SwapSettings } from '../engine/swaps';
import { validate } from '../engine/validate';
import type { Assignment, ISODate, Profile, RotaProblem } from '../engine/types';
import { describeRule } from './rules/sentence';
import { placeCode } from './components/codes';
import { placeName } from './placeName';

export function sessionFor(activity: string | undefined, profile?: Profile, settings?: import('./sessions').SessionsSettings) {
  if (!activity || activity.endsWith('[Removed]') || activity.includes('…') || activity.includes('&hellip;')) return undefined;
  const place = profile?.roles.find(role => role.name === activity);
  const parentId = place?.parentId ?? place?.id;
  const type = settings?.types.find(item => !!parentId && item.placeIds.includes(parentId));
  if (type) return { ...type, code: placeCode(place, profile?.roles ?? []) };
  return place ? { id: `unmapped-${place.id}`, name: placeName(place), colour: 8, kind: 'day' as const, placeIds: [parentId ?? place.id], code: placeCode(place, profile?.roles ?? []) } : undefined;
}

export function overviewRange(today: ISODate, offsetWeeks = 0) {
  const start = addDays(today, offsetWeeks * 7);
  return { start, end: addDays(start, 27), dates: dateRange(start, addDays(start, 27)) };
}

export function overviewGroups(staff: Profile['staff'], groups: Profile['groups']) {
  const firstGroup = new Map(staff.map(person => [person.id, person.groupIds[0]]));
  const grouped = groups.map(group => ({ name: group.name, people: staff.filter(person => firstGroup.get(person.id) === group.id) })).filter(group => group.people.length);
  const ungrouped = staff.filter(person => !firstGroup.get(person.id) || !groups.some(group => group.id === firstGroup.get(person.id)));
  return [...grouped, ...(ungrouped.length ? [{ name: 'No group', people: ungrouped }] : [])];
}

export function overviewAssignments(profile: Profile, snapshot: RotaSnapshot, start: ISODate, end: ISODate): Assignment[] {
  return snapshotAssignments(profile, snapshot, dateRange(start, end)).assignments;
}

export function overviewValidation(profile: Profile, snapshot: RotaSnapshot, start: ISODate, end: ISODate) {
  const margin = 7;
  const expandedStart = addDays(start, -margin);
  const expandedEnd = addDays(end, margin);
  const expandedDates = dateRange(expandedStart, expandedEnd);
  const converted = snapshotAssignments(profile, snapshot, expandedDates);
  const expandedAssignments = converted.assignments;
  const problem: RotaProblem = { profile: converted.profile, start: expandedStart, end: expandedEnd, fixed: [], unavailability: [] };
  const result = validate(problem, expandedAssignments);
  const ruleNames = new Map(activeRules(profile).map(rule => [rule.id, describeRule(profile, rule)]));
  const visibleAssignments = expandedAssignments.filter(a => a.date >= start && a.date <= end);
  const listGaps = consultantListGaps(profile, converted.profile, visibleAssignments, start, end);
  const listRoleIds = new Set(profile.roles.filter(role => role.parentId).map(role => role.id));
  const parentRoleIds = new Set(profile.roles.filter(role => profile.roles.some(child => child.parentId === role.id)).map(role => role.id));
  const ordinaryGaps = result.gaps.filter(gap => gap.date >= start && gap.date <= end && !listRoleIds.has(gap.roleId) && !parentRoleIds.has(gap.roleId));
  return {
    assignments: visibleAssignments,
    violations: result.violations.filter(v => v.date !== undefined && v.date >= start && v.date <= end && profile.rules.find(r => r.id === v.ruleId)?.hard)
      .map(v => ({ ...v, ruleName: ruleNames.get(v.ruleId) ?? v.ruleName })),
    gaps: [...ordinaryGaps, ...listGaps],
  };
}

/** Count parent-place doctors against consultant lists first, then the parent need. */
function consultantListGaps(profile: Profile, validationProfile: Profile, assignments: Assignment[], start: ISODate, end: ISODate) {
  const gaps: { roleId: string; shiftTypeId: string; date: ISODate; required: number; assigned: number }[] = [];
  const dates = dateRange(start, end);
  for (const parent of profile.roles.filter(role => profile.roles.some(child => child.parentId === role.id))) {
    const children = profile.roles.filter(role => role.parentId === parent.id);
    for (const date of dates) {
      const childNeeds = children.flatMap(child => validationProfile.shiftTypes.map(shift => ({ role: child, shiftId: shift.id, demand: demandFor(profile, child.id, shift.id, date) }))).filter(item => item.demand.min > 0);
      const parentNeeds = validationProfile.shiftTypes.map(shift => ({ shiftId: shift.id, demand: demandFor(profile, parent.id, shift.id, date) })).filter(item => item.demand.min > 0);
      const onParent = assignments.filter(assignment => assignment.date === date && assignment.roleId === parent.id);
      let available = onParent.length;
      for (const item of childNeeds) {
        const assigned = Math.min(available, item.demand.min);
        available -= assigned;
        if (assigned < item.demand.min) gaps.push({ roleId: item.role.id, shiftTypeId: item.shiftId, date, required: item.demand.min, assigned });
      }
      let parentRemaining = available;
      for (const item of parentNeeds) {
        const assigned = Math.min(parentRemaining, item.demand.min);
        parentRemaining -= assigned;
        if (assigned < item.demand.min) gaps.push({ roleId: parent.id, shiftTypeId: item.shiftId, date, required: item.demand.min, assigned });
      }
    }
  }
  return gaps;
}

/** Doctors counted as working on a date, including locums (same definition as short days). */
export function workingCount(snapshot: RotaSnapshot, date: ISODate): number {
  return Object.values(snapshot.days).filter(days => isCountedWork(days[date])).length;
}

export function shortDays(snapshot: RotaSnapshot, settings: SwapSettings | undefined, dates: ISODate[], _staffIds?: string[]) {
  if (!settings) return new Map<ISODate, number>();
  return new Map(dates.map(date => {
    const working = workingCount(snapshot, date);
    const minimum = settings.bankHolidays.includes(date) ? settings.minDoctorsBankHoliday : settings.minDoctors[weekday(date)] ?? 0;
    // A minimum of 0 means "no minimum": never treat the day as under.
    if (minimum <= 0) return [date, 0];
    return [date, Math.max(0, minimum - working)];
  }));
}

/** Footer text: show only the working count when no minimum is set. */
export function workingMinimumLabel(working: number, minimum: number): string {
  return minimum > 0 ? `${working}/${minimum}` : String(working);
}
