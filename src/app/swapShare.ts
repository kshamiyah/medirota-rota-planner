import type { ISODate } from '../engine/types';
import type { DayJobSwapGroup } from './dayJobSwaps';
import type { SwapPlan, SwapUnit } from '../engine/swaps';
import { SAME_DAY_LABEL, completePlansFirst, partialCoverageTitle, swapPlanNotes, visibleSwapPlans, type SwapPlanFilter, type SwapResultHides } from './swapsView';
import { formatDateLong } from './components/ui';

export interface ShareRow {
  number: number;
  people: number;
  ask: string[];
  steps: string[];
  instead: string;
  keptTogether: boolean;
  sameDay?: string;
  notes: string[];
  status: string;
  reason: string;
  alternatives: { dates: string; sortDate: ISODate; needsCheck: boolean; checkLabel?: string }[];
  representedOptions: number;
}
export interface ShareContent {
  heading: string;
  subheading: string;
  requesterName: string;
  shiftType: string;
  shiftDates: string;
  shiftActivities: string[];
  shiftTag: string;
  existingShortageLines: string[];
  extraShiftsToHandBack: string[];
  sections: { title: string; rows: ShareRow[] }[];
  more: number;
  /** True when All shown still cannot include unloaded search pages. */
  moreExistUnloaded?: boolean;
  rotaDate: string;
}
export interface ShareInput {
  plans: SwapPlan[];
  filter: SwapPlanFilter;
  hides?: SwapResultHides;
  requesterId: string;
  requesterName: string;
  nameFor: (staffId: string) => string;
  covered: { dates: ISODate[]; activity: string; kind: SwapUnit['kind'] }[];
  existingShortages: { date: ISODate; doctors: number; minimum: number }[];
  extraShiftsToHandBack?: { date: ISODate; activity: string }[];
  importedAt?: string;
  limit: 5 | 10 | 'all';
  /** Search still has unloaded pages (Find 50 more / plan limits). */
  searchIncomplete?: boolean;
}
export const DEFAULT_SHARE_LIMIT = 10 as const;

function sortedDates(dates: ISODate[]): ISODate[] { return [...new Set(dates)].sort(); }
function dateParts(iso: ISODate): { date: string; month: string; year: string } {
  const [weekday, day, month] = formatDateLong(iso).split(' ');
  return { date: `${weekday} ${day}`, month, year: iso.slice(0, 4) };
}
function sameMonth(dates: ISODate[]): boolean { return dates[0].slice(0, 7) === dates.at(-1)!.slice(0, 7); }
function formatShareDate(iso: ISODate, requestedYear: string): string {
  return `${formatDateLong(iso)}${iso.slice(0, 4) === requestedYear ? '' : ` ${iso.slice(0, 4)}`}`;
}
function dateSpan(dates: ISODate[], separator: ' + ' | ' to ', requestedYear: string): string {
  const ordered = sortedDates(dates);
  const first = dateParts(ordered[0]);
  const last = dateParts(ordered.at(-1)!);
  if (sameMonth(ordered)) return `${first.date}${separator}${last.date} ${last.month}${last.year === requestedYear ? '' : ` ${last.year}`}`;
  return `${formatShareDate(ordered[0], requestedYear)}${separator}${formatShareDate(ordered.at(-1)!, requestedYear)}`;
}
function datesText(dates: ISODate[], requestedYear: string): string {
  const ordered = sortedDates(dates);
  if (!ordered.length) return 'Dates to agree';
  if (ordered.length === 1) return formatShareDate(ordered[0], requestedYear);
  return dateSpan(ordered, ordered.length === 2 ? ' + ' : ' to ', requestedYear);
}
function unitText(unit: Pick<SwapUnit, 'dates' | 'kind' | 'activity'>, requestedYear: string): string {
  const dates = sortedDates(unit.dates);
  if (unit.kind === 'nightBlock') return `${datesText(dates, requestedYear)} (${unit.activity || `${dates.length} ${dates.length === 1 ? 'night' : 'nights'}`})`;
  if (unit.kind === 'longDay' && dates.length > 1) {
    const place = unit.activity && unit.activity !== 'Long day' && unit.activity !== 'Long days' ? unit.activity : '';
    return `${datesText(dates, requestedYear)} (${place ? `Long days, ${place}` : 'Long days'})`;
  }
  return `${datesText(dates, requestedYear)} (${unit.activity || (unit.kind === 'longDay' ? 'Long day' : 'Day shift')})`;
}
/** Pay-difference wording: bank holiday returns are not called weekends. */
function payDifferenceReason(plan: SwapPlan, requesterId: string): string | undefined {
  if (!plan.chains.some(chain => chain.payDifferent)) return undefined;
  const returnIsBankHoliday = plan.chains.some(chain => {
    if (!chain.payDifferent || chain.links.length < 2) return false;
    const index = chain.links.findIndex(link => link.staffId === requesterId);
    if (index < 0) return chain.links.slice(1).some(link => link.gives.dayType === 'bankHoliday');
    // Unit the requester receives to close the chain.
    const received = chain.links[(index + chain.links.length - 1) % chain.links.length].gives;
    return received.dayType === 'bankHoliday';
  });
  return returnIsBankHoliday ? 'Bank holiday for a weekday' : 'Weekend for a weekday';
}

