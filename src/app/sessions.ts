import { addDays, dateRange } from '../engine/calendar';
import { snapshotAssignments, type RotaSnapshot } from '../engine/swaps';
import type { ISODate, Profile, Staff } from '../engine/types';

export interface SessionTypeSetting {
  id: string;
  name: string;
  colour: number;
  kind: 'day' | 'on-call';
  placeIds: string[];
}
export interface SessionSubGroup {
  id: string;
  name: string;
  grades: string[];
}
export interface SessionComparisonGroup {
  id: string;
  name: string;
  grades: string[];
  /** Explicit placements for doctors without a MediRota grade. */
  staffIds?: string[];
  subGroups?: SessionSubGroup[];
}
export interface SessionsSettings {
  types: SessionTypeSetting[];
  groups: SessionComparisonGroup[];
  ratios: Record<string, Record<string, number>>;
  sameConsultants?: { groupIds: string[]; typeIds: string[] };
}
export interface SessionActivityCount { activity: string; count: number }
export interface SessionPersonCounts {
  staff: Staff;
  groupId?: string;
  comparisonId?: string;
  counts: Record<string, number>;
  extras: number;
  availability: number;
  targets: Record<string, number>;
}
export interface SessionAnalysis {
  people: SessionPersonCounts[];
  types: SessionTypeSetting[];
  groups: SessionComparisonGroup[];
  unmapped: SessionActivityCount[];
  ignored: SessionActivityCount[];
  dates: ISODate[];
}
export interface SessionEntry { date: ISODate; activity: string; amount: number; extra: boolean }
export interface GradeSessionRow { id: string; name: string; count: number; fte: number; availability: number; actual: Record<string, number>; intended: Record<string, number>; totals: Record<string, number> }

export const SESSION_COLOURS = [
  { number: 1, label: 'Blue', value: '#dce6f7' },
  { number: 2, label: 'Green', value: '#ddefe4' },
  { number: 3, label: 'Amber', value: '#fbe6d4' },
  { number: 4, label: 'Rose', value: '#f6dfe6' },
  { number: 5, label: 'Slate', value: '#e3eaed' },
  { number: 6, label: 'Teal', value: '#d9efec' },
  { number: 7, label: 'Purple', value: '#ece3f2' },
  { number: 8, label: 'Grey', value: '#eaeeed' },
  { number: 9, label: 'Indigo', value: '#e1e5f5' },
  { number: 10, label: 'Coral', value: '#f6e0d9' },
  { number: 11, label: 'Mint', value: '#dcefe9' },
  { number: 12, label: 'Lavender', value: '#ebe4fa' },
  { number: 13, label: 'Lemon', value: '#f2efcf' },
  { number: 14, label: 'Sky', value: '#dceaf1' },
  { number: 15, label: 'Mauve', value: '#f0e1ee' },
  { number: 16, label: 'Olive', value: '#e8edda' },
] as const;

function gradeKey(grade: string): string { return grade.trim().toLocaleLowerCase('en-GB'); }

export function defaultSessionsSettings(profile: Profile): SessionsSettings {
  void profile;
  return { types: [], groups: [], ratios: {}, sameConsultants: { groupIds: [], typeIds: [] } };
}

export function sessionDateRange(snapshot?: RotaSnapshot): { start: ISODate; end: ISODate } | undefined {
  const weeks = Object.keys(snapshot?.importedAt ?? {}).sort();
  return weeks.length ? { start: weeks[0], end: addDays(weeks.at(-1)!, 6) } : undefined;
}

export function sessionForPlace(settings: SessionsSettings, placeId?: string): SessionTypeSetting | undefined {
  if (!placeId) return undefined;
  return settings.types.find(type => type.placeIds.includes(placeId));
}

export function sessionValue(status: string, sessions?: string[]): number {
  if (status === 'longDay' || status === 'night') return 1;
  if (status === 'partShift') return 0.5;
  if (status !== 'dayJob') return 0;
  if (sessions?.includes('am') && sessions.includes('pm')) return 1;
  return 0.5;
}

function isSessionWork(status: string): boolean {
  return status === 'dayJob' || status === 'longDay' || status === 'partShift' || status === 'night';
}

export function isIgnoredSessionActivity(activity?: string): boolean {
  return !!activity && (activity.endsWith('[Removed]') || activity.includes('…') || activity.includes('&hellip;'));
}

export function gradeForStaff(staff: Staff, profile: Profile): string | undefined {
  const firstGroupId = staff.groupIds[0];
  return profile.groups.find(group => group.id === firstGroupId)?.name.trim() || undefined;
}

