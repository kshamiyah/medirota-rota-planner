/**
 * Importing MediRota weeks: first-time setup and the routine import.
 *
 * planImport reads saved "By person" and "By activity" weeks against the
 * current workspace and proposes what to do, with sensible defaults the
 * person can change in the preview. applyImport carries the plan out.
 * Everything brought in is marked as coming from MediRota, so importing the
 * same weeks again replaces it while anything entered by hand is kept.
 */
import { addDays, dateRange, shiftInterval, weekday } from '../engine/calendar';
import { validate, type Violation } from '../engine/validate';
import type { FixedAssignment, ISODate, Role, ShiftType, Staff, Unavailability } from '../engine/types';
import { applyConsultantLists, guessPlace, isEllipsisOnlyName, timesInNote, type ActivityWeek, type ActivityJunior, type PersonRow, type PersonWeek, type Session } from './medirota';
import { newId, toProblem, type RotaSnapshot, type SnapshotDay, type SwapSettings, type Workspace } from './store';
import { applyPresetPeopleSettings, normalisePresetName } from './presets';

/** What an activity becomes in the app. */
export type Treat = 'night' | 'long' | 'dayjob' | 'leave' | 'training' | 'zero' | 'unavailable' | 'ignore';

export interface ActivityChoice {
  treat: Treat;
  /** For night, long and dayjob: the place in the app, or 'new' to create one with the activity's name. */
  placeId?: string;
}

export interface ActivityPlan extends ActivityChoice {
  name: string;
  /** Doctor-days it appears on in these weeks. */
  days: number;
  /** True when the choice came from an earlier import rather than a guess. */
  remembered: boolean;
}

export interface PersonPlan {
  mediRotaId: string;
  name: string;
  grade?: string;
  /** The app's person this is, or undefined for someone new. */
  staffId?: string;
  /** A close name in the app that might be the same person (e.g. Hayes / Hays). */
  possible?: { staffId: string; name: string };
  action: 'match' | 'add' | 'skip';
  locum: boolean;
  /** Doctor-days with anything on them in these weeks. */
  days: number;
  /** Set when they start after the first imported week or stop before the last: a rotation changeover. */
  from?: ISODate;
  until?: ISODate;
}

export interface LeaverPlan { staffId: string; name: string; markLeft: boolean; lastDay: ISODate }

export interface NeedSuggestion { placeName: string; treat: 'night' | 'long' | 'dayjob'; weekdays: number[]; min: number; max: number; create: boolean }

export interface ImportPlan {
  dates: ISODate[];
  firstTime: boolean;
  people: PersonPlan[];
  leavers: LeaverPlan[];
  activities: ActivityPlan[];
  needs: NeedSuggestion[];
  /** Set the rota's dates: from this week, for 1–8 weeks. Undefined keeps the current dates. */
  period?: { start: ISODate; weeks: number };
  keepDayJobs: boolean;
  /** MediRota bookings to leave out, as "mediRotaId|date" (chosen when one breaks a Must rule). */
  skip: string[];
  /** The "By activity" weeks, for consultant lists. */
  activityWeeks: ActivityWeek[];
  personWeeks: PersonWeek[];
  unmatchedActivityJuniors?: number;
}

function activityJuniorMatch(junior: ActivityJunior, personWeeks: PersonWeek[], knownStaff: Staff[] = []): string | undefined {
  const people = personWeeks.flatMap(week => week.people);
  if (junior.mediRotaId) {
    if (people.some(person => person.id === junior.mediRotaId)) return `mr:${junior.mediRotaId}`;
    const byId = knownStaff.filter(staff => staff.mediRotaId === junior.mediRotaId);
    return byId.length === 1 ? `staff:${byId[0]!.id}` : undefined;
  }
  const name = junior.name.replace(/\s*\([^)]*\)\s*$/, '').trim();
  const matches = people.filter(person => {
    const candidate = nameAndGrade(person).name;
    return sameName(candidate, name) || sameName(person.rowName, name);
  });
  if (matches.length === 1) return `mr:${matches[0]!.id}`;
  const staffMatches = knownStaff.filter(person => sameName(person.name, name));
  return staffMatches.length === 1 ? `staff:${staffMatches[0]!.id}` : undefined;
}

export function countUnmatchedActivityJuniors(activityWeeks: ActivityWeek[], personWeeks: PersonWeek[], knownStaff: Staff[] = []): number {
  return activityWeeks.flatMap(week => week.activities.flatMap(activity => Object.values(activity.days).flatMap(day => day.cells ?? [])))
    .reduce((count, cell) => count + cell.juniors.filter(junior => !activityJuniorMatch(junior, personWeeks, knownStaff)).length, 0);
}