/** Full wording for the main-row warning line (first reason only; priority unchanged). */
function status(plan: SwapPlan, requesterId: string): { label: string; reason: string } {
  if (plan.warnings.length) {
    const warning = plan.warnings[0];
    return { label: '⚠ Check', reason: `Leaves ${warning.doctors} of ${warning.minimum} doctors` };
  }
  const alert = plan.alerts?.[0];
  if (alert) {
    const reason = alertReason(alert.message);
    return { label: '⚠ Check', reason };
  }
  const pay = payDifferenceReason(plan, requesterId);
  if (pay) return { label: '⚠ Check', reason: pay };
  return { label: '✓ No issues', reason: '' };
}

function alertReason(message: string): string {
  const clean = message.replace(/\.$/, '');
  if (/\b72\b/.test(clean) || (/hours/i.test(clean) && /week/i.test(clean))) return 'Over 72 h that week';
  return clean;
}

/** Every check reason that applies to a plan, main-row wording. Pay first so "weekend + over 72 h" reads naturally. */
function planCheckReasons(plan: SwapPlan, requesterId: string): string[] {
  const reasons: string[] = [];
  const pay = payDifferenceReason(plan, requesterId);
  if (pay) reasons.push(pay);
  for (const alert of plan.alerts ?? []) reasons.push(alertReason(alert.message));
  if (plan.warnings.length) {
    const warning = plan.warnings[0];
    reasons.push(`Leaves ${warning.doctors} of ${warning.minimum} doctors`);
  }
  return [...new Set(reasons)];
}