function comparisonFor(staff: Staff, profile: Profile, settings: SessionsSettings, placements: Record<string, string>): { groupId?: string; comparisonId?: string } {
  const grade = gradeForStaff(staff, profile);
  const group = settings.groups.find(candidate => candidate.staffIds?.includes(staff.id) || (!!grade && candidate.grades.some(item => gradeKey(item) === gradeKey(grade))));
  if (!group) return {};
  if (group.staffIds?.includes(staff.id)) return { groupId: group.id, comparisonId: group.id };
  if (!group.subGroups?.length) return { groupId: group.id, comparisonId: group.id };
  const byGrade = grade ? group.subGroups.find(subgroup => subgroup.grades.some(item => gradeKey(item) === gradeKey(grade))) : undefined;
  if (byGrade) return { groupId: group.id, comparisonId: byGrade.id };
  const placed = placements[staff.id];
  return placed && group.subGroups.some(subgroup => subgroup.id === placed) ? { groupId: group.id, comparisonId: placed } : { groupId: group.id };
}

export function sessionComparisonFor(staff: Staff, profile: Profile, settings: SessionsSettings, placements: Record<string, string> = {}) {
  return comparisonFor(staff, profile, settings, placements);
}

export function sessionGroupOptions(settings: SessionsSettings): { id: string; groupId: string; name: string }[] {
  return settings.groups.flatMap(group => group.subGroups?.length
    ? group.subGroups.map(subgroup => ({ id: subgroup.id, groupId: group.id, name: `${group.name} · ${subgroup.name}` }))
    : [{ id: group.id, groupId: group.id, name: group.name }]);
}

export function sessionEntries(profile: Profile, snapshot: RotaSnapshot, settings: SessionsSettings, staffId: string, start: ISODate, end: ISODate, typeId?: string): SessionEntry[] {
  const converted = snapshotAssignments(profile, snapshot, dateRange(start, end));
  const roles = new Map(converted.profile.roles.map(role => [role.id, role]));
  const type = typeId ? settings.types.find(item => item.id === typeId) : undefined;
  return converted.assignments.flatMap(assignment => {
    if (assignment.staffId !== staffId) return [];
    const day = snapshot.days[staffId]?.[assignment.date];
    if (!day || !isSessionWork(day.status) || isIgnoredSessionActivity(day.activity)) return [];
    const role = assignment.roleId ? roles.get(assignment.roleId) : undefined;
    const mapped = settings.types.find(item => item.placeIds.includes(role?.parentId ?? role?.id ?? ''));
    if (!day.extra && (!type || mapped?.id !== type.id)) return [];
    if (day.extra && type) return [];
    return [{ date: assignment.date, activity: day.activity ?? '', amount: sessionValue(day.status, day.sessions), extra: !!day.extra }];
  });
}

