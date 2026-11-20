/** Presentation and browser exports only. Nothing here changes solver inputs or assignments. */
import { addDays, dateRange, weekday } from '../engine/calendar';
import type { Assignment, ISODate, Role } from '../engine/types';
import type { FairerModel } from './fairer';
import type { SessionsSettings } from './sessions';
import { sessionComparisonFor } from './sessions';
import { sessionFor } from './overview';
import { placeCode, shiftCode } from './components/codes';
import { placeName } from './placeName';
import type { Workspace } from './store';

/** Visible place label for a role id via the model's place mapping. Keys stay on role ids. */
export function fairerRoleLabel(roleId: string | undefined, model: FairerModel, roles: Map<string, Role>): string {
  if (!roleId) return '';
  const role = roles.get(model.placeForRole[roleId] ?? roleId) ?? roles.get(roleId);
  return role ? placeName(role) : 'Day place';
}

/** Map a MediRota activity string to the place display name when it matches a known place (or its consultant list). */
export function fairerActivityLabel(activity: string | undefined, roles: Iterable<Role>): string {
  if (!activity) return '';
  const list = [...roles];
  const match = list.find(role => role.name.toLocaleLowerCase('en-GB') === activity.toLocaleLowerCase('en-GB'));
  if (!match) return activity;
  const place = match.parentId ? list.find(role => role.id === match.parentId) ?? match : match;
  return placeName(place);
}

export const fairerList = (names: string[]) => names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;

export function fairerSharesLine(type: { id: string; name: string }, settings: SessionsSettings): string {
  const entries = settings.groups.map(group => ({
    name: group.name,
    value: settings.ratios[type.id]?.[group.id] ?? 1,
  }));
  const zeros = entries.filter(entry => entry.value === 0);
  const active = entries.filter(entry => entry.value !== 0);
  const distinct = [...new Set(active.map(entry => entry.value))];
  let main: string;
  if (active.length === 0 || distinct.length < 2) {
    main = `${type.name}: everyone the same`;
  } else {
    const wholePair = distinct.length === 2 && distinct.every(value => Number.isInteger(value));
    if (wholePair) {
      const [high, low] = [...distinct].sort((a, b) => b - a);
      const scale = low!;
      const highNames = active.filter(entry => entry.value === high).map(entry => entry.name);
      const lowNames = active.filter(entry => entry.value === low).map(entry => entry.name);
      main = `${type.name}: ${fairerList(highNames)} do ${high! / scale} for every ${low! / scale} that ${fairerList(lowNames)} do`;
    } else {
      main = `${type.name}: ${active.map(entry => `${entry.name} ${entry.value}`).join(' · ')} (bigger number = bigger share)`;
    }
  }
  const zeroNotes = zeros.map(entry => `${entry.name} don't do ${type.name}`);
  return [main, ...zeroNotes].join('. ');
}

export function fairerDisplayNote(note: string): string {
  return note.replace(/\b(ratios?|targets?)\b/gi, word => /^[A-Z]/.test(word) ? 'Shares' : 'shares');
}

/** Mark from unrounded distances; only shown when rounded (displayed) distance changes by at least 1pp. */
export function fairerShareMark(before: number, after: number, aim: number): '' | '✓' | '✗' {
  const change = Math.abs(after - aim) - Math.abs(before - aim);
  if (Math.abs(change) < 1e-9) return '';
  const shownBefore = Math.abs(Math.round(before) - Math.round(aim));
  const shownAfter = Math.abs(Math.round(after) - Math.round(aim));
  if (Math.abs(shownAfter - shownBefore) < 1) return '';
  return change < 0 ? '✓' : '✗';
}

export function unchangedFromBaseline(a: Assignment, b: Assignment, model: FairerModel) {
  if (a.staffId !== b.staffId || a.date !== b.date || a.shiftTypeId !== b.shiftTypeId) return false;
  const baselineRole = model.baselineRoleByStaffDate[`${a.staffId}|${a.date}`];
  return baselineRole ? b.roleId === baselineRole : model.placeForRole[a.roleId ?? ''] === model.placeForRole[b.roleId ?? ''];
}

export interface FairerDisplayCell {
  activity: string; previous: string; code: string; changed: boolean; extra: boolean; colour?: number; consultants: string[];
}
export interface FairerDisplayDoctor { id: string; name: string; grade: string; groupId: string; regularLocum?: boolean }
export interface FairerDisplay {
  dates: ISODate[]; doctors: FairerDisplayDoctor[]; cells: Map<string, FairerDisplayCell>;
}
export const fairerCellKey = (id: string, date: ISODate) => `${id}|${date}`;