/** Short lower-case label after ⚠ on an Other dates line. */
function shortCheckLabel(reasons: string[]): string {
  const shorts = reasons.map(reason => {
    if (/bank holiday for a weekday/i.test(reason)) return 'bank holiday';
    if (/weekend for a weekday/i.test(reason)) return 'weekend';
    if (/over 72 h/i.test(reason) || /\b72\b/.test(reason)) return 'over 72 h';
    if (/leaves \d+ of \d+ doctors/i.test(reason)) return reason.replace(/^Leaves\s+/i, '').toLowerCase();
    if (/in a row/i.test(reason)) return 'days in a row';
    if (/rest/i.test(reason)) return 'rest';
    return reason.toLowerCase();
  });
  return [...new Set(shorts)].join(' + ');
}
function askIds(plan: SwapPlan, requesterId: string): string[] {
  return [...new Set(plan.chains.flatMap(chain => chain.links.map(link => link.staffId)).filter(id => id !== requesterId))];
}
function askNames(plan: SwapPlan, input: Pick<ShareInput, 'requesterId' | 'nameFor'>): string[] {
  return askIds(plan, input.requesterId).map(input.nameFor);
}
function returnUnits(plan: SwapPlan, requesterId: string): Pick<SwapUnit, 'dates' | 'kind' | 'activity'>[] {
  return plan.chains.flatMap(chain => {
    const index = chain.links.findIndex(link => link.staffId === requesterId);
    if (index < 0 || chain.links.length < 2 || chain.sameDay) return [];
    const gives = chain.links[(index + chain.links.length - 1) % chain.links.length].gives;
    return [{ dates: gives.dates, kind: gives.kind, activity: gives.activity }];
  });
}
function optionDates(plan: SwapPlan, requesterId: string, requestedYear: string, _nameFor: ShareInput['nameFor']): { dates: string; sortDate: ISODate; needsCheck: boolean; checkLabel?: string } {
  const units = returnUnits(plan, requesterId);
  const dates = sortedDates(units.flatMap(unit => unit.dates));
  const work = units.length ? datesForDisplay(plan, requesterId, requestedYear) : '';
  // NWD alternatives keep their swap wording. Missed-training stays a plan note only (once), not on Other dates.
  const special = plan.chains.filter(chain => chain.sameDay).map(chain => `${formatShareDate(chain.links[0].gives.dates[0], requestedYear)}: NWD swap, you take their ${chain.links[1].gives.activity} and request it as annual leave (${chain.sameDay!.doctors} of ${chain.sameDay!.minimum} working after leave; ${SAME_DAY_LABEL})`);
  const reasons = planCheckReasons(plan, requesterId);
  const needsCheck = reasons.length > 0;
  return {
    dates: `${partialCoverageTitle(plan, requesterId) ? `${partialCoverageTitle(plan, requesterId)}: ` : ''}${[...(work && work !== 'Dates to agree' ? [work] : []), ...special].join('; ') || special[0] || work || 'Dates to agree'}`,
    sortDate: sortedDates([...dates, ...plan.chains.filter(chain => chain.sameDay).flatMap(chain => chain.links[0].gives.dates)])[0] ?? '9999-12-31',
    needsCheck,
    ...(needsCheck ? { checkLabel: shortCheckLabel(reasons) } : {}),
  };
}
function alternativeLines(alternatives: ShareRow['alternatives']): string[] {
  if (!alternatives.length) return [];
  return ['Other dates:', ...alternatives.map(item => `• ${item.dates}${item.checkLabel ? ` ⚠ ${item.checkLabel}` : ''}`)];
}
function distinctOptions(group: SwapPlan[], requesterId: string, requestedYear: string, nameFor: ShareInput['nameFor'], allAlternatives: boolean): { options: { dates: string; sortDate: ISODate; needsCheck: boolean; checkLabel?: string; count: number }[]; represented: number } {
  const byDates = new Map<string, { dates: string; sortDate: ISODate; needsCheck: boolean; checkLabel?: string; count: number }>();
  for (const plan of group) {
    const option = optionDates(plan, requesterId, requestedYear, nameFor);
    const previous = byDates.get(option.dates);
    if (previous) {
      previous.count++;
      // Prefer a clean duplicate over a checked one (same as before).
      if (previous.needsCheck && !option.needsCheck) {
        previous.needsCheck = false;
        delete previous.checkLabel;
      } else if (previous.needsCheck && option.needsCheck && option.checkLabel) {
        const labels = new Set([...(previous.checkLabel ?? '').split(' + ').filter(Boolean), ...option.checkLabel.split(' + ')]);
        previous.checkLabel = [...labels].join(' + ');
      }
    } else byDates.set(option.dates, { ...option, count: 1 });
  }
  const options = [...byDates.values()];
  // Top 5 / Top 10 keep the best option plus up to 3 other dates. All shown lists every other date.
  const shown = allAlternatives ? options : options.slice(0, 4);
  return { options, represented: shown.reduce((count, option) => count + option.count, 0) };
}
function datesForDisplay(plan: SwapPlan, requesterId: string, requestedYear: string): string {
  const units = returnUnits(plan, requesterId);
  if (!units.length) return 'Dates to agree';
  const groups = new Map<string, Pick<SwapUnit, 'dates' | 'kind' | 'activity'>>();
  for (const unit of units) {
    const key = `${unit.kind}|${unit.activity}`;
    const group = groups.get(key) ?? { dates: [], kind: unit.kind, activity: unit.activity };
    group.dates.push(...unit.dates);
    groups.set(key, group);
  }
  const orderedGroups = [...groups.values()].sort((a, b) => sortedDates(a.dates)[0].localeCompare(sortedDates(b.dates)[0]));
  return orderedGroups.map(unit => unitText(unit, requestedYear)).join(' + ');
}
function stepsFor(plan: SwapPlan, input: Pick<ShareInput, 'requesterId' | 'nameFor'>, requestedYear: string): string[] {
  const grouped = new Map<string, { receiver: string; owner: string; dates: ISODate[] }>();
  for (const chain of plan.chains) {
    if (chain.sameDay) continue;
    chain.links.forEach((link, index) => {
      if (chain.links.length < 2) return;
      const receiverId = chain.links[(index + 1) % chain.links.length].staffId;
      const receiver = receiverId === input.requesterId ? 'You' : input.nameFor(receiverId);
      const owner = link.staffId === input.requesterId ? 'your' : `${input.nameFor(link.staffId)}'s`;
      const key = `${receiver}|${owner}`;
      const row = grouped.get(key) ?? { receiver, owner, dates: [] };
      row.dates.push(...link.gives.dates);
      grouped.set(key, row);
    });
  }
  return [...grouped.values()].map(row => `${row.receiver} ${row.receiver === 'You' ? 'work' : 'works'} ${row.owner} ${datesText(row.dates, requestedYear)}`);
}
function coveredGroups(items: ShareInput['covered']): { dates: ISODate[]; activity: string; kind: SwapUnit['kind'] }[] {
  const groups = new Map<string, { dates: ISODate[]; kind: SwapUnit['kind']; activity: string }>();
  for (const item of items) {
    const key = `${item.kind}|${item.activity}`;
    const row = groups.get(key) ?? { dates: [], kind: item.kind, activity: item.activity };
    row.dates.push(...item.dates);
    groups.set(key, row);
  }
  return [...groups.values()].map(row => ({ ...row, dates: sortedDates(row.dates) }));
}
function headingType(items: ShareInput['covered']): string {
  const kinds = new Set(items.map(item => item.kind));
  if (kinds.size !== 1) return 'Leave';
  const kind = items[0]?.kind;
  if (kind === 'nightBlock') return 'Nights';
  if (kind === 'longDay') return items.reduce((count, item) => count + item.dates.length, 0) > 1 ? 'Long days' : 'Long day';
  return 'Leave';
}
function planKey(plan: SwapPlan, requesterId: string): string { return `${plan.people}|${askIds(plan, requesterId).sort().join('|')}`; }

