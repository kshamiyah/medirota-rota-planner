/**
 * Stage 2 tester helpers. Off/compatibility follow docs/swaps-brief.md §3 and §6
 * independently of src/engine/swaps.ts (wording and structure differ on purpose).
 */
import { addDays, dateRange, matchesDay, shiftHours, weekday } from '../src/engine/calendar';
import { activeRules } from '../src/engine/semantics';
import { validate, type Violation } from '../src/engine/validate';
import { limitDefs } from '../src/app/rules/grid';
import type { Assignment, ISODate, Profile, RotaProblem, Rule, ShiftType, Weekday } from '../src/engine/types';
import type { SwapPlan } from '../src/engine/swaps';
import type {
  MovedShift, RotaSnapshot, SnapshotDay, SwapChain, SwapRequest, SwapSettings, SwapUnit, UnitKind,
} from '../src/engine/swaps';
import { testerNightPackageForChains } from './swaps-night-rest-helpers';

export const STAGE2_TODAY = '2026-10-01';
export const STAGE2_MONDAY = '2026-11-02';
export const DAY_SESSIONS = ['am', 'pm', 'eve'] as const;

const WORK_STATUSES = new Set<SnapshotDay['status']>(['night', 'longDay', 'partShift', 'dayJob']);
const WORK_TIME_RULES = new Set(['minRest', 'restAfterRun', 'restAfterBlock', 'maxHours', 'maxConsecutive', 'minBlock', 'weekendFrequency']);

export function stage2Settings(patch: Partial<SwapSettings> = {}): SwapSettings {
  return {
    weekendDayActivities: [], hoursTolerance: 1, maxChain: 4,
    minDoctors: [7, 7, 7, 7, 7, 3, 3], minDoctorsBankHoliday: 4,
    bankHolidays: [], regularDaysOff: {}, excluded: [], ...patch,
  };
}

export function applyDefaultLimitRules(profile: Profile): void {
  const limitValues: Record<string, number[]> = {
    rest: [11], hours7: [72, 7], avg: [48], days: [7], weekends: [1, 2],
    nights: [4], postnights: [46], longdays: [4],
  };
  profile.rules = limitDefs(profile)
    .filter(def => !def.offByDefault)
    .map(def => def.make(limitValues[def.id]!));
}

export function stage2Profile(staffIds: string[], activities: string[], rules: Profile['rules'] = []): Profile {
  const p: Profile = {
    name: 'Fixture department',
    shiftTypes: [
      { id: 'night', name: 'Night', start: '20:00', end: '08:30' },
      { id: 'long', name: 'Long day', start: '08:00', end: '20:30' },
      { id: 'day', name: 'Day job', start: '08:00', end: '17:30' },
    ],
    roles: activities.map(activity => ({ id: `role-${activity}`, name: activity })),
    groups: [{ id: 'qualified', name: 'Qualified' }],
    staff: staffIds.map((id, index) => ({ id, name: `Fixture ${index + 1}`, groupIds: index === 0 ? ['qualified'] : [], fte: 1 })),
    demands: [], rules, fairness: [],
  };
  return p;
}

export function blankSnapshot(staffIds: string[], weeks = 8): RotaSnapshot {
  const snapshot: RotaSnapshot = { days: {}, importedAt: {} };
  for (let offset = 0; offset < weeks * 7; offset += 7) {
    const start = addDays(STAGE2_MONDAY, offset);
    snapshot.importedAt[start] = '2026-11-04T12:00:00.000Z';
    for (const staffId of staffIds) {
      snapshot.days[staffId] ??= {};
      for (let day = 0; day < 7; day++) snapshot.days[staffId][addDays(start, day)] = { status: 'blank' };
    }
  }
  return snapshot;
}

export function setDay(snapshot: RotaSnapshot, staffId: string, date: string, status: SnapshotDay['status'], activity = '', sessions?: SnapshotDay['sessions']) {
  snapshot.days[staffId] ??= {};
  snapshot.days[staffId][date] = { status, ...(activity ? { activity } : {}), ...(sessions ? { sessions } : {}) };
}

export function work(snapshot: RotaSnapshot, staffId: string, date: string, status: SnapshotDay['status'], activity: string) {
  const sessions: NonNullable<SnapshotDay['sessions']> = status === 'night' ? ['night'] : status === 'longDay' ? [...DAY_SESSIONS] : ['am'];
  setDay(snapshot, staffId, date, status, activity, sessions);
}

export function off(snapshot: RotaSnapshot, staffId: string, date: string) {
  setDay(snapshot, staffId, date, 'zero', 'Zero Day', ['am']);
}

export function stage2Request(staffId = 'a', leaveDates = [STAGE2_MONDAY], patch: Partial<SwapRequest> = {}): SwapRequest {
  return { staffId, leaveDates, leaveType: 'annual', today: STAGE2_TODAY, ...patch };
}

