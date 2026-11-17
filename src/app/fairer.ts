import { dateRange } from '../engine/calendar';
import type { BuildOptions } from '../engine/build';
import type { Assignment, ISODate, Profile, RotaProblem, Staff } from '../engine/types';
import { solve, type StageReport } from '../engine/solve';
import { snapshotAssignments, type RotaSnapshot } from '../engine/swaps';
import { defaultSessionsSettings, sessionComparisonFor, sessionForPlace, type SessionsSettings } from './sessions';
import type { Workspace } from './store';

export interface FairerConsultantPlan { enabled: boolean; groupIds: string[]; typeIds: string[]; selectedStaffIds: string[]; pairs: Record<string, string[]>; slots: { date: ISODate; placeId: string; roles: { roleId: string; count: number }[] }[]; fallbackDays: number; baselineByStaffDate: Record<string, string[]>; metBeforeRangeByStaff: Record<string, string[]>; validStaffDates: string[]; }
export interface FairerModel { problem: RotaProblem; buildOptions: BuildOptions; baseline: Assignment[]; dayJobs: Assignment[]; movable: Assignment[]; dates: ISODate[]; dayTypes: { id: string; name: string }[]; placeForRole: Record<string, string>; typeForRole: Record<string, string>; comparisonByStaff: Record<string, string | undefined>; consultantsByRole: Record<string, string[]>; ratios: SessionsSettings['ratios']; maxChanges: number; consultantPlan: FairerConsultantPlan; baselineRoleByStaffDate: Record<string, string>; consultantGroupNames?: string[]; }

const key = (a: Assignment) => `${a.staffId}|${a.date}|${a.roleId ?? ''}|${a.shiftTypeId}`;
type Allowed = NonNullable<BuildOptions['allowedVariables']>[number];
function indexAllowed(variables: Allowed[], typeForRole: Record<string, string> = {}) {
  const staffDate = new Map<string, Allowed[]>(), date = new Map<string, Allowed[]>(), staffType = new Map<string, Allowed[]>(), staffDateRole = new Map<string, Allowed[]>();
  const add = (map: Map<string, Allowed[]>, k: string, value: Allowed) => map.set(k, [...(map.get(k) ?? []), value]);
  for (const variable of variables) {
    add(staffDate, `${variable.staffId}|${variable.date}`, variable);
    add(date, variable.date, variable);
    add(staffDateRole, `${variable.staffId}|${variable.date}|${variable.roleId}`, variable);
    const type = typeForRole[variable.roleId]; if (type) add(staffType, `${variable.staffId}|${type}`, variable);
  }
  return { staffDate, date, staffType, staffDateRole };
}

export function fairerTimeLimit(weeks: number): number { return weeks <= 13 ? 60 : Math.min(180, 60 + 15 * (weeks - 13)); }
export function fairerProgressPercent(elapsedSeconds: number, weeks: number): number {
  return Math.min(96, (Math.max(0, elapsedSeconds) / fairerTimeLimit(Math.max(1, weeks))) * 100);
}
export function fairerRemainingTimeLimit(weeks: number, setupSeconds: number): number { return Math.max(0, fairerTimeLimit(weeks) - Math.max(0, setupSeconds) - 1); }
export function fairerConsultantBudget(remainingSeconds: number): number { return Math.max(1, Math.max(0, remainingSeconds) * 0.65); }
export const FAIRNESS_ALLOWANCE = 0.03;
export function fairnessWithinAllowance(before: number | undefined, after: number | undefined): boolean {
  return before === undefined || (after !== undefined && after <= before * (1 + FAIRNESS_ALLOWANCE) + 1e-6);
}
export function fairnessAllowanceNote(before: number | undefined, after: number | undefined, groupNames = 'the configured group'): string | undefined {
  if (before === undefined || after === undefined || after <= before + 1e-6) return undefined;
  const percent = before ? (after / before - 1) * 100 : 0;
  // Skip floating-point noise that would round to "0.0%" (owner wants a real one-decimal figure).
  if (percent < 0.05) return undefined;
  return `Ratios are ${percent.toFixed(1)}% less even, to keep ${groupNames} with the same consultants.`;
}

export function fairerFallbackNote(check: string, fairnessObjectiveBefore?: number, fairnessObjectiveAfter?: number): string {
  if (check === 'time-budget' || check === 'solve-time-limit') return 'Too many weeks to plan same consultants in time. Try a shorter range.';
  if (check === 'fairness-over-allowance') {
    if (fairnessObjectiveBefore === undefined || fairnessObjectiveAfter === undefined) return 'Same consultants were not used because their effect on ratios could not be measured. Try again: another run may keep it.';
    const percent = fairnessObjectiveBefore ? (fairnessObjectiveAfter / fairnessObjectiveBefore - 1) * 100 : 0;
    return `Same consultants made the ratios ${percent.toFixed(1)}% less even, so they weren't used. Try again: another run may keep them.`;
  }
  if (check === 'list-slot-counts') return "The consultant lists don't match the rota for some days, so same consultants was skipped.";
  return "Same consultants couldn't be planned for these dates, so the fairer ratios are shown without it.";
}

export function findFairerMovableAssignments(
  assignments: Assignment[], snapshot: RotaSnapshot, profile: Profile, settings: SessionsSettings,
  placements: Record<string, string>, placeForRole: Record<string, string>, typeForRole: Record<string, string>,
): Assignment[] {
  const staff = new Map(profile.staff.map(person => [person.id, person]));
  const jobsByDoctorDay = new Map<string, Assignment[]>();
  for (const assignment of assignments) {
    if (snapshot.days[assignment.staffId]?.[assignment.date]?.status !== 'dayJob') continue;
    const k = `${assignment.staffId}|${assignment.date}`;
    jobsByDoctorDay.set(k, [...(jobsByDoctorDay.get(k) ?? []), assignment]);
  }
  return assignments.filter(assignment => {
    const day = snapshot.days[assignment.staffId]?.[assignment.date];
    const person = staff.get(assignment.staffId);
    const comparison = person && sessionComparisonFor(person, profile, settings, placements);
    const sameDayJobs = jobsByDoctorDay.get(`${assignment.staffId}|${assignment.date}`) ?? [];
    const places = new Set(sameDayJobs.map(item => placeForRole[item.roleId ?? '']));
    return day?.status === 'dayJob' && !day.extra && !person?.locum && comparison?.comparisonId !== undefined && sameDayJobs.length === 1 && places.size === 1 && !!assignment.roleId && !!typeForRole[assignment.roleId];
  });
}

function roleConsultants(profile: Profile): Map<string, string[]> {
  const names = new Map((profile.leads ?? []).map(lead => [lead.id, lead.name]));
  return new Map(profile.roles.filter(role => role.parentId).map(role => [role.id, (role.leadIds ?? []).map(id => names.get(id)).filter((name): name is string => !!name)]));
}