export function makeShareContent(input: ShareInput): ShareContent {
  const coveredDates = sortedDates(input.covered.flatMap(item => item.dates));
  const requestedYear = coveredDates[0]?.slice(0, 4) ?? input.importedAt?.slice(0, 4) ?? '';
  const shiftType = headingType(input.covered);
  const shiftDates = datesText(coveredDates, requestedYear);
  const activities = [...new Set(coveredGroups(input.covered).map(item => item.activity || (item.kind === 'nightBlock' ? 'Nights' : item.kind === 'longDay' ? 'Long days' : 'Day shift')))];
  const shiftTag = `${shiftType} on ${shiftDates}${activities.length ? ` (${activities.join(', ')})` : ''}`;
  const existingShortageLines = input.existingShortages.map(item => `${formatShareDate(item.date, requestedYear)} is already a doctor short (${item.doctors} of ${item.minimum})`);
  const extraShiftsToHandBack = (input.extraShiftsToHandBack ?? []).map(item => `Extra shift on ${formatShareDate(item.date, requestedYear)} (${item.activity}): hand back to medical staffing`);
  const filtered = visibleSwapPlans(input.plans, input.filter, input.hides);
  const grouped = new Map<string, SwapPlan[]>();
  for (const plan of completePlansFirst(filtered)) {
    const key = planKey(plan, input.requesterId);
    grouped.set(key, [...(grouped.get(key) ?? []), plan]);
  }
  let number = 0;
  const allAlternatives = input.limit === 'all';
  const allRows = [1, 2, 3].map(size => ({ title: `Ask ${['', 'one person', 'two people', 'three people'][size]}`, rows: [...grouped.values()].filter(group => group[0].people === size).map(group => {
    const best = group[0];
    const distinct = distinctOptions(group, input.requesterId, requestedYear, input.nameFor, allAlternatives);
    const mainOption = distinct.options[0];
    const result = status(best, input.requesterId);
    const checkNeeded = mainOption?.needsCheck ?? result.label === '⚠ Check';
    const sameDayChains = best.chains.filter(chain => chain.sameDay);
    const sameDay = best.chains.length === 1 && sameDayChains.length === 1
      ? `NWD swap, you take their ${sameDayChains[0].links[1].gives.activity} and request it as annual leave` : undefined;
    const notes = [
      ...(best.people > 1 && partialCoverageTitle(best, input.requesterId) ? [partialCoverageTitle(best, input.requesterId)!] : []),
      ...(!sameDay ? sameDayChains.map(chain => {
        const activity = chain.links[1].gives.activity;
        const date = formatShareDate(chain.links[0].gives.dates[0], requestedYear);
        // One-person rows already name the doctor in the ask line; keep the name on 2+ person rows.
        return best.people > 1
          ? `${date}: ${input.nameFor(chain.links[1].staffId)} works your long day; you take their ${activity} and request it as annual leave`
          : `${date}: NWD swap, you take their ${activity} and request it as annual leave`;
      }) : []),
      ...swapPlanNotes(best, input.nameFor, date => formatShareDate(date, requestedYear)),
    ];
    const alternativeOptions = allAlternatives ? distinct.options.slice(1) : distinct.options.slice(1, 4);
    const row: ShareRow = {
      ...(sameDay ? { sameDay } : {}),
      notes,
      number: ++number,
      people: size,
      ask: askNames(best, input),
      steps: best.people > 1 ? stepsFor(best, input, requestedYear) : [],
      instead: sameDay ?? (best.people === 1 ? `${partialCoverageTitle(best, input.requesterId) ? `${partialCoverageTitle(best, input.requesterId)}: ` : ''}${datesForDisplay(best, input.requesterId, requestedYear)}` : ''),
      keptTogether: Boolean((best.blockLength || best.wholeWeekend) && best.chains.some(chain => chain.links.some(link => link.gives.kind !== 'nightBlock'))),
      status: checkNeeded ? result.label : '✓ No issues',
      reason: checkNeeded ? result.reason : '',
      alternatives: alternativeOptions.sort((a, b) => Number(a.dates.startsWith('Covers ')) - Number(b.dates.startsWith('Covers ')) || a.sortDate.localeCompare(b.sortDate)).map(({ dates, sortDate, needsCheck, checkLabel }) => ({ dates, sortDate, needsCheck, ...(checkLabel ? { checkLabel } : {}) })),
      representedOptions: distinct.represented,
    };
    return { row, total: group.length };
  }) })).filter(section => section.rows.length);
  const visibleCount = input.limit === 'all' ? Number.POSITIVE_INFINITY : input.limit;
  let rowCount = 0;
  let represented = 0;
  const sections = allRows.map(section => ({ title: section.title, rows: section.rows.filter(({ row }) => {
    if (rowCount >= visibleCount) return false;
    rowCount++;
    represented += row.representedOptions;
    return true;
  }).map(item => item.row) })).filter(section => section.rows.length);
  const more = Math.max(0, filtered.length - represented);
  return {
    heading: 'SWAP OPTIONS',
    subheading: input.requesterName,
    requesterName: input.requesterName,
    shiftType,
    shiftDates,
    shiftActivities: activities,
    shiftTag,
    existingShortageLines,
    extraShiftsToHandBack,
    sections,
    more,
    ...(input.limit === 'all' && input.searchIncomplete ? { moreExistUnloaded: true } : {}),
    rotaDate: input.importedAt ? formatShareDate(input.importedAt.slice(0, 10), requestedYear) : 'date unavailable',
  };
}

