import { addDays, weekday } from '../engine/calendar';
import { classifySwapDates, type MovedShift, type ReturnWindow, type RotaSnapshot, type SwapChain, type SwapPlan, type SwapSettings, type SwapUnit } from '../engine/swaps';
import type { ISODate, Staff } from '../engine/types';
import { formatDateLong } from './components/ui';

export interface SwapFormInputs {
  staffId: string;
  leaveDates: ISODate[];
  leaveType: 'annual' | 'study';
  cantWorkDates: ISODate[];
  excludedStaffIds: string[];
  includeNormalDays: boolean;
  askMode?: 'everyone' | 'only' | 'prefer';
  askStaffIds?: string[];
  returnPattern?: 'consecutive' | 'separate' | 'noPreference';
  returnDayType?: 'noPreference' | 'weekdays' | 'weekends';
  returnWindow?: ReturnWindow;
  noAlertsOnly?: boolean;
  maxChain?: number;
}

/** People shown in manual swap candidate controls. Locums are never offered. */
export function swapOptionPeople(staff: Staff[], requesterId: string): Staff[] {
  return staff.filter(person => person.id !== requesterId && !person.locum);
}

/** Doctors who may be chosen as the Find swaps requester. Occasional locums are hidden. */
export function swapRequesterPeople(staff: Staff[]): Staff[] {
  return staff.filter(person => !person.locum || person.regularLocum);
}

export type SwapPlanFilter = 'all' | 'ask1' | 'ask2' | 'ask3' | 'noAlerts' | 'blocks' | 'wholeWeekend';

/** Session-only result toggles. Not saved with the workspace. */
export interface SwapResultHides {
  hideSameDay?: boolean;
  hideMissedTraining?: boolean;
}

export function planChainSize(plan: SwapPlan): number {
  return Math.max(2, ...plan.chains.map(chain => chain.links.length));
}

export function planHasSameDay(plan: SwapPlan): boolean {
  return plan.chains.some(chain => !!chain.sameDay);
}

export function planHasMissedTraining(plan: SwapPlan): boolean {
  return !!plan.missedTraining?.length;
}

export function planMatchesHides(plan: SwapPlan, hides: SwapResultHides = {}): boolean {
  if (hides.hideSameDay && planHasSameDay(plan)) return false;
  if (hides.hideMissedTraining && planHasMissedTraining(plan)) return false;
  return true;
}

export function planMatchesFilter(plan: SwapPlan, filter: SwapPlanFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'ask1') return plan.people === 1;
  if (filter === 'ask2') return plan.people === 2;
  if (filter === 'ask3') return plan.people === 3;
  if (filter === 'noAlerts') return !(plan.alerts?.length || plan.warnings.length);
  if (filter === 'blocks') return !!plan.blockLength;
  return !!plan.wholeWeekend;
}

export function visibleSwapPlans(plans: SwapPlan[], filter: SwapPlanFilter, hides: SwapResultHides = {}): SwapPlan[] {
  return plans.filter(plan => planMatchesFilter(plan, filter) && planMatchesHides(plan, hides));
}

export function planFilterCounts(plans: SwapPlan[], hides: SwapResultHides = {}): Record<SwapPlanFilter, number> {
  const shown = plans.filter(plan => planMatchesHides(plan, hides));
  const counts = {
    all: shown.length,
    ask1: shown.filter(plan => planMatchesFilter(plan, 'ask1')).length,
    ask2: shown.filter(plan => planMatchesFilter(plan, 'ask2')).length,
    ask3: shown.filter(plan => planMatchesFilter(plan, 'ask3')).length,
    noAlerts: shown.filter(plan => planMatchesFilter(plan, 'noAlerts')).length,
    wholeWeekend: shown.filter(plan => planMatchesFilter(plan, 'wholeWeekend')).length,
  } as Record<SwapPlanFilter, number>;
  Object.defineProperty(counts, 'blocks', { value: shown.filter(plan => planMatchesFilter(plan, 'blocks')).length, enumerable: false });
  return counts;
}

export function inclusiveDates(first: ISODate, last: ISODate): ISODate[] {
  if (!first || !last || last < first) return [];
  const dates: ISODate[] = [];
  for (let date = first; date <= last; date = addDays(date, 1)) dates.push(date);
  return dates;
}

export function calendarColumns(changedDates: ISODate[]): (ISODate | '…')[] {
  const visible = new Set<ISODate>();
  for (const changed of changedDates) for (let offset = -2; offset <= 2; offset++) visible.add(addDays(changed, offset));
  const sorted = [...visible].sort();
  const columns: (ISODate | '…')[] = [];
  for (const date of sorted) {
    const previous = columns.at(-1);
    if (previous && previous !== '…' && addDays(previous, 1) !== date) columns.push('…');
    columns.push(date);
  }
  return columns;
}