export function unitKey(unit: SwapUnit): string {
  return `${unit.kind}|${unit.staffId}|${unit.dates.join(',')}|${unit.activity}`;
}

export interface UnitRecord {
  unit: SwapUnit;
  assignments: Assignment[];
  dayShiftClass?: 'weekendDay' | 'normalDay';
  id: string;
}

interface ViolationBaselineEntry {
  count: number;
  dates: Map<string, number>;
}

type ViolationBaseline = Map<string, ViolationBaselineEntry>;

export interface SwapBreach {
  ruleId: string;
  staffId?: string;
  date?: ISODate;
}

export interface BreachCheckResult {
  rejecting: SwapBreach[];
  alerting: SwapBreach[];
}

export interface TestContext {
  problem: RotaProblem;
  assignments: Assignment[];
  availability: RotaProblem['unavailability'];
  profile: Profile;
  unitRecords: Map<string, UnitRecord>;
  baselineViolationCounts: ViolationBaseline;
}

function weekStartOf(date: ISODate): ISODate {
  return addDays(date, -weekday(date));
}

/** Brief §3: in post that week = at least one non-blank day in the imported week. */
function postedInWeek(snapshot: RotaSnapshot, staffId: string, date: ISODate): boolean {
  const start = weekStartOf(date);
  if (!snapshot.importedAt[start]) return false;
  const days = snapshot.days[staffId] ?? {};
  return dateRange(start, addDays(start, 6)).some(d => (days[d]?.status ?? 'blank') !== 'blank');
}

function calendarKind(date: ISODate, bankHolidays: readonly ISODate[]): SwapUnit['dayType'] {
  if (bankHolidays.includes(date)) return 'bankHoliday';
  return weekday(date) >= 5 ? 'weekend' : 'weekday';
}

function isExcluded(staffId: string, date: ISODate, settings: SwapSettings, request: SwapRequest): boolean {
  if (request.excludeStaffIds?.includes(staffId)) return true;
  return settings.excluded.some(row => row.staffId === staffId && (!row.until || date <= row.until));
}

/** Brief §3: is this doctor off on this single date? */
export function doctorOffOnDate(
  snapshot: RotaSnapshot,
  settings: SwapSettings,
  staffId: string,
  date: ISODate,
  request?: SwapRequest,
): boolean {
  if (request?.staffId === staffId) {
    const blocked = new Set([...(request.leaveDates ?? []), ...(request.cantWorkDates ?? [])]);
    if (blocked.has(date)) return false;
  }
  if (isExcluded(staffId, date, settings, request ?? { staffId: '', leaveDates: [], leaveType: 'annual', today: STAGE2_TODAY })) return false;
  if ((settings.regularDaysOff[staffId] ?? []).includes(weekday(date) as Weekday)) return false;
  const day = snapshot.days[staffId]?.[date];
  if (!day || day.status === 'zero') return true;
  if (day.status === 'blank' && settings.bankHolidays.includes(date) && postedInWeek(snapshot, staffId, date)) return true;
  return false;
}

/** Brief §3: off on every date the shift spans. */
export function doctorOffForUnit(
  snapshot: RotaSnapshot,
  settings: SwapSettings,
  staffId: string,
  unit: SwapUnit,
  request?: SwapRequest,
): boolean {
  if (request?.staffId === staffId) {
    const blocked = new Set([...(request.leaveDates ?? []), ...(request.cantWorkDates ?? [])]);
    if (unit.dates.some(d => blocked.has(d))) return false;
  }
  return unit.dates.every(date => {
    if (isExcluded(staffId, date, settings, request ?? { staffId: '', leaveDates: [], leaveType: 'annual', today: STAGE2_TODAY })) return false;
    if ((settings.regularDaysOff[staffId] ?? []).includes(weekday(date) as Weekday)) return false;
    return doctorOffOnDate(snapshot, settings, staffId, date, request);
  });
}

/** Human-readable off failure for assertions (not matched to engine strings). */
export function offReason(staffId: string, unit: SwapUnit, snapshot: RotaSnapshot, settings: SwapSettings, request?: SwapRequest): string | undefined {
  if (request?.staffId === staffId && unit.dates.some(d => [...(request.leaveDates ?? []), ...(request.cantWorkDates ?? [])].includes(d))) {
    return 'return falls on requester leave or cant-work date';
  }
  for (const date of unit.dates) {
    if (isExcluded(staffId, date, settings, request ?? { staffId: '', leaveDates: [], leaveType: 'annual', today: STAGE2_TODAY })) return 'excluded';
    if ((settings.regularDaysOff[staffId] ?? []).includes(weekday(date) as Weekday)) return 'regular day off';
    const day = snapshot.days[staffId]?.[date];
    if (day?.status === 'zero') continue;
    if (day?.status === 'blank' && settings.bankHolidays.includes(date) && postedInWeek(snapshot, staffId, date)) continue;
    if (!day || day.status === 'blank') return 'blank not off';
    return `working as ${day.status}`;
  }
  return undefined;
}