export function makeFairerDisplay(ws: Workspace, settings: SessionsSettings, model: FairerModel, suggestion: Assignment[]): FairerDisplay {
  const roles = new Map(ws.profile.roles.map(role => [role.id, role]));
  const before = new Map(model.movable.map(item => [fairerCellKey(item.staffId, item.date), item]));
  const after = new Map(suggestion.filter(item => !item.fixed && item.roleId && model.typeForRole[item.roleId]).map(item => [fairerCellKey(item.staffId, item.date), item]));
  const doctors = ws.profile.staff.map(person => {
    const comparison = sessionComparisonFor(person, ws.profile, settings, ws.sessionSubGroups ?? {});
    return { id: person.id, name: person.name, grade: ws.profile.groups.find(group => group.id === person.groupIds[0])?.name ?? '', groupId: comparison.comparisonId ?? 'fairer-no-group', regularLocum: person.regularLocum };
  });
  const cells = new Map<string, FairerDisplayCell>();
  // A partial chosen range still shows the imported, unchanged days around it in the week grid.
  const first = model.dates[0], last = model.dates.at(-1);
  const gridDates = first && last ? dateRange(addDays(first, -weekday(first)), addDays(last, 6 - weekday(last))) : [];
  for (const person of doctors) for (const date of gridDates) {
    const key = fairerCellKey(person.id, date), day = ws.swapFinder?.snapshot.days[person.id]?.[date];
    const base = before.get(key), assigned = after.get(key);
    const changed = !!base && !!assigned && !unchangedFromBaseline(base, assigned, model);
    const statusLabel = ({ leave: 'Leave', training: 'Training', zero: 'Zero day', night: 'Night', longDay: 'Long day', partShift: 'Part shift', notAvailable: 'Not available', available: 'Available', blank: '', dayJob: '', '': '' } as Record<string, string>)[day?.status ?? ''] ?? '';
    // Matching and codes stay on the MediRota/canonical name; visible cell text uses display names.
    const canonical = (changed && assigned && roles.get(model.placeForRole[assigned.roleId ?? ''] ?? assigned.roleId ?? '')?.name) || day?.activity || (assigned && roles.get(model.placeForRole[assigned.roleId ?? ''] ?? assigned.roleId ?? '')?.name) || statusLabel;
    const activity = (changed && assigned && fairerRoleLabel(assigned.roleId, model, roles)) || fairerActivityLabel(day?.activity, roles.values()) || (assigned && fairerRoleLabel(assigned.roleId, model, roles)) || statusLabel;
    const type = sessionFor(canonical, ws.profile, settings);
    const code = type?.code || (day?.status === 'leave' ? 'Leave' : day?.status === 'training' ? 'Train' : day?.status === 'zero' ? 'Zero' : day?.status === 'night' || day?.status === 'longDay' ? shiftCode(canonical) : canonical ? placeCode({ id: 'display-only', name: canonical }, []) : '·');
    const assignment = assigned ?? base;
    const place = assignment && model.placeForRole[assignment.roleId ?? ''];
    let consultants: string[] = [];
    if (assignment && model.consultantPlan.typeIds.includes(settings.types.find(item => item.placeIds.includes(place ?? ''))?.id ?? '')) {
      consultants = model.consultantsByRole[assignment.roleId ?? ''] ?? [];
      if (!consultants.length) consultants = roles.get(assignment.roleId ?? '')?.leadIds?.flatMap(id => ws.profile.leads?.find(lead => lead.id === id)?.name ?? []) ?? [];
      if (!consultants.length && base && model.placeForRole[base.roleId ?? ''] === place) consultants = model.consultantPlan.baselineByStaffDate[key] ?? [];
    }
    const previous = changed ? fairerActivityLabel(day?.activity, roles.values()) || (base && fairerRoleLabel(base.roleId, model, roles)) || '' : '';
    cells.set(key, { activity, previous, code, changed, extra: !!day?.extra, colour: type?.colour, consultants });
  }
  return { dates: [...model.dates], doctors, cells };
}

export function fairerWeekDates(week: ISODate): ISODate[] { return dateRange(week, addDays(week, 6)); }
export function fairerChangedWeeks(display: FairerDisplay, viewerId?: string): ISODate[] {
  if (!viewerId) return [];
  return [...new Set(display.dates.filter(date => display.cells.get(fairerCellKey(viewerId, date))?.changed).map(date => addDays(date, -weekday(date))))];
}
export function fairerNextChangeWeek(weeks: ISODate[], current: ISODate): ISODate | undefined { return weeks.find(week => week > current) ?? weeks[0]; }
export function fairerVisibleDoctors(display: FairerDisplay, dates: ISODate[], changedOnly: boolean) {
  return display.doctors.filter(person => !changedOnly || dates.some(date => display.cells.get(fairerCellKey(person.id, date))?.changed));
}
export function fairerCodeKey(display: FairerDisplay, doctors: FairerDisplayDoctor[], dates: ISODate[], changedOnly: boolean) {
  const entries = new Map<string, { labels: Set<string>; colour?: number }>();
  for (const person of doctors) for (const date of dates) {
    const cell = display.cells.get(fairerCellKey(person.id, date));
    if (changedOnly && !cell?.changed) continue;
    const code = cell?.code ?? '·', label = cell?.activity || 'No entry';
    const entry = entries.get(code) ?? { labels: new Set<string>(), colour: cell?.colour };
    entry.labels.add(label);
    entries.set(code, entry);
  }
  return [...entries].map(([code, { labels, colour }]) => ({ code, label: [...labels].join(' / '), colour }));
}

/** BOM and CRLF make the UTF-8 CSV readable in Excel, including accented names. */
export function fairerCsv(display: FairerDisplay): string {
  const quote = (value: string) => `"${value.replace(/"/g, '""')}"`;
  const rows = [['Doctor', 'Grade', ...display.dates], ...display.doctors.map(person => [person.name, person.grade, ...display.dates.map(date => {
    const cell = display.cells.get(fairerCellKey(person.id, date));
    return `${cell?.activity ?? ''}${cell?.changed ? ` (was ${cell.previous})` : ''}`;
  })])];
  return '\uFEFF' + rows.map(row => row.map(quote).join(',')).join('\r\n') + '\r\n';
}
export function downloadFairerCsv(display: FairerDisplay) {
  const url = URL.createObjectURL(new Blob([fairerCsv(display)], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url; link.download = `fairer-rota-${display.dates[0]}-to-${display.dates.at(-1)}.csv`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