/** A Must rule broken by the imported bookings, with the MediRota booking on that day if there is one. */
export interface ImportProblem extends Violation {
  name?: string;
  mediRotaId?: string;
  /** "Long Day · Delivery Suite": the imported booking on that day, which can be left out. */
  booking?: string;
}

export interface ImportPreview {
  leave: { before: number; after: number };
  booked: { before: number; after: number };
  newPeople: number;
  newPlaces: number;
  consultantDays: number;
  replaced: number;
  problems: ImportProblem[];
  clearsRota: boolean;
}

const clean = (a: string) => a.replace(/^×\s*/, '').replace(/\s*\[Extra\]\s*$/, '').trim();
const isExtra = (a: string) => /\[Extra\]\s*$/.test(a);
const TRAINING = /train|teach|prompt|fetal|mandatory|induction|self development|study day|chang(e)?over|shadow/i;

function guessTreat(name: string, sessions: Set<Session>): Treat {
  if (/zero day/i.test(name)) return 'zero';
  if (/^\[away\]$|annual leave|study leave/i.test(name)) return 'leave';
  if (/not available/i.test(name)) return 'unavailable';
  if (/^available$/i.test(name)) return 'ignore';
  if (TRAINING.test(name)) return 'training';
  if (sessions.has('night') && !sessions.has('am')) return 'night';
  if (sessions.has('eve')) return 'long';
  return 'dayjob';
}

export const DEFAULT_SWAP_SETTINGS: SwapSettings = {
  weekendDayActivities: [],
  hoursTolerance: 1,
  maxChain: 4,
  returnPattern: 'consecutive',
  returnDayType: 'noPreference',
  returnWindow: { kind: 'any' },
  noAlertsOnly: false,
  includeNormalDays: false,
  minDoctors: [0, 0, 0, 0, 0, 0, 0],
  minDoctorsBankHoliday: 0,
  bankHolidays: ['2026-08-31', '2026-12-25', '2026-12-28', '2027-01-01'],
  regularDaysOff: {},
  excluded: [],
};

const SESSION_ORDER: Session[] = ['am', 'pm', 'eve', 'night'];
const AWAY_PRIORITY: Treat[] = ['leave', 'training', 'zero', 'unavailable'];

/** Preserve session detail and apply the finder priority without touching planner data. */
function snapshotDay(sessions: Partial<Record<Session, string[]>>, choices: Map<string, ActivityPlan>): SnapshotDay {
  const byActivity = new Map<string, Session[]>();
  const extras = new Set<string>();
  for (const session of SESSION_ORDER) for (const raw of sessions[session] ?? []) {
    const name = clean(raw);
    if (isExtra(raw)) extras.add(name);
    const inSessions = byActivity.get(name) ?? [];
    if (!inSessions.includes(session)) inSessions.push(session);
    byActivity.set(name, inSessions);
  }
  const entries = [...byActivity].map(([activity, foundSessions]) => ({ activity, sessions: foundSessions, treat: choices.get(activity)?.treat }));
  const selected = (treat: Treat) => entries.find(entry => entry.treat === treat);
  const daySessions = [...new Set(entries.flatMap(entry => entry.sessions))]
    .sort((a, b) => SESSION_ORDER.indexOf(a) - SESSION_ORDER.indexOf(b));
  const allSessions = [...new Set(entries.filter(entry => entry.treat === 'night' || entry.treat === 'long' || entry.treat === 'dayjob').flatMap(entry => entry.sessions))]
    .sort((a, b) => SESSION_ORDER.indexOf(a) - SESSION_ORDER.indexOf(b));
  const night = selected('night');
  if (night) return { status: 'night', activity: night.activity, sessions: night.sessions, ...(extras.has(night.activity) ? { extra: true as const } : {}) };
  const long = selected('long');
  if (long) {
    const complete = (['am', 'pm', 'eve'] as Session[]).every(session => long.sessions.includes(session));
    return { status: complete ? 'longDay' : 'partShift', activity: long.activity, sessions: complete ? long.sessions : allSessions, ...(extras.has(long.activity) ? { extra: true as const } : {}) };
  }
  const dayJob = selected('dayjob');
  if (dayJob) return { status: 'dayJob', activity: dayJob.activity, sessions: dayJob.sessions, ...(extras.has(dayJob.activity) ? { extra: true as const } : {}) };
  for (const treat of AWAY_PRIORITY) {
    const away = selected(treat);
    if (away) {
      const status = treat === 'leave' ? 'leave' : treat === 'training' ? 'training' : treat === 'zero' ? 'zero' : 'notAvailable';
      return { status, activity: away.activity, sessions: away.sessions };
    }
  }
  const available = entries.find(entry => entry.treat === 'ignore' && /^available$/i.test(entry.activity));
  const ignored = entries.find(entry => entry.treat === 'ignore' && !/^available$/i.test(entry.activity));
  if (ignored) return { status: 'notAvailable', activity: ignored.activity, sessions: daySessions };
  if (available && entries.every(entry => entry.treat === 'ignore' && /^available$/i.test(entry.activity))) {
    return { status: 'available', activity: available.activity, sessions: available.sessions };
  }
  if (entries.length) return { status: 'notAvailable', activity: entries[0].activity, sessions: daySessions };
  return { status: 'blank' };
}

