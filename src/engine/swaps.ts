import { addDays, dateRange, matchesDay, shiftHours, weekday } from './calendar';
import { activeRules } from './semantics';
import { validate, type Violation } from './validate';
import type { Assignment, ISODate, Profile, RotaProblem, Rule, ShiftType, Weekday } from './types';

export type DayStatus = 'night' | 'longDay' | 'partShift' | 'dayJob' | 'leave' | 'training' | 'zero' | 'available' | 'notAvailable' | 'blank';

export interface SnapshotDay {
  status: DayStatus;
  activity?: string;
  sessions?: ('am' | 'pm' | 'eve' | 'night')[];
  /** MediRota marks an additional shift with [Extra]. */
  extra?: true;
}

export interface RotaSnapshot {
  /** staffId -> date -> day. */
  days: Record<string, Record<ISODate, SnapshotDay>>;
  /** Week start -> ISO timestamp of the import. */
  importedAt: Record<ISODate, string>;
  /** True when imports from MediRota preserve its [Extra] marker. */
  extrasTagged?: true;
}

export interface SwapSettings {
  weekendDayActivities: string[];
  hoursTolerance: number;
  maxChain: number;
  /** Preferred pattern for shifts given back by one doctor covering several clashes. */
  returnPattern?: 'consecutive' | 'separate' | 'noPreference';
  /** Preferred calendar type for shifts the requester works in return. */
  returnDayType?: 'noPreference' | 'weekdays' | 'weekends';
  /** Saved default for the requester's return-date limit. */
  returnWindow?: ReturnWindow;
  /** Saved default for excluding plans with working-time alerts. */
  noAlertsOnly?: boolean;
  /** Saved default for searching normal working days. */
  includeNormalDays?: boolean;
  /** Index 0 = Monday … 6 = Sunday. */
  minDoctors: number[];
  minDoctorsBankHoliday: number;
  bankHolidays: ISODate[];
  /** Confirmed regular days off (0 = Monday). */
  regularDaysOff: Record<string, Weekday[]>;
  excluded: { staffId: string; until?: ISODate }[];
  /** Total rest days checked before a received night block. Undefined uses 2. */
  nightRestDaysBefore?: number;
  /** Total rest days checked after a received night block. Undefined uses 2, or 3 after 4+ nights. */
  nightRestDaysAfter?: number;
}

export interface PatternFlag {
  staffId: string;
  kind: 'regularDaysOff' | 'oneWeekday';
  weekdays: Weekday[];
  /** Weeks in post, the denominator for the 90% test. */
  weeksInPost: number;
}

/** Detect owner-review suggestions; this never applies a setting to the rota. */
export function detectPatterns(snapshot: RotaSnapshot): PatternFlag[] {
  const weeks = Object.keys(snapshot.importedAt).sort();
  const flags: PatternFlag[] = [];
  if (!weeks.length) return flags;

  for (const [staffId, days] of Object.entries(snapshot.days)) {
    const inPostWeeks = weeks.filter(start => Array.from({ length: 7 }, (_, i) => days[addDays(start, i)]?.status ?? 'blank').some(status => status !== 'blank'));
    if (inPostWeeks.length < 8) continue;

    const offWeekdays = ([0, 1, 2, 3, 4] as Weekday[]).filter(wd => {
      const zeroWeeks = inPostWeeks.filter(start => days[addDays(start, wd)]?.status === 'zero').length;
      return zeroWeeks / inPostWeeks.length >= 0.9;
    });
    if (offWeekdays.length) flags.push({ staffId, kind: 'regularDaysOff', weekdays: offWeekdays, weeksInPost: inPostWeeks.length });

    const oneWeekday = ([0, 1, 2, 3, 4, 5, 6] as Weekday[]).filter(wd => {
      const matchingWeeks = inPostWeeks.filter(start => {
        const workedWeekdays = ([0, 1, 2, 3, 4, 5, 6] as Weekday[]).filter(day => {
          const status = days[addDays(start, day)]?.status ?? 'blank';
          return status !== 'blank';
        });
        return workedWeekdays.length === 1 && workedWeekdays[0] === wd;
      }).length;
      return matchingWeeks / inPostWeeks.length >= 0.9;
    });
    for (const wd of oneWeekday) flags.push({ staffId, kind: 'oneWeekday', weekdays: [wd], weeksInPost: inPostWeeks.length });
  }
  return flags;
}

export interface SwapRequest {
  staffId: string;
  leaveDates: ISODate[];
  leaveType: 'annual' | 'study';
  cantWorkDates?: ISODate[];
  excludeStaffIds?: string[];
  /** Also search normal working days. Off by default. */
  includeNormalDays?: boolean;
  /** Today, passed in so results are testable. */
  today: ISODate;
  /** Number of ranked plans requested for each longest chain size. */
  planLimits?: Partial<Record<2 | 3 | 4, number>>;
  returnPattern?: 'consecutive' | 'separate' | 'noPreference';
  returnDayType?: 'noPreference' | 'weekdays' | 'weekends';
  returnWindow?: ReturnWindow;
  noAlertsOnly?: boolean;
  askMode?: 'everyone' | 'only' | 'prefer';
  askStaffIds?: string[];
}

export type ReturnWindow =
  | { kind: 'any' }
  | { kind: 'weeks'; weeks: number }
  | { kind: 'dates'; from: ISODate; to: ISODate };

export type UnitKind = 'nightBlock' | 'longDay' | 'dayShift';

/** One thing that moves: a night block, or a single long day or day shift. */
export interface SwapUnit {
  kind: UnitKind;
  staffId: string;
  activity: string;
  dates: ISODate[];
  dayType: 'weekday' | 'weekend' | 'bankHoliday';
  hours: number;
}

/** `gives` goes to the next person. In a same-day pair the returned day job becomes annual leave. */
export interface SwapChain {
  links: { staffId: string; gives: SwapUnit }[];
  payDifferent: boolean;
  /** Direct weekday exchange, with the returned day job taken as annual leave. */
  sameDay?: { doctors: number; minimum: number };
}

export interface MovedShift {
  fromStaffId: string;
  toStaffId: string;
  date: ISODate;
  activity: string;
  kind: 'dayJob' | 'longDay';
}

export interface HoursAlertBreakdown {
  startDate: ISODate;
  endDate: ISODate;
  totalHours: number;
  limitHours: number;
  shifts: { date: ISODate; activity: string; hours: number; fromSwap: boolean }[];
  suggestionTotalHours?: number;
}

export interface SwapAlert {
  staffId: string;
  date: ISODate;
  message: string;
  suggestion?: { date: ISODate; activity: string };
  hours?: HoursAlertBreakdown;
}

export interface SwapPlan {
  chains: SwapChain[];
  people: number;
  shiftsMoved: number;
  cleared: SwapUnit[];
  remaining: SwapUnit[];
  warnings: { date: ISODate; doctors: number; minimum: number }[];
  alerts?: SwapAlert[];
  /** Colleagues who take a long day instead of attending training. */
  missedTraining?: { staffId: string; date: ISODate }[];
  /** Day or long-day shifts passed back as part of a night-block package. */
  movedShifts?: MovedShift[];
  /** Passed day jobs, including same-day exchanges, the requester can take as leave. */
  leaveRequests?: { date: ISODate; activity: string }[];
  /** Passed long days which still need their own swap. */
  toArrange?: { date: ISODate; activity: string }[];
  /** Both days of a leave weekend are exchanged for both days of another weekend. */
  wholeWeekend?: boolean;
  /** Consecutive long days exchanged as one run. */
  blockLength?: number;
  /** Every person in this plan was selected in "These people first". */
  chosenPeople?: boolean;
}

export interface RuledOut {
  unit: SwapUnit;
  staffId: string;
  reason: string;
  group: 'notOnRota' | 'working' | 'leave' | 'training' | 'excluded' | 'other';
}

export interface SwapResult {
  clashes: SwapUnit[];
  /** Part shifts in the leave dates. */
  sortByHand: { date: ISODate; activity: string }[];
  /** NWDs in the leave dates that aren't being searched. */
  requestAsLeave: { date: ISODate; activity: string }[];
  extraShiftsToHandBack: { date: ISODate; activity: string }[];
  plans: SwapPlan[];
  ruledOut: RuledOut[];
  leaveWarnings: { date: ISODate; doctors: number; minimum: number }[];
  /** Dates already below X on the rota before the requester's leave. */
  existingShortages: { date: ISODate; doctors: number; minimum: number }[];
  noRulesWarning: boolean;
  /** Limits that may have hidden otherwise valid options. */
  limits?: ('chainSample' | 'planSample' | 'planCap')[];
  /** Chain sizes for which another page of plans may exist. */
  morePlanSizes?: (2 | 3 | 4)[];
  /** True if a search limit was hit, so options may be missing. */
  truncated: boolean;
}

export interface SwapDateClassification {
  clashes: { date: ISODate; kind: UnitKind; activity: string }[];
  sortByHand: { date: ISODate; activity: string }[];
  requestAsLeave: { date: ISODate; activity: string }[];
  extraShiftsToHandBack: { date: ISODate; activity: string }[];
}

export function extraNightRestDisposition(mandatory: boolean): { reject?: string; alert?: string } {
  return mandatory
    ? { reject: 'A mandatory rest-day extra shift cannot be passed on.' }
    : { alert: 'A recommended rest-day extra shift cannot be passed on' };
}

const LONG_CHAIN_BUDGETS = {
  3: { steps: 10_000, validations: 10 },
  4: { steps: 20_000, validations: 10 },
} as const;
const NIGHT_LONG_CHAIN_BUDGETS = {
  3: { steps: 50_000, validations: 50 },
  4: { steps: 100_000, validations: 50 },
} as const;
const MAX_PLAN_STEPS = 50_000;
const FIRST_PAGE_PLANS_PER_SIZE = { 2: 50, 3: 10, 4: 10 } as const;
const FULL_VALIDATION_HEADROOM = 25;
const MAX_FIRST_PAGE_FULL_VALIDATIONS = 96;
/** Extra first-page direct places for each lower-ranked kind (missed training; NWD swap). */
const RESERVED_DIRECT_PER_KIND = 10;
const MAX_NO_ALERT_VALIDATIONS_PER_SIZE = { 2: 500, 3: 200, 4: 200 } as const;
const WORK_STATUSES = new Set<DayStatus>(['night', 'longDay', 'partShift', 'dayJob']);
const WORK_TIME_RULES = new Set(['minRest', 'restAfterRun', 'restAfterBlock', 'maxHours', 'maxConsecutive', 'minBlock', 'weekendFrequency']);

/** Count key for swap validation: doctor rules ignore reporting date so a moved breach is not treated as new. */
function violationCompareKey(v: { ruleId: string; staffId?: string; date?: ISODate }, profile: Profile): string {
  if (v.staffId && profile.rules.some(rule => rule.id === v.ruleId)) return `${v.ruleId}|${v.staffId}`;
  return `${v.ruleId}|${v.staffId ?? ''}|${v.date ?? ''}`;
}

interface ViolationBaselineEntry {
  count: number;
  dates: Map<string, number>;
}

type ViolationBaseline = Map<string, ViolationBaselineEntry>;