function dayShiftCategory(record: UnitRecord, settings: SwapSettings): 'weekendDay' | 'normalDay' {
  if (record.dayShiftClass) return record.dayShiftClass;
  const activity = record.unit.activity;
  const kind = calendarKind(record.unit.dates[0], settings.bankHolidays);
  if (kind !== 'weekday' && settings.weekendDayActivities.includes(activity)) return 'weekendDay';
  return 'normalDay';
}

/** Brief §3 swap table + §6 hours tolerance. */
export function unitsCompatible(
  clash: UnitRecord,
  offer: UnitRecord,
  settings: SwapSettings,
  request: SwapRequest,
): boolean {
  const a = clash.unit;
  const b = offer.unit;
  if (Math.abs(a.hours - b.hours) > Math.max(0, settings.hoursTolerance)) return false;

  if (a.kind === 'nightBlock' || b.kind === 'nightBlock') {
    return a.kind === 'nightBlock' && b.kind === 'nightBlock' && a.dates.length === b.dates.length;
  }
  if (a.kind === 'longDay' || b.kind === 'longDay') {
    return a.kind === 'longDay' && b.kind === 'longDay';
  }
  if (a.kind !== 'dayShift' || b.kind !== 'dayShift') return false;

  const left = dayShiftCategory(clash, settings);
  const right = dayShiftCategory(offer, settings);
  if (left === 'weekendDay' && right === 'weekendDay') return true;
  if (!request.includeNormalDays) return false;
  if (left === 'normalDay' && right === 'normalDay') return true;
  return left === 'weekendDay' || right === 'weekendDay';
}

function findRole(profile: Profile, activity: string) {
  return profile.roles.find(role => role.name.toLocaleLowerCase() === activity.toLocaleLowerCase());
}