export function doctorCountText(count: number): string {
  return `${count} ${count === 1 ? 'doctor' : 'doctors'}`;
}

export function peopleCountText(count: number): string {
  return `${count} ${count === 1 ? 'person' : 'people'}`;
}

export function swapGroupHeading(names: string[], optionCount: number): string {
  const people = names.length < 2 ? names[0] ?? '' : names.length === 2
    ? `${names[0]} and ${names[1]}`
    : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  return `${people} · ${optionCount} ${optionCount === 1 ? 'option' : 'options'}`;
}

export function hoursSuggestionText(suggestion: { date: ISODate; activity: string }): string {
  return `To stay under 72 hours, you could request ${suggestion.activity} on ${formatDateLong(suggestion.date)} as annual leave.`;
}

export function swapLimitMessages(limits: ('chainSample' | 'planSample' | 'planCap')[] | undefined, blockWording = false): string[] {
  const messages: string[] = [];
  if (limits?.includes('chainSample')) messages.push('All direct swaps are shown. Some 3- and 4-person chains may be missing, because the search only checks those closest in date.');
  if (limits?.includes('planSample')) messages.push(`Some combinations may be missing because the search limits how many plans it builds. Direct ${blockWording ? 'block' : 'whole-weekend'} swaps are still checked in full.`);
  if (limits?.includes('planCap')) messages.push('The first page is shown for each chain size. Use Find 50 more to extend a page.');
  return messages;
}

export function planIdentity(plan: SwapPlan): string {
  return plan.chains.map(chain => chain.links.map(link => `${link.staffId}:${link.gives.kind}:${link.gives.dates.join(',')}`).join('>')).sort().join('|');
}

export function appendSwapPlans(existing: SwapPlan[], incoming: SwapPlan[], size?: 2 | 3 | 4, limit = 50): SwapPlan[] {
  const seen = new Set(existing.map(planIdentity));
  const added = incoming.filter(plan => (!size || planChainSize(plan) === size) && !seen.has(planIdentity(plan))).slice(0, limit);
  return [...existing, ...added];
}

export interface SwapPlanGroup {
  key: string;
  people: string[];
  options: { plan: SwapPlan; index: number }[];
}

export function groupSwapPlans(plans: SwapPlan[], requesterId: string, filter: SwapPlanFilter, chosenPeople?: boolean, hides: SwapResultHides = {}): SwapPlanGroup[] {
  const groups = new Map<string, SwapPlanGroup>();
  plans.forEach((plan, index) => {
    if (!planMatchesFilter(plan, filter) || !planMatchesHides(plan, hides)) return;
    if (chosenPeople !== undefined && !!plan.chosenPeople !== chosenPeople) return;
    const people = [...new Set(plan.chains.flatMap(chain => chain.links.map(link => link.staffId)).filter(id => id !== requesterId))].sort();
    const key = people.join('|');
    const group = groups.get(key) ?? { key, people, options: [] };
    group.options.push({ plan, index });
    groups.set(key, group);
  });
  return [...groups.values()];
}

function sameValues(left: string[], right: string[]): boolean {
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.length === sortedRight.length && sortedLeft.every((value, index) => value === sortedRight[index]);
}

export function sameSwapFormInputs(left: SwapFormInputs, right: SwapFormInputs): boolean {
  return left.staffId === right.staffId && left.leaveType === right.leaveType &&
    left.includeNormalDays === right.includeNormalDays && left.askMode === right.askMode &&
    left.returnPattern === right.returnPattern && left.returnDayType === right.returnDayType &&
    JSON.stringify(left.returnWindow) === JSON.stringify(right.returnWindow) &&
    left.noAlertsOnly === right.noAlertsOnly && left.maxChain === right.maxChain &&
    sameValues(left.leaveDates, right.leaveDates) && sameValues(left.cantWorkDates, right.cantWorkDates) &&
    sameValues(left.excludedStaffIds, right.excludedStaffIds) && sameValues(left.askStaffIds ?? [], right.askStaffIds ?? []);
}

/** Historical searches may still store study; the current form is annual leave only. */
export function annualLeaveInputs(inputs: SwapFormInputs): SwapFormInputs {
  return { ...inputs, leaveType: 'annual' };
}

export function swapSettingsFingerprint(settings: SwapSettings): string {
  return JSON.stringify(settings);
}