function snapshotImport(w: Workspace, plan: ImportPlan, staffOf: Map<string, Staff>): void {
  const prior = w.swapFinder;
  const snapshot: RotaSnapshot = prior?.snapshot ?? { days: {}, importedAt: {} };
  snapshot.extrasTagged = true;
  const settings = prior?.settings ?? structuredClone(DEFAULT_SWAP_SETTINGS);
  const choices = new Map(plan.activities.map(activity => [activity.name, activity]));
  const now = new Date().toISOString();
  const staffById = new Map(w.profile.staff.map(staff => [staff.id, staff]));

  for (const week of plan.personWeeks) {
    const dates = dateRange(week.start, addDays(week.start, 6));
    for (const days of Object.values(snapshot.days)) for (const date of dates) delete days[date];
    for (const staffId of staffById.keys()) {
      const days = snapshot.days[staffId] ?? (snapshot.days[staffId] = {});
      for (const date of dates) days[date] = { status: 'blank' };
    }
    for (const row of week.people) {
      const staff = staffOf.get(row.id);
      if (!staff) continue;
      const days = snapshot.days[staff.id] ?? (snapshot.days[staff.id] = {});
      for (const date of dates) {
        const dayActivities = row.days[date];
        if (dayActivities) days[date] = snapshotDay(dayActivities, choices);
      }
    }
    // Imported weeks replace any older week whose dates overlap this one.
    for (const start of Object.keys(snapshot.importedAt)) {
      if (start <= dates[dates.length - 1] && addDays(start, 6) >= dates[0]) delete snapshot.importedAt[start];
    }
    snapshot.importedAt[week.start] = now;
  }
  w.swapFinder = { settings, snapshot, ...(prior?.recentSearches ? { recentSearches: prior.recentSearches } : {}) };
}

/** "Ellis Rowan (ST2)" → name and grade; falls back to the row's "Rowan, Ellis". */
function nameAndGrade(p: PersonRow): { name: string; grade?: string } {
  const m = p.label?.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
  if (m) return { name: m[1].trim(), grade: m[2].trim() };
  if (p.label && p.label.trim()) return { name: p.label.trim() };
  const r = p.rowName.match(/^([^,]+),\s*(.+)$/);
  return { name: r ? `${r[2]} ${r[1]}` : p.rowName };
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '');
/** "Ellis Rowan" and "Rowan Ellis" are the same person: compare the words in any order. */
const sameName = (a: string, b: string) => a.toLowerCase().split(/[\s,]+/).map(norm).filter(Boolean).sort().join() === b.toLowerCase().split(/[\s,]+/).map(norm).filter(Boolean).sort().join();
function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