const consultantKey = (names: string[]) => [...new Set(names.map(name => name.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'en-GB')).join('|');
const sessionStaffComparison = (person: Staff, profile: Profile, settings: SessionsSettings, placements: Record<string, string>) => sessionComparisonFor(person, profile, settings, placements);

export function prepareFairerModel(ws: Workspace, start: ISODate, end: ISODate, changeLimit: number | 'none', maxDays: 2 | 3 | 4 | 'none', keepSameConsultants = true): FairerModel {
  const snapshot = ws.swapFinder!.snapshot;
  const settings = ws.sessions ?? defaultSessionsSettings(ws.profile);
  const dates = dateRange(start, end);
  const read = snapshotAssignments(ws.profile, snapshot, dates);
  const dayJobs = read.assignments.filter(item => snapshot.days[item.staffId]?.[item.date]?.status === 'dayJob');
  const placeForRole: Record<string, string> = {};
  for (const role of ws.profile.roles) placeForRole[role.id] = role.parentId ?? role.id;
  const dayTypes = settings.types.filter(type => type.kind === 'day');
  const typeByRole = new Map<string, string>();
  for (const role of ws.profile.roles) {
    const type = sessionForPlace(settings, placeForRole[role.id]);
    if (type?.kind === 'day') typeByRole.set(role.id, type.id);
  }
  const movable = findFairerMovableAssignments(read.assignments, snapshot, ws.profile, settings, ws.sessionSubGroups ?? {}, placeForRole, Object.fromEntries(typeByRole));
  const same = settings.sameConsultants ?? { groupIds: [], typeIds: [] };
  const groupIds = [...same.groupIds], typeIds = [...same.typeIds];
  const consultantNames = roleConsultants(ws.profile);
  const comparisonByStaff = new Map(ws.profile.staff.map(person => [person.id, sessionStaffComparison(person, ws.profile, settings, ws.sessionSubGroups ?? {})]));
  const staffComparison = (staffId: string) => comparisonByStaff.get(staffId) ?? {};
  const selectedStaff = (staffId: string) => groupIds.includes(staffComparison(staffId).groupId ?? '');
  const hasConsultantData = (ws.consultantLists ?? []).some(cell => typeIds.includes(sessionForPlace(settings, cell.placeId)?.id ?? '') && cell.consultants.length > 0);
  const consultantTracking = groupIds.length > 0 && typeIds.length > 0 && hasConsultantData;
  const consultantEnabled = changeLimit === 'none' && keepSameConsultants && consultantTracking;
  const modelProfile: Profile = structuredClone(ws.profile);
  const selectedListPlaces = new Set(settings.types.filter(type => typeIds.includes(type.id)).flatMap(type => type.placeIds));
  if (consultantEnabled) modelProfile.roles = modelProfile.roles.filter(role => !role.parentId || !selectedListPlaces.has(role.parentId));
  const baselineByStaffDate: Record<string, string[]> = {};
  for (const cell of ws.consultantLists ?? []) if (cell.date >= start && cell.date <= end && typeIds.includes(sessionForPlace(settings, cell.placeId)?.id ?? '') && cell.consultants.length) {
    for (const staffId of cell.staffIds) if (selectedStaff(staffId)) baselineByStaffDate[`${staffId}|${cell.date}`] = [...new Set([...(baselineByStaffDate[`${staffId}|${cell.date}`] ?? []), ...cell.consultants])];
  }
  const metBeforeRangeByStaff: Record<string, string[]> = {};
  for (const cell of ws.consultantLists ?? []) if (cell.date < start && typeIds.includes(sessionForPlace(settings, cell.placeId)?.id ?? '') && cell.consultants.length) {
    for (const staffId of cell.staffIds) if (selectedStaff(staffId)) metBeforeRangeByStaff[staffId] = [...new Set([...(metBeforeRangeByStaff[staffId] ?? []), ...cell.consultants])];
  }
  const slotCounts = new Map<string, Map<string, number>>();
  const invalidSlots = new Set<string>();
  const baselineConsultants = new Map<string, string[]>();
  const baselineListRoles: Record<string, string> = {};
  const validStaffDates = new Set<string>();
  const consultantsByRole: Record<string, string[]> = {};
  const consultantCellsByDatePlace = new Map<string, NonNullable<Workspace['consultantLists']>>();
  for (const cell of ws.consultantLists ?? []) {
    const k = `${cell.date}|${cell.placeId}`;
    consultantCellsByDatePlace.set(k, [...(consultantCellsByDatePlace.get(k) ?? []), cell]);
  }
  const tierStaffIds = new Set(ws.profile.staff.filter(person => !person.locum && !!sessionStaffComparison(person, ws.profile, settings, ws.sessionSubGroups ?? {}).comparisonId).map(person => person.id));
  if (consultantEnabled) {
    const selectedPlaceDays = new Map<string, Assignment[]>();
    for (const item of movable) {
      const place = placeForRole[item.roleId ?? ''];
      if (!place || !typeIds.includes(sessionForPlace(settings, place)?.id ?? '')) continue;
      const key = `${item.date}|${place}`;
      selectedPlaceDays.set(key, [...(selectedPlaceDays.get(key) ?? []), item]);
    }
    for (const [key, items] of selectedPlaceDays) {
      const [date, place] = key.split('|');
      const cells = consultantCellsByDatePlace.get(key) ?? [];
      let invalid = cells.length === 0;
      const byList = new Map<string, { consultants: string[]; staffIds: Set<string> }>();
      for (const cell of cells) {
        const names = [...new Set(cell.consultants.map(name => name.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'en-GB'));
        if (!names.length) continue;
        const listKey = consultantKey(names);
        const list = byList.get(listKey) ?? { consultants: names, staffIds: new Set<string>() };
        for (const staffId of cell.staffIds) if (tierStaffIds.has(staffId)) list.staffIds.add(staffId);
        byList.set(listKey, list);
      }
      const counted = [...byList.values()].reduce((sum, list) => sum + list.staffIds.size, 0);
      if (counted !== items.length) invalid = true;
      if (invalid) { invalidSlots.add(key); continue; }
      const counts = new Map<string, number>();
      for (const [listIndex, list] of [...byList.values()].entries()) {
        const listId = `fairer-list-${date}-${place}-${listIndex}`;
        const roleId = listId.replace(/[^a-zA-Z0-9_-]/g, '-');
        modelProfile.roles.push({ id: roleId, name: `${ws.profile.roles.find(role => role.id === place)?.name ?? place} · ${list.consultants.join(' & ')}`, parentId: place, leadIds: [] });
        placeForRole[roleId] = place!;
        typeByRole.set(roleId, sessionForPlace(settings, place!)!.id);
        consultantsByRole[roleId] = list.consultants;
        consultantNames.set(roleId, list.consultants);
        counts.set(roleId, list.staffIds.size);
        for (const staffId of list.staffIds) {
          const staffDate = `${staffId}|${date}`;
          if (items.some(item => item.staffId === staffId)) {
            baselineListRoles[staffDate] = roleId;
            baselineConsultants.set(staffDate, [...new Set([...(baselineConsultants.get(staffDate) ?? []), ...list.consultants])]);
            validStaffDates.add(staffDate);
          }
        }
      }
      slotCounts.set(key, counts);
    }
  }
  const movableStaffDays = new Map<string, Assignment[]>();
  for (const item of movable) {
    const k = `${item.staffId}|${item.date}`;
    movableStaffDays.set(k, [...(movableStaffDays.get(k) ?? []), item]);
  }
  const placeDayCounts = new Map<string, number>();
  const doctorCapacities: Record<string, number> = {};
  for (const item of movable) {
    const place = placeForRole[item.roleId!]!;
    const k = `${place}|${item.date}`;
    placeDayCounts.set(k, (placeDayCounts.get(k) ?? 0) + 1);
    doctorCapacities[item.staffId] = (doctorCapacities[item.staffId] ?? 0) + 1;
  }

  modelProfile.rules = maxDays === 'none' ? [] : [...new Set(movable.map(item => placeForRole[item.roleId!]))]
    .map((place, index) => ({ id: `fairer-run-${index}`, name: 'Place variety', type: 'maxConsecutive' as const, hard: false, tier: 'preference' as const, weight: 1,
      work: { roleIds: modelProfile.roles.filter(role => placeForRole[role.id] === place).map(role => role.id), shiftTypeIds: ws.profile.shiftTypes.map(st => st.id) }, maxDays }));
  modelProfile.fairness = dayTypes.map(type => ({ id: `fairer-share-${type.id}`, name: `${type.name} share`, unit: 'shifts', weight: 1,
    work: { roleIds: modelProfile.roles.filter(role => typeByRole.get(role.id) === type.id).map(role => role.id) },
    who: { staffIds: ws.profile.staff.filter(person => !person.locum && sessionComparisonFor(person, ws.profile, settings, ws.sessionSubGroups ?? {}).comparisonId).map(person => person.id) },
    capacityByStaff: doctorCapacities, factorsByStaff: Object.fromEntries(ws.profile.staff.map(person => [person.id, settings.ratios[type.id]?.[sessionComparisonFor(person, ws.profile, settings, ws.sessionSubGroups ?? {}).groupId ?? ''] ?? 1])) }));
  modelProfile.tierOrder = consultantEnabled ? ['fairness', 'paired', 'consultants', 'preference', 'extra'] : ['fairness', 'preference', 'extra'];
  modelProfile.useSpareCapacity = false;
  modelProfile.demands = [];
  const movableByDate = new Map<string, Assignment[]>();
  for (const item of movable) movableByDate.set(item.date, [...(movableByDate.get(item.date) ?? []), item]);
  for (const [slot, count] of placeDayCounts) {
    const [rolePlace, date] = slot.split('|');
    const roleIds = modelProfile.roles.filter(role => placeForRole[role.id] === rolePlace).map(role => role.id);
    const shifts = [...new Set((movableByDate.get(date!) ?? []).filter(entry => roleIds.includes(entry.roleId ?? '')).map(item => item.shiftTypeId))];
    for (const shiftTypeId of shifts) for (const roleId of roleIds) {
      if (modelProfile.demands.some(d => d.roleId === roleId && d.shiftTypeId === shiftTypeId && d.days.dates?.[0] === date)) continue;
      modelProfile.demands.push({ id: `fairer-demand-${roleId}-${shiftTypeId}-${date}`, roleId, shiftTypeId, days: { dates: [date as ISODate] }, min: 0, max: count });
    }
  }
  const allowedVariables = [...movableStaffDays.entries()].flatMap(([staffDate, entries]) => {
    const [staffId, date] = staffDate.split('|');
    const shiftTypeId = entries[0]!.shiftTypeId;
    return modelProfile.roles.filter(role => typeByRole.has(role.id)).flatMap(role => {
      const place = placeForRole[role.id];
      const slotKey = `${date}|${place}`;
      if (consultantEnabled && slotCounts.has(slotKey)) return slotCounts.get(slotKey)!.has(role.id) ? [{ staffId: staffId!, date: date as ISODate, roleId: role.id, shiftTypeId }] : [];
      return !role.parentId ? [{ staffId: staffId!, date: date as ISODate, roleId: role.id, shiftTypeId }] : [];
    });
  });
  const variableIndex = indexAllowed(allowedVariables, Object.fromEntries(typeByRole));
  const staffDateVariables = (staffId: string, date: string) => variableIndex.staffDate.get(`${staffId}|${date}`) ?? [];
  const dateVariables = (date: string) => variableIndex.date.get(date) ?? [];
  const dateRoleVariables = (date: string, roleId: string) => variableIndex.date.get(date)?.filter(v => v.roleId === roleId) ?? [];
  const additionalRows: NonNullable<BuildOptions['additionalRows']> = [];
  for (const [slot, count] of placeDayCounts) {
    const [place, date] = slot.split('|');
    additionalRows.push({ terms: dateVariables(date!).filter(v => placeForRole[v.roleId] === place).map(v => ({ ...v, fixed: false })), lower: count, upper: count });
  }
  if (consultantEnabled) for (const [slot, counts] of slotCounts) {
    const date = slot.split('|')[0]!;
    for (const [roleId, count] of counts) additionalRows.push({ terms: dateRoleVariables(date!, roleId).map(v => ({ ...v, fixed: false })), lower: count, upper: count });
  }
  for (const staffDate of movableStaffDays.keys()) {
    const [staffId, date] = staffDate.split('|');
    additionalRows.push({ terms: staffDateVariables(staffId!, date!).map(v => ({ ...v, fixed: false })), lower: 1, upper: 1 });
  }
  const allowedChanges = changeLimit === 'none' ? movable.length : Math.floor(movable.length * Math.max(0, Math.min(100, changeLimit)) / 100 + 1e-9);
  const baselineSelectors = movable.flatMap(item => {
    const staffDate = `${item.staffId}|${item.date}`;
    const baselineList = consultantEnabled ? baselineListRoles[staffDate] : undefined;
    if (baselineList) return variableIndex.staffDateRole.get(`${item.staffId}|${item.date}|${baselineList}`)?.map(v => ({ ...v, fixed: false })) ?? [];
    const place = placeForRole[item.roleId ?? ''];
    if (consultantEnabled && slotCounts.has(`${item.date}|${place}`)) return staffDateVariables(item.staffId, item.date).filter(v => placeForRole[v.roleId] === place).map(v => ({ ...v, fixed: false }));
    return variableIndex.staffDateRole.get(`${item.staffId}|${item.date}|${item.roleId}`)?.map(v => ({ ...v, fixed: false })) ?? [];
  });
  if (changeLimit !== 'none') additionalRows.push({ terms: baselineSelectors, lower: movable.length - allowedChanges, upper: Infinity });
  const additionalVariables: NonNullable<BuildOptions['additionalVariables']> = [];
  const additionalObjectives: NonNullable<BuildOptions['additionalObjectives']> = [{ tier: 'extra', terms: baselineSelectors.map(term => ({ ...term, coefficient: -1 })) }];
  if (consultantEnabled) {
    const consultantCandidates = allowedVariables.filter(variable => selectedStaff(variable.staffId) && (consultantNames.get(variable.roleId)?.length ?? 0) > 0);
    const pairs = consultantCandidates.filter(variable => (ws.consultantPairs?.[variable.staffId] ?? []).some(pair => (consultantNames.get(variable.roleId) ?? []).some(name => name.toLocaleLowerCase('en-GB') === pair.toLocaleLowerCase('en-GB'))));
    additionalObjectives.push({ tier: 'paired', terms: pairs.map(variable => ({ ...variable, fixed: false, coefficient: -1 })) });

    const datesForDoctor = new Map<string, string[]>();
    const candidatesByStaffDate = new Map<string, typeof consultantCandidates>();
    for (const variable of consultantCandidates) {
      const key = `${variable.staffId}|${variable.date}`;
      candidatesByStaffDate.set(key, [...(candidatesByStaffDate.get(key) ?? []), variable]);
      const dates = datesForDoctor.get(variable.staffId) ?? [];
      if (!dates.includes(variable.date)) dates.push(variable.date);
      datesForDoctor.set(variable.staffId, dates);
    }
    for (const dates of datesForDoctor.values()) dates.sort();
    const movableByStaffDate = new Map(movable.map(item => [`${item.staffId}|${item.date}`, item]));
    const fallbackMetByStaff = new Map<string, { date: string; names: string[] }[]>();
    for (const [staffDate, names] of Object.entries(baselineByStaffDate)) {
      const [staffId, date] = staffDate.split('|');
      const assignment = movableByStaffDate.get(staffDate);
      const place = assignment && placeForRole[assignment.roleId ?? ''];
      if (!staffId || !date || !place || slotCounts.has(`${date}|${place}`)) continue;
      fallbackMetByStaff.set(staffId, [...(fallbackMetByStaff.get(staffId) ?? []), { date, names }]);
    }
    const indicator = new Map<string, string>();
    for (const [staffId, dateList] of datesForDoctor) for (const date of dateList) {
      const dayCandidates = candidatesByStaffDate.get(`${staffId}|${date}`) ?? [];
      const dayNames = [...new Set(dayCandidates.flatMap(variable => consultantNames.get(variable.roleId) ?? []))];
      for (const name of dayNames) {
        const variableId = `met:${staffId}:${date}:${name}`;
        indicator.set(`${staffId}|${date}|${name}`, variableId);
        additionalVariables.push({ id: variableId });
        const matching = dayCandidates.filter(variable => consultantNames.get(variable.roleId)?.includes(name));
        for (const variable of matching) additionalRows.push({ terms: [{ variableId }, { ...variable, fixed: false, coefficient: -1 }], lower: 0, upper: Infinity });
        additionalRows.push({ terms: [{ variableId }, ...matching.map(variable => ({ ...variable, fixed: false, coefficient: -1 }))], lower: -Infinity, upper: 0 });
      }
    }
    for (const variable of consultantCandidates) {
      const consultants = consultantNames.get(variable.roleId) ?? [];
      const fallbackMet = (fallbackMetByStaff.get(variable.staffId) ?? []).filter(item => item.date < variable.date).flatMap(item => item.names);
      const alreadyKnown = [...(metBeforeRangeByStaff[variable.staffId] ?? []), ...fallbackMet]
        .some(previous => consultants.some(name => name.toLocaleLowerCase('en-GB') === previous.toLocaleLowerCase('en-GB')));
      const previousDates = (datesForDoctor.get(variable.staffId) ?? []).filter(previous => previous < variable.date);
      const priorIndicators = [...new Set(previousDates.flatMap(previous => consultants.map(name => indicator.get(`${variable.staffId}|${previous}|${name}`)).filter((id): id is string => !!id)))];
      const repeatId = `repeat:${variable.staffId}:${variable.date}:${variable.roleId}`;
      additionalVariables.push({ id: repeatId });
      additionalRows.push({ terms: [{ variableId: repeatId }, { ...variable, fixed: false, coefficient: -1 }], lower: -Infinity, upper: 0 });
      if (alreadyKnown) additionalRows.push({ terms: [{ variableId: repeatId }, { ...variable, fixed: false, coefficient: -1 }], lower: 0, upper: 0 });
      else {
        additionalRows.push({ terms: [{ variableId: repeatId }, ...priorIndicators.map(variableId => ({ variableId, coefficient: -1 }))], lower: -Infinity, upper: 0 });
        for (const priorIndicator of priorIndicators) additionalRows.push({ terms: [{ variableId: repeatId }, { ...variable, fixed: false, coefficient: -1 }, { variableId: priorIndicator, coefficient: -1 }], lower: -1, upper: Infinity });
      }
      additionalObjectives.push({ tier: 'consultants', terms: [{ variableId: repeatId, coefficient: -1 }] });
    }
  }
  // Eligibility is the imported doctor-day set. Workspace unavailability cannot remove a person already working in this snapshot.
  // Non-movable work is retained separately and reattached after solving. The
  // solver's built-in overlap checks must not rewrite or reject imported work.
  const problem: RotaProblem = { profile: modelProfile, start, end, unavailability: [], fixed: [] };
  for (const [key, names] of baselineConsultants) baselineByStaffDate[key] = names;
  const consultantPlan: FairerConsultantPlan = {
    enabled: consultantEnabled, groupIds, typeIds,
    selectedStaffIds: ws.profile.staff.filter(person => selectedStaff(person.id)).map(person => person.id),
    pairs: Object.fromEntries(Object.entries(ws.consultantPairs ?? {}).map(([staffId, pairs]) => [staffId, [...pairs]])),
    slots: [...slotCounts].map(([slot, counts]) => { const [date, placeId] = slot.split('|'); return { date: date as ISODate, placeId: placeId!, roles: [...counts].map(([roleId, count]) => ({ roleId, count })) }; }),
    fallbackDays: invalidSlots.size, baselineByStaffDate, metBeforeRangeByStaff, validStaffDates: [...validStaffDates],
  };
  const buildOptions: BuildOptions = { allowedVariables, additionalRows, additionalObjectives, additionalVariables };
  return { problem, buildOptions, baseline: read.assignments, dayJobs, movable, dates, dayTypes: dayTypes.map(({ id, name }) => ({ id, name })), placeForRole, typeForRole: Object.fromEntries(typeByRole), comparisonByStaff: Object.fromEntries(ws.profile.staff.map(person => [person.id, sessionComparisonFor(person, ws.profile, settings, ws.sessionSubGroups ?? {}).comparisonId])), consultantsByRole, ratios: settings.ratios, maxChanges: allowedChanges, consultantPlan, baselineRoleByStaffDate: consultantEnabled ? baselineListRoles : {}, consultantGroupNames: groupIds.map(id => settings.groups.find(group => group.id === id)?.name).filter((name): name is string => !!name) };
}

export async function allocateFairerConsultants(
  model: FairerModel, ratioAssignments: Assignment[], remainingSeconds: number,
  reportProgress: NonNullable<import('../engine/solve').SolveOptions['onProgress']>,
  fairnessObjectiveBefore?: number,
): Promise<{ completeAssignments?: Assignment[]; skipTiers?: import('../engine/types').Tier[]; stages?: StageReport[]; note?: string; debug?: import('../engine/solve').SolveDebug } | undefined> {
  if (!model.consultantPlan.enabled) return undefined;
  let allocationStages: StageReport[] = [];
  const fallback = (check: string, _detail: string, repeatDays?: number, fairnessObjectiveAfter?: number) => ({
    skipTiers: ['paired', 'consultants'] as import('../engine/types').Tier[],
    note: fairerFallbackNote(check, fairnessObjectiveBefore, fairnessObjectiveAfter),
    ...(allocationStages.length ? { stages: [...allocationStages] } : {}),
    debug: { ...(repeatDays === undefined ? {} : { consultantRepeatDays: repeatDays }), consultantFallbackCheck: check, consultantFallbackDetail: _detail,
      ...(fairnessObjectiveBefore === undefined ? {} : { fairnessObjectiveBefore }), ...(fairnessObjectiveAfter === undefined ? {} : { fairnessObjectiveAfter }) },
  });
  if (remainingSeconds < 2) return fallback('time-budget', 'The consultant allocation could not be checked in the available time, so the ratios-stage rota was kept for the remaining Stage 4 aims.');

  const slotsByDatePlace = new Map(model.consultantPlan.slots.map(slot => [`${slot.date}|${slot.placeId}`, slot]));
  const workByDate = new Map<string, Assignment[]>();
  const theatreCountByDatePlace = new Map<string, number>();
  for (const item of model.movable) {
    workByDate.set(item.date, [...(workByDate.get(item.date) ?? []), item]);
    const type = model.typeForRole[item.roleId ?? ''], place = model.placeForRole[item.roleId ?? ''];
    if (!place || !model.consultantPlan.typeIds.includes(type ?? '')) continue;
    const key = `${item.date}|${place}`;
    theatreCountByDatePlace.set(key, (theatreCountByDatePlace.get(key) ?? 0) + 1);
  }
  const fallbackByDatePlace = new Map<string, number>();
  for (const [key, total] of theatreCountByDatePlace) {
    const known = slotsByDatePlace.get(key)?.roles.reduce((sum, role) => sum + role.count, 0) ?? 0;
    if (known > total) return fallback('list-slot-counts', 'The consultant slots did not match the imported theatre totals, so the ratios-stage rota was kept for the remaining Stage 4 aims.');
    if (total > known) fallbackByDatePlace.set(key, total - known);
  }

  const listRoleIds = new Set(model.consultantPlan.slots.flatMap(slot => slot.roles.map(role => role.roleId)));
  const fallbackRoleIds = new Set([...fallbackByDatePlace.keys()].map(key => key.split('|')[1]!));
  const nonTheatreRoleByDate = new Map(model.dates.map(date => [date, `fairer-non-theatre-${date}`]));
  const profile = structuredClone(model.problem.profile);
  profile.staff = profile.staff.filter(person => model.movable.some(item => item.staffId === person.id));
  profile.roles = profile.roles.filter(role => listRoleIds.has(role.id) || fallbackRoleIds.has(role.id));
  for (const roleId of nonTheatreRoleByDate.values()) profile.roles.push({ id: roleId, name: 'Other day work' });
  profile.rules = [];
  profile.fairness = [];
  profile.tierOrder = ['paired', 'consultants', 'preference'];
  profile.useSpareCapacity = false;
  profile.demands = [];

  const theatreRolesByDate = new Map<string, string[]>();
  for (const slot of model.consultantPlan.slots) theatreRolesByDate.set(slot.date, [...(theatreRolesByDate.get(slot.date) ?? []), ...slot.roles.map(role => role.roleId)]);
  for (const [key] of fallbackByDatePlace) {
    const [date, place] = key.split('|');
    theatreRolesByDate.set(date!, [...(theatreRolesByDate.get(date!) ?? []), place!]);
  }
  const theatreTotalByDate = new Map<string, number>();
  for (const [key, count] of theatreCountByDatePlace) {
    const date = key.split('|')[0]!;
    theatreTotalByDate.set(date, (theatreTotalByDate.get(date) ?? 0) + count);
  }
  const optionsByDate = new Map(model.dates.map(date => [date, [...(theatreRolesByDate.get(date) ?? []), nonTheatreRoleByDate.get(date)!]]));
  const allowedVariables = model.movable.flatMap(item => (optionsByDate.get(item.date) ?? []).map(roleId => ({ staffId: item.staffId, date: item.date, roleId, shiftTypeId: item.shiftTypeId })));
  const variableIndex = indexAllowed(allowedVariables, model.typeForRole);
  const staffDateVariables = (staffId: string, date: string) => variableIndex.staffDate.get(`${staffId}|${date}`) ?? [];
  const dateRoleVariables = (date: string, roleId: string) => variableIndex.date.get(date)?.filter(v => v.roleId === roleId) ?? [];
  const staffTypeVariables = (staffId: string, typeId: string) => variableIndex.staffType.get(`${staffId}|${typeId}`) ?? [];
  const additionalRows: NonNullable<BuildOptions['additionalRows']> = [];
  for (const item of model.movable) additionalRows.push({ terms: staffDateVariables(item.staffId, item.date).map(variable => ({ ...variable, fixed: false })), lower: 1, upper: 1 });
  for (const slot of model.consultantPlan.slots) for (const role of slot.roles) additionalRows.push({ terms: dateRoleVariables(slot.date, role.roleId).map(variable => ({ ...variable, fixed: false })), lower: role.count, upper: role.count });
  for (const [key, count] of fallbackByDatePlace) {
    const [date, roleId] = key.split('|');
    additionalRows.push({ terms: dateRoleVariables(date!, roleId!).map(variable => ({ ...variable, fixed: false })), lower: count, upper: count });
  }
  for (const date of model.dates) {
    const capacity = (workByDate.get(date)?.length ?? 0) - (theatreTotalByDate.get(date) ?? 0);
    const roleId = nonTheatreRoleByDate.get(date)!;
    additionalRows.push({ terms: dateRoleVariables(date, roleId).map(variable => ({ ...variable, fixed: false })), lower: capacity, upper: capacity });
  }

  const ratioTheatreByStaff = new Map<string, number>();
  for (const item of ratioAssignments) if (model.consultantPlan.typeIds.includes(model.typeForRole[item.roleId ?? ''] ?? '')) ratioTheatreByStaff.set(item.staffId, (ratioTheatreByStaff.get(item.staffId) ?? 0) + 1);
  const movableByStaff = new Map<string, Assignment[]>();
  for (const item of model.movable) movableByStaff.set(item.staffId, [...(movableByStaff.get(item.staffId) ?? []), item]);
  for (const [staffId, count] of ratioTheatreByStaff) {
    const terms = (movableByStaff.get(staffId) ?? []).flatMap(item => staffDateVariables(staffId, item.date).filter(variable => theatreRolesByDate.get(item.date)?.includes(variable.roleId)).map(variable => ({ ...variable, fixed: false })));
    additionalRows.push({ terms, lower: count, upper: count });
  }
  const theatreTypeCountByStaff = new Map<string, number>();
  for (const item of ratioAssignments) {
    const typeId = model.typeForRole[item.roleId ?? ''];
    if (!typeId || !model.consultantPlan.typeIds.includes(typeId) || !model.comparisonByStaff[item.staffId]) continue;
    const key = `${item.staffId}|${typeId}`;
    theatreTypeCountByStaff.set(key, (theatreTypeCountByStaff.get(key) ?? 0) + 1);
  }
  for (const staffId of new Set(Object.entries(model.comparisonByStaff).filter(([, group]) => !!group).map(([id]) => id))) for (const typeId of model.consultantPlan.typeIds) {
    const count = theatreTypeCountByStaff.get(`${staffId}|${typeId}`) ?? 0;
    const terms = staffTypeVariables(staffId, typeId).map(variable => ({ ...variable, fixed: false }));
    additionalRows.push({ terms, lower: count, upper: count });
  }

  const ratioByStaffDate = new Map(ratioAssignments.map(item => [`${item.staffId}|${item.date}`, item]));
  const ratioByDate = new Map<string, Assignment[]>();
  for (const item of ratioAssignments) ratioByDate.set(item.date, [...(ratioByDate.get(item.date) ?? []), item]);
  const ratioMatchTerms: NonNullable<BuildOptions['additionalRows']>[number]['terms'] = [];
  for (const item of model.movable) {
    const baseline = ratioByStaffDate.get(`${item.staffId}|${item.date}`);
    if (!baseline) continue;
    const baselineIsTheatre = model.consultantPlan.typeIds.includes(model.typeForRole[baseline.roleId ?? ''] ?? '');
    const baselineNames = model.consultantsByRole[baseline.roleId ?? ''] ?? [];
    const same = staffDateVariables(item.staffId, item.date).filter(variable => (
      baselineIsTheatre
        ? theatreRolesByDate.get(item.date)?.includes(variable.roleId) && (baselineNames.length
          ? variable.roleId === baseline.roleId
          : model.placeForRole[variable.roleId] === model.placeForRole[baseline.roleId ?? ''])
        : variable.roleId === nonTheatreRoleByDate.get(item.date)
    ));
    ratioMatchTerms.push(...same.map(variable => ({ ...variable, fixed: false })));
  }

  for (const date of model.dates) for (const roleId of new Set(optionsByDate.get(date))) {
    let max = roleId === nonTheatreRoleByDate.get(date) ? (workByDate.get(date)?.length ?? 0) - (theatreTotalByDate.get(date) ?? 0) : 0;
    for (const slot of model.consultantPlan.slots) if (slot.date === date) max = Math.max(max, slot.roles.find(role => role.roleId === roleId)?.count ?? 0);
    for (const [key, count] of fallbackByDatePlace) if (key === `${date}|${roleId}`) max = count;
    const shifts = [...new Set((workByDate.get(date) ?? []).map(item => item.shiftTypeId))];
    for (const shiftTypeId of shifts) profile.demands.push({ id: `consultant-sub-${date}-${roleId}-${shiftTypeId}`, roleId, shiftTypeId, days: { dates: [date] }, min: 0, max });
  }

  const selected = new Set(model.consultantPlan.selectedStaffIds);
  const objectives: NonNullable<BuildOptions['additionalObjectives']> = [];
  const aimCandidates = allowedVariables.filter(variable => selected.has(variable.staffId) && !!model.consultantsByRole[variable.roleId]?.length);
  const aimCandidatesByStaffDate = new Map<string, typeof aimCandidates>();
  for (const variable of aimCandidates) {
    const key = `${variable.staffId}|${variable.date}`;
    aimCandidatesByStaffDate.set(key, [...(aimCandidatesByStaffDate.get(key) ?? []), variable]);
  }
  const pairTerms = aimCandidates.filter(variable => (model.consultantPlan.pairs[variable.staffId] ?? []).some(pair => (model.consultantsByRole[variable.roleId] ?? []).some(name => name.toLocaleLowerCase('en-GB') === pair.toLocaleLowerCase('en-GB'))));
  objectives.push({ tier: 'paired', terms: pairTerms.map(variable => ({ ...variable, fixed: false, coefficient: -1 })) });
  const candidateDates = new Map<string, string[]>();
  for (const variable of aimCandidates) candidateDates.set(variable.staffId, [...new Set([...(candidateDates.get(variable.staffId) ?? []), variable.date])].sort());
  const metIndicators = new Map<string, string>();
  const variables: NonNullable<BuildOptions['additionalVariables']> = [];
  for (const [staffId, dates] of candidateDates) for (const date of dates) {
    const day = aimCandidatesByStaffDate.get(`${staffId}|${date}`) ?? [];
    const names = [...new Set(day.flatMap(variable => model.consultantsByRole[variable.roleId] ?? []))];
    for (const name of names) {
      const id = `met:${staffId}:${date}:${name}`;
      metIndicators.set(`${staffId}|${date}|${name.toLocaleLowerCase('en-GB')}`, id);
      variables.push({ id });
      const matching = day.filter(variable => (model.consultantsByRole[variable.roleId] ?? []).some(item => item.toLocaleLowerCase('en-GB') === name.toLocaleLowerCase('en-GB')));
      for (const variable of matching) additionalRows.push({ terms: [{ variableId: id }, { ...variable, fixed: false, coefficient: -1 }], lower: 0, upper: Infinity });
      additionalRows.push({ terms: [{ variableId: id }, ...matching.map(variable => ({ ...variable, fixed: false, coefficient: -1 }))], lower: -Infinity, upper: 0 });
    }
  }
  for (const variable of aimCandidates) {
    const names = model.consultantsByRole[variable.roleId] ?? [];
    const alreadyMet = names.some(name => (model.consultantPlan.metBeforeRangeByStaff[variable.staffId] ?? []).some(previous => previous.toLocaleLowerCase('en-GB') === name.toLocaleLowerCase('en-GB')));
    const repeatId = `repeat:${variable.staffId}:${variable.date}:${variable.roleId}`;
    variables.push({ id: repeatId });
    additionalRows.push({ terms: [{ variableId: repeatId }, { ...variable, fixed: false, coefficient: -1 }], lower: -Infinity, upper: 0 });
    if (alreadyMet) additionalRows.push({ terms: [{ variableId: repeatId }, { ...variable, fixed: false, coefficient: -1 }], lower: 0, upper: 0 });
    else {
      const previousDates = (candidateDates.get(variable.staffId) ?? []).filter(previous => previous < variable.date);
      const previousMet = [...new Set(previousDates.flatMap(previous => names.map(name => metIndicators.get(`${variable.staffId}|${previous}|${name.toLocaleLowerCase('en-GB')}`)).filter((id): id is string => !!id)))];
      additionalRows.push({ terms: [{ variableId: repeatId }, ...previousMet.map(indicator => ({ variableId: indicator, coefficient: -1 }))], lower: -Infinity, upper: 0 });
      for (const indicator of previousMet) additionalRows.push({ terms: [{ variableId: repeatId }, { ...variable, fixed: false, coefficient: -1 }, { variableId: indicator, coefficient: -1 }], lower: -1, upper: Infinity });
    }
    objectives.push({ tier: 'consultants', terms: [{ variableId: repeatId, coefficient: -1 }] });
  }
  objectives.push({ tier: 'preference', terms: ratioMatchTerms.map(term => ({ ...term, coefficient: -1 })) });

  const subproblem: RotaProblem = { profile, start: model.problem.start, end: model.problem.end, unavailability: [], fixed: [] };
  const allocationOptions: BuildOptions = { allowedVariables, additionalRows, additionalVariables: variables, additionalObjectives: objectives };
  const solveAllocation = (extraRows: NonNullable<BuildOptions['additionalRows']>, timeLimit: number) => solve(subproblem, {
    timeLimit: Math.max(1, timeLimit), gap: 0,
    buildOptions: { ...allocationOptions, additionalRows: [...additionalRows, ...extraRows] },
    smallConsultantProofShare: 1,
    onProgress: reportProgress,
  });
  // Keep most of the remaining time for the full-rota completion. The
  // theatre-only model is smaller, but its result still needs to pass every
  // Stage 4 hard check when combined with fixed on-calls and rest constraints.
  const allocationBudget = fairerConsultantBudget(remainingSeconds);
  const allocation = await solveAllocation([], allocationBudget);
  if (!allocation.ok) return fallback('theatre-subproblem-infeasible', 'The theatre-only consultant allocation could not be solved; the ratios-stage rota was kept for the remaining Stage 4 aims.');
  allocationStages = allocation.stages;

  const theatrePlanOf = (items: Assignment[]) => items.filter(item => model.consultantPlan.typeIds.includes(model.typeForRole[item.roleId ?? ''] ?? ''));
  const hasPreservedCounts = (plan: Assignment[]) => {
    const counts = new Map<string, number>();
    for (const item of plan) counts.set(item.staffId, (counts.get(item.staffId) ?? 0) + 1);
    return [...ratioTheatreByStaff].every(([staffId, count]) => (counts.get(staffId) ?? 0) === count);
  };
  const makeCompletionStart = (plan: Assignment[]) => {
    const planByStaffDate = new Map(plan.map(item => [`${item.staffId}|${item.date}`, item]));
    const planByDate = new Map<string, Assignment[]>();
    for (const item of plan) planByDate.set(item.date, [...(planByDate.get(item.date) ?? []), item]);
    const replacements = new Map<string, Assignment>();
    for (const date of model.dates) {
      const onTheatre = planByDate.get(date) ?? [];
      const baselineTheatre = (ratioByDate.get(date) ?? []).filter(item => model.consultantPlan.typeIds.includes(model.typeForRole[item.roleId ?? ''] ?? ''));
      const incoming = onTheatre.filter(item => !model.consultantPlan.typeIds.includes(model.typeForRole[ratioByStaffDate.get(`${item.staffId}|${date}`)?.roleId ?? ''] ?? ''));
      const outgoing = baselineTheatre.filter(item => !planByStaffDate.has(`${item.staffId}|${date}`));
      if (incoming.length !== outgoing.length) return undefined;
      incoming.sort((a, b) => a.staffId.localeCompare(b.staffId));
      outgoing.sort((a, b) => a.staffId.localeCompare(b.staffId));
      incoming.forEach((item, index) => {
        const oldIncoming = ratioByStaffDate.get(`${item.staffId}|${date}`);
        const displaced = outgoing[index];
        if (oldIncoming?.roleId && displaced) replacements.set(`${displaced.staffId}|${date}`, { ...displaced, roleId: oldIncoming.roleId });
      });
    }
    return model.movable.flatMap(base => {
      const key = `${base.staffId}|${base.date}`;
      const theatre = planByStaffDate.get(key);
      if (theatre) return [theatre];
      const swapped = replacements.get(key);
      const initial = ratioByStaffDate.get(key);
      return swapped ? [swapped] : initial ? [initial] : [];
    });
  };
  const tryComplete = async (plan: Assignment[], timeLimit: number) => {
    const initialAssignments = makeCompletionStart(plan);
    if (!initialAssignments) return { reason: 'theatre-counts-changed' as const };
    const completionRows: NonNullable<BuildOptions['additionalRows']> = plan.map(item => ({ terms: [{ staffId: item.staffId, date: item.date, roleId: item.roleId, shiftTypeId: item.shiftTypeId, fixed: false }], lower: 1, upper: 1 }));
    const completionProfile = structuredClone(model.problem.profile);
    completionProfile.tierOrder = ['fairness', 'preference', 'extra'];
    const completionOptions: BuildOptions = {
      ...model.buildOptions,
      additionalRows: [...(model.buildOptions.additionalRows ?? []), ...completionRows],
      additionalObjectives: (model.buildOptions.additionalObjectives ?? []).filter(objective => objective.tier === 'extra'),
    };
    const consistentStart = () => {
      const byStaffDate = new Map(initialAssignments.map(item => [`${item.staffId}|${item.date}`, item]));
      if (byStaffDate.size !== model.movable.length || model.movable.some(base => {
        const item = byStaffDate.get(`${base.staffId}|${base.date}`);
        return !item || item.shiftTypeId !== base.shiftTypeId;
      })) return false;
      const allowed = new Set((model.buildOptions.allowedVariables ?? []).map(item => `${item.staffId}|${item.date}|${item.roleId}|${item.shiftTypeId}`));
      if (initialAssignments.some(item => !allowed.has(`${item.staffId}|${item.date}|${item.roleId}|${item.shiftTypeId}`))) return false;
      if (plan.some(item => byStaffDate.get(`${item.staffId}|${item.date}`)?.roleId !== item.roleId)) return false;
      return !validateFairerResult(model, combineFairerAssignments(model, initialAssignments));
    };
    const startIsConsistent = consistentStart();
    const completion = await solve({ ...model.problem, profile: completionProfile }, {
      timeLimit: Math.max(1, timeLimit), buildOptions: completionOptions,
      // Only pass a complete x-variable start when it satisfies the fixed plan
      // and the completion rows; auxiliary consultant indicators remain free.
      ...(startIsConsistent ? { initialAssignments } : {}), onProgress: reportProgress,
    });
    if (!completion.ok) return { reason: 'full-rota-infeasible' as const, completion, issue: completion.conflicts.map(conflict => `${conflict.ruleName}: ${conflict.instances.map(instance => instance.detail).join(', ')}`).join('; ') };
    const fairnessObjectiveAfter = completion.stages.find(stage => stage.tier === 'fairness')?.objective;
    if (!fairnessWithinAllowance(fairnessObjectiveBefore, fairnessObjectiveAfter)) return { reason: 'fairness-over-allowance' as const, completion, fairnessObjectiveAfter };
    if (fairnessObjectiveBefore !== undefined && fairnessObjectiveAfter === undefined) return { reason: 'fairness-objective-missing' as const, completion, fairnessObjectiveAfter };
    const issue = validateFairerResult(model, combineFairerAssignments(model, completion.assignments));
    if (issue) return { reason: 'stage-4-validation' as const, completion, fairnessObjectiveAfter, issue };
    return { reason: undefined, completion, fairnessObjectiveAfter };
  };

  const firstPlan = theatrePlanOf(allocation.assignments);
  if (!hasPreservedCounts(firstPlan)) return fallback('theatre-counts-changed', 'The theatre allocation did not preserve each doctor’s ratio-stage theatre count; the ratios-stage result was kept.', -((allocation.stages.find(stage => stage.tier === 'consultants')?.objective) ?? 0));
  const firstRepeatDays = Math.max(0, -((allocation.stages.find(stage => stage.tier === 'consultants')?.objective) ?? 0));
  const firstCompletionBudget = Math.max(1, remainingSeconds - allocation.seconds);
  const firstCompletion = await tryComplete(firstPlan, firstCompletionBudget);
  if (!firstCompletion.reason && 'completion' in firstCompletion && firstCompletion.completion?.ok) return {
    completeAssignments: firstCompletion.completion.assignments,
    stages: [...allocation.stages, ...firstCompletion.completion.stages],
    ...(fairnessAllowanceNote(fairnessObjectiveBefore, firstCompletion.fairnessObjectiveAfter, model.consultantGroupNames?.join(' and ') || 'the configured group') ? { note: fairnessAllowanceNote(fairnessObjectiveBefore, firstCompletion.fairnessObjectiveAfter, model.consultantGroupNames?.join(' and ') || 'the configured group') } : {}),
    debug: { consultantRepeatDays: firstRepeatDays, ...(fairnessObjectiveBefore === undefined ? {} : { fairnessObjectiveBefore }), ...(firstCompletion.fairnessObjectiveAfter === undefined ? {} : { fairnessObjectiveAfter: firstCompletion.fairnessObjectiveAfter }) },
  };

  const reason = firstCompletion.reason ?? 'full-rota-infeasible';
  const after = 'fairnessObjectiveAfter' in firstCompletion ? firstCompletion.fairnessObjectiveAfter : undefined;
  const issue = 'issue' in firstCompletion ? firstCompletion.issue : undefined;
  return fallback(reason, issue ?? reason, firstRepeatDays, after);
}

export function combineFairerAssignments(model: FairerModel, movable: Assignment[]): Assignment[] {
  const movingDays = new Set(model.movable.map(item => `${item.staffId}|${item.date}`));
  return [...model.baseline.filter(item => !movingDays.has(`${item.staffId}|${item.date}`)).map(item => ({ ...item, fixed: true })), ...movable];
}

export function validateFairerResult(model: FairerModel, assignments: Assignment[]): string | undefined {
  const baselineMovableDays = new Set(model.movable.map(item => `${item.staffId}|${item.date}`));
  const baselineByStaffDate = new Map(model.movable.map(item => [`${item.staffId}|${item.date}`, item]));
  const afterByStaffDate = new Map<string, Assignment[]>();
  for (const item of assignments) if (!item.fixed && model.dates.includes(item.date) && item.roleId && model.typeForRole[item.roleId]) {
    const k = `${item.staffId}|${item.date}`; afterByStaffDate.set(k, [...(afterByStaffDate.get(k) ?? []), item]);
  }
  const fixed = model.baseline.filter(item => !baselineMovableDays.has(`${item.staffId}|${item.date}`));
  const returned = new Set(assignments.map(key));
  for (const item of fixed) if (!returned.has(key(item))) return 'A fixed imported assignment changed during optimisation.';
  const movableStaffDays = new Set(model.movable.map(item => `${item.staffId}|${item.date}`));
  const after = [...afterByStaffDate.values()].flat();
  for (const item of after) if (!movableStaffDays.has(`${item.staffId}|${item.date}`)) return 'The suggestion assigned a session to a doctor-day that was not working in the imported rota.';
  for (const staffDate of movableStaffDays) {
    const assigned = afterByStaffDate.get(staffDate) ?? [];
    if (assigned.length !== 1) return 'A working doctor-day does not have exactly one movable session.';
    const base = baselineByStaffDate.get(staffDate)!;
    if (assigned[0]!.shiftTypeId !== base.shiftTypeId) return 'A moved session changed its imported shift time.';
  }
  const countFor = (items: Assignment[]) => {
    const out = new Map<string, number>();
    for (const item of items) if (item.roleId && model.typeForRole[item.roleId]) {
      const place = model.placeForRole[item.roleId] ?? item.roleId;
      const k = `${place}|${item.date}`; out.set(k, (out.get(k) ?? 0) + 1);
    }
    return out;
  };
  const beforeCounts = countFor(model.movable), afterCounts = countFor(after);
  for (const slot of new Set([...beforeCounts.keys(), ...afterCounts.keys()])) if (afterCounts.get(slot) !== beforeCounts.get(slot)) return 'The number of sessions at a place on a day changed.';
  const changed = model.movable.length - model.movable.filter(item => (afterByStaffDate.get(`${item.staffId}|${item.date}`) ?? []).some(next => {
    if (next.shiftTypeId !== item.shiftTypeId) return false;
    const baselineRole = model.baselineRoleByStaffDate[`${item.staffId}|${item.date}`];
    return baselineRole ? next.roleId === baselineRole : model.placeForRole[next.roleId ?? ''] === model.placeForRole[item.roleId ?? ''];
  })).length;
  if (changed > model.maxChanges) return 'The suggestion exceeded the selected change limit.';
  if (model.maxChanges === 0 && changed !== 0) return 'The 0% limit must leave the imported assignments unchanged.';
  return undefined;
}

export interface ConsultantDoctorReport { staffId: string; name: string; theatreDays: number; theatreDaysAfter: number; differentBefore: number; differentAfter: number; repeatBefore: number; repeatAfter: number; matchedDaysBefore: number; matchedDaysAfter: number; consultantsBefore: { name: string; days: number }[]; consultantsAfter: { name: string; days: number }[]; pairedBefore?: number; pairedAfter?: number; }
export interface ConsultantReport { rows: ConsultantDoctorReport[]; averageBefore: number; averageAfter: number; repeatBefore: number; repeatAfter: number; doctorsThreeBefore: number; doctorsThreeAfter: number; fallbackDays: number; }

export function consultantReport(model: FairerModel, suggestion: Assignment[], ws: Workspace): ConsultantReport {
  const settings = ws.sessions ?? defaultSessionsSettings(ws.profile);
  const selected = new Set(model.consultantPlan.groupIds);
  const typeIds = new Set(model.consultantPlan.typeIds);
  const staff = ws.profile.staff.filter(person => !person.locum && selected.has(sessionComparisonFor(person, ws.profile, settings, ws.sessionSubGroups ?? {}).groupId ?? ''));
  const roles = roleConsultants(ws.profile);
  const allTheatre = model.movable.filter(item => typeIds.has(model.typeForRole[item.roleId ?? '']));
  const beforeByStaff = new Map<string, Assignment[]>(), afterByStaff = new Map<string, Assignment[]>();
  for (const item of allTheatre) beforeByStaff.set(item.staffId, [...(beforeByStaff.get(item.staffId) ?? []), item]);
  for (const item of suggestion) if (!item.fixed && typeIds.has(model.typeForRole[item.roleId ?? ''] ?? '')) afterByStaff.set(item.staffId, [...(afterByStaff.get(item.staffId) ?? []), item]);
  const assignedNames = (item: Assignment, before: boolean) => {
    const key = `${item.staffId}|${item.date}`;
    if (before) return model.consultantPlan.baselineByStaffDate[key] ?? [];
    const dynamicNames = model.consultantsByRole[item.roleId ?? ''];
    if (dynamicNames?.length) return dynamicNames;
    const names = roles.get(item.roleId ?? '') ?? [];
    if (names.length) return names;
    return [];
  };
  const rows = staff.map(person => {
    const beforeItems = (beforeByStaff.get(person.id) ?? []).sort((a, b) => a.date.localeCompare(b.date));
    const afterItems = (afterByStaff.get(person.id) ?? []).sort((a, b) => a.date.localeCompare(b.date));
    const measure = (items: Assignment[], before: boolean) => {
      const met = new Set(model.consultantPlan.metBeforeRangeByStaff[person.id] ?? []);
      const consultants = new Map<string, number>();
      let repeated = 0, paired = 0, matchedDays = 0;
      const pair = ws.consultantPairs?.[person.id] ?? [];
      for (const item of items) {
        const names = assignedNames(item, before);
        if (!names.length) continue;
        matchedDays++;
        if (names.some(name => met.has(name))) repeated++;
        if (pair.some(name => names.includes(name))) paired++;
        for (const name of new Set(names)) { consultants.set(name, (consultants.get(name) ?? 0) + 1); met.add(name); }
      }
      return { consultants: consultants.size, consultantDays: [...consultants].map(([name, days]) => ({ name, days })).sort((a, b) => b.days - a.days || a.name.localeCompare(b.name)), repeated, paired, matchedDays };
    };
    const before = measure(beforeItems, true), after = measure(afterItems, false);
    return { staffId: person.id, name: person.name, theatreDays: beforeItems.length, theatreDaysAfter: afterItems.length, differentBefore: before.consultants, differentAfter: after.consultants, repeatBefore: before.repeated, repeatAfter: after.repeated, matchedDaysBefore: before.matchedDays, matchedDaysAfter: after.matchedDays, consultantsBefore: before.consultantDays, consultantsAfter: after.consultantDays, ...(ws.consultantPairs?.[person.id]?.length ? { pairedBefore: before.paired, pairedAfter: after.paired } : {}) };
  });
  const matchedBefore = rows.reduce((sum, row) => sum + row.matchedDaysBefore, 0);
  const matchedAfter = rows.reduce((sum, row) => sum + row.matchedDaysAfter, 0);
  const avg = (field: 'differentBefore' | 'differentAfter') => rows.length ? rows.reduce((sum, row) => sum + row[field], 0) / rows.length : 0;
  const countThree = (before: boolean) => rows.filter(row => {
    const frequency = new Map<string, number>();
    const items = before ? beforeByStaff.get(row.staffId) ?? [] : afterByStaff.get(row.staffId) ?? [];
    for (const item of items) for (const name of assignedNames(item, before)) frequency.set(name, (frequency.get(name) ?? 0) + 1);
    return [...frequency.values()].some(count => count >= 3);
  }).length;
  const totals = (before: boolean) => rows.reduce((sum, row) => sum + (before ? row.repeatBefore : row.repeatAfter), 0);
  return { rows, averageBefore: avg('differentBefore'), averageAfter: avg('differentAfter'), repeatBefore: matchedBefore ? totals(true) / matchedBefore * 100 : 0, repeatAfter: matchedAfter ? totals(false) / matchedAfter * 100 : 0, doctorsThreeBefore: countThree(true), doctorsThreeAfter: countThree(false), fallbackDays: model.consultantPlan.fallbackDays };
}

export function latestImportedAt(snapshot: RotaSnapshot): string | undefined { return Object.values(snapshot.importedAt).sort().at(-1); }
export function personForId(profile: Profile, id: string): Staff | undefined { return profile.staff.find(person => person.id === id); }