export function shareMoreLine(content: ShareContent): string | undefined {
  if (content.more > 0) return `${content.more} more options. Ask me for more.`;
  if (content.moreExistUnloaded) return 'More options exist. Ask me for more.';
  return undefined;
}

export function shareText(content: ShareContent): string {
  const activityText = content.shiftActivities.length ? ` (${content.shiftActivities.join(', ')})` : '';
  const out = [`*Swap options for ${content.requesterName}*`, `${content.shiftType} on *${content.shiftDates}*${activityText}`];
  out.push(...content.existingShortageLines);
  if (content.extraShiftsToHandBack.length) out.push('', ...content.extraShiftsToHandBack.map(item => `• ${item}`));
  for (const section of content.sections) {
    // One blank line before each section heading (rows do not leave a trailing blank).
    out.push('', `*${section.title}*`, '');
    section.rows.forEach((row, index) => {
      if (row.sameDay) {
        out.push(`${row.number}. *${row.ask[0]}*: ${row.sameDay}`);
      } else if (row.people === 1) {
        const work = row.keptTogether && row.instead.endsWith(')') ? `${row.instead.slice(0, -1)}, kept together)` : row.instead;
        out.push(`*${row.number}. ${row.ask[0]}*`, `You work: ${work}`);
      } else {
        out.push(`*${row.number}. ${row.ask.join(' + ')}*`, ...row.steps);
        if (row.keptTogether) out.push('Kept together.');
      }
      out.push(...row.notes);
      out.push(...alternativeLines(row.alternatives));
      if (row.status.startsWith('⚠')) out.push(`⚠️ ${row.reason}`);
      if (index < section.rows.length - 1) out.push('');
    });
  }
  const moreLine = shareMoreLine(content);
  if (moreLine) out.push('', moreLine);
  out.push('', `Rota as of ${content.rotaDate}. Check MediRota before agreeing.`);
  return out.join('\n');
}