export function buildTestContext(profile: Profile, snapshot: RotaSnapshot, settings: SwapSettings, request: SwapRequest): TestContext | undefined {
  const workingProfile = structuredClone(profile);
  const importedWeeks = Object.keys(snapshot.importedAt);
  const importedDateSet = new Set(importedWeeks.flatMap(week => dateRange(week, addDays(week, 6))));
  const snapshotDates = [...importedDateSet].sort();
  if (!snapshotDates.length) return undefined;
  const start = snapshotDates[0];
  const end = snapshotDates[snapshotDates.length - 1];
  const bankHolidays = new Set(settings.bankHolidays);

  const ensureShift = (kind: 'night' | 'long' | 'day'): ShiftType => {
    const matches = (shift: ShiftType) => kind === 'night'
      ? shift.end <= shift.start
      : shift.end > shift.start && (kind === 'long' ? shiftHours(shift) >= 11 : shiftHours(shift) < 11);
    const existing = workingProfile.shiftTypes.find(matches);
    if (existing) return existing;
    const template: ShiftType = kind === 'night'
      ? { id: 'swap-synthetic-night', name: 'Night', start: '20:00', end: '08:30' }
      : kind === 'long'
        ? { id: 'swap-synthetic-long', name: 'Long day', start: '08:00', end: '20:30' }
        : { id: 'swap-synthetic-day', name: 'Day job', start: '08:00', end: '17:30' };
    workingProfile.shiftTypes.push(template);
    return template;
  };

  const shiftFor = (activity: string, date: ISODate, kind: 'night' | 'long' | 'day' | 'part'): ShiftType => {
    const role = findRole(workingProfile, activity);
    const demands = role ? workingProfile.demands.filter(demand => demand.roleId === role.id && matchesDay(demand.days, date)) : [];
    const demanded = demands.map(demand => workingProfile.shiftTypes.find(shift => shift.id === demand.shiftTypeId)).filter((shift): shift is ShiftType => !!shift);
    const suitable = (shift: ShiftType) => {
      if (kind === 'part') return shift.end > shift.start;
      if (kind === 'night') return shift.end <= shift.start;
      return shift.end > shift.start && (kind === 'long' ? shiftHours(shift) >= 11 : shiftHours(shift) < 11);
    };
    return demanded.find(suitable) ?? workingProfile.shiftTypes.find(suitable) ?? ensureShift(kind === 'part' ? 'day' : kind);
  };

  const records = new Map<string, UnitRecord>();
  const descriptors = new Map<string, Assignment>();
  const unavailable: RotaProblem['unavailability'] = [];

  for (const [staffId, days] of Object.entries(snapshot.days)) for (const [date, day] of Object.entries(days)) {
    if (!importedDateSet.has(date)) continue;
    if (day.status === 'zero') unavailable.push({ staffId, date, kind: 'nonWorking', reason: 'Zero Day' });
    else if (day.status === 'leave') unavailable.push({ staffId, date, kind: 'leave', reason: 'Leave' });
    else if (day.status === 'training') unavailable.push({ staffId, date, kind: 'other', reason: 'Training' });
    else if (day.status === 'notAvailable') unavailable.push({ staffId, date, kind: 'other', reason: 'Not available' });
    if (!WORK_STATUSES.has(day.status)) continue;
    const activity = day.activity ?? '';
    const shift = shiftFor(activity, date, day.status === 'night' ? 'night' : day.status === 'longDay' ? 'long' : day.status === 'partShift' ? 'part' : 'day');
    const roleId = findRole(workingProfile, activity)?.id;
    descriptors.set(`${staffId}|${date}`, { staffId, date, shiftTypeId: shift.id, ...(roleId ? { roleId } : {}) });
  }

  const mkRecord = (staffId: string, dates: ISODate[], kind: UnitKind, activity: string): UnitRecord | undefined => {
    const assignments = dates.map(date => descriptors.get(`${staffId}|${date}`)).filter((a): a is Assignment => !!a);
    if (!assignments.length) return undefined;
    const hours = assignments.reduce((sum, assignment) => sum + shiftHours(workingProfile.shiftTypes.find(shift => shift.id === assignment.shiftTypeId)!), 0);
    const kindDayType = kind === 'nightBlock'
      ? dates.some(date => bankHolidays.has(date)) ? 'bankHoliday' : dates.some(date => weekday(date) >= 5) ? 'weekend' : 'weekday'
      : calendarKind(dates[0], settings.bankHolidays);
    const unit: SwapUnit = { kind, staffId, activity, dates, dayType: kindDayType, hours };
    const record: UnitRecord = { unit, assignments, id: unitKey(unit) };
    if (kind === 'dayShift') {
      record.dayShiftClass = calendarKind(dates[0], settings.bankHolidays) !== 'weekday' && settings.weekendDayActivities.includes(activity) ? 'weekendDay' : 'normalDay';
    }
    records.set(record.id, record);
    return record;
  };

  for (const [staffId, days] of Object.entries(snapshot.days)) {
    const nightDates = Object.keys(days).filter(date => snapshot.importedAt[weekStartOf(date)] && days[date].status === 'night').sort();
    let block: ISODate[] = [];
    const flush = () => {
      if (!block.length) return;
      mkRecord(staffId, block, 'nightBlock', days[block[0]].activity ?? '');
      block = [];
    };
    for (const date of nightDates) {
      if (block.length && addDays(block[block.length - 1], 1) !== date) flush();
      block.push(date);
    }
    flush();
  }

  for (const [staffId, days] of Object.entries(snapshot.days)) for (const [date, day] of Object.entries(days)) {
    if (day.status === 'longDay') mkRecord(staffId, [date], 'longDay', day.activity ?? '');
    if (day.status === 'dayJob') mkRecord(staffId, [date], 'dayShift', day.activity ?? '');
  }

  const baseAssignments = [...descriptors.values()];
  for (const date of request.leaveDates) unavailable.push({ staffId: request.staffId, date, kind: 'leave', reason: request.leaveType === 'annual' ? 'Requested annual leave' : 'Requested study leave' });
  const problem: RotaProblem = { profile: workingProfile, start, end, fixed: [], unavailability: unavailable };
  const baselineFull = validate({ ...problem, unavailability: filterAvailability(unavailable, baseAssignments, []) }, baseAssignments);
  const baselineViolationCounts = tallyViolationBaseline(baselineFull.violations, workingProfile);

  return { problem, assignments: baseAssignments, availability: unavailable, profile: workingProfile, unitRecords: records, baselineViolationCounts };
}

function filterAvailability(
  availability: RotaProblem['unavailability'],
  assignments: Assignment[],
  chains: SwapChain[],
  restMoves: import('../src/engine/swaps').MovedShift[] = [],
): RotaProblem['unavailability'] {
  const assigned = new Set(assignments.map(assignment => `${assignment.staffId}|${assignment.date}`));
  const received = new Set<string>();
  for (const chain of chains) for (let index = 0; index < chain.links.length; index++) {
    const giver = chain.links[index].gives;
    const recipient = chain.links[(index + 1) % chain.links.length].staffId;
    for (const date of giver.dates) received.add(`${recipient}|${date}`);
  }
  for (const move of restMoves) received.add(`${move.toStaffId}|${move.date}`);
  return availability.filter(item => {
    const key = `${item.staffId}|${item.date}`;
    return assigned.has(key) && !(item.kind === 'nonWorking' && received.has(key));
  });
}