export function swapResultIsCurrent(resultInputs: SwapFormInputs, resultSettings: string, currentInputs: SwapFormInputs, currentSettings: string): boolean {
  return resultSettings === currentSettings && sameSwapFormInputs(resultInputs, currentInputs);
}

export function withDeclinedDoctor(inputs: SwapFormInputs, staffId: string): SwapFormInputs {
  return { ...inputs, excludedStaffIds: [...new Set([...inputs.excludedStaffIds, staffId])] };
}

export interface SwapDateSummary {
  clashes: { date: ISODate; label: string }[];
  swapCount: number;
  requestAsLeave: { date: ISODate; label: string }[];
  sortByHand: { date: ISODate; label: string }[];
  extraShiftsToHandBack: { date: ISODate; label: string }[];
  partialRun?: { dates: ISODate[]; missing: ISODate[] };
}

export function swapDateSummary(snapshot: RotaSnapshot, settings: SwapSettings, staffId: string, leaveDates: ISODate[], includeNormalDays: boolean, today = '0000-01-01'): SwapDateSummary {
  const days = snapshot.days[staffId] ?? {};
  const summary: SwapDateSummary = { clashes: [], swapCount: 0, requestAsLeave: [], sortByHand: [], extraShiftsToHandBack: [] };
  const classified = classifySwapDates(snapshot, settings, { staffId, leaveDates, leaveType: 'annual', includeNormalDays, today });
  const label = (date: ISODate, fallback: string) => days[date]?.activity || fallback;
  summary.clashes = classified.clashes.map(item => ({ date: item.date, label: label(item.date, item.kind === 'nightBlock' ? 'Night' : item.kind === 'longDay' ? 'Long day' : 'Day job') }));
  const selectedNightDates = new Set(classified.clashes.filter(item => item.kind === 'nightBlock').map(item => item.date));
  let nightBlocks = 0;
  for (const date of [...selectedNightDates].sort()) {
    if (selectedNightDates.has(addDays(date, -1))) continue;
    nightBlocks++;
  }
  summary.swapCount = classified.clashes.filter(item => item.kind !== 'nightBlock').length + nightBlocks;
  summary.requestAsLeave = classified.requestAsLeave.map(item => ({ date: item.date, label: label(item.date, 'Day job') }));
  summary.sortByHand = classified.sortByHand.map(item => ({ date: item.date, label: label(item.date, 'Part shift') }));
  summary.extraShiftsToHandBack = classified.extraShiftsToHandBack.map(item => ({ date: item.date, label: item.activity || 'Extra shift' }));
  const selected = new Set(leaveDates);
  const checked = new Set<ISODate>();
  for (const date of [...selected].sort()) {
    if (days[date]?.status !== 'longDay' || checked.has(date)) continue;
    let first = date, last = date;
    while (days[addDays(first, -1)]?.status === 'longDay') first = addDays(first, -1);
    while (days[addDays(last, 1)]?.status === 'longDay') last = addDays(last, 1);
    const run = inclusiveDates(first, last);
    run.forEach(item => checked.add(item));
    const missing = run.filter(item => !selected.has(item));
    if (run.length >= 2 && missing.length && run.some(item => selected.has(item))) { summary.partialRun = { dates: run, missing }; break; }
  }
  return summary;
}

export function partialCoverageTitle(plan: SwapPlan, requesterId: string): string | undefined {
  if (!plan.remaining.length) return undefined;
  const covered = [...new Set(plan.cleared.filter(unit => unit.staffId === requesterId).flatMap(unit => unit.dates))].sort();
  if (!covered.length) return 'Covers part of the request';
  if (covered.length === 1) return `Covers ${formatDateLong(covered[0]).split(' ')[0]} only`;
  return `Covers ${covered.map(date => formatDateLong(date).replace(/^(\w+) (\d+) (\w+)$/, '$1 $2')).join(' and ')}`;
}

export function completePlansFirst<T extends SwapPlan>(plans: T[]): T[] {
  return [...plans].sort((a, b) => Number(a.remaining.length > 0) - Number(b.remaining.length > 0));
}

export function staffingSummaryLine(leaveWarnings: { date: ISODate }[], existingShortages: { date: ISODate }[]): string | undefined {
  if (!leaveWarnings.length && !existingShortages.length) return undefined;
  const leave = leaveWarnings.length ? `${leaveWarnings.length} ${leaveWarnings.length === 1 ? 'day' : 'days'} below minimum with your leave` : 'no days below minimum with your leave';
  const existing = existingShortages.length ? `, ${existingShortages.length} ${existingShortages.length === 1 ? 'day' : 'days'} already short` : '';
  return `Staffing: ${leave}${existing}`;
}

