import { addDays, weekday } from '../engine/calendar';
import { leaveMinimumWarningsForSnapshot, type RotaSnapshot, type SwapSettings } from '../engine/swaps';
import type { ISODate, Profile, Staff } from '../engine/types';
import { sessionComparisonFor, type SessionsSettings } from './sessions';
import { formatDateLong } from './components/ui';
import { datesOutsideImports, swapDateSummary } from './swapsView';

export interface LeaveCheckDay { dates: ISODate[]; activity: string; outcome: string }
export interface LeaveCheck {
  cost: string;
  outsideCount: number;
  days: LeaveCheckDay[];
  othersOff: string[];
  minimum: string[];
}

const countPhrase = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;
export function leaveCheckDateLabel(dates: ISODate[]): string {
  if (dates.length === 1) return formatDateLong(dates[0]);
  const first = formatDateLong(dates[0]).split(' ');
  const last = formatDateLong(dates.at(-1)!).split(' ');
  if (dates[0].slice(0, 7) === dates.at(-1)!.slice(0, 7)) return `${first[0]} ${first[1]} – ${last[0]} ${last[1]} ${last[2]}`;
  return `${formatDateLong(dates[0])} – ${formatDateLong(dates.at(-1)!)}`;
}

export function leaveCheckDayLine(date: ISODate, activity: string, outcome: string, status?: string, outside = false): string {
  const label = new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  const rawShift = activity.trim();
  const statusShift: Record<string, string> = { longDay: 'long day', night: 'night', dayJob: 'day job', zero: 'zero day', leave: 'leave', training: 'training', partShift: 'part shift' };
  const shift = statusShift[status ?? ''] ?? (({ 'normal working day': 'day job' } as Record<string, string>)[rawShift.toLocaleLowerCase('en-GB')] ?? rawShift);
  const description = outcome === 'Needs a swap' ? `${shift || 'This shift'}, needs a swap`
    : outcome === 'Book as leave' ? `${shift || 'Day job'}, book as annual leave`
    : outcome === 'Sort out by hand' ? `${shift || 'Part shift'}, needs sorting by hand`
    : outcome === 'Hand back (extra)' ? `${rawShift || 'Extra shift'}, hand back`
    : status === 'zero' ? 'already off'
    : status === 'training' ? `${shift || 'Training'}, already off`
    : status === 'leave' ? `${shift || 'Leave'}, already off`
    : outcome === 'Nothing on the rota' ? 'nothing on the rota'
    : 'already off';
  return `${label}: ${outside ? `${description}, outside the imported weeks` : description}.`;
}