export function movedAssignments(context: TestContext, chains: SwapChain[]): Assignment[] {
  const moved = new Map<string, { owner: string; receiver: string; record: UnitRecord }>();
  for (const chain of chains) for (let i = 0; i < chain.links.length; i++) {
    const owner = chain.links[i];
    const receiver = chain.links[(i + 1) % chain.links.length];
    const record = context.unitRecords.get(unitKey(owner.gives));
    if (!record) continue;
    moved.set(record.id, { owner: owner.staffId, receiver: receiver.staffId, record });
  }
  const removed = new Set([...moved.values()].flatMap(move => move.record.assignments.map(assignment => `${move.owner}|${assignment.date}`)));
  const out = context.assignments.filter(assignment => !removed.has(`${assignment.staffId}|${assignment.date}`));
  for (const move of moved.values()) for (const assignment of move.record.assignments) out.push({ ...assignment, staffId: move.receiver, fixed: undefined });
  return out;
}

/** Chain swaps plus night rest pass-back moves (matches post-package rota). */
export function movedAssignmentsWithRestMoves(context: TestContext, chains: SwapChain[], restMoves: import('../src/engine/swaps').MovedShift[]): Assignment[] {
  let out = movedAssignments(context, chains);
  for (const move of restMoves) {
    const source = context.assignments.find(assignment => assignment.staffId === move.fromStaffId && assignment.date === move.date);
    out = out.filter(assignment => {
      if (assignment.staffId !== move.fromStaffId || assignment.date !== move.date) return true;
      return source ? assignment.shiftTypeId !== source.shiftTypeId : true;
    });
    if (source) out.push({ ...source, staffId: move.toStaffId, fixed: undefined });
  }
  return out;
}

function swapCompareKey(violation: Violation, profile: Profile): string {
  if (violation.staffId && profile.rules.some(rule => rule.id === violation.ruleId)) {
    return `${violation.ruleId}|${violation.staffId}`;
  }
  return `${violation.ruleId}|${violation.staffId ?? ''}|${violation.date ?? ''}`;
}

function tallyViolationBaseline(violations: Violation[], profile: Profile): ViolationBaseline {
  const counts: ViolationBaseline = new Map();
  for (const violation of violations) {
    const key = swapCompareKey(violation, profile);
    const entry = counts.get(key) ?? { count: 0, dates: new Map<string, number>() };
    entry.count++;
    const date = violation.date ?? '';
    entry.dates.set(date, (entry.dates.get(date) ?? 0) + 1);
    counts.set(key, entry);
  }
  return counts;
}

function addedViolations(violations: Violation[], before: ViolationBaseline, profile: Profile): Violation[] {
  const grouped = new Map<string, Violation[]>();
  for (const violation of violations) {
    const key = swapCompareKey(violation, profile);
    const list = grouped.get(key) ?? [];
    list.push(violation);
    grouped.set(key, list);
  }
  const added: Violation[] = [];
  for (const [key, current] of grouped) {
    const baseline = before.get(key);
    if (!baseline) { added.push(...current); continue; }
    const exactDates = new Map(baseline.dates);
    const unmatched: Violation[] = [];
    let exactMatches = 0;
    for (const violation of current) {
      const date = violation.date ?? '';
      const remaining = exactDates.get(date) ?? 0;
      if (remaining > 0) {
        exactDates.set(date, remaining - 1);
        exactMatches++;
      } else unmatched.push(violation);
    }
    added.push(...unmatched.slice(Math.max(0, baseline.count - exactMatches)));
  }
  return added;
}

type BreachKind = 'ignore' | 'alert' | 'reject';

function breachKind(violation: Violation, profile: Profile): BreachKind {
  const rule = profile.rules.find(entry => entry.id === violation.ruleId);
  if (rule?.type === 'weekendFrequency') return 'ignore';
  if (rule?.hard && (rule.type === 'minRest' || rule.type === 'restAfterRun' || rule.type === 'restAfterBlock' ||
    rule.type === 'maxHours' || rule.type === 'maxConsecutive' || rule.type === 'minBlock' ||
    (rule.type === 'count' && !!(rule as Rule & { perWeekAverage?: boolean }).perWeekAverage))) return 'alert';
  return 'reject';
}

function toSwapBreach(violation: Violation): SwapBreach {
  return { ruleId: violation.ruleId, staffId: violation.staffId, date: violation.date };
}

const staffBaselineStore = new WeakMap<TestContext, Map<string, ViolationBaseline>>();

function staffViolationBaseline(context: TestContext, staffId: string): ViolationBaseline {
  let cache = staffBaselineStore.get(context);
  if (!cache) {
    cache = new Map();
    staffBaselineStore.set(context, cache);
  }
  const hit = cache.get(staffId);
  if (hit) return hit;
  const assignments = context.assignments.filter(assignment => assignment.staffId === staffId);
  const report = validate(context.problem, assignments, { staffIds: [staffId] });
  const baseline = tallyViolationBaseline(report.violations.filter(v => v.staffId === staffId), context.profile);
  cache.set(staffId, baseline);
  return baseline;
}