export function planImport(ws: Workspace, personWeeks: PersonWeek[], activityWeeks: ActivityWeek[]): ImportPlan {
  const p = ws.profile;
  const weeks = [...personWeeks].sort((a, b) => a.start.localeCompare(b.start));
  const dates = [...new Set(weeks.flatMap(w => w.people.flatMap(r => Object.keys(r.days))).concat(weeks.flatMap(w => dateRange(w.start, addDays(w.start, 6)))))].sort();
  const firstTime = p.staff.length === 0 && p.roles.length === 0;

  // People: merge rows across weeks by MediRota id.
  // MediRota's By person pages can leave out someone with little on that week, so only a run of
  // CHANGEOVER_WEEKS or more missing weeks at the start or end is read as joining or leaving.
  const byId = new Map<string, { row: PersonRow; days: number; extra: number; clinical: number; first?: ISODate; last?: ISODate }>();
  for (const w of weeks) for (const r of w.people) {
    const e = byId.get(r.id) ?? { row: r, days: 0, extra: 0, clinical: 0 };
    e.first ??= w.start; e.last = w.start;
    if (!e.row.label && r.label) e.row = { ...e.row, label: r.label };
    for (const s of Object.values(r.days)) {
      const acts = Object.values(s).flat();
      e.days++;
      if (acts.some(isExtra)) e.extra++;
      if (acts.length) e.clinical++;
    }
    byId.set(r.id, e);
  }
  const lastWeek = weeks.length ? weeks[weeks.length - 1].start : undefined;
  const people: PersonPlan[] = [...byId.values()].map(({ row, days, extra, first, last }) => {
    const { name, grade } = nameAndGrade(row);
    const byMr = p.staff.find(s => s.mediRotaId === row.id);
    const byName = byMr ?? p.staff.find(s => !s.mediRotaId && (sameName(s.name, name) || sameName(s.name, row.rowName)));
    let possible: PersonPlan['possible'];
    if (!byName) {
      const [first, ...rest] = name.toLowerCase().split(/\s+/);
      const last = rest.join(' ');
      const close = p.staff.find(s => {
        const [f, ...l] = s.name.toLowerCase().split(/\s+/);
        return f === first && editDistance(l.join(' '), last) <= 2;
      });
      if (close) possible = { staffId: close.id, name: close.name };
    }
    const locum = byName?.locum ?? (row.role.toLowerCase() === 'locum' || (days > 0 && extra === days));
    return {
      mediRotaId: row.id, name, grade, staffId: byName?.id, possible,
      // Everyone listed is in the department, even with nothing allocated yet; a locum with no shifts isn't worth adding.
      action: byName ? 'match' : possible ? 'match' : days > 0 || !locum ? 'add' : 'skip',
      locum, days,
      ...(!locum && first && first >= addDays(weeks[0].start, CHANGEOVER_WEEKS * 7) ? { from: first } : {}),
      ...(!locum && last && lastWeek && last <= addDays(lastWeek, -CHANGEOVER_WEEKS * 7) ? { until: addDays(last, 6) } : {}),
    } as PersonPlan;
  }).map(pp => (pp.action === 'match' && !pp.staffId && pp.possible ? { ...pp, staffId: pp.possible.staffId } : pp))
    .sort((a, b) => Number(!a.grade) - Number(!b.grade) || (a.grade ?? '').localeCompare(b.grade ?? '') || a.name.localeCompare(b.name));

  // People in the app who aren't in these weeks at all: probably left at a changeover.
  const seen = new Set(people.map(x => x.staffId).filter(Boolean));
  const leavers: LeaverPlan[] = firstTime ? [] : p.staff
    // Locums only appear when they pick up a shift, so missing weeks says nothing about them.
    .filter(s => !seen.has(s.id) && !s.locum && !(s.endDate && s.endDate < dates[0]))
    // Only suggested when the weeks are long enough to be sure they've gone.
    .map(s => ({ staffId: s.id, name: s.name, markLeft: !!s.mediRotaId && weeks.length >= CHANGEOVER_WEEKS, lastDay: addDays(dates[0], -1) }));

  // Activities: what each becomes, remembered from last time or guessed.
  const sessionsOf = new Map<string, Set<Session>>();
  const countOf = new Map<string, number>();
  for (const w of weeks) for (const r of w.people) for (const s of Object.values(r.days)) {
    const seenToday = new Set<string>();
    for (const [session, acts] of Object.entries(s) as [Session, string[]][]) for (const a of acts) {
      const n = clean(a);
      if (!sessionsOf.has(n)) sessionsOf.set(n, new Set());
      sessionsOf.get(n)!.add(session);
      if (!seenToday.has(n)) { seenToday.add(n); countOf.set(n, (countOf.get(n) ?? 0) + 1); }
    }
  }
  const memory = ws.mediRota?.activities ?? {};
  const activities: ActivityPlan[] = [...sessionsOf.keys()].map(name => {
    const m = memory[name];
    if (m && (!m.placeId || m.placeId === 'new' || p.roles.some(r => r.id === m.placeId))) return { name, ...m, days: countOf.get(name) ?? 0, remembered: true };
    const treat = guessTreat(name, sessionsOf.get(name)!);
    const days = countOf.get(name) ?? 0;
    const isPlace = treat === 'night' || treat === 'long' || treat === 'dayjob';
    const placeId = isPlace ? guessPlace(p.roles, name) ?? 'new' : undefined;
    // A free-text note ("Dr Quinn to cover Theatre 2") or a rare one-off is left out unless it matches a place.
    const note = /\bto cover\b|[(),*]/i.test(name) || name.split(/\s+/).length > 5;
    const finalTreat: Treat = isPlace && placeId === 'new' && (note || days < weeks.length / 2) ? 'ignore' : treat;
    return { name, treat: finalTreat, ...(finalTreat === 'ignore' ? {} : { placeId }), days, remembered: false };
  }).sort((a, b) => ORDER.indexOf(a.treat) - ORDER.indexOf(b.treat) || b.days - a.days);

  // First-time setup: suggest staffing needs from how many juniors each activity usually had.
  const needs: NeedSuggestion[] = [];
  for (const a of activities.filter(x => x.treat === 'night' || x.treat === 'long' || x.treat === 'dayjob')) {
    const place = a.placeId && a.placeId !== 'new' ? p.roles.find(r => r.id === a.placeId) : undefined;
    if (place && p.demands.some(d => d.roleId === place.id && !d.days.dates?.length)) continue;
    const perDate = new Map<ISODate, number>();
    for (const w of weeks) for (const r of w.people) for (const [d, s] of Object.entries(r.days)) {
      if (Object.values(s).flat().some(x => clean(x) === a.name)) perDate.set(d, (perDate.get(d) ?? 0) + 1);
    }
    const byWeekday = new Map<number, number[]>();
    for (const d of dates) { const wd = weekday(d); if (!byWeekday.has(wd)) byWeekday.set(wd, []); byWeekday.get(wd)!.push(perDate.get(d) ?? 0); }
    const usual = new Map([...byWeekday].map(([wd, xs]) => [wd, [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)]]));
    // A float is nice to have: suggest none needed, on the days it ever appeared.
    const float = /float|spare/i.test(a.name);
    const wds = [...(float ? new Map([...byWeekday].map(([wd, xs]) => [wd, Math.max(...xs)])) : usual)].filter(([, n]) => n > 0).map(([wd]) => wd).sort();
    if (!wds.length) continue;
    const min = Math.max(...wds.map(wd => usual.get(wd)!));
    const max = Math.max(...[...perDate.values()]);
    needs.push({ placeName: place?.name ?? a.name, treat: a.treat as NeedSuggestion['treat'], weekdays: wds, min: float ? 0 : min, max: Math.max(min, max), create: true });
  }

  // Offer the imported weeks as the rota's dates unless they're already the current ones.
  const inPeriod = dates.length > 0 && dates[0] <= ws.period.start && ws.period.end <= dates[dates.length - 1];
  const period = dates.length && (firstTime || !inPeriod) ? { start: dates[0], weeks: Math.min(MAX_WEEKS, Math.ceil(dates.length / 7)) } : undefined;
  const inDates = new Set(dates);
  const skip = (ws.mediRota?.skip ?? []).filter(k => inDates.has(k.split('|')[1]));
  return { dates, firstTime, people, leavers, activities, needs, period, keepDayJobs: false, skip, activityWeeks, personWeeks: weeks, unmatchedActivityJuniors: countUnmatchedActivityJuniors(activityWeeks, weeks, p.staff) };
}