export function analyseSessions(
  profile: Profile, snapshot: RotaSnapshot, settings: SessionsSettings, placements: Record<string, string>,
  start: ISODate, end: ISODate,
): SessionAnalysis {
  const dates = dateRange(start, end);
  const converted = snapshotAssignments(profile, snapshot, dates);
  const placeTypes = new Map<string, SessionTypeSetting>();
  for (const type of settings.types) for (const placeId of type.placeIds) placeTypes.set(placeId, type);
  const roleById = new Map(converted.profile.roles.map(role => [role.id, role]));
  const counts = new Map<string, Record<string, number>>();
  const extraCounts = new Map<string, number>();
  const unmappedCounts = new Map<string, number>();
  const ignoredCounts = new Map<string, number>();
  for (const assignment of converted.assignments) {
    const day = snapshot.days[assignment.staffId]?.[assignment.date];
    if (!day || !isSessionWork(day.status)) continue;
    const activity = day.activity ?? '';
    if (isIgnoredSessionActivity(activity)) {
      ignoredCounts.set(activity, (ignoredCounts.get(activity) ?? 0) + 1);
      continue;
    }
    if (day.extra) {
      extraCounts.set(assignment.staffId, (extraCounts.get(assignment.staffId) ?? 0) + sessionValue(day.status, day.sessions));
      continue;
    }
    const role = assignment.roleId ? roleById.get(assignment.roleId) : undefined;
    const type = placeTypes.get(role?.parentId ?? role?.id ?? '');
    if (!type) {
      if (activity) unmappedCounts.set(activity, (unmappedCounts.get(activity) ?? 0) + 1);
      continue;
    }
    const byType = counts.get(assignment.staffId) ?? {};
    byType[type.id] = (byType[type.id] ?? 0) + sessionValue(day.status, day.sessions);
    counts.set(assignment.staffId, byType);
  }

  const leaveDays = new Map(profile.staff.map(person => [person.id, new Set(dates.filter(date => snapshot.days[person.id]?.[date]?.status === 'leave'))]));
  const people = profile.staff.filter(person => !person.locum || person.regularLocum).map(staff => {
    const { groupId, comparisonId } = comparisonFor(staff, profile, settings, placements);
    const availabilityDays = dates.filter(date => (!staff.startDate || date >= staff.startDate) && (!staff.endDate || date <= staff.endDate)).length;
    const availability = Math.max(0, availabilityDays * staff.fte - (leaveDays.get(staff.id)?.size ?? 0));
    return { staff, groupId, comparisonId, counts: counts.get(staff.id) ?? {}, extras: extraCounts.get(staff.id) ?? 0, availability, targets: {} as Record<string, number> };
  });

  for (const type of settings.types) {
    const counted = people.filter(person => !person.staff.locum && !!person.groupId && !!person.comparisonId);
    const total = counted.reduce((sum, person) => sum + (person.counts[type.id] ?? 0), 0);
    const denominator = counted.reduce((sum, person) => sum + (settings.ratios[type.id]?.[person.groupId!] ?? 1) * person.availability, 0);
    if (!denominator) continue;
    for (const person of counted) {
      person.targets[type.id] = total * ((settings.ratios[type.id]?.[person.groupId!] ?? 1) * person.availability) / denominator;
    }
  }

  return {
    people, types: settings.types, groups: settings.groups,
    unmapped: [...unmappedCounts].map(([activity, count]) => ({ activity, count })).sort((a, b) => a.activity.localeCompare(b.activity)),
    ignored: [...ignoredCounts].map(([activity, count]) => ({ activity, count })).sort((a, b) => a.activity.localeCompare(b.activity)),
    dates,
  };
}

export function offTarget(done: number, target: number): 'under' | 'over' | undefined {
  if (target <= 0) return undefined;
  if (target - done > 2 && done < target * 0.8) return 'under';
  if (done - target > 2 && done > target * 1.2) return 'over';
  return undefined;
}

export function formatSessions(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

export function gradeSessionRates(analysis: SessionAnalysis, settings: SessionsSettings): GradeSessionRow[] {
  const groups = settings.groups.flatMap(group => group.subGroups?.length
    ? group.subGroups.map(subgroup => ({ id: subgroup.id, name: `${group.name} · ${subgroup.name}`, parentId: group.id }))
    : [{ id: group.id, name: group.name, parentId: group.id }]);
  const rows: GradeSessionRow[] = groups.map(group => {
    const members = analysis.people.filter(person => !person.staff.locum && person.comparisonId === group.id);
    const availability = members.reduce((sum, person) => sum + person.availability, 0);
    const actual: Record<string, number> = {};
    const intended: Record<string, number> = {};
    const totals: Record<string, number> = {};
    for (const type of settings.types) {
      const total = members.reduce((sum, person) => sum + (person.counts[type.id] ?? 0), 0);
      totals[type.id] = total;
      actual[type.id] = availability > 0 ? total / availability * 28 : 0;
      const weightedTotal = analysis.people.filter(person => !person.staff.locum && person.groupId && person.comparisonId)
        .reduce((sum, person) => sum + (person.counts[type.id] ?? 0), 0);
      const denominator = analysis.people.filter(person => !person.staff.locum && person.groupId && person.comparisonId)
        .reduce((sum, person) => sum + (settings.ratios[type.id]?.[person.groupId!] ?? 1) * person.availability, 0);
      const ratio = settings.ratios[type.id]?.[group.parentId] ?? 1;
      intended[type.id] = denominator > 0 && availability > 0 ? weightedTotal * ratio * availability / denominator / availability * 28 : 0;
    }
    return { id: group.id, name: group.name, count: members.length, fte: members.reduce((sum, person) => sum + person.staff.fte, 0), availability, actual, intended, totals };
  });
  return rows;
}

export function visibleGradeSessionRows(rows: GradeSessionRow[], ownGroupId?: string): GradeSessionRow[] {
  return rows.filter(row => row.count > 0 || row.id === ownGroupId);
}

export function visibleSessionTypes(types: SessionTypeSetting[], hideOnCalls: boolean): SessionTypeSetting[] {
  return types.filter(type => !hideOnCalls || type.kind !== 'on-call');
}

export function gradeDateRangeLabel(start: ISODate, end: ISODate): string {
  const shortDate = (date: ISODate, includeYear: boolean) => new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(includeYear ? { year: 'numeric' } : {}), timeZone: 'UTC' });
  return `${shortDate(start, false)} to ${shortDate(end, true)}`;
}