function staffMovementRejections(context: TestContext, chains: SwapChain[], restMoves: import('../src/engine/swaps').MovedShift[] = []): Violation[] {
  const movements = new Map<string, { gives: UnitRecord[]; receives: UnitRecord[] }>();
  for (const chain of chains) for (let index = 0; index < chain.links.length; index++) {
    const owner = chain.links[index];
    const receiver = chain.links[(index + 1) % chain.links.length];
    const record = context.unitRecords.get(unitKey(owner.gives));
    if (!record) continue;
    const ownerMovement = movements.get(owner.staffId) ?? { gives: [], receives: [] };
    ownerMovement.gives.push(record);
    movements.set(owner.staffId, ownerMovement);
    const receiverMovement = movements.get(receiver.staffId) ?? { gives: [], receives: [] };
    receiverMovement.receives.push(record);
    movements.set(receiver.staffId, receiverMovement);
  }
  for (const move of restMoves) {
    movements.set(move.fromStaffId, movements.get(move.fromStaffId) ?? { gives: [], receives: [] });
    movements.set(move.toStaffId, movements.get(move.toStaffId) ?? { gives: [], receives: [] });
  }
  const assignmentsByStaff = new Map<string, Assignment[]>();
  for (const assignment of context.assignments) {
    const list = assignmentsByStaff.get(assignment.staffId) ?? [];
    list.push(assignment);
    assignmentsByStaff.set(assignment.staffId, list);
  }
  const rejecting: Violation[] = [];
  for (const [staffId, movement] of movements) {
    const gives = [...movement.gives].sort((a, b) => a.id.localeCompare(b.id));
    const receives = [...movement.receives].sort((a, b) => a.id.localeCompare(b.id));
    const removedDates = new Set(gives.flatMap(record => record.assignments.map(assignment => assignment.date)));
    for (const move of restMoves.filter(item => item.fromStaffId === staffId)) removedDates.add(move.date);
    const assignments = (assignmentsByStaff.get(staffId) ?? []).filter(assignment => !removedDates.has(assignment.date));
    for (const record of receives) for (const assignment of record.assignments) assignments.push({ ...assignment, staffId, fixed: undefined });
    for (const move of restMoves.filter(item => item.toStaffId === staffId)) {
      const assignment = (assignmentsByStaff.get(move.fromStaffId) ?? []).find(item => item.date === move.date);
      if (assignment) assignments.push({ ...assignment, staffId, fixed: undefined });
    }
    const receivedDates = new Set([
      ...receives.flatMap(record => record.unit.dates),
      ...restMoves.filter(item => item.toStaffId === staffId).map(item => item.date),
    ]);
    const assignedDates = new Set(assignments.map(assignment => assignment.date));
    const availability = context.availability.filter(item => item.staffId === staffId && assignedDates.has(item.date) &&
      (item.kind !== 'nonWorking' || !receivedDates.has(item.date)));
    const report = validate({ ...context.problem, unavailability: availability }, assignments, { staffIds: [staffId] });
    const fresh = addedViolations(report.violations.filter(v => v.staffId === staffId), staffViolationBaseline(context, staffId), context.profile);
    rejecting.push(...fresh.filter(v => breachKind(v, context.profile) === 'reject'));
  }
  return rejecting;
}

function fullRosterAddedViolations(context: TestContext, chains: SwapChain[], restMoves: import('../src/engine/swaps').MovedShift[] = []): Violation[] {
  const assignments = movedAssignmentsWithRestMoves(context, chains, restMoves);
  const availability = filterAvailability(context.availability, assignments, chains, restMoves);
  const full = validate({ ...context.problem, unavailability: availability }, assignments);
  return addedViolations(full.violations, context.baselineViolationCounts, context.profile);
}

export function newRejectingBreaches(context: TestContext, chains: SwapChain[]): SwapBreach[] {
  const fromStaff = staffMovementRejections(context, chains);
  if (fromStaff.length) return fromStaff.map(toSwapBreach);
  return fullRosterAddedViolations(context, chains)
    .filter(v => breachKind(v, context.profile) === 'reject')
    .map(toSwapBreach);
}

export function newAlertingBreaches(context: TestContext, chains: SwapChain[]): SwapBreach[] {
  if (staffMovementRejections(context, chains).length) return [];
  return fullRosterAddedViolations(context, chains)
    .filter(v => breachKind(v, context.profile) === 'alert')
    .map(toSwapBreach);
}

export function newBreachesAfterSwap(context: TestContext, chains: SwapChain[]): BreachCheckResult {
  return { rejecting: newRejectingBreaches(context, chains), alerting: newAlertingBreaches(context, chains) };
}

