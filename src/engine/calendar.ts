import type { DaySelector, ISODate, Profile, ShiftType, Staff, StaffSelector, Weekday, WorkSelector, Role } from './types';

const DAY_MS = 86_400_000;
const parsedDates = new Map<ISODate, number>();
const formattedDates = new Map<number, ISODate>();
const parsedTimes = new Map<string, number>();

export function parseDate(d: ISODate): number {
  const cached = parsedDates.get(d);
  if (cached !== undefined) return cached;
  const [y, m, day] = d.split('-').map(Number);
  const value = Date.UTC(y, m - 1, day);
  parsedDates.set(d, value);
  return value;
}

export function formatDate(ms: number): ISODate {
  const cached = formattedDates.get(ms);
  if (cached) return cached;
  const value = new Date(ms).toISOString().slice(0, 10);
  formattedDates.set(ms, value);
  if (ms % DAY_MS === 0) parsedDates.set(value, ms);
  return value;
}

export function addDays(d: ISODate, n: number): ISODate {
  return formatDate(parseDate(d) + n * DAY_MS);
}

export function dateRange(start: ISODate, end: ISODate): ISODate[] {
  const out: ISODate[] = [];
  const endMs = parseDate(end);
  for (let t = parseDate(start); t <= endMs; t += DAY_MS) out.push(formatDate(t));
  return out;
}

export function weekday(d: ISODate): Weekday {
  return ((new Date(parseDate(d)).getUTCDay() + 6) % 7) as Weekday;
}

/** Monday of the ISO week containing d. */
export function weekStart(d: ISODate): ISODate {
  return addDays(d, -weekday(d));
}

export function monthKey(d: ISODate): string {
  return d.slice(0, 7);
}

function parseTime(t: string): number {
  const cached = parsedTimes.get(t);
  if (cached !== undefined) return cached;
  const [h, m] = t.split(':').map(Number);
  const value = h * 60 + m;
  parsedTimes.set(t, value);
  return value;
}

/** Start and end in minutes since the Unix epoch (wall-clock, UTC-based). */
export function shiftInterval(date: ISODate, st: ShiftType): { start: number; end: number } {
  const base = parseDate(date) / 60_000;
  const s = parseTime(st.start);
  let e = parseTime(st.end);
  if (e <= s) e += 24 * 60;
  return { start: base + s, end: base + e };
}

export function shiftHours(st: ShiftType): number {
  if (st.hours !== undefined) return st.hours;
  const { start, end } = shiftInterval('2000-01-03', st);
  return (end - start) / 60;
}

export function matchesDay(sel: DaySelector | undefined, d: ISODate): boolean {
  if (!sel) return true;
  if (sel.excludeDates?.includes(d)) return false;
  if (sel.dates && sel.dates.length > 0 && !sel.dates.includes(d)) return false;
  if (sel.weekdays && sel.weekdays.length > 0 && !sel.weekdays.includes(weekday(d))) return false;
  return true;
}

export function matchesStaff(sel: StaffSelector | undefined, s: Staff): boolean {
  if (!sel) return true;
  const hasIds = !!sel.staffIds && sel.staffIds.length > 0;
  const hasGroups = !!sel.groupIds && sel.groupIds.length > 0;
  if (!hasIds && !hasGroups) return true;
  if (hasIds && sel.staffIds!.includes(s.id)) return true;
  if (hasGroups && s.groupIds.some(g => sel.groupIds!.includes(g))) return true;
  return false;
}

/**
 * Whether a piece of work matches. `roleId` undefined means an outside fixed
 * commitment: it only matches selectors that don't restrict role or category.
 */
export function matchesWork(sel: WorkSelector | undefined, roleId: string | undefined, shiftTypeId: string, roles: Map<string, Role>): boolean {
  if (!sel) return true;
  if (sel.shiftTypeIds && sel.shiftTypeIds.length > 0 && !sel.shiftTypeIds.includes(shiftTypeId)) return false;
  const restrictsRole = (sel.roleIds && sel.roleIds.length > 0) || (sel.categories && sel.categories.length > 0);
  if (!restrictsRole) return true;
  if (roleId === undefined) return false;
  // A consultant's list counts as its parent place too.
  const parent = roles.get(roleId)?.parentId;
  if (sel.roleIds && sel.roleIds.length > 0 && !sel.roleIds.includes(roleId) && !(parent && sel.roleIds.includes(parent))) return false;
  if (sel.categories && sel.categories.length > 0) {
    const cat = roles.get(roleId)?.category ?? (parent ? roles.get(parent)?.category : undefined);
    if (!cat || !sel.categories.includes(cat)) return false;
  }
  return true;
}

/** Whether a shift's time interval touches Saturday or Sunday. Returns the weekend's Saturday, or null. */
export function weekendOf(date: ISODate, st: ShiftType): ISODate | null {
  const { start, end } = shiftInterval(date, st);
  // Check each calendar day the shift touches (end is exclusive).
  for (let t = Math.floor(start / 1440) * 1440; t < end; t += 1440) {
    const d = formatDate(t * 60_000);
    const wd = weekday(d);
    if (wd === 5) return d;
    if (wd === 6) return addDays(d, -1);
  }
  return null;
}

/** Period buckets intersected with the horizon; fraction is the share of the period's days inside it. */
export function periodBuckets(period: 'week' | 'month' | 'horizon', dates: ISODate[]): { key: string; dates: ISODate[]; fraction: number }[] {
  if (period === 'horizon') return [{ key: 'horizon', dates, fraction: 1 }];
  const map = new Map<string, ISODate[]>();
  for (const d of dates) {
    const k = period === 'week' ? weekStart(d) : monthKey(d);
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(d);
  }
  return [...map.entries()].map(([key, ds]) => {
    const full = period === 'week' ? 7 : daysInMonth(key);
    return { key, dates: ds, fraction: ds.length / full };
  });
}

function daysInMonth(key: string): number {
  const [y, m] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function indexProfile(p: Profile) {
  return {
    roles: new Map(p.roles.map(r => [r.id, r])),
    shiftTypes: new Map(p.shiftTypes.map(s => [s.id, s])),
    staff: new Map(p.staff.map(s => [s.id, s])),
  };
}