function violationCounts(violations: Violation[], profile: Profile): ViolationBaseline {
  const counts: ViolationBaseline = new Map();
  for (const violation of violations) {
    const key = violationCompareKey(violation, profile);
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
    const key = violationCompareKey(violation, profile);
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

function violationDisposition(violation: Violation, profile: Profile): 'ignore' | 'alert' | 'reject' {
  const rule = profile.rules.find(entry => entry.id === violation.ruleId);
  if (rule?.type === 'weekendFrequency') return 'ignore';
  if (rule?.hard && (rule.type === 'minRest' || rule.type === 'restAfterRun' || rule.type === 'restAfterBlock' ||
    rule.type === 'maxHours' || rule.type === 'maxConsecutive' || rule.type === 'minBlock' ||
    (rule.type === 'count' && !!rule.perWeekAverage))) return 'alert';
  return 'reject';
}

function consecutiveSubject(rule: Extract<Rule, { type: 'maxConsecutive' }>, profile: Profile): string {
  const shifts = (rule.work.shiftTypeIds ?? []).map(id => profile.shiftTypes.find(shift => shift.id === id)).filter((shift): shift is ShiftType => !!shift);
  if (shifts.length && shifts.every(shift => shift.end <= shift.start)) return 'nights';
  if (shifts.length && shifts.every(shift => shiftHours(shift) >= 10)) return 'long days';
  return 'working days';
}

function alertMessage(violation: Violation, profile: Profile): string {
  const rule = profile.rules.find(entry => entry.id === violation.ruleId);
  if (!rule) return violation.message.trim() || 'Would break a working-time limit';
  switch (rule.type) {
    case 'maxHours': return `Would exceed ${rule.hours} hours in ${rule.windowDays} days`;
    case 'minRest': return `Would have less than ${rule.hours} hours between shifts`;
    case 'restAfterBlock': return `Would have less than ${rule.hours} hours off after a block`;
    case 'restAfterRun': return `Would have less than ${rule.hours} hours off after ${rule.runDays} days in a row`;
    case 'maxConsecutive': return `Would work more than ${rule.maxDays} ${consecutiveSubject(rule, profile)} in a row`;
    case 'minBlock': return `Would create a work block shorter than ${rule.minDays} days`;
    case 'count': return `Would exceed an average of ${rule.max ?? 0} ${rule.unit} per week`;
    default: return violation.message.trim() || 'Would break a working-time limit';
  }
}

function rejectionMessage(violation: Violation): string {
  return violation.ruleName.trim() || violation.message.trim() || 'Adds a hard rule break.';
}

type DayType = SwapUnit['dayType'];
type DayShiftClass = 'weekendDay' | 'normalDay';
interface UnitRecord {
  unit: SwapUnit;
  assignments: Assignment[];
  dayShiftClass?: DayShiftClass;
  id: string;
}
interface ValidationContext {
  problem: RotaProblem;
  assignments: Assignment[];
  availability: RotaProblem['unavailability'];
  profile: Profile;
  unitRecords: Map<string, UnitRecord>;
  workingDates: Map<ISODate, Set<string>>;
}
interface SearchState {
  limits: Set<'chainSample' | 'planSample' | 'planCap'>;
}

function dayType(date: ISODate, bankHolidays: Set<ISODate>): DayType {
  if (bankHolidays.has(date)) return 'bankHoliday';
  return weekday(date) >= 5 ? 'weekend' : 'weekday';
}

export function isCountedWork(day: SnapshotDay | undefined): boolean {
  return day?.status === 'dayJob' || day?.status === 'longDay' ||
    (day?.status === 'partShift' && !!day.sessions?.some(session => session === 'am' || session === 'pm'));
}

function isoDistance(a: ISODate, b: ISODate): number {
  return Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;
}

function unitId(unit: SwapUnit): string {
  return `${unit.kind}|${unit.staffId}|${unit.dates.join(',')}|${unit.activity}`;
}

function findRole(profile: Profile, activity: string) {
  return profile.roles.find(role => role.name.toLocaleLowerCase() === activity.toLocaleLowerCase());
}

function ensureActivityShift(profile: Profile, kind: 'night' | 'long' | 'day'): ShiftType {
  const matches = (shift: ShiftType) => kind === 'night'
    ? shift.end <= shift.start
    : shift.end > shift.start && (kind === 'long' ? shiftHours(shift) >= 11 : shiftHours(shift) < 11);
  const existing = profile.shiftTypes.find(matches);
  if (existing) return existing;
  const template: ShiftType = kind === 'night'
    ? { id: 'swap-synthetic-night', name: 'Night', start: '20:00', end: '08:30' }
    : kind === 'long'
      ? { id: 'swap-synthetic-long', name: 'Long day', start: '08:00', end: '20:30' }
      : { id: 'swap-synthetic-day', name: 'Day job', start: '08:00', end: '17:30' };
  while (profile.shiftTypes.some(shift => shift.id === template.id)) template.id += '-copy';
  profile.shiftTypes.push(template);
  return template;
}

function shiftForActivity(profile: Profile, activity: string, date: ISODate, kind: 'night' | 'long' | 'day' | 'part'): ShiftType {
  const role = findRole(profile, activity);
  const demands = role ? profile.demands.filter(demand => demand.roleId === role.id && matchesDay(demand.days, date)) : [];
  const demanded = demands.map(demand => profile.shiftTypes.find(shift => shift.id === demand.shiftTypeId)).filter((shift): shift is ShiftType => !!shift);
  const suitable = (shift: ShiftType) => {
    if (kind === 'part') return shift.end > shift.start;
    if (kind === 'night') return shift.end <= shift.start;
    return shift.end > shift.start && (kind === 'long' ? shiftHours(shift) >= 11 : shiftHours(shift) < 11);
  };
  return demanded.find(suitable) ?? profile.shiftTypes.find(suitable) ?? ensureActivityShift(profile, kind === 'part' ? 'day' : kind);
}

function makeValidationContext(profile: Profile, snapshot: RotaSnapshot, settings: SwapSettings, request: SwapRequest): ValidationContext | undefined {
  const workingProfile = structuredClone(profile);
  const importedWeeks = Object.keys(snapshot.importedAt);
  const importedDateSet = new Set(importedWeeks.flatMap(week => dateRange(week, addDays(week, 6))));
  const snapshotDates = [...importedDateSet].sort();
  if (!snapshotDates.length) return undefined;
  const start = snapshotDates[0];
  const end = snapshotDates[snapshotDates.length - 1];
  const bankHolidays = new Set(settings.bankHolidays);

  const records = new Map<string, UnitRecord>();
  const descriptors = new Map<string, Assignment>();
  const unavailable: RotaProblem['unavailability'] = [];
  const workingDates = new Map<ISODate, Set<string>>();
  for (const [staffId, days] of Object.entries(snapshot.days)) for (const [date, day] of Object.entries(days)) {
    if (!importedDateSet.has(date)) continue;
    if (day.status === 'zero') unavailable.push({ staffId, date, kind: 'nonWorking', reason: 'Zero Day' });
    else if (day.status === 'leave') unavailable.push({ staffId, date, kind: 'leave', reason: 'Leave' });
    else if (day.status === 'training') unavailable.push({ staffId, date, kind: 'other', reason: 'Training' });
    else if (day.status === 'notAvailable') unavailable.push({ staffId, date, kind: 'other', reason: 'Not available' });

    if (!WORK_STATUSES.has(day.status)) continue;
    const activity = day.activity ?? '';
    const shift = shiftForActivity(workingProfile, activity, date, day.status === 'night' ? 'night' : day.status === 'longDay' ? 'long' : day.status === 'partShift' ? 'part' : 'day');
    const roleId = findRole(workingProfile, activity)?.id;
    const assignment: Assignment = { staffId, date, shiftTypeId: shift.id, ...(roleId ? { roleId } : {}) };
    descriptors.set(`${staffId}|${date}`, assignment);
    if (isCountedWork(day)) {
      const set = workingDates.get(date) ?? new Set<string>();
      set.add(staffId);
      workingDates.set(date, set);
    }
  }

  const mkRecord = (staffId: string, dates: ISODate[], kind: UnitKind, activity: string): UnitRecord | undefined => {
    const assignments = dates.map(date => descriptors.get(`${staffId}|${date}`)).filter((a): a is Assignment => !!a);
    if (!assignments.length) return undefined;
    const hours = assignments.reduce((sum, assignment) => sum + shiftHours(workingProfile.shiftTypes.find(shift => shift.id === assignment.shiftTypeId)!), 0);
    const kindDayType = kind === 'nightBlock'
      ? dates.some(date => bankHolidays.has(date)) ? 'bankHoliday' : dates.some(date => weekday(date) >= 5) ? 'weekend' : 'weekday'
      : dayType(dates[0], bankHolidays);
    const unit: SwapUnit = { kind, staffId, activity, dates, dayType: kindDayType, hours };
    const record: UnitRecord = { unit, assignments, id: unitId(unit) };
    if (kind === 'dayShift') {
      record.dayShiftClass = dayType(dates[0], bankHolidays) !== 'weekday' && settings.weekendDayActivities.includes(activity) ? 'weekendDay' : 'normalDay';
    }
    records.set(record.id, record);
    return record;
  };

  // Create full night blocks first so a clash on any night moves the entire block.
  for (const [staffId, days] of Object.entries(snapshot.days)) {
    const nightDates = Object.keys(days).filter(date => snapshot.importedAt[addDays(date, -weekday(date))] && days[date].status === 'night' && !days[date].extra).sort();
    let block: ISODate[] = [];
    const flush = () => {
      if (!block.length) return;
      const first = days[block[0]];
      mkRecord(staffId, block, 'nightBlock', first.activity ?? '');
      block = [];
    };
    for (const date of nightDates) {
      if (block.length && addDays(block[block.length - 1], 1) !== date) flush();
      block.push(date);
    }
    flush();
  }

  for (const [staffId, days] of Object.entries(snapshot.days)) for (const [date, day] of Object.entries(days)) {
    if (day.status === 'longDay' && !day.extra) mkRecord(staffId, [date], 'longDay', day.activity ?? '');
    if (day.status === 'dayJob' && !day.extra) mkRecord(staffId, [date], 'dayShift', day.activity ?? '');
  }

  const baseAssignments = [...descriptors.values()];
  const leaveDates = new Set(request.leaveDates);
  for (const date of leaveDates) unavailable.push({ staffId: request.staffId, date, kind: 'leave', reason: request.leaveType === 'annual' ? 'Requested annual leave' : 'Requested study leave' });
  const problem: RotaProblem = { profile: workingProfile, start, end, fixed: [], unavailability: unavailable };
  return { problem, assignments: baseAssignments, availability: unavailable, profile: workingProfile, unitRecords: records, workingDates };
}

/** Assignments used to validate a swap, excluding requester extras being handed back on requested leave dates. */
export function assignmentsForSwapValidation(assignments: Assignment[], snapshot: RotaSnapshot, request: SwapRequest): Assignment[] {
  const leaveDates = new Set(request.leaveDates);
  return assignments.filter(assignment => !(
    assignment.staffId === request.staffId && leaveDates.has(assignment.date) &&
    snapshot.days[assignment.staffId]?.[assignment.date]?.extra
  ));
}

/** Read imported snapshot days with the same activity, place and shift semantics used by swaps. */
export function snapshotAssignments(profile: Profile, snapshot: RotaSnapshot, dates: ISODate[]): { profile: Profile; assignments: Assignment[] } {
  const workingProfile = structuredClone(profile);
  const chosenDates = new Set(dates);
  const assignments: Assignment[] = [];
  for (const [staffId, days] of Object.entries(snapshot.days)) for (const [date, day] of Object.entries(days)) {
    if (!chosenDates.has(date) || !WORK_STATUSES.has(day.status)) continue;
    const activity = day.activity ?? '';
    const kind = day.status === 'night' ? 'night' : day.status === 'longDay' ? 'long' : day.status === 'partShift' ? 'part' : 'day';
    const shift = shiftForActivity(workingProfile, activity, date, kind);
    const roleId = findRole(workingProfile, activity)?.id;
    assignments.push({ staffId, date, shiftTypeId: shift.id, ...(roleId ? { roleId } : {}) });
  }
  return { profile: workingProfile, assignments };
}

function weekInPost(snapshot: RotaSnapshot, staffId: string, date: ISODate): boolean {
  const start = addDays(date, -weekday(date));
  if (!snapshot.importedAt[start]) return false;
  const days = snapshot.days[staffId] ?? {};
  return dateRange(start, addDays(start, 6)).some(d => (days[d]?.status ?? 'blank') !== 'blank');
}

function excludedOnDate(staffId: string, date: ISODate, settings: SwapSettings, request: SwapRequest, profile?: Profile): boolean {
  if (staffId !== request.staffId && profile?.staff.find(person => person.id === staffId)?.locum) return true;
  if (request.excludeStaffIds?.includes(staffId)) return true;
  if (staffId !== request.staffId && request.askMode === 'only' && !(request.askStaffIds ?? []).includes(staffId)) return true;
  return settings.excluded.some(item => item.staffId === staffId && (!item.until || date <= item.until));
}

function requesterReturnAllowed(unit: SwapUnit, request: SwapRequest): boolean {
  const preference = request.returnWindow ?? { kind: 'any' as const };
  if (preference.kind === 'any') return true;
  if (preference.kind === 'dates') return unit.dates.every(date => date >= preference.from && date <= preference.to);
  const leave = [...request.leaveDates].sort();
  if (!leave.length) return true;
  const days = Math.max(0, Math.floor(preference.weeks)) * 7;
  const first = addDays(leave[0], -days);
  const last = addDays(leave.at(-1)!, days);
  return unit.dates.every(date => date >= first && date <= last);
}

function offReason(staffId: string, unit: SwapUnit, snapshot: RotaSnapshot, settings: SwapSettings, request?: SwapRequest, allowTraining = false, profile?: Profile): string | undefined {
  if (request && staffId === request.staffId) {
    const unavailableDates = new Set([...(request.leaveDates ?? []), ...(request.cantWorkDates ?? [])]);
    if (unit.dates.some(date => unavailableDates.has(date))) return 'The return shift falls on a leave or can’t-work date.';
  }
  for (const date of unit.dates) {
    if (request && excludedOnDate(staffId, date, settings, request, profile)) return 'This doctor is excluded.';
    if ((settings.regularDaysOff[staffId] ?? []).includes(weekday(date))) return 'This is a confirmed regular day off.';
    const day = snapshot.days[staffId]?.[date];
    if (day?.status === 'training' && allowTraining && request && staffId !== request.staffId && unit.kind === 'longDay') continue;
    if (day?.status === 'zero') {
      continue;
    }
    if (day?.status === 'blank' && settings.bankHolidays.includes(date) && weekInPost(snapshot, staffId, date)) continue;
    return day?.status === 'blank' ? 'A blank day is not off.' : `The doctor is not off (${day?.status ?? 'not imported'}).`;
  }
  return undefined;
}

function receiveReason(staffId: string, unit: SwapUnit, snapshot: RotaSnapshot, settings: SwapSettings, request: SwapRequest, profile?: Profile): string | undefined {
  // The requester's return shift must be tomorrow or later, never today.
  if (staffId === request.staffId && unit.dates.some(date => date <= request.today)) {
    return 'The return shift must be after today.';
  }
  if (unit.kind !== 'nightBlock') return offReason(staffId, unit, snapshot, settings, request, true, profile);
  for (const date of unit.dates) {
    const status = snapshot.days[staffId]?.[date]?.status ?? 'blank';
    if (status === 'dayJob' || status === 'longDay') continue;
    const reason = offReason(staffId, { ...unit, dates: [date] }, snapshot, settings, request, false, profile);
    if (reason) return reason;
  }
  return undefined;
}

function plainRuledOutReason(staffId: string, unit: SwapUnit, snapshot: RotaSnapshot, settings: SwapSettings, request: SwapRequest, profile?: Profile): Pick<RuledOut, 'reason' | 'group'> | undefined {
  if (unit.dates.some(date => excludedOnDate(staffId, date, settings, request, profile))) return { reason: 'Excluded from swap suggestions', group: 'excluded' };
  for (const date of unit.dates) {
    if ((settings.regularDaysOff[staffId] ?? []).includes(weekday(date))) return { reason: `Confirmed regular day off on ${date}`, group: 'other' };
    const day = snapshot.days[staffId]?.[date];
    const status = day?.status ?? 'blank';
    if (status === 'zero' || (status === 'training' && staffId !== request.staffId && unit.kind === 'longDay')) continue;
    if (status === 'blank' && settings.bankHolidays.includes(date) && weekInPost(snapshot, staffId, date)) continue;
    if (status === 'blank') return { reason: 'Not on the rota on these dates', group: 'notOnRota' };
    if (unit.kind === 'nightBlock' && (status === 'dayJob' || status === 'longDay')) continue;
    if (status === 'dayJob' || status === 'longDay' || status === 'night' || status === 'partShift') {
      return { reason: `Working ${day?.activity || (status === 'longDay' ? 'a long day' : status === 'night' ? 'nights' : 'a day shift')} on ${date}`, group: 'working' };
    }
    if (status === 'leave') return { reason: `On leave on ${date}`, group: 'leave' };
    if (status === 'training') return { reason: `Training on ${date}`, group: 'training' };
    if (status === 'available') return { reason: `Marked available rather than off on ${date}`, group: 'other' };
    if (status === 'notAvailable') return { reason: `Not available on ${date}`, group: 'other' };
  }
  return undefined;
}

/** Shared classification for the pre-search summary and the full search. */
export function classifySwapDates(snapshot: RotaSnapshot, settings: SwapSettings, request: SwapRequest): SwapDateClassification {
  const result: SwapDateClassification = { clashes: [], sortByHand: [], requestAsLeave: [], extraShiftsToHandBack: [] };
  const importedWeeks = new Set(Object.keys(snapshot.importedAt));
  const leaveDates = [...new Set(request.leaveDates)].filter(date => date >= request.today).sort();
  for (const date of leaveDates) {
    if (!importedWeeks.has(addDays(date, -weekday(date)))) continue;
    const day = snapshot.days[request.staffId]?.[date];
    if (!day) continue;
    const activity = day.activity ?? '';
    if (day.extra) { result.extraShiftsToHandBack.push({ date, activity }); continue; }
    if (day.status === 'night') result.clashes.push({ date, kind: 'nightBlock', activity });
    else if (day.status === 'longDay') result.clashes.push({ date, kind: 'longDay', activity });
    else if (day.status === 'partShift') result.sortByHand.push({ date, activity });
    else if (day.status === 'dayJob') {
      const weekendDay = (weekday(date) >= 5 || settings.bankHolidays.includes(date)) && settings.weekendDayActivities.includes(activity);
      if (weekendDay || request.includeNormalDays) result.clashes.push({ date, kind: 'dayShift', activity });
      else result.requestAsLeave.push({ date, activity });
    }
  }
  return result;
}

interface NightPackage {
  movedShifts: MovedShift[];
  alerts: NonNullable<SwapPlan['alerts']>;
  leaveRequests: { date: ISODate; activity: string }[];
  toArrange: { date: ISODate; activity: string }[];
  rejectReason?: string;
}

function nightPackageForChain(
  chain: SwapChain, snapshot: RotaSnapshot, settings: SwapSettings, request: SwapRequest,
  allGives: Map<string, Set<ISODate>>, allNightReceives: Map<string, Set<ISODate>>, profile: Profile,
): NightPackage {
  const outcome: NightPackage = { movedShifts: [], alerts: [], leaveRequests: [], toArrange: [] };
  if (!chain.links.length || chain.links.some(link => link.gives.kind !== 'nightBlock')) return outcome;
  for (let index = 0; index < chain.links.length; index++) {
    const blockOwner = chain.links[index];
    const receiver = chain.links[(index + 1) % chain.links.length];
    const receiverGives = new Set(receiver.gives.dates);
    const ownerGives = allGives.get(blockOwner.staffId) ?? new Set<ISODate>();
    const ownerReceives = allNightReceives.get(blockOwner.staffId) ?? new Set<ISODate>();
    const first = blockOwner.gives.dates[0];
    const last = blockOwner.gives.dates[blockOwner.gives.dates.length - 1];
    const before = Math.max(1, Math.floor(settings.nightRestDaysBefore ?? 2));
    const afterDefault = blockOwner.gives.dates.length >= 4 ? 3 : 2;
    const after = Math.max(1, Math.floor(settings.nightRestDaysAfter ?? afterDefault));
    const daysToCheck = [
      ...blockOwner.gives.dates.map(date => ({ date, mandatory: true, nightDate: true })),
      ...Array.from({ length: before }, (_, offset) => ({ date: addDays(first, -(offset + 1)), mandatory: offset === 0, nightDate: false })),
      ...Array.from({ length: after }, (_, offset) => ({ date: addDays(last, offset + 1), mandatory: offset === 0, nightDate: false })),
    ];
    for (const checked of daysToCheck) {
      if (receiverGives.has(checked.date)) continue;
      const day = snapshot.days[receiver.staffId]?.[checked.date];
      const status = day?.status ?? 'blank';
      if (!checked.nightDate && (status === 'zero' || status === 'blank' || status === 'leave')) continue;
      if (checked.nightDate && !day?.extra && status !== 'dayJob' && status !== 'longDay') {
        const singleNight: SwapUnit = { ...blockOwner.gives, dates: [checked.date] };
        const unavailable = offReason(receiver.staffId, singleNight, snapshot, settings, request, false, profile);
        if (!unavailable) continue;
        outcome.rejectReason ??= `Cannot take the night on ${checked.date}: ${unavailable}`;
        continue;
      }
      if (status === 'night' && (!day?.extra || !checked.nightDate)) {
        outcome.alerts.push({ staffId: receiver.staffId, date: checked.date, message: 'The night block runs into existing nights' });
        continue;
      }
      if (status === 'dayJob' || status === 'longDay') {
        if (day?.extra) {
          const disposition = extraNightRestDisposition(checked.mandatory);
          if (disposition.reject) outcome.rejectReason ??= disposition.reject.replace('rest-day extra shift', `rest-day extra shift on ${checked.date}`);
          else outcome.alerts.push({ staffId: receiver.staffId, date: checked.date, message: disposition.alert! });
          continue;
        }
        const kind = status;
        const restUnit: SwapUnit = {
          kind: kind === 'longDay' ? 'longDay' : 'dayShift', staffId: receiver.staffId,
          activity: day?.activity ?? '', dates: [checked.date], dayType: dayType(checked.date, new Set(settings.bankHolidays)), hours: 0,
        };
        const cantWork = blockOwner.staffId === request.staffId && request.cantWorkDates?.includes(checked.date);
        const ownerFree = !cantWork && !ownerReceives.has(checked.date) && (ownerGives.has(checked.date) || !offReason(blockOwner.staffId, restUnit, snapshot, settings, request, false, profile));
        if (ownerFree) {
          outcome.movedShifts.push({ fromStaffId: receiver.staffId, toStaffId: blockOwner.staffId, date: checked.date, activity: day?.activity ?? '', kind });
          if (blockOwner.staffId === request.staffId && request.leaveDates.includes(checked.date)) {
            const item = { date: checked.date, activity: day?.activity ?? '' };
            if (kind === 'dayJob') outcome.leaveRequests.push(item);
            else outcome.toArrange.push(item);
          }
        } else if (checked.nightDate || checked.mandatory) outcome.rejectReason ??= `${checked.nightDate ? 'A shift on a night date' : 'A mandatory rest-day shift'} on ${checked.date} cannot be passed on.`;
        else outcome.alerts.push({ staffId: receiver.staffId, date: checked.date, message: 'A recommended rest-day shift cannot be passed on' });
        continue;
      }
      if (checked.mandatory) outcome.rejectReason ??= `A mandatory rest day on ${checked.date} contains ${status}.`;
      else outcome.alerts.push({ staffId: receiver.staffId, date: checked.date, message: `The recommended rest day contains ${status}` });
    }
  }
  return outcome;
}

export function nightPackageForChains(chains: SwapChain[], snapshot: RotaSnapshot, settings: SwapSettings, request: SwapRequest, profile: Profile): NightPackage {
  const combined: NightPackage = { movedShifts: [], alerts: [], leaveRequests: [], toArrange: [] };
  const moved = new Set<string>();
  const alerts = new Set<string>();
  const leaveRequests = new Set<string>();
  const toArrange = new Set<string>();
  const allGives = new Map<string, Set<ISODate>>();
  const allNightReceives = new Map<string, Set<ISODate>>();
  for (const chain of chains) for (let index = 0; index < chain.links.length; index++) {
    const link = chain.links[index];
    const gives = allGives.get(link.staffId) ?? new Set<ISODate>();
    for (const date of link.gives.dates) gives.add(date);
    allGives.set(link.staffId, gives);
    if (link.gives.kind === 'nightBlock') {
      const receiver = chain.links[(index + 1) % chain.links.length].staffId;
      const receives = allNightReceives.get(receiver) ?? new Set<ISODate>();
      for (const date of link.gives.dates) receives.add(date);
      allNightReceives.set(receiver, receives);
    }
  }
  for (const chain of chains) {
    const packageResult = nightPackageForChain(chain, snapshot, settings, request, allGives, allNightReceives, profile);
    combined.rejectReason ??= packageResult.rejectReason;
    for (const shift of packageResult.movedShifts) {
      const key = `${shift.fromStaffId}|${shift.toStaffId}|${shift.date}|${shift.kind}`;
      if (!moved.has(key)) { moved.add(key); combined.movedShifts.push(shift); }
    }
    for (const alert of packageResult.alerts) {
      const key = `${alert.staffId}|${alert.date}|${alert.message}`;
      if (!alerts.has(key)) { alerts.add(key); combined.alerts.push(alert); }
    }
    for (const item of packageResult.leaveRequests) {
      const key = `${item.date}|${item.activity}`;
      if (!leaveRequests.has(key)) { leaveRequests.add(key); combined.leaveRequests.push(item); }
    }
    for (const item of packageResult.toArrange) {
      const key = `${item.date}|${item.activity}`;
      if (!toArrange.has(key)) { toArrange.add(key); combined.toArrange.push(item); }
    }
  }
  return combined;
}

function nightPackageConflict(chains: SwapChain[], movedShifts: MovedShift[]): boolean {
  const primary = new Set(chains.flatMap(chain => chain.links.flatMap(link => link.gives.dates.map(date => `${link.staffId}|${date}`))));
  const sources = new Set<string>();
  for (const move of movedShifts) {
    const source = `${move.fromStaffId}|${move.date}`;
    if (primary.has(source) || sources.has(source)) return true;
    sources.add(source);
  }
  return false;
}

function compatible(a: UnitRecord, b: UnitRecord, settings: SwapSettings, request: SwapRequest): { ok: boolean; payDifferent: boolean } {
  const payDifferent = (a.unit.dayType === 'weekday' && b.unit.dayType !== 'weekday') ||
    (b.unit.dayType === 'weekday' && a.unit.dayType !== 'weekday');
  if (Math.abs(a.unit.hours - b.unit.hours) > Math.max(0, settings.hoursTolerance)) return { ok: false, payDifferent: false };
  if (a.unit.kind !== b.unit.kind) {
    const isDayShiftPair = a.unit.kind === 'dayShift' && (b.unit.kind === 'dayShift');
    if (!isDayShiftPair) return { ok: false, payDifferent: false };
  }
  if (a.unit.kind === 'nightBlock' || b.unit.kind === 'nightBlock') {
    return { ok: a.unit.kind === 'nightBlock' && b.unit.kind === 'nightBlock' && a.unit.dates.length === b.unit.dates.length, payDifferent };
  }
  if (a.unit.kind === 'longDay' || b.unit.kind === 'longDay') {
    return { ok: a.unit.kind === 'longDay' && b.unit.kind === 'longDay', payDifferent };
  }
  if (a.dayShiftClass === 'weekendDay' && b.dayShiftClass === 'weekendDay') return { ok: true, payDifferent };
  if (!request.includeNormalDays) return { ok: false, payDifferent: false };
  if (a.dayShiftClass === 'normalDay' && b.dayShiftClass === 'normalDay') return { ok: true, payDifferent };
  return { ok: true, payDifferent };
}

function movedAssignments(context: ValidationContext, chains: SwapChain[], extraMoves: MovedShift[] = []): Assignment[] {
  const moved = new Map<string, { owner: string; receiver: string; record: UnitRecord; asLeave: boolean }>();
  for (const chain of chains) for (let i = 0; i < chain.links.length; i++) {
    const owner = chain.links[i];
    const receiver = chain.links[(i + 1) % chain.links.length];
    const record = context.unitRecords.get(unitId(owner.gives));
    if (!record) continue;
    moved.set(record.id, { owner: owner.staffId, receiver: receiver.staffId, record, asLeave: !!chain.sameDay && i === 1 });
  }
  const removed = new Set([...moved.values()].flatMap(move => move.record.assignments.map(assignment => `${move.owner}|${assignment.date}`)));
  const out = context.assignments.filter(assignment => !removed.has(`${assignment.staffId}|${assignment.date}`));
  for (const move of moved.values()) if (!move.asLeave) for (const assignment of move.record.assignments) out.push({ ...assignment, staffId: move.receiver, fixed: undefined });
  for (const move of extraMoves) {
    const index = out.findIndex(assignment => assignment.staffId === move.fromStaffId && assignment.date === move.date);
    if (index < 0) continue;
    const [assignment] = out.splice(index, 1);
    out.push({ ...assignment, staffId: move.toStaffId, fixed: undefined });
  }
  return out;
}

function assignmentKey(staffId: string, assignment: Pick<Assignment, 'date' | 'shiftTypeId' | 'roleId'>): string {
  return `${staffId}|${assignment.date}|${assignment.shiftTypeId}|${assignment.roleId ?? ''}`;
}

function swapAddedAssignmentLabels(context: ValidationContext, chains: SwapChain[], extraMoves: MovedShift[]): Map<string, string> {
  const labels = new Map<string, string>();
  for (const chain of chains) for (let index = 0; index < chain.links.length; index++) {
    const link = chain.links[index];
    const receiver = chain.links[(index + 1) % chain.links.length].staffId;
    const record = context.unitRecords.get(unitId(link.gives));
    if (!record) continue;
    for (const assignment of record.assignments) labels.set(assignmentKey(receiver, assignment), link.gives.activity);
  }
  for (const move of extraMoves) {
    const assignment = context.assignments.find(item => item.staffId === move.fromStaffId && item.date === move.date);
    if (assignment) labels.set(assignmentKey(move.toStaffId, assignment), move.activity);
  }
  return labels;
}

function hoursAlertBreakdown(
  violation: Violation,
  context: ValidationContext,
  snapshot: RotaSnapshot,
  addedLabels: Map<string, string>,
  suggestion?: { date: ISODate; activity: string },
): HoursAlertBreakdown | undefined {
  const details = violation.details;
  const staffId = violation.staffId;
  if (details?.kind !== 'maxHours' || !staffId) return undefined;
  const shifts = details.shifts.map(shift => {
    const key = assignmentKey(staffId, shift);
    const activity = addedLabels.get(key) ?? snapshot.days[staffId]?.[shift.date]?.activity ??
      (shift.roleId ? context.profile.roles.find(role => role.id === shift.roleId)?.name : undefined) ??
      context.profile.shiftTypes.find(type => type.id === shift.shiftTypeId)?.name ?? 'Working shift';
    return { date: shift.date, activity, hours: shift.hours, fromSwap: addedLabels.has(key) };
  });
  const suggestionHours = suggestion
    ? details.shifts.filter(shift => shift.date === suggestion.date).reduce((total, shift) => total + shift.hours, 0)
    : 0;
  return {
    startDate: details.startDate,
    endDate: details.endDate,
    totalHours: details.totalHours,
    limitHours: details.limitHours,
    shifts,
    ...(suggestion ? { suggestionTotalHours: Math.max(0, details.totalHours - suggestionHours) } : {}),
  };
}

function relevantAvailability(context: ValidationContext, assignments: Assignment[], chains: SwapChain[] = [], extraMoves: MovedShift[] = []): RotaProblem['unavailability'] {
  const assigned = new Set(assignments.map(assignment => `${assignment.staffId}|${assignment.date}`));
  const received = new Set<string>();
  const passed = new Set(extraMoves.map(move => `${move.toStaffId}|${move.date}`));
  for (const chain of chains) for (let index = 0; index < chain.links.length; index++) {
    const record = context.unitRecords.get(unitId(chain.links[index].gives));
    if (!record) continue;
    const recipient = chain.links[(index + 1) % chain.links.length].staffId;
    for (const date of record.unit.dates) received.add(`${recipient}|${date}`);
  }
  for (const key of passed) received.add(key);
  const trainingReplaced = new Set(chains.flatMap(chain => chain.links.flatMap((link, index) =>
    link.gives.kind === 'longDay' && index + 1 < chain.links.length
      ? link.gives.dates.map(date => `${chain.links[index + 1].staffId}|${date}`) : [])));
  return context.availability.filter(item => {
    const key = `${item.staffId}|${item.date}`;
    return assigned.has(key) && !passed.has(key) && !(item.reason === 'Training' && trainingReplaced.has(key)) && !(item.kind === 'nonWorking' && received.has(key));
  });
}

function countWithChains(context: ValidationContext, request: SwapRequest, chains: SwapChain[]): Map<ISODate, Set<string>> {
  const counts = new Map<ISODate, Set<string>>([...context.workingDates].map(([date, ids]) => [date, new Set(ids)]));
  for (const date of request.leaveDates) counts.get(date)?.delete(request.staffId);
  const moves = chains.flatMap(chain => chain.links.flatMap((owner, index) => {
    if (owner.gives.kind === 'nightBlock') return [];
    return owner.gives.dates.map(date => ({ owner: owner.staffId, receiver: chain.links[(index + 1) % chain.links.length].staffId, date, asLeave: !!chain.sameDay && index === 1 }));
  }));
  // Remove every outgoing shift before adding incoming work, including same-date exchanges.
  for (const move of moves) counts.get(move.date)?.delete(move.owner);
  for (const move of moves) if (!move.asLeave) {
    const set = counts.get(move.date) ?? new Set<string>();
    set.add(move.receiver);
    counts.set(move.date, set);
  }
  return counts;
}

function minimumFor(date: ISODate, settings: SwapSettings): number {
  return settings.bankHolidays.includes(date) ? settings.minDoctorsBankHoliday : settings.minDoctors[weekday(date)] ?? 0;
}

function warningsFor(counts: Map<ISODate, Set<string>>, dates: ISODate[], settings: SwapSettings, baseline?: Map<ISODate, Set<string>>): SwapPlan['warnings'] {
  return [...new Set(dates)].sort().flatMap(date => {
    const doctors = counts.get(date)?.size;
    if (doctors === undefined) return [];
    const minimum = minimumFor(date, settings);
    const baselineDoctors = baseline ? baseline.get(date)?.size ?? 0 : undefined;
    return doctors < minimum && (baselineDoctors === undefined || doctors < baselineDoctors) ? [{ date, doctors, minimum }] : [];
  });
}

/** The requester's leave and pre-existing minimum warnings, shared by the live leave check and search. */
export function leaveMinimumWarningsForSnapshot(profile: Profile, snapshot: RotaSnapshot, settings: SwapSettings, request: Pick<SwapRequest, 'staffId' | 'leaveDates' | 'leaveType'> & { today?: ISODate }): Pick<SwapResult, 'leaveWarnings' | 'existingShortages'> {
  const context = makeValidationContext(profile, snapshot, settings, { ...request, today: '0000-01-01' });
  if (!context) return { leaveWarnings: [], existingShortages: [] };
  const knownDates = new Set(Object.keys(snapshot.importedAt).flatMap(week => dateRange(week, addDays(week, 6))));
  const dates = [...new Set(request.leaveDates)].filter(date => knownDates.has(date) && date >= (request.today ?? '0000-01-01'));
  const after = new Map<ISODate, Set<string>>([...context.workingDates].map(([date, staff]) => [date, new Set(staff)]));
  for (const date of dates) after.get(date)?.delete(request.staffId);
  return {
    leaveWarnings: warningsFor(after, dates, settings),
    existingShortages: warningsFor(context.workingDates, dates, settings),
  };
}

/** Minimum warnings caused by a proposed swap, compared with the current rota. */
export function minimumWarningsForSwap(before: Map<ISODate, Set<string>>, after: Map<ISODate, Set<string>>, dates: ISODate[], settings: SwapSettings): SwapPlan['warnings'] {
  return warningsFor(after, dates, settings, before);
}

function chainDistance(chain: SwapChain): number {
  return chain.links.reduce((total, link, index) => {
    const next = chain.links[(index + 1) % chain.links.length];
    const closest = Math.min(...link.gives.dates.flatMap(a => next.gives.dates.map(b => isoDistance(a, b))));
    return total + closest;
  }, 0);
}

function planDistance(plan: SwapPlan): number {
  return plan.chains.reduce((sum, chain) => sum + chainDistance(chain), 0);
}

function consecutive(dates: ISODate[]): boolean {
  const sorted = [...new Set(dates)].sort();
  return sorted.length >= 2 && sorted.every((date, index) => index === 0 || addDays(sorted[index - 1], 1) === date);
}

function blockLengthForPlan(plan: SwapPlan, request: SwapRequest): number | undefined {
  const longLeave = [...new Set(request.leaveDates.filter(date => plan.chains.some(chain => chain.links[0]?.gives.kind === 'longDay' && chain.links[0].gives.dates.includes(date))))].sort();
  const runs: ISODate[][] = [];
  for (const date of longLeave) {
    const current = runs.at(-1);
    if (current && addDays(current.at(-1)!, 1) === date) current.push(date);
    else runs.push([date]);
  }
  for (const run of runs.filter(item => item.length >= 2).sort((a, b) => b.length - a.length)) {
    const chains = run.map(date => plan.chains.find(chain => chain.links[0]?.gives.kind === 'longDay' && chain.links[0].gives.dates.includes(date)));
    if (chains.some(chain => !chain || chain.links.length !== 2 || chain.links[1].gives.kind !== 'longDay')) continue;
    const direct = chains as SwapChain[];
    const cover = direct[0].links[1].staffId;
    if (direct.some(chain => chain.links[1].staffId !== cover)) continue;
    const returns = direct.flatMap(chain => chain.links[1].gives.dates);
    if (returns.length === run.length && consecutive(returns)) return run.length;
  }
  return undefined;
}

function isLegacyWholeWeekendPlan(plan: SwapPlan, request: SwapRequest): boolean {
  const leave = new Set(request.leaveDates);
  for (const saturday of request.leaveDates.filter(date => weekday(date) === 5)) {
    const sunday = addDays(saturday, 1);
    if (!leave.has(sunday)) continue;
    const first = plan.chains.find(chain => chain.links[0]?.gives.dates.includes(saturday));
    const second = plan.chains.find(chain => chain.links[0]?.gives.dates.includes(sunday));
    if (!first || !second || first.links.length !== 2 || second.links.length !== 2 || first.links[0].gives.kind === 'nightBlock' || second.links[0].gives.kind === 'nightBlock') continue;
    if (first.links[1].staffId !== second.links[1].staffId) continue;
    const returns = [...first.links[1].gives.dates, ...second.links[1].gives.dates];
    const returnSaturday = returns.find(date => weekday(date) === 5);
    if (returnSaturday && returns.includes(addDays(returnSaturday, 1))) return true;
  }
  return false;
}

function returnPatternRank(plan: SwapPlan, pattern: NonNullable<SwapRequest['returnPattern']>): number {
  if (pattern === 'noPreference') return 0;
  const returnsByCover = new Map<string, ISODate[]>();
  for (const chain of plan.chains) {
    const requester = chain.links[0];
    const cover = chain.links[1];
    if (!requester || !cover) continue;
    const dates = returnsByCover.get(cover.staffId) ?? [];
    dates.push(...cover.gives.dates);
    returnsByCover.set(cover.staffId, dates);
  }
  const patterns = [...returnsByCover.values()].filter(dates => dates.length >= 2).map(dates => {
    const sorted = [...new Set(dates)].sort();
    return sorted.length >= 2 && sorted.every((date, index) => index === 0 || addDays(sorted[index - 1], 1) === date);
  });
  if (!patterns.length) return 1;
  const matches = pattern === 'consecutive' ? patterns.some(Boolean) : patterns.some(value => !value);
  return matches ? 0 : 1;
}

function returnDayTypeRank(plan: SwapPlan, preference: NonNullable<SwapRequest['returnDayType']>, bankHolidays: ReadonlySet<ISODate>): number {
  if (preference === 'noPreference') return 0;
  const dates = plan.chains.flatMap(chain => chain.links.at(-1)?.gives.dates ?? []);
  if (!dates.length) return 1;
  const isWeekendRate = (date: ISODate) => bankHolidays.has(date) || weekday(date) >= 5;
  const matches = preference === 'weekdays' ? dates.every(date => !isWeekendRate(date)) : dates.every(isWeekendRate);
  return matches ? 0 : 1;
}

function comparePlans(a: SwapPlan, b: SwapPlan, returnPattern: NonNullable<SwapRequest['returnPattern']>, returnDayType: NonNullable<SwapRequest['returnDayType']>, bankHolidays: ReadonlySet<ISODate>): number {
  return b.cleared.length - a.cleared.length || a.people - b.people ||
    (a.toArrange?.length ?? 0) - (b.toArrange?.length ?? 0) ||
    Number(a.chains.some(chain => chain.sameDay) || !!a.missedTraining?.length) - Number(b.chains.some(chain => chain.sameDay) || !!b.missedTraining?.length) ||
    a.shiftsMoved - b.shiftsMoved ||
    returnPatternRank(a, returnPattern) - returnPatternRank(b, returnPattern) ||
    returnDayTypeRank(a, returnDayType, bankHolidays) - returnDayTypeRank(b, returnDayType, bankHolidays) ||
    a.warnings.length - b.warnings.length ||
    (a.alerts?.length ?? 0) - (b.alerts?.length ?? 0) ||
    Number(a.chains.some(chain => chain.payDifferent)) - Number(b.chains.some(chain => chain.payDifferent)) ||
    planDistance(a) - planDistance(b);
}

function planHasMissedTraining(plan: SwapPlan): boolean {
  return !!plan.missedTraining?.length;
}
function planHasNwdSwap(plan: SwapPlan): boolean {
  return plan.chains.some(chain => !!chain.sameDay);
}
function planIsDirect(plan: SwapPlan): boolean {
  return Math.max(2, ...plan.chains.map(chain => chain.links.length)) === 2;
}
/** Lower-ranked direct kinds that get reserved first-page places. */
function directLowerKind(plan: SwapPlan): 'missedTraining' | 'nwd' | undefined {
  if (!planIsDirect(plan)) return undefined;
  if (planHasMissedTraining(plan)) return 'missedTraining';
  if (planHasNwdSwap(plan)) return 'nwd';
  return undefined;
}

function compareChains(a: SwapChain, b: SwapChain): number {
  const peopleA = a.links.length - 1, peopleB = b.links.length - 1;
  const movedA = a.links.reduce((sum, link) => sum + link.gives.dates.length, 0);
  const movedB = b.links.reduce((sum, link) => sum + link.gives.dates.length, 0);
  return peopleA - peopleB || Number(a.payDifferent) - Number(b.payDifferent) || movedA - movedB || chainDistance(a) - chainDistance(b);
}

/** Find possible cycles of shift exchanges without mutating profile, snapshot or settings. */
export function findSwaps(profile: Profile, snapshot: RotaSnapshot, settings: SwapSettings, request: SwapRequest): SwapResult {
  const state: SearchState = { limits: new Set() };
  const context = makeValidationContext(profile, snapshot, settings, request);
  const result: SwapResult = { clashes: [], sortByHand: [], requestAsLeave: [], extraShiftsToHandBack: [], plans: [], ruledOut: [], leaveWarnings: [], existingShortages: [], noRulesWarning: !activeRules(profile).some(rule => WORK_TIME_RULES.has(rule.type) || (rule.type === 'count' && !!rule.perWeekAverage)), truncated: false };
  if (!context) return result;
  const returnPattern = request.returnPattern ?? settings.returnPattern ?? 'consecutive';
  const returnDayType = request.returnDayType ?? settings.returnDayType ?? 'noPreference';
  const bankHolidays = new Set(settings.bankHolidays);
  const rankPlans = (a: SwapPlan, b: SwapPlan) => comparePlans(a, b, returnPattern, returnDayType, bankHolidays);
  const chosenStaff = new Set(request.askStaffIds ?? []);
  const preferChosen = request.askMode === 'prefer' && chosenStaff.size > 0;
  const chainUsesChosen = (chain: SwapChain) => chain.links.slice(1).every(link => chosenStaff.has(link.staffId));
  const planUsesChosen = (plan: Pick<SwapPlan, 'chains'>) => plan.chains.every(chainUsesChosen);

  const recordsById = context.unitRecords;
  const today = request.today;
  const importedWeeks = new Set(Object.keys(snapshot.importedAt));
  const isImportedDate = (date: ISODate) => importedWeeks.has(addDays(date, -weekday(date)));
  const knownDates = new Set(Object.keys(snapshot.importedAt).flatMap(week => dateRange(week, addDays(week, 6))));
  const clashIds = new Set<string>();
  const byDate = new Map<string, SwapUnit>();
  for (const record of recordsById.values()) for (const date of record.unit.dates) byDate.set(`${record.unit.staffId}|${date}|${record.unit.kind}`, record.unit);

  const classification = classifySwapDates(snapshot, settings, request);
  result.sortByHand = classification.sortByHand;
  result.requestAsLeave = classification.requestAsLeave;
  result.extraShiftsToHandBack = classification.extraShiftsToHandBack;
  for (const item of classification.clashes) {
    const unit = byDate.get(`${request.staffId}|${item.date}|${item.kind}`);
    if (unit && unit.dates.every(date => date >= today) && !clashIds.has(unitId(unit))) { result.clashes.push(unit); clashIds.add(unitId(unit)); }
  }
  result.clashes.sort((a, b) => a.dates[0].localeCompare(b.dates[0]) || a.staffId.localeCompare(b.staffId));
  result.sortByHand.sort((a, b) => a.date.localeCompare(b.date));
  result.requestAsLeave.sort((a, b) => a.date.localeCompare(b.date));

  const minimumWarnings = leaveMinimumWarningsForSnapshot(profile, snapshot, settings, request);
  result.leaveWarnings = minimumWarnings.leaveWarnings;
  result.existingShortages = minimumWarnings.existingShortages;
  if (!result.clashes.length) return { ...result, truncated: false };

  const startUnit = (unit: SwapUnit) => recordsById.get(unitId(unit))!;
  const profileStaff = new Set(profile.staff.map(staff => staff.id));
  const futureRecords = [...recordsById.values()].filter(record => profileStaff.has(record.unit.staffId) && record.unit.dates.every(date => date >= today && isImportedDate(date)));
  const validationContext: ValidationContext = {
    ...context,
    // Handed-back extras are still physical work for cover, but don't count
    // against the requester on dates they have asked to take as leave.
    assignments: assignmentsForSwapValidation(context.assignments, snapshot, request),
  };
  const baselineAssignments = validationContext.assignments;
  const baselineProblem = { ...context.problem, unavailability: relevantAvailability(context, baselineAssignments) };
  const baselineFull = validate(baselineProblem, baselineAssignments);
  const baselineFullCounts = violationCounts(baselineFull.violations, context.profile);

  const validationReason = new Map<string, string>();
  const validChainsByClash = new Map<string, SwapChain[]>();
  const cappedClashes = new Set<string>();
  const planLimitedChainKeys = new Set<string>();
  const globallyUsedChainKeys = new Set<string>();
  const assignmentsByStaff = new Map<string, Assignment[]>();
  for (const assignment of baselineAssignments) {
    const list = assignmentsByStaff.get(assignment.staffId) ?? [];
    list.push(assignment);
    assignmentsByStaff.set(assignment.staffId, list);
  }
  const staffBaselineCache = new Map<string, ViolationBaseline>();
  const staffBaseline = (staffId: string) => {
    const cached = staffBaselineCache.get(staffId);
    if (cached) return cached;
    const report = validate(context.problem, assignmentsByStaff.get(staffId) ?? [], { staffIds: [staffId] });
    const counts = violationCounts(report.violations.filter(violation => violation.staffId === staffId), context.profile);
    staffBaselineCache.set(staffId, counts);
    return counts;
  };
  const staffValidationCache = new Map<string, { ok: boolean; reason?: string }>();
  const validateStaffMovements = (chains: SwapChain[]): { ok: boolean; reason?: string } => {
    const packageResult = nightPackageForChains(chains, snapshot, settings, request, profile);
    if (packageResult.rejectReason) return { ok: false, reason: packageResult.rejectReason };
    if (nightPackageConflict(chains, packageResult.movedShifts)) return { ok: false, reason: 'A rest-day shift is already moving in this plan.' };
    const movements = new Map<string, { gives: UnitRecord[]; receives: UnitRecord[] }>();
    for (const chain of chains) for (let index = 0; index < chain.links.length; index++) {
      const owner = chain.links[index];
      const receiver = chain.links[(index + 1) % chain.links.length];
      const record = recordsById.get(unitId(owner.gives));
      if (!record) continue;
      const ownerMovement = movements.get(owner.staffId) ?? { gives: [], receives: [] };
      ownerMovement.gives.push(record);
      movements.set(owner.staffId, ownerMovement);
      const receiverMovement = movements.get(receiver.staffId) ?? { gives: [], receives: [] };
      if (!chain.sameDay || index !== 1) receiverMovement.receives.push(record);
      movements.set(receiver.staffId, receiverMovement);
    }
    for (const move of packageResult.movedShifts) {
      if (!movements.has(move.fromStaffId)) movements.set(move.fromStaffId, { gives: [], receives: [] });
      if (!movements.has(move.toStaffId)) movements.set(move.toStaffId, { gives: [], receives: [] });
    }
    for (const [staffId, movement] of movements) {
      const gives = [...movement.gives].sort((a, b) => a.id.localeCompare(b.id));
      const receives = [...movement.receives].sort((a, b) => a.id.localeCompare(b.id));
      const movedOut = packageResult.movedShifts.filter(move => move.fromStaffId === staffId).sort((a, b) => a.date.localeCompare(b.date));
      const movedIn = packageResult.movedShifts.filter(move => move.toStaffId === staffId).sort((a, b) => a.date.localeCompare(b.date));
      const cacheKey = `${staffId}|g:${gives.map(record => record.id).join(';')}|r:${receives.map(record => record.id).join(';')}|go:${movedOut.map(move => `${move.date}:${move.kind}`).join(';')}|ri:${movedIn.map(move => `${move.fromStaffId}:${move.date}:${move.kind}`).join(';')}`;
      const cached = staffValidationCache.get(cacheKey);
      if (cached) {
        if (!cached.ok) return cached;
        continue;
      }
      const removedDates = new Set(gives.flatMap(record => record.assignments.map(assignment => assignment.date)));
      for (const move of movedOut) removedDates.add(move.date);
      const assignments = (assignmentsByStaff.get(staffId) ?? []).filter(assignment => !removedDates.has(assignment.date));
      for (const record of receives) for (const assignment of record.assignments) assignments.push({ ...assignment, staffId, fixed: undefined });
      for (const move of movedIn) {
        const assignment = (assignmentsByStaff.get(move.fromStaffId) ?? []).find(item => item.date === move.date);
        if (assignment) assignments.push({ ...assignment, staffId, fixed: undefined });
      }
      const receivedDates = new Set([...receives.flatMap(record => record.unit.dates), ...movedIn.map(move => move.date)]);
      const assignedDates = new Set(assignments.map(assignment => assignment.date));
      const availability = context.availability.filter(item => item.staffId === staffId && assignedDates.has(item.date) &&
        !movedIn.some(move => move.date === item.date) &&
        !(item.reason === 'Training' && staffId !== request.staffId && receives.some(record => record.unit.kind === 'longDay' && record.unit.dates.includes(item.date))) &&
        (item.kind !== 'nonWorking' || !receivedDates.has(item.date)));
      const report = validate({ ...context.problem, unavailability: availability }, assignments, { staffIds: [staffId] });
      const newViolations = addedViolations(
        report.violations.filter(violation => violation.staffId === staffId),
        staffBaseline(staffId),
        context.profile,
      );
      const rejected = newViolations.find(violation => violationDisposition(violation, context.profile) === 'reject');
      const checked = rejected ? { ok: false, reason: rejectionMessage(rejected) } : { ok: true };
      staffValidationCache.set(cacheKey, checked);
      if (!checked.ok) return checked;
    }
    return { ok: true };
  };

  for (const clash of result.clashes) {
    const root = startUnit(clash);
    const candidatesByDistance = [...futureRecords].sort((a, b) => {
      const distanceA = Math.min(...a.unit.dates.flatMap(date => clash.dates.map(clashDate => isoDistance(date, clashDate))));
      const distanceB = Math.min(...b.unit.dates.flatMap(date => clash.dates.map(clashDate => isoDistance(date, clashDate))));
      return distanceA - distanceB || a.unit.staffId.localeCompare(b.unit.staffId) || a.id.localeCompare(b.id);
    });
    const found: SwapChain[] = [];
    const keys = new Set<string>();
    // Same-day pairs are direct only and bypass return-date availability and hours matching.
    if (clash.kind === 'longDay' && clash.dayType === 'weekday' && clash.dates.length === 1) {
      const date = clash.dates[0];
      for (const candidate of futureRecords) {
        const staffId = candidate.unit.staffId;
        if (staffId === request.staffId || profile.staff.find(person => person.id === staffId)?.locum || candidate.unit.kind !== 'dayShift' || candidate.unit.dates[0] !== date) continue;
        const sessions = snapshot.days[staffId]?.[date]?.sessions;
        if (!sessions?.includes('am') || !sessions.includes('pm')) continue;
        if (excludedOnDate(staffId, date, settings, request, profile) || (settings.regularDaysOff[staffId] ?? []).includes(weekday(date))) continue;
        const doctors = (context.workingDates.get(date)?.size ?? 0) - 1;
        const minimum = minimumFor(date, settings);
        if (doctors < minimum) {
          validationReason.set(`${unitId(clash)}|${staffId}`, `Leave on their ${candidate.unit.activity || 'normal working'} day would leave ${doctors} of ${minimum} working, so it's likely to be refused`);
          continue;
        }
        const chain: SwapChain = { links: [{ staffId: request.staffId, gives: clash }, { staffId, gives: candidate.unit }], payDifferent: false, sameDay: { doctors, minimum } };
        const checked = validateStaffMovements([chain]);
        if (checked.ok) found.push(chain);
        else validationReason.set(`${unitId(clash)}|${staffId}`, checked.reason ?? 'Adds a rule break.');
      }
    }
    const maxPeople = Math.min(4, Math.max(2, settings.maxChain));
    for (let people = 2; people <= maxPeople; people++) {
      const budget = people > 2 ? (clash.kind === 'nightBlock' ? NIGHT_LONG_CHAIN_BUDGETS : LONG_CHAIN_BUDGETS)[people as 3 | 4] : undefined;
      const phases = budget && preferChosen
        ? [{ candidates: candidatesByDistance.filter(candidate => chosenStaff.has(candidate.unit.staffId)), chosenOnly: true, skipChosen: false }, { candidates: candidatesByDistance, chosenOnly: false, skipChosen: true }]
        : [{ candidates: candidatesByDistance, chosenOnly: request.askMode === 'only', skipChosen: false }];
      for (const phase of phases) {
        let phaseSteps = 0;
        let phaseValidations = 0;
        let phaseCapped = false;
        const walk = (links: SwapChain['links']) => {
          if (phaseCapped) return;
          const last = links[links.length - 1];
          const current = recordsById.get(unitId(last.gives))!;
          if (links.length === people) {
            const close = compatible(current, root, settings, request);
            const requesterReason = close.ok
              ? !requesterReturnAllowed(current.unit, request) ? 'The return shift is outside the chosen return window.' : receiveReason(request.staffId, current.unit, snapshot, settings, request, profile)
              : undefined;
            if (requesterReason) for (const link of links.slice(1)) validationReason.set(`${unitId(clash)}|${link.staffId}`, requesterReason);
            if (close.ok && !requesterReason) {
              const hasWeekday = links.some(link => link.gives.dayType === 'weekday');
              const hasWeekend = links.some(link => link.gives.dayType !== 'weekday');
              const chain: SwapChain = { links: [...links], payDifferent: hasWeekday && hasWeekend };
              if (phase.skipChosen && chainUsesChosen(chain)) return;
              const key = chain.links.map(link => `${link.staffId}:${unitId(link.gives)}`).join('>');
              if (!keys.has(key)) {
                if (budget && ++phaseValidations > budget.validations) {
                  phaseCapped = true;
                  cappedClashes.add(unitId(clash));
                  state.limits.add('chainSample');
                  return;
                }
                keys.add(key);
                const checked = validateStaffMovements([chain]);
                if (checked.ok) found.push(chain);
                else for (const link of links.slice(1)) validationReason.set(`${unitId(clash)}|${link.staffId}`, checked.reason ?? 'Adds a working-time rule break.');
              }
            }
            return;
          }
          for (const candidate of phase.candidates) {
            if (budget && ++phaseSteps > budget.steps) {
              phaseCapped = true;
              cappedClashes.add(unitId(clash));
              state.limits.add('chainSample');
              return;
            }
            if (candidate.unit.staffId === request.staffId || profile.staff.find(person => person.id === candidate.unit.staffId)?.locum || links.some(link => link.staffId === candidate.unit.staffId)) continue;
            if (receiveReason(candidate.unit.staffId, current.unit, snapshot, settings, request, profile)) continue;
            const match = compatible(current, candidate, settings, request);
            if (!match.ok) continue;
            walk([...links, { staffId: candidate.unit.staffId, gives: candidate.unit }]);
            if (phaseCapped) return;
          }
        };
        walk([{ staffId: request.staffId, gives: clash }]);
      }
    }
    found.sort((a, b) => preferChosen ? Number(chainUsesChosen(b)) - Number(chainUsesChosen(a)) || compareChains(a, b) : compareChains(a, b));
    validChainsByClash.set(unitId(clash), found);
  }

  const orderedClashes = [...result.clashes];
  const markPlanLimited = (plan: Pick<SwapPlan, 'chains'>) => {
    for (const chain of plan.chains) for (const link of chain.links.slice(1)) {
      planLimitedChainKeys.add(`${unitId(chain.links[0].gives)}|${link.staffId}`);
    }
  };
  const choices = orderedClashes.map(unit => validChainsByClash.get(unitId(unit)) ?? []);
  const candidatePlans: SwapPlan[] = [];
  const candidatePlanKeys = new Set<string>();
  const picked: SwapChain[] = [];
  const usedUnits = new Set<string>();
  let planSteps = 0;
  let combinationCapped = false;
  const buildPlan = (cleared: SwapUnit[]) => {
    if (!picked.length) return;
    const signature = picked.map(chain => chain.links.map(link => `${link.staffId}:${unitId(link.gives)}`).join('>')).sort().join('|');
    if (candidatePlanKeys.has(signature)) return;
    candidatePlanKeys.add(signature);
    const packageResult = nightPackageForChains(picked, snapshot, settings, request, profile);
    if (packageResult.rejectReason || nightPackageConflict(picked, packageResult.movedShifts)) return;
    const people = new Set(picked.flatMap(chain => chain.links.slice(1).map(link => link.staffId)));
    const sameDayLeave = picked.filter(chain => chain.sameDay).map(chain => ({ date: chain.links[1].gives.dates[0], activity: chain.links[1].gives.activity }));
    const missedTraining = picked.flatMap(chain => chain.links.flatMap((link, index) => {
      const receiver = chain.links[(index + 1) % chain.links.length].staffId;
      return link.gives.kind === 'longDay' && receiver !== request.staffId
        ? link.gives.dates.filter(date => snapshot.days[receiver]?.[date]?.status === 'training').map(date => ({ staffId: receiver, date })) : [];
    }));
    const plan: SwapPlan = {
      ...(missedTraining.length ? { missedTraining } : {}),
      chains: [...picked], people: people.size,
      shiftsMoved: picked.reduce((sum, chain) => sum + chain.links.reduce((sub, link) => sub + link.gives.dates.length, 0), 0) + packageResult.movedShifts.length,
      cleared: [...cleared], remaining: result.clashes.filter(unit => !cleared.some(done => unitId(done) === unitId(unit))),
      warnings: [],
      ...(packageResult.movedShifts.length ? { movedShifts: packageResult.movedShifts } : {}),
      ...(packageResult.alerts.length ? { alerts: packageResult.alerts } : {}),
      ...((packageResult.leaveRequests.length || sameDayLeave.length) ? { leaveRequests: [...packageResult.leaveRequests, ...sameDayLeave] } : {}),
      ...(packageResult.toArrange.length ? { toArrange: packageResult.toArrange } : {}),
      ...(preferChosen && planUsesChosen({ chains: picked }) ? { chosenPeople: true } : {}),
    };
    const blockLength = blockLengthForPlan(plan, request);
    if (blockLength) {
      plan.blockLength = blockLength;
      if (blockLength === 2 && request.leaveDates.some(date => weekday(date) === 5 && request.leaveDates.includes(addDays(date, 1)))) plan.wholeWeekend = true;
    } else if (isLegacyWholeWeekendPlan(plan, request)) plan.wholeWeekend = true;
    candidatePlans.push(plan);
  };
  const combine = (index: number, cleared: SwapUnit[]) => {
    if (combinationCapped) return;
    if (++planSteps > MAX_PLAN_STEPS) {
      combinationCapped = true;
      state.limits.add('planSample');
      return;
    }
    if (index === orderedClashes.length) { buildPlan(cleared); return; }
    const unit = orderedClashes[index];
    for (const chain of choices[index]) {
      if (chain.links.some(link => usedUnits.has(unitId(link.gives)))) continue;
      for (const link of chain.links) usedUnits.add(unitId(link.gives));
      picked.push(chain);
      combine(index + 1, [...cleared, unit]);
      picked.pop();
      for (const link of chain.links) usedUnits.delete(unitId(link.gives));
    }
    combine(index + 1, cleared);
  };
  combine(0, []);
  const longRuns: SwapUnit[][] = [];
  for (const clash of orderedClashes.filter(unit => unit.kind === 'longDay').sort((a, b) => a.dates[0].localeCompare(b.dates[0]))) {
    const current = longRuns.at(-1);
    if (current && addDays(current.at(-1)!.dates[0], 1) === clash.dates[0]) current.push(clash);
    else longRuns.push([clash]);
  }
  for (const run of longRuns.filter(items => items.length >= 2)) {
    const directByClash = run.map(clash => (validChainsByClash.get(unitId(clash)) ?? []).filter(chain => chain.links.length === 2));
    const coverIds = [...new Set(directByClash[0].map(chain => chain.links[1].staffId))];
    for (const coverId of coverIds) {
      const choicesForCover = directByClash.map(chains => chains.filter(chain => chain.links[1].staffId === coverId));
      if (choicesForCover.some(chains => !chains.length)) continue;
      const chosenChains: SwapChain[] = [];
      const used = new Set<string>();
      const buildBlocks = (index: number) => {
        if (index === choicesForCover.length) {
          const draft: SwapPlan = { chains: [...chosenChains], people: 1, shiftsMoved: 0, cleared: run, remaining: [], warnings: [] };
          if (blockLengthForPlan(draft, request) !== run.length) return;
          picked.push(...chosenChains); buildPlan(run); picked.splice(picked.length - chosenChains.length, chosenChains.length);
          return;
        }
        for (const chain of choicesForCover[index]) {
          const units = chain.links.map(link => unitId(link.gives));
          if (units.some(unit => used.has(unit))) continue;
          units.forEach(unit => used.add(unit)); chosenChains.push(chain); buildBlocks(index + 1); chosenChains.pop(); units.forEach(unit => used.delete(unit));
        }
      };
      buildBlocks(0);
    }
  }
  const exchangeSignature = (plan: SwapPlan) => {
    const people = [...new Set(plan.chains.flatMap(chain => chain.links.map(link => link.staffId)))].sort().join(',');
    const shifts = [...new Set(plan.chains.flatMap(chain => chain.links.map(link => unitId(link.gives))))].sort().join(',');
    return `${people}:${shifts}`;
  };
  const candidateByExchange = new Map<string, SwapPlan>();
  for (const plan of candidatePlans) {
    const key = exchangeSignature(plan);
    const existing = candidateByExchange.get(key);
    if (!existing || rankPlans(plan, existing) < 0) candidateByExchange.set(key, plan);
  }
  const rankedCandidates = [...candidateByExchange.values()].sort((a, b) => preferChosen ? Number(!!b.chosenPeople) - Number(!!a.chosenPeople) || rankPlans(a, b) : rankPlans(a, b));
  const validPlans: SwapPlan[] = [];
  const sizes = [2, 3, 4] as const;
  const planSize = (plan: SwapPlan): 2 | 3 | 4 => Math.max(2, ...plan.chains.map(chain => chain.links.length)) as 2 | 3 | 4;
  const requestedBySize = new Map<2 | 3 | 4, number>(sizes.map(size => [size, Math.max(0, Math.floor(request.planLimits?.[size] ?? FIRST_PAGE_PLANS_PER_SIZE[size]))]));
  /** First-page default for directs: keep validating lower-ranked kinds after the main 50. */
  const reserveDirectKinds = request.planLimits?.[2] == null;
  const validationsBySize = new Map<2 | 3 | 4, number>(sizes.map(size => [size, 0]));
  const directFirstPageBudget = FIRST_PAGE_PLANS_PER_SIZE[2] + FULL_VALIDATION_HEADROOM;
  const activeLongSizeCount = Math.max(0, Math.min(2, settings.maxChain - 2));
  const longFirstPageShare = activeLongSizeCount
    ? Math.max(1, Math.floor((MAX_FIRST_PAGE_FULL_VALIDATIONS - directFirstPageBudget) / activeLongSizeCount))
    : 0;
  const reservedDirectBudget = reserveDirectKinds ? RESERVED_DIRECT_PER_KIND * 2 + FULL_VALIDATION_HEADROOM : 0;
  const validationBudget = (size: 2 | 3 | 4) => {
    const target = requestedBySize.get(size)!;
    if (request.noAlertsOnly) return Math.max(target, MAX_NO_ALERT_VALIDATIONS_PER_SIZE[size]);
    if (size === 2) return target + FULL_VALIDATION_HEADROOM + reservedDirectBudget;
    if (target > FIRST_PAGE_PLANS_PER_SIZE[size]) return target + FULL_VALIDATION_HEADROOM;
    return Math.min(target + FULL_VALIDATION_HEADROOM, longFirstPageShare);
  };
  const validCountsBySize = new Map<2 | 3 | 4, number>(sizes.map(size => [size, 0]));
  const reservedValid = { missedTraining: 0, nwd: 0 };
  const cappedSizes = new Set<2 | 3 | 4>();
  const directMainFull = () => validCountsBySize.get(2)! >= requestedBySize.get(2)!;
  const reservedDirectFull = () => reservedValid.missedTraining >= RESERVED_DIRECT_PER_KIND && reservedValid.nwd >= RESERVED_DIRECT_PER_KIND;
  for (let candidateIndex = 0; candidateIndex < rankedCandidates.length; candidateIndex++) {
    const plan = rankedCandidates[candidateIndex];
    const size = planSize(plan);
    const target = requestedBySize.get(size)!;
    if (!plan.blockLength && size === 2 && reserveDirectKinds && directMainFull()) {
      const kind = directLowerKind(plan);
      if (!kind || reservedValid[kind] >= RESERVED_DIRECT_PER_KIND || reservedDirectFull()) {
        cappedSizes.add(2);
        markPlanLimited(plan);
        continue;
      }
    } else if (!plan.blockLength && validCountsBySize.get(size)! >= target) {
      cappedSizes.add(size);
      markPlanLimited(plan);
      continue;
    }
    const validations = validationsBySize.get(size)!;
    if (!plan.blockLength && validations >= validationBudget(size)) {
      cappedSizes.add(size);
      markPlanLimited(plan);
      continue;
    }
    if (!plan.blockLength) validationsBySize.set(size, validations + 1);
    const movementCheck = validateStaffMovements(plan.chains);
    if (!movementCheck.ok) continue;
    const packageResult = nightPackageForChains(plan.chains, snapshot, settings, request, profile);
    const assignments = movedAssignments(validationContext, plan.chains, packageResult.movedShifts);
    const addedAssignmentLabels = swapAddedAssignmentLabels(validationContext, plan.chains, packageResult.movedShifts);
    const full = validate({ ...context.problem, unavailability: relevantAvailability(validationContext, assignments, plan.chains, packageResult.movedShifts) }, assignments);
    const newViolations = addedViolations(full.violations, baselineFullCounts, context.profile);
    const rejected = newViolations.find(violation => violationDisposition(violation, context.profile) === 'reject');
    if (rejected) {
      const reason = rejectionMessage(rejected);
      for (const chain of plan.chains) for (const link of chain.links.slice(1)) validationReason.set(`${unitId(chain.links[0].gives)}|${link.staffId}`, reason);
      continue;
    }
    const alertDate = plan.chains[0]?.links[0]?.gives.dates[0] ?? request.today;
    const alertViolations = newViolations.filter(violation => violationDisposition(violation, context.profile) === 'alert');
    const isRequester72 = (violation: Violation) => {
      const rule = context.profile.rules.find(item => item.id === violation.ruleId);
      return violation.staffId === request.staffId && rule?.type === 'maxHours' && rule.hours === 72 && rule.windowDays === 7;
    };
    let hoursSuggestion: { date: ISODate; activity: string } | undefined;
    const requester72 = alertViolations.filter(isRequester72);
    if (requester72.length) {
      const movedDates = new Set([...plan.chains.flatMap(chain => chain.links.flatMap(link => link.gives.dates)), ...packageResult.movedShifts.map(move => move.date)]);
      const leaveDates = new Set(request.leaveDates);
      const candidateDates = [...new Set(requester72.flatMap(violation => violation.date ? dateRange(violation.date, addDays(violation.date, 6)) : []))]
        .filter(date => snapshot.days[request.staffId]?.[date]?.status === 'dayJob' && !leaveDates.has(date) && !movedDates.has(date));
      for (const date of candidateDates) {
        const withoutDay = assignments.filter(assignment => !(assignment.staffId === request.staffId && assignment.date === date));
        const suggestionReport = validate({ ...context.problem, unavailability: relevantAvailability(validationContext, withoutDay, plan.chains, packageResult.movedShifts) }, withoutDay);
        const suggestionAdded = addedViolations(suggestionReport.violations, baselineFullCounts, context.profile);
        if (!suggestionAdded.some(isRequester72)) {
          const activity = snapshot.days[request.staffId]?.[date]?.activity ?? 'normal working day';
          hoursSuggestion = { date, activity };
          break;
        }
      }
    }
    const alerts = alertViolations.map(violation => {
      const suggestion = hoursSuggestion && isRequester72(violation) ? hoursSuggestion : undefined;
      const hours = hoursAlertBreakdown(violation, context, snapshot, addedAssignmentLabels, suggestion);
      return {
        staffId: violation.staffId ?? request.staffId,
        date: violation.date ?? alertDate,
        message: alertMessage(violation, context.profile),
        ...(suggestion ? { suggestion } : {}),
        ...(hours ? { hours } : {}),
      };
    });
    const allAlerts = [...packageResult.alerts, ...alerts];
    if (allAlerts.length) plan.alerts = allAlerts;
    else delete plan.alerts;
    if (request.noAlertsOnly && allAlerts.length) continue;
    const movedDates = new Set([...plan.chains.flatMap(chain => chain.links.flatMap(link => link.gives.dates)), ...packageResult.movedShifts.map(move => move.date)]);
    const counts = countWithChains(context, request, plan.chains);
    const underMinimum = plan.chains.find(chain => chain.sameDay && (counts.get(chain.links[0].gives.dates[0])?.size ?? 0) < chain.sameDay.minimum);
    if (underMinimum) {
      const date = underMinimum.links[0].gives.dates[0];
      validationReason.set(`${unitId(underMinimum.links[0].gives)}|${underMinimum.links[1].staffId}`, `Leave on their ${underMinimum.links[1].gives.activity || 'normal working'} day would leave ${counts.get(date)?.size ?? 0} of ${underMinimum.sameDay!.minimum} working, so it's likely to be refused`);
      continue;
    }
    plan.chains = plan.chains.map(chain => chain.sameDay ? { ...chain, sameDay: { ...chain.sameDay, doctors: counts.get(chain.links[0].gives.dates[0])?.size ?? 0 } } : chain);
    const warningDates = [...new Set([...request.leaveDates, ...movedDates])].filter(date => knownDates.has(date));
    plan.warnings = minimumWarningsForSwap(context.workingDates, counts, warningDates, settings);
    validPlans.push(plan);
    if (!plan.blockLength) {
      validCountsBySize.set(size, validCountsBySize.get(size)! + 1);
      if (size === 2 && reserveDirectKinds) {
        const kind = directLowerKind(plan);
        if (kind && validCountsBySize.get(2)! > requestedBySize.get(2)!) reservedValid[kind]++;
      }
    }
  }
  validPlans.sort((a, b) => preferChosen ? Number(!!b.chosenPeople) - Number(!!a.chosenPeople) || rankPlans(a, b) : rankPlans(a, b));
  const returnedBySize = new Map<2 | 3 | 4, number>(sizes.map(size => [size, 0]));
  const selectedDirects = new Set<SwapPlan>();
  if (reserveDirectKinds) {
    const directs = validPlans.filter(plan => !plan.blockLength && planIsDirect(plan));
    const main = directs.slice(0, requestedBySize.get(2)!);
    for (const plan of main) selectedDirects.add(plan);
    for (const kind of ['missedTraining', 'nwd'] as const) {
      let added = 0;
      for (const plan of directs) {
        if (selectedDirects.has(plan) || directLowerKind(plan) !== kind) continue;
        selectedDirects.add(plan);
        if (++added >= RESERVED_DIRECT_PER_KIND) break;
      }
    }
  }
  const diversePlans = validPlans.filter(plan => {
    const size = planSize(plan);
    if (plan.blockLength) return true;
    if (size === 2 && reserveDirectKinds) {
      if (selectedDirects.has(plan)) {
        returnedBySize.set(2, (returnedBySize.get(2) ?? 0) + 1);
        return true;
      }
      cappedSizes.add(2);
      markPlanLimited(plan);
      return false;
    }
    const target = requestedBySize.get(size)!;
    if ((returnedBySize.get(size) ?? 0) >= target) { cappedSizes.add(size); markPlanLimited(plan); return false; }
    returnedBySize.set(size, (returnedBySize.get(size) ?? 0) + 1);
    return true;
  });
  if (cappedSizes.size) state.limits.add('planCap');
  result.morePlanSizes = cappedSizes.size ? [...cappedSizes].sort() : undefined;
  result.plans = diversePlans;
  for (const plan of result.plans) for (const chain of plan.chains) for (const link of chain.links.slice(1)) globallyUsedChainKeys.add(`${unitId(chain.links[0].gives)}|${link.staffId}`);
  const allStaff = profile.staff.filter(staff => staff.id !== request.staffId && !staff.locum && (request.askMode !== 'only' || (request.askStaffIds ?? []).includes(staff.id)));
  for (const clash of result.clashes) for (const staff of allStaff) {
    const id = `${unitId(clash)}|${staff.id}`;
    if (globallyUsedChainKeys.has(id)) continue;
    const plain = plainRuledOutReason(staff.id, clash, snapshot, settings, request, profile);
    const sameDayCandidate = clash.kind === 'longDay' && clash.dayType === 'weekday' && clash.dates.length === 1 && snapshot.days[staff.id]?.[clash.dates[0]]?.status === 'dayJob' &&
      snapshot.days[staff.id]?.[clash.dates[0]]?.sessions?.includes('am') && snapshot.days[staff.id]?.[clash.dates[0]]?.sessions?.includes('pm');
    const reason = planLimitedChainKeys.has(id)
      ? { group: 'other' as const, reason: "A valid swap exists but wasn't shown because of the plan limit." }
      : sameDayCandidate && plain?.group === 'working' && validationReason.has(id)
        ? { group: 'working' as const, reason: validationReason.get(id)! }
        : plain ?? { group: 'other' as const, reason: validationReason.get(id) ?? (cappedClashes.has(unitId(clash)) ? 'No valid chain found before the search limit.' : 'No compatible return shifts complete a valid chain.') };
    result.ruledOut.push({ unit: clash, staffId: staff.id, ...reason });
  }
  result.limits = state.limits.size ? [...state.limits] : undefined;
  result.truncated = state.limits.size > 0;
  return result;
}