export function newRejectingBreachesWithRestMoves(context: TestContext, chains: SwapChain[], restMoves: import('../src/engine/swaps').MovedShift[]): SwapBreach[] {
  if (restMoves.length) {
    return fullRosterAddedViolations(context, chains, restMoves)
      .filter(v => breachKind(v, context.profile) === 'reject')
      .map(toSwapBreach);
  }
  return newRejectingBreaches(context, chains);
}

export function newAlertingBreachesWithRestMoves(context: TestContext, chains: SwapChain[], restMoves: import('../src/engine/swaps').MovedShift[]): SwapBreach[] {
  if (restMoves.length) {
    return fullRosterAddedViolations(context, chains, restMoves)
      .filter(v => breachKind(v, context.profile) === 'alert')
      .map(toSwapBreach);
  }
  return newAlertingBreaches(context, chains);
}

/** Map new working-time violations to swap-style alerts for parity checks. */
export function workingTimeAlerts(context: TestContext, chains: SwapChain[], restMoves: import('../src/engine/swaps').MovedShift[]): { staffId: string; date: ISODate; message: string }[] {
  const violations = fullRosterAddedViolations(context, chains, restMoves).filter(v => breachKind(v, context.profile) === 'alert');
  return violations.map(violation => ({
    staffId: violation.staffId ?? '',
    date: violation.date ?? '',
    message: testerWorkingTimeAlertMessage(violation, context.profile),
  })).filter(alert => alert.staffId && alert.date);
}

function testerWorkingTimeAlertMessage(violation: Violation, profile: Profile): string {
  const rule = profile.rules.find(entry => entry.id === violation.ruleId);
  if (!rule) return violation.message.trim() || 'Would break a working-time limit';
  const typed = rule as Rule & { hours?: number; windowDays?: number; runDays?: number; maxDays?: number; minDays?: number; max?: number; unit?: string };
  switch (rule.type) {
    case 'maxHours': return `Would exceed ${typed.hours} hours in ${typed.windowDays} days`;
    case 'minRest': return `Would have less than ${typed.hours} hours between shifts`;
    case 'restAfterBlock': return `Would have less than ${typed.hours} hours off after a block`;
    case 'restAfterRun': return `Would have less than ${typed.hours} hours off after ${typed.runDays} days in a row`;
    case 'maxConsecutive': return `Would work more than ${typed.maxDays} nights in a row`;
    case 'minBlock': return `Would create a work block shorter than ${typed.minDays} days`;
    case 'count': return `Would exceed an average of ${typed.max ?? 0} ${typed.unit} per week`;
    default: return violation.message.trim() || 'Would break a working-time limit';
  }
}

export function alertStaffOnPlan(plan: SwapPlan): string[] {
  return [...new Set((plan.alerts ?? []).map(alert => alert.staffId))].sort();
}

export function expectedAlertStaff(context: TestContext, chains: SwapChain[]): string[] {
  return [...new Set(newAlertingBreaches(context, chains).map(b => b.staffId).filter((id): id is string => !!id))].sort();
}

export function directChainKey(chain: SwapChain): string | null {
  if (chain.links.length !== 2) return null;
  const [giver, receiver] = chain.links;
  return `${receiver.staffId}:${unitKey(receiver.gives)}<=${giver.staffId}:${unitKey(giver.gives)}`;
}

export function directSwapSignatures(plans: SwapPlan[]): { key: string; alertStaff: string[] }[] {
  const out: { key: string; alertStaff: string[] }[] = [];
  for (const plan of plans) {
    for (const chain of plan.chains) {
      const key = directChainKey(chain);
      if (!key) continue;
      out.push({ key, alertStaff: alertStaffOnPlan(plan) });
    }
  }
  return out.sort((a, b) => a.key.localeCompare(b.key) || a.alertStaff.join(',').localeCompare(b.alertStaff.join(',')));
}

export interface BruteForceStats {
  signatures: Map<string, string[]>;
  rejectedCount: number;
  alertOnlyCount: number;
}

