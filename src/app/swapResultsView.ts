import { addDays, dateRange, shiftHours, weekday } from '../engine/calendar';
import { isCountedWork, snapshotAssignments, type RotaSnapshot, type SwapPlan, type SwapResult, type SwapSettings, type SwapUnit } from '../engine/swaps';
import type { ISODate, Profile, Staff } from '../engine/types';
import { rotaShortCode } from './components/SwapDateCalendar';
import { appendSwapPlans, chainSentences, completePlansFirst, partialCoverageTitle, planChainSize, planIdentity, planMatchesFilter, planMatchesHides, type SwapPlanFilter, type SwapResultHides } from './swapsView';

export const SAME_DAY_EXPLANATION = 'Same-day swap: they work your long day, you take their day job as leave';
export const PAY_EXPLANATION = 'Weekday and weekend shifts exchanged: check any effect on pay';
export const shortDate = (date: ISODate): string => new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).replace(',', '');
export function naturalJoin(values: string[]): string { return values.length < 3 ? values.join(' and ') : `${values.slice(0, -1).join(', ')} and ${values.at(-1)}`; }
export function resultDateLabel(dates: ISODate[]): string {
  const sorted = [...new Set(dates)].sort();
  return naturalJoin(sorted.map((date, index) => index < sorted.length - 1 && date.slice(0, 7) === sorted.at(-1)!.slice(0, 7) ? shortDate(date).replace(/ \w+$/, '') : shortDate(date)));
}
export function optionContacts(plan: SwapPlan, requesterId: string): string[] {
  return [...new Set([...plan.chains.flatMap(chain => chain.links.map(link => link.staffId)), ...(plan.movedShifts?.flatMap(move => [move.fromStaffId, move.toStaffId]) ?? [])])].filter(id => id !== requesterId);
}
export function optionKind(plan: SwapPlan): string {
  return plan.chains.some(chain => chain.sameDay) ? 'Same-day swap' : planChainSize(plan) === 2 ? 'Straight swap' : planChainSize(plan) === 3 ? 'Three-way' : 'Four-way';
}
export function optionBadge(plan: SwapPlan, noRulesWarning = false): string {
  if (plan.remaining.length) return 'Part';
  const count = (plan.alerts?.length ?? 0) + plan.warnings.length;
  return count ? `${count} ${count === 1 ? 'alert' : 'alerts'}` : noRulesWarning ? 'Not checked' : 'No alerts';
}
/** Everyone's moves, including the person working each same-day long day. */
export function optionChainSentences(plan: SwapPlan, staff: Staff[], requesterId: string): string[] {
  const name = (id: string) => staff.find(person => person.id === id)?.name ?? 'Unknown doctor';
  return plan.chains.flatMap(chain => chain.sameDay
    ? [`${name(chain.links[1].staffId)} works your long day on ${resultDateLabel(chain.links[0].gives.dates)}; you take their ${chain.links[1].gives.activity} as annual leave.`]
    : chainSentences(chain, staff, requesterId));
}
export function ownLeaveText(plan: SwapPlan): string | undefined {
  return plan.usesOwnLeave?.length ? `Uses your leave on ${naturalJoin(plan.usesOwnLeave.map(shortDate))}: you'd need to cancel it in MediRota` : undefined;
}
export function differentShiftLengths(plan: SwapPlan, requesterId: string): string | undefined {
  const differences = plan.chains.flatMap(chain => {
    const index = chain.links.findIndex(link => link.staffId === requesterId);
    if (index < 0) return [];
    const give = chain.links[index].gives, take = chain.links[(index + chain.links.length - 1) % chain.links.length].gives;
    return Math.abs(give.hours - take.hours) > 0.001 ? [`${take.hours} h for your ${give.hours} h`] : [];
  });
  if (differences.length) return `Different shift lengths: ${[...new Set(differences)].join('; ')}`;
  const withinChain = plan.chains.flatMap(chain => {
    const hours = [...new Set(chain.links.map(link => link.gives.hours))].sort((a, b) => a - b);
    return hours.length > 1 && hours.at(-1)! - hours[0] > 0.001 ? [`${naturalJoin(hours.map(value => `${value} h`))} exchanged within a chain`] : [];
  });
  return withinChain.length ? `Different shift lengths: ${[...new Set(withinChain)].join('; ')}` : undefined;
}
export function optionSummary(plan: SwapPlan, requesterId: string): string {
  const dates = [...new Set(plan.cleared.flatMap(unit => unit.dates))];
  // Design B list rows use "Fri only", not the longer "Covers Fri only" title used elsewhere.
  const partial = partialCoverageTitle(plan, requesterId);
  const coverage = partial ? partial.replace(/^Covers /, '') : dates.length === 2 ? 'both days' : dates.length > 2 ? `all ${dates.length} days` : 'the day';
  return [optionKind(plan), coverage, ...(plan.chains.some(chain => chain.sameDay) ? ['day job as leave'] : []), ...(differentShiftLengths(plan, requesterId) ? ['different shift lengths'] : []), ownLeaveText(plan)].filter(Boolean).join(' · ');
}
export interface OptionRow { plan: SwapPlan; number: number; identity: string; section?: 'Your chosen people' | 'Everyone else' }
export function optionRows(plans: SwapPlan[], filter: SwapPlanFilter = 'all', hides: SwapResultHides = {}, hasChosenPeople = false, askMode?: 'everyone' | 'only' | 'prefer'): OptionRow[] {
  const shown = plans.filter(plan => planMatchesFilter(plan, filter) && planMatchesHides(plan, hides));
  const isChosen = (plan: SwapPlan) => askMode === 'only' || !!plan.chosenPeople;
  const ordered = hasChosenPeople ? [...completePlansFirst(shown.filter(isChosen)), ...completePlansFirst(shown.filter(plan => !isChosen(plan)))] : completePlansFirst(shown);
  return ordered.map((plan, index) => ({ plan, number: index + 1, identity: planIdentity(plan), ...(hasChosenPeople ? { section: isChosen(plan) ? 'Your chosen people' as const : 'Everyone else' as const } : {}) }));
}
/** Keep old options visible during both progress and completion of Find 50 more. */
export function resultWithAppendedPlans(incoming: SwapResult, previous?: SwapResult, size?: 2 | 3 | 4): SwapResult {
  return previous ? { ...incoming, plans: appendSwapPlans(previous.plans, incoming.plans, size) } : incoming;
}
export function selectedOption(rows: OptionRow[], identity?: string): OptionRow | undefined { return rows.find(row => row.identity === identity) ?? rows[0]; }
export function resultLimitsLine(result: Partial<Pick<SwapResult, 'limits' | 'morePlanSizes' | 'truncated'>>): string | undefined {
  if (!result.limits?.length && !result.morePlanSizes?.length && !result.truncated) return undefined;
  const sampled = result.limits?.some(limit => limit === 'chainSample' || limit === 'planSample');
  return `Showing the first page.${sampled ? " Some 3- and 4-person swaps aren't shown yet." : ' More options may be available.'}`;
}
export function moreOptionSizes(result: Partial<Pick<SwapResult, 'limits' | 'morePlanSizes' | 'truncated'>>, maxChain: number): (2 | 3 | 4)[] {
  if (result.morePlanSizes?.length) return result.morePlanSizes.filter(size => size <= maxChain);
  if (!resultLimitsLine(result)) return [];
  return ([2, 3, 4] as const).filter(size => size <= maxChain && (size >= 3 || !result.limits?.includes('chainSample') || result.limits.includes('planSample')));
}
export interface RequesterMove { dates: ISODate[]; activity: string; hours: number; kind: SwapUnit['kind']; asLeave?: boolean }
export function requesterMoves(plan: SwapPlan, requesterId: string, profile?: Profile, snapshot?: RotaSnapshot): { give: RequesterMove[]; take: RequesterMove[] } {
  const give: RequesterMove[] = [], take: RequesterMove[] = [];
  for (const chain of plan.chains) chain.links.forEach((link, index) => {
    if (link.staffId === requesterId) give.push({ ...link.gives });
    if (chain.links[(index + 1) % chain.links.length].staffId === requesterId) take.push({ ...link.gives, ...(chain.sameDay && index === 1 ? { asLeave: true } : {}) });
  });
  for (const move of plan.movedShifts ?? []) {
    if (move.fromStaffId !== requesterId && move.toStaffId !== requesterId) continue;
    let hours = 0;
    if (profile && snapshot) {
      const actual = snapshotAssignments(profile, snapshot, [move.date]);
      const assignment = actual.assignments.find(item => item.staffId === move.fromStaffId && item.date === move.date);
      const shift = actual.profile.shiftTypes.find(item => item.id === assignment?.shiftTypeId);
      if (shift) hours = shiftHours(shift);
    }
    (move.fromStaffId === requesterId ? give : take).push({ dates: [move.date], activity: move.activity, kind: move.kind === 'dayJob' ? 'dayShift' : 'longDay', hours });
  }
  return { give, take };
}
export function moveLabel(move: RequesterMove): string { return `${resultDateLabel(move.dates)} · ${move.activity || (move.kind === 'nightBlock' ? 'Nights' : move.kind === 'longDay' ? 'Long day' : 'Day job')} · ${move.hours} h${move.asLeave ? ' (take as annual leave)' : ''}`; }
export function copySwapMessage(plan: SwapPlan, staff: Staff[], requesterId: string, profile?: Profile, snapshot?: RotaSnapshot): string {
  const name = (id: string) => staff.find(person => person.id === id)?.name ?? 'Unknown doctor';
  const names = optionContacts(plan, requesterId).map(name).join(', ');
  const describe = (move: RequesterMove) => `${resultDateLabel(move.dates)} ${move.activity || (move.kind === 'nightBlock' ? 'nights' : move.kind === 'longDay' ? 'long day' : 'day job')} (${move.hours} h)`;
  const moves = requesterMoves(plan, requesterId, profile, snapshot);
  const direct = planChainSize(plan) === 2 && !plan.chains.some(chain => chain.sameDay) && optionContacts(plan, requesterId).length === 1;
  let body: string;
  if (plan.chains.every(chain => chain.sameDay) && optionContacts(plan, requesterId).length === 1) body = `You would work my long ${moves.give.flatMap(move => move.dates).length > 1 ? 'days' : 'day'} on ${resultDateLabel(moves.give.flatMap(move => move.dates))}, and I'd take your day job as annual leave.`;
  else if (direct) body = `I'd give you ${naturalJoin(moves.give.map(describe))}, and take your ${naturalJoin(moves.take.map(describe))}.`;
  else body = plan.chains.flatMap(chain => chain.sameDay ? [`${name(chain.links[1].staffId)} would work my long day on ${resultDateLabel(chain.links[0].gives.dates)}, and I'd take their day job as annual leave.`] : chain.links.map((link, index) => {
    const receiver = chain.links[(index + 1) % chain.links.length].staffId;
    return `${link.staffId === requesterId ? 'I' : name(link.staffId)} would give ${describe(link.gives)} to ${receiver === requesterId ? 'me' : name(receiver)}.`;
  })).join(' ');
  // Package moves are already included in the requester description for direct options.
  if (!direct) body += (plan.movedShifts ?? []).map(move => ` ${move.fromStaffId === requesterId ? 'I' : name(move.fromStaffId)} would also give ${move.activity} on ${shortDate(move.date)} to ${move.toStaffId === requesterId ? 'me' : name(move.toStaffId)}.`).join('');
  if (plan.usesOwnLeave?.length) body += ` I'd cancel my leave on ${naturalJoin(plan.usesOwnLeave.map(shortDate))} in MediRota.`;
  return `Hi ${names}, would you swap with me? ${body} (Found with Rota Planner; I'll check and book it in MediRota.)`;
}
export interface StaffingLine { date: ISODate; doctors: number; minimum: number; below: boolean }
/** Mirrors countWithChains and minimumFor. Night-package moves do not change the daytime headcount. */
export function optionStaffing(plan: SwapPlan, snapshot: RotaSnapshot, settings: SwapSettings, requesterId: string, leaveDates: ISODate[]): StaffingLine[] {
  const counts = new Map<ISODate, Set<string>>();
  for (const [id, days] of Object.entries(snapshot.days)) for (const [date, day] of Object.entries(days)) {
    if (!snapshot.importedAt[addDays(date, -weekday(date))] || !isCountedWork(day)) continue;
    const people = counts.get(date) ?? new Set<string>(); people.add(id); counts.set(date, people);
  }
  for (const date of leaveDates) counts.get(date)?.delete(requesterId);
  const moves = plan.chains.flatMap(chain => chain.links.flatMap((link, index) => link.gives.kind === 'nightBlock' ? [] : link.gives.dates.map(date => ({ date, from: link.staffId, to: chain.links[(index + 1) % chain.links.length].staffId, asLeave: !!chain.sameDay && index === 1 }))));
  for (const move of moves) counts.get(move.date)?.delete(move.from);
  for (const move of moves) if (!move.asLeave) { const people = counts.get(move.date) ?? new Set<string>(); people.add(move.to); counts.set(move.date, people); }
  const dates = [...new Set([...leaveDates, ...plan.chains.flatMap(chain => chain.links.flatMap(link => link.gives.dates)), ...(plan.movedShifts?.map(move => move.date) ?? [])])].sort();
  return dates.flatMap(date => {
    if (!snapshot.importedAt[addDays(date, -weekday(date))]) return [];
    const minimum = settings.bankHolidays.includes(date) ? settings.minDoctorsBankHoliday : settings.minDoctors[weekday(date)] ?? 0;
    const doctors = counts.get(date)?.size ?? 0;
    return minimum > 0 ? [{ date, doctors, minimum, below: doctors < minimum }] : [];
  });
}
export function staffingLine(item: Pick<StaffingLine, 'date' | 'doctors' | 'minimum'>): string {
  return `${shortDate(item.date)}: ${item.doctors} ${item.doctors === 1 ? 'doctor' : 'doctors'} at work (minimum ${item.minimum})${item.doctors < item.minimum ? ', below minimum' : ''}`;
}
export function requesterCalendar(plan: SwapPlan, snapshot: RotaSnapshot, requesterId: string, leaveDates: ISODate[]) {
  const moves = requesterMoves(plan, requesterId);
  const changed = [...leaveDates, ...[...moves.give, ...moves.take].flatMap(move => move.dates)];
  const weeks = [...new Set(changed.map(date => addDays(date, -weekday(date))))].sort();
  return weeks.map(start => ({ start, days: dateRange(start, addDays(start, 6)).map(date => {
    const given = moves.give.filter(move => move.dates.includes(date)), taken = moves.take.filter(move => move.dates.includes(date));
    const code = (move: RequesterMove) => rotaShortCode(move.kind === 'nightBlock' ? 'night' : move.kind === 'longDay' ? 'longDay' : 'dayJob');
    const leave = leaveDates.includes(date) || taken.some(move => move.asLeave) || !!plan.leaveRequests?.some(item => item.date === date);
    return { date, given: given.map(code), taken: taken.filter(move => !move.asLeave).map(code), leave, code: given.length || taken.length ? '' : rotaShortCode(snapshot.days[requesterId]?.[date]?.status ?? 'blank') };
  }) }));
}

/** Page and share wording, deliberately separate from the chat add-on's historical helpers. */
export function optionNotes(plan: SwapPlan, requesterId: string, nameFor: (id: string) => string, dateFor: (date: ISODate) => string = shortDate): string[] {
  return [
    ...(plan.chains.some(chain => chain.sameDay) ? [SAME_DAY_EXPLANATION] : []),
    ...plan.chains.filter(chain => chain.sameDay && chain.sameDay.minimum > 0).map(chain => {
      const { doctors, minimum } = chain.sameDay!;
      return `${dateFor(chain.links[0].gives.dates[0])}: ${doctors} doctors at work (minimum ${minimum})${doctors < minimum ? ', below minimum' : ''}`;
    }),
    ...(differentShiftLengths(plan, requesterId) ? [differentShiftLengths(plan, requesterId)!] : []),
    ...(plan.chains.some(chain => chain.payDifferent) ? [PAY_EXPLANATION] : []),
    ...(plan.missedTraining ?? []).map(item => `${plan.people > 1 ? `${nameFor(item.staffId)}: ` : ''}Misses training on ${dateFor(item.date)}`),
    ...(ownLeaveText(plan) ? [ownLeaveText(plan)!] : []),
  ];
}