export const MAX_WEEKS = 8;
/** Weeks missing in a row before someone is taken to have joined or left. */
export const CHANGEOVER_WEEKS = 4;

const ORDER: Treat[] = ['night', 'long', 'dayjob', 'leave', 'training', 'zero', 'unavailable', 'ignore'];

function shiftFor(shifts: ShiftType[], treat: 'night' | 'long' | 'dayjob'): ShiftType | undefined {
  const hours = (s: ShiftType) => { const [a, b] = [s.start, s.end].map(t => +t.slice(0, 2) + +t.slice(3) / 60); return b > a ? b - a : b + 24 - a; };
  if (treat === 'night') return shifts.find(s => s.end <= s.start);
  if (treat === 'long') return shifts.find(s => s.end > s.start && hours(s) >= 11);
  return shifts.find(s => s.end > s.start && hours(s) < 11);
}

export interface ImportResult {
  people: number; leave: number; booked: number; places: number; consultantDays: number;
  /** Bookings entered before (by hand or by an older import) that clashed with MediRota's and were replaced. */
  replaced: number;
  /** True when a leftover MediRota slot-heading place (ellipsis-only name) was removed. */
  removedHeadingPlace?: boolean;
}

/** Drop a place that was only a MediRota slot heading, plus its needs and saved activity choice. */
function removeMediRotaHeadingPlaces(w: Workspace, appearing: Set<string>): boolean {
  const doomed = w.profile.roles.filter(role => !role.parentId && isEllipsisOnlyName(role.name) && !appearing.has(role.name));
  const ids = new Set(doomed.map(role => role.id));
  if (ids.size) {
    w.profile.roles = w.profile.roles.filter(role => !ids.has(role.id));
    w.profile.demands = w.profile.demands.filter(demand => !ids.has(demand.roleId));
  }
  let clearedChoice = false;
  if (w.mediRota?.activities) {
    for (const [name, choice] of Object.entries(w.mediRota.activities)) {
      if ((isEllipsisOnlyName(name) && !appearing.has(name)) || (choice.placeId && ids.has(choice.placeId))) {
        delete w.mediRota.activities[name];
        clearedChoice = true;
      }
    }
  }
  return ids.size > 0 || clearedChoice;
}