/** The browser's calendar date, deliberately not the UTC date. */
export function localISODate(now = new Date()): ISODate {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function datesBeforeToday(dates: ISODate[], today: ISODate): ISODate[] {
  return [...new Set(dates)].filter(date => date < today).sort();
}

export function pastLeaveWarning(dates: ISODate[], today: ISODate): string | undefined {
  const past = datesBeforeToday(dates, today);
  return past.length ? `These leave dates are before today and cannot be searched: ${past.map(formatDateLong).join(', ')}.` : undefined;
}

export function importedWeekFor(date: ISODate): ISODate {
  return addDays(date, -weekday(date));
}

export function datesOutsideImports(snapshot: RotaSnapshot, dates: ISODate[]): ISODate[] {
  return [...new Set(dates)].filter(date => !snapshot.importedAt[importedWeekFor(date)]).sort();
}

export function latestImport(snapshot: RotaSnapshot): string | undefined {
  return Object.values(snapshot.importedAt).sort().at(-1);
}

export function weekendActivities(snapshot: RotaSnapshot, bankHolidays: ISODate[]): string[] {
  const holidays = new Set(bankHolidays);
  const found = new Set<string>();
  for (const days of Object.values(snapshot.days)) for (const [date, day] of Object.entries(days)) {
    if (day.status === 'dayJob' && day.activity && (weekday(date) >= 5 || holidays.has(date))) found.add(day.activity);
  }
  return [...found].sort((a, b) => a.localeCompare(b));
}

function possessive(name: string): string {
  return name.endsWith('s') ? `${name}'` : `${name}'s`;
}

export function unitDescription(unit: SwapUnit): string {
  const kind = unit.kind === 'nightBlock' ? 'night block' : unit.kind === 'longDay' ? 'long day' : 'day shift';
  const activity = unit.activity ? ` (${unit.activity})` : '';
  const dates = unit.dates.length === 1
    ? formatDateLong(unit.dates[0])
    : `${formatDateLong(unit.dates[0])} to ${formatDateLong(unit.dates[unit.dates.length - 1])}`;
  return `${kind}${activity} on ${dates}`;
}

export function chainSentences(chain: SwapChain, staff: Staff[], requesterId: string): string[] {
  const name = (id: string) => staff.find(person => person.id === id)?.name ?? 'Unknown doctor';
  if (chain.sameDay) return [`NWD swap: ${name(chain.links[1].staffId)} works your long day; you take their ${chain.links[1].gives.activity} and request it as annual leave.`];
  return chain.links.map((link, index) => {
    const recipient = chain.links[(index + 1) % chain.links.length].staffId;
    const ownerName = link.staffId === requesterId ? 'your' : possessive(name(link.staffId));
    const recipientName = recipient === requesterId ? 'You' : name(recipient);
    return `${recipientName} ${recipient === requesterId ? 'take' : 'takes'} ${ownerName} ${unitDescription(link.gives)}.`;
  });
}

export function movedShiftSentence(move: MovedShift, staff: Staff[], requesterId: string): string {
  const name = (id: string) => staff.find(person => person.id === id)?.name ?? 'Unknown doctor';
  const recipient = move.toStaffId === requesterId ? 'You' : name(move.toStaffId);
  const owner = move.fromStaffId === requesterId ? 'your' : possessive(name(move.fromStaffId));
  return `${recipient} also ${move.toStaffId === requesterId ? 'take' : 'takes'} ${owner} ${move.activity || (move.kind === 'longDay' ? 'long day' : 'day shift')} on ${formatDateLong(move.date)}.`;
}

export const SAME_DAY_LABEL = 'Not like for like: they work a long day instead of their day job';

export function swapPlanNotes(plan: SwapPlan, nameFor: (staffId: string) => string, dateFor: (date: ISODate) => string = formatDateLong): string[] {
  const nameNotes = plan.people > 1;
  return [
    ...(plan.chains.some(chain => chain.sameDay) ? [SAME_DAY_LABEL] : []),
    ...plan.chains.filter(chain => chain.sameDay).map(chain => `${dateFor(chain.links[0].gives.dates[0])}: ${chain.sameDay!.doctors} of ${chain.sameDay!.minimum} working after leave`),
    ...(plan.missedTraining ?? []).map(item => nameNotes
      ? `${nameFor(item.staffId)}: Misses training on ${dateFor(item.date)}`
      : `Misses training on ${dateFor(item.date)}`),
  ];
}