export function enumerateDirectSwaps(
  profile: Profile,
  snapshot: RotaSnapshot,
  settings: SwapSettings,
  request: SwapRequest,
  clashes: SwapUnit[],
): BruteForceStats {
  const stats: BruteForceStats = { signatures: new Map(), rejectedCount: 0, alertOnlyCount: 0 };
  const context = buildTestContext(profile, snapshot, settings, request);
  if (!context) return stats;
  const today = request.today;
  const importedWeeks = new Set(Object.keys(snapshot.importedAt));
  const isImportedDate = (date: ISODate) => importedWeeks.has(weekStartOf(date));
  const futureRecords = [...context.unitRecords.values()].filter(record =>
    record.unit.staffId !== request.staffId &&
    record.unit.dates.every(date => date >= today && isImportedDate(date)),
  );

  for (const clash of clashes) {
    const root = context.unitRecords.get(unitKey(clash));
    if (!root) continue;
    for (const offer of futureRecords) {
      if (!doctorOffForUnit(snapshot, settings, offer.unit.staffId, root.unit, request)) continue;
      if (!unitsCompatible(root, offer, settings, request)) continue;
      if (!doctorOffForUnit(snapshot, settings, request.staffId, offer.unit, request)) continue;
      const chain: SwapChain = {
        links: [
          { staffId: request.staffId, gives: root.unit },
          { staffId: offer.unit.staffId, gives: offer.unit },
        ],
        payDifferent: false,
      };
      const nightBlock = chain.links.every(link => link.gives.kind === 'nightBlock');
      let restMoves: MovedShift[] = [];
      let packageAlerts: { staffId: string; date: ISODate; message: string }[] = [];
      if (nightBlock) {
        const pkg = testerNightPackageForChains([chain], snapshot, settings, request);
        if (pkg.rejectReason) {
          stats.rejectedCount++;
          continue;
        }
        restMoves = pkg.moved;
        packageAlerts = pkg.alerts;
      }
      const rejecting = nightBlock
        ? newRejectingBreachesWithRestMoves(context, [chain], restMoves)
        : newBreachesAfterSwap(context, [chain]).rejecting;
      if (rejecting.length) {
        stats.rejectedCount++;
        continue;
      }
      const key = directChainKey(chain);
      if (!key) continue;
      const wtAlerts = nightBlock
        ? newAlertingBreachesWithRestMoves(context, [chain], restMoves)
        : newBreachesAfterSwap(context, [chain]).alerting;
      const alertStaff = [...new Set([
        ...packageAlerts.map(a => a.staffId),
        ...wtAlerts.map(b => b.staffId).filter((id): id is string => !!id),
      ])].sort();
      stats.signatures.set(key, alertStaff);
      if (alertStaff.length) stats.alertOnlyCount++;
    }
  }
  return stats;
}

export function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function testerPlanIsValid(
  profile: Profile,
  snapshot: RotaSnapshot,
  settings: SwapSettings,
  request: SwapRequest,
  plan: SwapPlan,
): string | undefined {
  const context = buildTestContext(profile, snapshot, settings, request);
  if (!context) return 'No validation context';
  const hasNight = plan.chains.some(chain => chain.links.some(link => link.gives.kind === 'nightBlock'));
  const nightPkg = hasNight ? testerNightPackageForChains(plan.chains, snapshot, settings, request) : undefined;
  const restMoves = nightPkg?.moved ?? [];
  if (nightPkg?.rejectReason) return nightPkg.rejectReason;
  if (newRejectingBreachesWithRestMoves(context, plan.chains, restMoves).length) return 'New rejecting working-time or movement breach';
  return undefined;
}

export function buildSeededRandomRota(seed: number): { profile: Profile; snapshot: RotaSnapshot; request: SwapRequest } {
  const rand = mulberry32(seed);
  const staffIds = ['req', 'cover-a', 'cover-b', 'cover-c', 'cover-d', 'cover-e'];
  const profile = stage2Profile(staffIds, ['Long List', 'Night List']);
  applyDefaultLimitRules(profile);
  const snapshot = blankSnapshot(staffIds, 6);
  const activity = rand() > 0.3 ? 'Long List' : 'Night List';
  const clashDate = addDays(STAGE2_MONDAY, Math.floor(rand() * 5));
  if (activity === 'Long List') work(snapshot, 'req', clashDate, 'longDay', activity);
  else {
    work(snapshot, 'req', clashDate, 'night', activity);
    if (rand() > 0.5) work(snapshot, 'req', addDays(clashDate, 1), 'night', activity);
  }
  for (const id of staffIds.slice(1)) {
    for (const start of Object.keys(snapshot.importedAt)) {
      for (let d = 0; d < 7; d++) {
        const date = addDays(start, d);
        if (rand() < 0.35) off(snapshot, id, date);
        else if (rand() < 0.08) work(snapshot, id, date, 'longDay', 'Long List');
        else if (rand() < 0.05) work(snapshot, id, date, 'night', 'Night List');
      }
    }
    const ret = addDays(clashDate, 7 + Math.floor(rand() * 14));
    work(snapshot, id, ret, 'longDay', 'Long List');
    if (rand() > 0.4) {
      work(snapshot, id, addDays(ret, -1), 'night', 'Night List');
      work(snapshot, id, addDays(ret, -2), 'night', 'Night List');
    }
    off(snapshot, 'req', ret);
    off(snapshot, id, clashDate);
  }
  return { profile, snapshot, request: stage2Request('req', [clashDate]) };
}

export function hasWorkingTimeRules(profile: Profile): boolean {
  return activeRules(profile).some(rule => WORK_TIME_RULES.has(rule.type));
}