/** Carry out a plan. Replaces what earlier imports brought in for these dates; keeps hand-entered leave and bookings. */
export function applyImport(w: Workspace, plan: ImportPlan): ImportResult {
  const p = w.profile;
  const selectedDoctorName = p.staff.find(person => person.id === w.me)?.name;
  const result: ImportResult = { people: 0, leave: 0, booked: 0, places: 0, consultantDays: 0, replaced: 0 };

  // Shifts, if the department has none of a kind it now needs.
  const notes = plan.activityWeeks.flatMap(x => x.activities.map(a => a.description)).join(' ');
  const times = timesInNote(notes);
  const need = new Set(plan.activities.map(a => a.treat));
  if (need.has('dayjob') && !shiftFor(p.shiftTypes, 'dayjob')) { const [start, end] = times.day ?? ['08:00', '17:30']; p.shiftTypes.push({ id: newId('shift'), name: 'Day job', start, end }); }
  if (need.has('long') && !shiftFor(p.shiftTypes, 'long')) { const [start, end] = times.long ?? ['08:00', '20:30']; p.shiftTypes.push({ id: newId('shift'), name: 'Long Day', start, end }); }
  if (need.has('night') && !shiftFor(p.shiftTypes, 'night')) p.shiftTypes.push({ id: newId('shift'), name: 'Night', start: '20:00', end: '08:30' });

  // Places for activities that need one.
  const placeOf = new Map<string, Role>();
  for (const a of plan.activities) {
    if (a.treat !== 'night' && a.treat !== 'long' && a.treat !== 'dayjob') continue;
    let role = a.placeId && a.placeId !== 'new' ? p.roles.find(r => r.id === a.placeId) : undefined;
    if (!role) {
      role = p.roles.find(r => !r.parentId && r.name.toLowerCase() === a.name.toLowerCase());
      if (!role) {
        role = { id: newId('place'), name: a.name, category: a.treat === 'dayjob' ? undefined : 'On-call' };
        p.roles.push(role);
        result.places++;
      }
    }
    placeOf.set(a.name, role);
  }
  // Remember the choices for next time, pointing at real places.
  // Bookings left out are remembered: those for these dates are replaced by this plan's choice.
  const dateSet = new Set(plan.dates);
  w.mediRota = { activities: { ...(w.mediRota?.activities ?? {}) }, skip: [...(w.mediRota?.skip ?? []).filter(k => !dateSet.has(k.split('|')[1])), ...plan.skip] };
  for (const a of plan.activities) w.mediRota.activities[a.name] = { treat: a.treat, ...(placeOf.has(a.name) ? { placeId: placeOf.get(a.name)!.id } : {}) };
  result.removedHeadingPlace = removeMediRotaHeadingPlaces(w, new Set(plan.activities.map(activity => activity.name)));

  // Staffing needs suggested for new places.
  for (const n of plan.needs.filter(x => x.create)) {
    const role = p.roles.find(r => r.name === n.placeName && !r.parentId);
    const shift = shiftFor(p.shiftTypes, n.treat);
    if (!role || !shift || p.demands.some(d => d.roleId === role.id && !d.days.dates?.length)) continue;
    p.demands.push({ id: newId('need'), roleId: role.id, shiftTypeId: shift.id, days: { weekdays: n.weekdays as (0 | 1 | 2 | 3 | 4 | 5 | 6)[] }, min: n.min, max: n.max, ...(n.treat !== 'dayjob' || n.min > 0 ? { importance: 3 } : {}) });
  }

  // People: groups by grade, new people, MediRota ids, locums, leavers.
  const groupFor = (grade?: string) => {
    if (!grade) return undefined;
    let g = p.groups.find(x => x.name.toLowerCase() === grade.toLowerCase());
    if (!g) { g = { id: newId('grp'), name: grade }; p.groups.push(g); }
    return g.id;
  };
  const staffOf = new Map<string, Staff>();
  for (const pp of plan.people) {
    if (pp.action === 'skip') continue;
    let s = pp.action === 'match' && pp.staffId ? p.staff.find(x => x.id === pp.staffId) : undefined;
    if (!s) {
      const g = groupFor(pp.grade);
      s = { id: newId('dr'), name: pp.name, groupIds: g ? [g] : [], fte: 1 };
      p.staff.push(s);
      result.people++;
    }
    s.mediRotaId = pp.mediRotaId;
    // A changeover inside the imported weeks: starting later only matters for someone new.
    if (pp.from && pp.action === 'add') s.startDate = pp.from;
    if (pp.until) s.endDate = pp.until;
    else if (s.endDate && plan.personWeeks.length && s.endDate < plan.personWeeks[plan.personWeeks.length - 1].start) delete s.endDate;
    if (pp.locum) s.locum = true; else delete s.locum;
    const presetPerson = w.presetPeople?.people.find(person => normalisePresetName(person.name) === normalisePresetName(s.name));
    const override = w.presetPeople?.manualOverrides[normalisePresetName(s.name)];
    const regularLocum = override && 'regularLocum' in override ? override.regularLocum : presetPerson?.regularLocum;
    if (regularLocum !== undefined) s.regularLocum = regularLocum;
    staffOf.set(pp.mediRotaId, s);
  }
  for (const l of plan.leavers.filter(x => x.markLeft)) {
    const s = p.staff.find(x => x.id === l.staffId);
    if (s) s.endDate = l.lastDay;
  }

  // Keep an independent, session-aware snapshot for the finder. This does not
  // change the planner's fixed or unavailability import behavior.
  snapshotImport(w, plan, staffOf);

  // Leave, days off and booked shifts: replace what came from MediRota for these dates.
  const inDates = new Set(plan.dates);
  w.unavailability = w.unavailability.filter(u => !(u.source === 'medirota' && inDates.has(u.date)));
  w.fixed = w.fixed.filter(f => !(f.source === 'medirota' && inDates.has(f.date)));
  const choice = new Map(plan.activities.map(a => [a.name, a]));
  for (const week of plan.personWeeks) for (const row of week.people) {
    const s = staffOf.get(row.id);
    if (!s) continue;
    for (const [date, sessions] of Object.entries(row.days)) {
      const acts = Object.values(sessions).flat().map(clean);
      const of = (t: Treat) => acts.find(a => choice.get(a)?.treat === t);
      const book = (name: string, treat: 'night' | 'long' | 'dayjob') => {
        if (plan.skip.includes(`${row.id}|${date}`)) return true;
        const role = placeOf.get(name);
        const shift = shiftFor(p.shiftTypes, treat);
        if (!role || !shift) return false;
        // MediRota is the record for these, so an earlier booking at the same time gives way.
        const t = shiftInterval(date, shift);
        const kept = w.fixed.filter(f => {
          if (f.staffId !== s.id || f.source === 'medirota' || Math.abs(Date.parse(f.date) - Date.parse(date)) > 864e5) return true;
          const st = p.shiftTypes.find(x => x.id === f.shiftTypeId);
          if (!st) return true;
          const o = shiftInterval(f.date, st);
          return o.end <= t.start || o.start >= t.end;
        });
        result.replaced += w.fixed.length - kept.length;
        w.fixed = kept;
        w.fixed.push({ staffId: s.id, date, shiftTypeId: shift.id, roleId: role.id, reason: 'Booked in MediRota', source: 'medirota' } as FixedAssignment);
        result.booked++;
        return true;
      };
      const night = of('night'), long = of('long'), job = of('dayjob');
      if (night && book(night, 'night')) continue;
      if (long && book(long, 'long')) continue;
      if (job) { if (plan.keepDayJobs) book(job, 'dayjob'); continue; }
      const away: [Treat, Unavailability['kind'], string][] = [['leave', 'leave', 'Leave'], ['training', 'other', 'Training'], ['zero', 'nonWorking', 'Zero Day'], ['unavailable', 'other', 'Not available']];
      for (const [t, kind, label] of away) {
        const a = of(t);
        if (!a) continue;
        // Already marked away that day (by hand or an older import): keep that.
        if (w.unavailability.some(u => u.staffId === s.id && u.date === date && !u.shiftTypeIds)) break;
        w.unavailability.push({ staffId: s.id, date, kind, reason: t === 'training' ? a : t === 'leave' && a !== '[Away]' ? a : label, source: 'medirota' });
        result.leave++;
        break;
      }
    }
  }

  // Consultant lists from the "By activity" weeks.
  if (plan.activityWeeks.length) {
    const placeFor = Object.fromEntries([...placeOf].map(([n, r]) => [n, r.id]));
    result.consultantDays = applyConsultantLists(w, plan.activityWeeks, placeFor).days;
    const personForMediId = new Map([...staffOf].map(([mediId, person]) => [mediId, person.id]));
    const retained = (w.consultantLists ?? []).filter(cell => !plan.dates.includes(cell.date));
    for (const week of plan.activityWeeks) for (const activity of week.activities) {
      const placeId = placeFor[activity.name];
      if (!placeId) continue;
      for (const day of Object.values(activity.days)) for (const cell of day.cells ?? []) {
        const staffIds = cell.juniors.flatMap(junior => {
          const match = activityJuniorMatch(junior, plan.personWeeks, w.profile.staff);
          const staffId = match?.startsWith('staff:') ? match.slice(6) : match?.startsWith('mr:') ? personForMediId.get(match.slice(3)) : undefined;
          return staffId ? [staffId] : [];
        });
        retained.push({ date: cell.date, placeId, activity: activity.name, session: cell.session, staffIds: [...new Set(staffIds)], consultants: [...cell.consultants], unmatched: cell.juniors.length - staffIds.length });
      }
    }
    w.consultantLists = retained;
  }

  // A rota made before the import no longer matches the leave and bookings, so it's cleared.
  if (plan.period) {
    const weeks = Math.max(1, Math.min(MAX_WEEKS, plan.period.weeks));
    w.period = { start: plan.period.start, end: addDays(plan.period.start, weeks * 7 - 1) };
  }
  delete w.rota;
  applyPresetPeopleSettings(w);
  const selectedName = selectedDoctorName ?? w.presetPeople?.me;
  if (w.role !== 'coordinator' && selectedName) {
    const matches = w.profile.staff.filter(person => normalisePresetName(person.name) === normalisePresetName(selectedName));
    if (matches.length === 1) w.me = matches[0].id;
  }
  return result;
}