export async function renderDayJobSwapPng(input: { date: ISODate; requesterName: string; requesterPlace: string; groups: DayJobSwapGroup[] }, createCanvas: () => HTMLCanvasElement = () => document.createElement('canvas')): Promise<Blob> {
  const canvas = createCanvas(); canvas.width = 720;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Could not create the share image.');
  const date = new Date(`${input.date}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  const rows = input.groups.flatMap(group => [`${group.placeName}`, ...group.people.map(person => `${person.staff.name}${person.grade ? ` (${person.grade})` : ''}${person.consultants.length ? ` · with ${person.consultants.join(', ')}` : ''}`)]);
  const lines = [`Day job swap, ${date}`, `${input.requesterName} · ${input.requesterPlace}`, 'Could anyone swap?', ...rows];
  const wrapped = lines.flatMap(line => wrapText(context, line, 660));
  canvas.height = Math.max(250, 180 + wrapped.length * 24 + input.groups.length * 12);
  context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#277c70'; context.font = 'bold 16px Arial'; context.fillText('DAY JOB SWAP', 28, 36);
  context.fillStyle = '#19352f'; context.font = 'bold 25px Arial'; context.fillText(lines[0], 28, 72);
  context.font = '16px Arial'; context.fillText(lines[1], 28, 101); context.fillText(lines[2], 28, 126);
  let y = 164;
  for (const group of input.groups) {
    context.fillStyle = '#277c70'; context.font = 'bold 18px Arial'; context.fillText(group.placeName, 28, y); y += 28;
    context.fillStyle = '#19352f'; context.font = '16px Arial';
    for (const person of group.people) {
      const text = `${person.staff.name}${person.grade ? ` (${person.grade})` : ''}${person.consultants.length ? ` · with ${person.consultants.join(', ')}` : ''}`;
      const personLines = wrapText(context, text, 650);
      personLines.forEach(line => { context.fillText(line, 44, y); y += 23; });
    }
    y += 8;
  }
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Could not create the share image.')), 'image/png'));
}

function wrapText(context: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  if (!text) return [];
  const lines: string[] = [];
  let line = '';
  // Keep a warning mark with the date before it, and prefer hyphen breaks in long names.
  const words = text.trim().split(/\s+/).flatMap((word, index, list) => {
    if (word === '⚠' && index > 0) return [];
    const joined = list[index + 1] === '⚠' ? `${word} ⚠` : word;
    return joined.match(/[^-]+-?/g) ?? [joined];
  });
  for (const word of words) {
    const candidate = line ? `${line}${line.endsWith('-') ? '' : ' '}${word}` : word;
    if (line && context.measureText(candidate).width > maxWidth) {
      lines.push(line);
      line = word;
    } else if (!line && context.measureText(word).width > maxWidth) {
      let fragment = '';
      for (const character of word) {
        if (fragment && context.measureText(fragment + character).width > maxWidth) {
          lines.push(fragment);
          fragment = character;
        } else fragment += character;
      }
      line = fragment;
    } else line = candidate;
  }
  if (line) lines.push(line);
  return lines;
}
interface CanvasRowLayout { ask: string[]; instead: string[]; steps: string[]; alternatives: string[]; notes: string[]; notesY: number; reason: string[]; height: number }
function layoutRow(context: CanvasRenderingContext2D, row: ShareRow): CanvasRowLayout {
  const wideColumn = row.people > 1;
  context.font = 'bold 16px Arial';
  const ask = wrapText(context, row.ask.join(' + '), wideColumn ? 445 : 87);
  context.font = '16px Arial';
  const instead = wrapText(context, row.instead, 348);
  context.font = '14px Arial';
  const steps = row.steps.flatMap(step => wrapText(context, step, 445));
  const alternatives = alternativeLines(row.alternatives).flatMap(line => wrapText(context, line, wideColumn ? 445 : 348));
  context.font = '14px Arial';
  const reason = row.reason ? wrapText(context, row.reason, 161) : [];
  const notes = row.notes.flatMap(note => wrapText(context, note, 445));
  const keptGap = row.keptTogether ? 16 : 0;
  const rowBody = wideColumn
    ? 29 + ask.length * 21 + steps.length * 19 + keptGap + alternatives.length * 18 + 16
    : 29 + Math.max(ask.length * 20, instead.length * 20 + keptGap) + alternatives.length * 18 + 16;
  const statusBody = row.reason ? 50 + reason.length * 18 : 48;
  const notesY = Math.max(rowBody - 16, statusBody + 2);
  const height = notes.length ? notesY + notes.length * 18 + 16 : Math.max(60, rowBody, statusBody);
  return { ask, instead, steps, alternatives, notes, notesY, reason, height };
}
export async function renderSharePng(content: ShareContent, createCanvas: () => HTMLCanvasElement = () => document.createElement('canvas')): Promise<Blob> {
  const canvas = createCanvas(); canvas.width = 720;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Could not create the share image.');
  const labelLines = (context.font = 'bold 15px Arial', wrapText(context, content.heading, 664));
  const nameLines = (context.font = 'bold 30px Arial', wrapText(context, content.subheading, 664));
  const tagLines = (context.font = 'bold 16px Arial', wrapText(context, content.shiftTag, 500));
  const bestOptions = 'Best options first';
  const tagWidth = Math.min(522, Math.max(...tagLines.map(line => context.measureText(line).width), 0) + 22);
  const bestWidth = context.measureText(bestOptions).width;
  const bestBeside = tagLines.length === 1 && tagWidth + 10 + bestWidth <= 664;
  const labelHeight = labelLines.length * 18;
  const nameHeight = nameLines.length * 36;
  const tagHeight = tagLines.length * 20 + 8;
  const headerY = 28 + labelHeight + 12 + nameHeight + 8;
  const afterTagY = headerY + tagHeight + (bestBeside ? 20 : 38);
  context.font = '14px Arial';
  const existingLines = content.existingShortageLines.flatMap(line => wrapText(context, line, 664));
  const extraLines = content.extraShiftsToHandBack.flatMap(line => wrapText(context, line, 664));
  const warningLineCount = existingLines.length + extraLines.length;
  const tableY = afterTagY + (warningLineCount ? warningLineCount * 18 + (existingLines.length && extraLines.length ? 18 : 10) : 0);
  const layouts = content.sections.map(section => section.rows.map(row => layoutRow(context, row)));
  const sectionHeights = content.sections.map(() => 60);
  const rowsHeight = layouts.flat().reduce((sum, layout) => sum + layout.height, 0);
  const footerLeft = shareMoreLine(content) ?? '';
  const footerRight = `Rota as of ${content.rotaDate}. Check MediRota before agreeing.`;
  context.font = '14px Arial';
  const leftFooterLines = footerLeft ? wrapText(context, footerLeft, 330) : [];
  const rightFooterLines = wrapText(context, footerRight, 330);
  const footerHeight = Math.max(leftFooterLines.length, rightFooterLines.length, 1) * 18;
  canvas.height = Math.max(250, tableY + sectionHeights.reduce((sum, height) => sum + height, 0) + rowsHeight + footerHeight + 34);
  context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#277c70'; context.font = 'bold 15px Arial';
  labelLines.forEach((line, index) => context.fillText(line, 28, 40 + index * 18));
  context.fillStyle = '#19352f'; context.font = 'bold 30px Arial';
  nameLines.forEach((line, index) => context.fillText(line, 28, 28 + labelHeight + 12 + 30 + index * 36));
  context.font = 'bold 16px Arial'; context.fillStyle = '#f4e9d8'; context.beginPath(); context.roundRect(28, headerY, tagWidth, tagHeight, 9); context.fill();
  context.fillStyle = '#75450f';
  tagLines.forEach((line, index) => context.fillText(line, 38, headerY + 19 + index * 20));
  context.fillStyle = '#536861'; context.font = '16px Arial';
  if (bestBeside) context.fillText(bestOptions, 28 + tagWidth + 10, headerY + 19);
  else context.fillText(bestOptions, 28, headerY + tagHeight + 18);
  context.fillStyle = '#9a4d00'; context.font = '14px Arial';
  existingLines.forEach((line, index) => context.fillText(line, 28, afterTagY + 12 + index * 18));
  extraLines.forEach((line, index) => context.fillText(line, 28, afterTagY + 12 + (existingLines.length + index) * 18));
  let y = tableY;
  for (const [sectionIndex, section] of content.sections.entries()) {
    context.fillStyle = '#277c70'; context.font = 'bold 18px Arial'; context.fillText(section.title, 28, y + 18); y += 39;
    context.fillStyle = '#84938f'; context.font = 'bold 12px Arial';
    context.fillText('ASK', 70, y + 12); context.fillText('YOU WORK INSTEAD', 167, y + 12); y += 21;
    for (const [rowIndex, row] of section.rows.entries()) {
      const layout = layouts[sectionIndex][rowIndex];
      context.strokeStyle = '#dce3df'; context.beginPath(); context.moveTo(28, y); context.lineTo(692, y); context.stroke();
      context.fillStyle = '#82928d'; context.font = 'bold 17px Arial'; context.fillText(String(row.number), 36, y + 28);
      context.fillStyle = '#19352f'; context.font = 'bold 16px Arial';
      const isGroup = row.people > 1;
      const askX = 70;
      layout.ask.forEach((line, index) => context.fillText(line, askX, y + 29 + index * 20));
      context.font = '16px Arial'; context.fillStyle = '#19352f';
      layout.instead.forEach((line, index) => context.fillText(line, 167, y + 29 + index * 20));
      const drawKeptTogether = (at: number) => {
        context.font = 'bold 12px Arial';
        const x = isGroup ? 70 : 167;
        context.fillStyle = '#e0e8e3'; context.beginPath(); context.roundRect(x - 4, at - 13, 94, 18, 8); context.fill();
        context.fillStyle = '#40594f'; context.fillText('Kept together', x + 2, at);
      };
      // Sit the tag just under the dates (or under the last step for multi-person rows).
      let detailY = isGroup
        ? y + 29 + layout.ask.length * 20
        : y + 29 + layout.instead.length * 20;
      if (row.keptTogether && !row.steps.length) { drawKeptTogether(detailY); detailY += 16; }
      context.font = '14px Arial';
      layout.steps.forEach((line, index) => context.fillText(line, 70, detailY + index * 19));
      detailY += layout.steps.length * 19;
      if (row.keptTogether && row.steps.length) { drawKeptTogether(detailY); detailY += 16; }
      const altY = isGroup
        ? detailY
        : Math.max(detailY, y + 29 + Math.max(layout.ask.length, layout.instead.length) * 20 + (row.keptTogether ? 16 : 0));
      context.fillStyle = '#536861';
      layout.alternatives.forEach((line, index) => context.fillText(line, isGroup ? 70 : 167, altY + index * 18));
      const notesY = y + layout.notesY;
      context.font = '14px Arial'; context.fillStyle = '#536861';
      layout.notes.forEach((line, index) => context.fillText(line, 70, notesY + index * 18));
      if (row.status.startsWith('⚠')) {
        context.fillStyle = '#9a4d00'; context.font = 'bold 17px Arial'; context.fillText(row.status, 531, y + 28);
      }
      if (row.reason) { context.font = '14px Arial'; layout.reason.forEach((line, index) => context.fillText(line, 531, y + 49 + index * 18)); }
      y += layout.height;
    }
  }
  context.strokeStyle = '#dce3df'; context.beginPath(); context.moveTo(28, y + 10); context.lineTo(692, y + 10); context.stroke();
  context.fillStyle = '#687c75'; context.font = '14px Arial';
  leftFooterLines.forEach((line, index) => context.fillText(line, 28, y + 34 + index * 18));
  context.textAlign = 'right'; rightFooterLines.forEach((line, index) => context.fillText(line, 692, y + 34 + index * 18)); context.textAlign = 'left';
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Could not create the share image.')), 'image/png'));
}