export function analyseLeaveCheck(profile: Profile, snapshot: RotaSnapshot, swapSettings: SwapSettings, staff: Staff[], sessions: SessionsSettings, staffId: string, dates: ISODate[], includeNormalDays: boolean, today: ISODate): LeaveCheck | undefined {
  if (!staffId || !dates.length) return undefined;
  const summary = swapDateSummary(snapshot, swapSettings, staffId, dates, includeNormalDays, today);
  const staffDays = snapshot.days[staffId] ?? {};
  const outcomeByDate = new Map<ISODate, string>();
  const activityByDate = new Map<ISODate, string>();
  for (const item of summary.clashes) { outcomeByDate.set(item.date, 'Needs a swap'); activityByDate.set(item.date, item.label); }
  for (const item of summary.requestAsLeave) { outcomeByDate.set(item.date, 'Book as leave'); activityByDate.set(item.date, item.label); }
  for (const item of summary.sortByHand) { outcomeByDate.set(item.date, 'Sort out by hand'); activityByDate.set(item.date, item.label); }
  for (const item of summary.extraShiftsToHandBack) { outcomeByDate.set(item.date, 'Hand back (extra)'); activityByDate.set(item.date, item.label); }
  for (const date of [...new Set(dates)].sort()) {
    const day = staffDays[date];
    if (!outcomeByDate.has(date)) outcomeByDate.set(date, day?.status === 'zero' ? 'Zero day, nothing to do' : day && day.status !== 'blank' ? 'Nothing to do' : 'Nothing on the rota');
    activityByDate.set(date, activityByDate.get(date) ?? day?.activity ?? '');
  }
  const rows: LeaveCheckDay[] = [];
  for (const date of [...new Set(dates)].sort()) {
    const outcome = outcomeByDate.get(date)!;
    const activity = activityByDate.get(date)!;
    const previous = rows.at(-1);
    const sameActivity = previous?.activity === activity;
    const consecutiveNightBlock = outcome === 'Needs a swap' && staffDays[date]?.status === 'night' && previous?.dates.every(rowDate => staffDays[rowDate]?.status === 'night');
    const mayJoinSwapDays = outcome !== 'Needs a swap' || consecutiveNightBlock;
    if (previous && previous.outcome === outcome && sameActivity && mayJoinSwapDays && addDays(previous.dates.at(-1)!, 1) === date) {
      previous.dates.push(date);
    } else rows.push({ dates: [date], activity, outcome });
  }
  const outsideCount = new Set([...dates.filter(date => date < today), ...datesOutsideImports(snapshot, dates)]).size;

  const sameTier = new Set(staff.filter(person => person.id !== staffId && !person.locum)
    .filter(person => !!sessionComparisonFor(person, profile, sessions).groupId)
    .map(person => person.id));
  const awayByDate = new Map<ISODate, string[]>();
  for (const personId of sameTier) for (const date of dates) {
    const day = snapshot.days[personId]?.[date];
    if (day?.status !== 'leave' && day?.status !== 'training') continue;
    const person = staff.find(item => item.id === personId);
    if (!person) continue;
    const reason = (day.activity ?? (day.status === 'leave' ? 'Away' : 'Training')).replace(/\[[^\]]*\]/g, '').trim();
    awayByDate.set(date, [...(awayByDate.get(date) ?? []), `${person.name} (${reason || 'Away'})`]);
  }
  // "Every day" only makes sense across more than one picked date.
  const allEveryDay = [...sameTier].filter(personId => dates.length > 1 && dates.every(date => ['leave', 'training'].includes(snapshot.days[personId]?.[date]?.status ?? '')));
  const othersOff = allEveryDay.map(personId => {
    const person = staff.find(item => item.id === personId)!;
    const reason = (snapshot.days[personId]?.[dates[0]]?.activity ?? 'Away').replace(/\[[^\]]*\]/g, '').trim();
    return `Every day: ${person.name} (${reason || 'Away'})`;
  });
  const dailyOthers: string[] = [];
  for (const date of [...new Set(dates)].sort()) {
    const entries = (awayByDate.get(date) ?? []).filter(item => !allEveryDay.some(id => item.startsWith(`${staff.find(person => person.id === id)?.name} (`)));
    if (entries.length) dailyOthers.push(`${formatDateLong(date)}: ${entries.join(', ')}`);
  }
  othersOff.push(...dailyOthers);
  if (!othersOff.length) othersOff.push('Nobody else off');
  const warningData = leaveMinimumWarningsForSnapshot(profile, snapshot, swapSettings, { staffId, leaveDates: dates, leaveType: 'annual', today });
  const existing = new Set(warningData.existingShortages.map(item => item.date));
  const minimum = warningData.leaveWarnings.map(item => `${formatDateLong(item.date)}: ${item.doctors} doctors working, minimum ${item.minimum}${existing.has(item.date) ? ', already short' : ''}`);

  const importedWeeks = new Set(Object.keys(snapshot.importedAt));
  const countedDays = [...new Set(dates)].filter(date => date >= today && importedWeeks.has(addDays(date, -weekday(date)))).length;
  let cost = `${countPhrase(countedDays, 'day')} off for ${summary.requestAsLeave.length} ${summary.requestAsLeave.length === 1 ? 'day' : 'days'} of annual leave and ${summary.swapCount} ${summary.swapCount === 1 ? 'swap' : 'swaps'}`;
  if (summary.sortByHand.length) cost += `, ${countPhrase(summary.sortByHand.length, 'part shift')} to sort out`;
  if (summary.extraShiftsToHandBack.length) cost += `, ${countPhrase(summary.extraShiftsToHandBack.length, 'extra shift')} to hand back`;
  return { cost, outsideCount, days: rows, othersOff: othersOff.length ? othersOff : ['Nobody else off'], minimum: minimum.length ? minimum : ['No day drops below the minimum.'] };
}

export function leaveCheckText(check: LeaveCheck | undefined): string[] {
  if (!check) return [];
  return [check.cost, ...check.days.map(row => `${leaveCheckDateLabel(row.dates)}: ${row.activity ? `${row.activity} · ` : ''}${row.outcome}`), ...check.othersOff, ...check.minimum];
}