/** Nice axis step: 1, 2, 2.5 or 5 times a power of ten. */
export function niceAxisStep(max: number, targetTicks = 5): number {
  if (!(max > 0)) return 1;
  const rough = max / Math.max(1, targetTicks - 1);
  const power = 10 ** Math.floor(Math.log10(rough));
  const residual = rough / power;
  const nice = residual <= 1 ? 1 : residual <= 2 ? 2 : residual <= 2.5 ? 2.5 : residual <= 5 ? 5 : 10;
  return nice * power;
}

export function niceAxisTicks(max: number, targetTicks = 5): number[] {
  const step = niceAxisStep(max, targetTicks);
  const top = Math.ceil(max / step - 1e-12) * step;
  const ticks: number[] = [];
  for (let value = 0; value <= top + step * 1e-9; value += step) ticks.push(Number(value.toPrecision(12)));
  return ticks.length ? ticks : [0, 1];
}

export function formatAxisTick(value: number, step: number): string {
  if (!Number.isFinite(value)) return '0';
  if (Number.isInteger(step) && Number.isInteger(value)) return String(value);
  const raw = step.toFixed(10).replace(/0+$/, '');
  const decimals = raw.includes('.') ? raw.split('.')[1]!.length : 0;
  return value.toFixed(decimals);
}

export const GRADE_CHART_IMAGE_MARGIN = 24;
export const GRADE_MARKER_WIDTH = 2;
export const GRADE_MARKER_EXTRA = 4;
export const GRADE_COMPACT_CHART_WIDTH = 360;
export const GRADE_CHART_MIN_TEXT_PX = 12;

/** Value label sits after the further of the bar end and the intended marker. */
export function gradeValueLabelX(barEnd: number, markerX: number, rightLimit: number, gap = 14): number {
  return Math.min(rightLimit, Math.max(barEnd, markerX) + gap);
}

/** Intended-split marker: a short vertical line through its bar. */
export function gradeMarkerRect(markerX: number, barY: number, barHeight: number) {
  return {
    x: markerX - GRADE_MARKER_WIDTH / 2,
    y: barY - GRADE_MARKER_EXTRA / 2,
    width: GRADE_MARKER_WIDTH,
    height: barHeight + GRADE_MARKER_EXTRA,
  };
}

export function gradeTypeFocusLabel(name: string): string {
  return `${name} ›`;
}

export function defaultCompactSessionType(types: SessionTypeSetting[]): SessionTypeSetting | undefined {
  return types.find(type => type.name === 'Theatre') ?? types.find(type => type.kind === 'day') ?? types[0];
}

export function equalGradeRatios(typeId: string, groups: SessionComparisonGroup[], settings: SessionsSettings): boolean {
  const ratios = groups.map(group => settings.ratios[typeId]?.[settings.groups.find(parent => parent.subGroups?.some(sub => sub.id === group.id))?.id ?? group.id] ?? 1);
  return ratios.length > 0 && ratios.every(ratio => ratio === ratios[0]);
}

export function gradeSummary(start: ISODate, end: ISODate, type: SessionTypeSetting, rows: GradeSessionRow[], settings: SessionsSettings): string {
  const startLabel = new Date(`${start}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  const endLabel = new Date(`${end}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const ordered = rows.map(row => `${row.name} ${row.actual[type.id].toFixed(1)}`).join(', ');
  const ratioList = rows.map(row => {
      const parent = settings.groups.find(group => group.subGroups?.some(sub => sub.id === row.id));
      return `${row.name} ${settings.ratios[type.id]?.[parent?.id ?? row.id] ?? 1}`;
    }).join(', ');
  const distinct = new Set(rows.map(row => {
    const parent = settings.groups.find(group => group.subGroups?.some(sub => sub.id === row.id));
    return settings.ratios[type.id]?.[parent?.id ?? row.id] ?? 1;
  }));
  return `${startLabel} to ${endLabel}: ${ordered} ${type.name.toLocaleLowerCase('en-GB')} sessions per full-time doctor per 4 weeks${distinct.size > 1 ? ` (ratios: ${ratioList})` : ''}.`;
}