/** What applying the plan would change, worked out on a copy. Booked shifts are checked across all the imported weeks. */
export function previewImport(ws: Workspace, plan: ImportPlan): ImportPreview {
  const copy = structuredClone(ws);
  const inDates = new Set(plan.dates);
  const before = { leave: ws.unavailability.filter(u => inDates.has(u.date)).length, booked: ws.fixed.filter(f => inDates.has(f.date)).length };
  const r = applyImport(copy, plan);
  const problems: ImportPreview['problems'] = [];
  if (plan.dates.length) {
    const problem = toProblem({ ...copy, period: { start: plan.dates[0], end: plan.dates[plan.dates.length - 1] } });
    for (const v of validate(problem, problem.fixed.map(f => ({ ...f }))).violations) {
      const staff = copy.profile.staff.find(s => s.id === v.staffId);
      const f = copy.fixed.find(x => x.staffId === v.staffId && x.date === v.date && x.source === 'medirota');
      const booking = f && [copy.profile.shiftTypes.find(t => t.id === f.shiftTypeId)?.name, copy.profile.roles.find(r => r.id === f.roleId)?.name].filter(Boolean).join(' · ');
      problems.push({ ...v, name: staff?.name, mediRotaId: staff?.mediRotaId, ...(booking ? { booking } : {}) });
    }
  }
  return {
    leave: { before: before.leave, after: copy.unavailability.filter(u => inDates.has(u.date)).length },
    booked: { before: before.booked, after: copy.fixed.filter(f => inDates.has(f.date)).length },
    newPeople: r.people, newPlaces: r.places, consultantDays: r.consultantDays, replaced: r.replaced, problems,
    clearsRota: !!ws.rota,
  };
}

/** Only "By activity" weeks: bring in who runs each list, for places already matched or with the same name. */
export function consultantListsOnly(w: Workspace, activityWeeks: ActivityWeek[]): ReturnType<typeof applyConsultantLists> {
  const memory = w.mediRota?.activities ?? {};
  const placeFor: Record<string, string> = {};
  for (const a of activityWeeks.flatMap(x => x.activities)) {
    const id = memory[a.name]?.placeId ?? guessPlace(w.profile.roles, a.name);
    if (id && w.profile.roles.some(r => r.id === id)) placeFor[a.name] = id;
  }
  return applyConsultantLists(w, activityWeeks, placeFor);
}
