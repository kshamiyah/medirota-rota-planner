import { legacySessions } from "../fixtures/legacy-sessions";

import { addDays, dateRange, weekday } from '../../src/engine/calendar';
import { emptyWorkspace } from '../../src/app/store';
import type { Workspace } from '../../src/app/store';

const names = ['Dr Rowan','Dr Ellis','Dr Hart','Dr Moss','Dr Vale','Dr Quinn','Dr Shaw','Dr Lane','Dr Bell','Dr Reed','Dr Frost','Dr King','Dr Cole','Dr Gray','Dr Wells','Dr Brooks','Dr Hayes','Dr James','Dr Young','Dr Price','Dr Finch','Dr Lowe','Dr Webb','Dr Hunt','Dr Ford','Dr Cross','Dr Hill','Dr Park','Dr Dale','Dr Rice','Dr Stone','Dr Birch','Dr Lake','Dr Field','Dr Ash','Dr Wood','Dr Brook','Dr Snow','Dr March','Dr Dawn'];
const activities = ['Elective C-Sections', 'Postnatal Wards CT', 'MAU CT', 'Float CT'];

/** Synthetic weekday rota used to exercise four and thirteen week Fairer rota solves. */
export function fairerFixture(weeks = 4, staffCount = 20): Workspace {
  const ws = emptyWorkspace();
  const start = '2026-11-02';
  const end = addDays(start, weeks * 7 - 1);
  ws.period = { start, end };
  ws.profile.name = 'Made-up Fairer rota department';
  ws.profile.groups = [
    { id: 'fy2', name: 'FY2' }, { id: 'gpreg', name: 'GP Reg' }, { id: 'gpvts', name: 'GPVTS' },
    { id: 'st1', name: 'ST1' }, { id: 'st12', name: 'ST1/2' }, { id: 'st2', name: 'ST2' },
  ];
  ws.profile.shiftTypes = [{ id: 'day', name: 'Day', start: '08:00', end: '17:00' }, { id: 'long', name: 'Long day', start: '08:00', end: '20:00' }, { id: 'night', name: 'Night', start: '20:00', end: '08:00' }];
  ws.profile.roles = activities.map((name, index) => ({ id: `fairer-place-${index}`, name, category: name }));
  ws.profile.staff = names.slice(0, staffCount).map((name, index) => ({
    id: `fairer-doctor-${index}`, name,
    groupIds: [index < 5 ? 'fy2' : index < 9 ? 'gpreg' : index < 13 ? 'gpvts' : index < 19 ? 'st1' : index < 24 ? 'st12' : 'st2'],
    fte: index === 1 ? 0.8 : 1,
    ...(index === staffCount - 1 ? { locum: true, regularLocum: true } : {}),
  }));
  ws.profile.demands = [];
  ws.profile.rules = [];
  ws.sessions = legacySessions(ws.profile);
  ws.swapFinder = { settings: { weekendDayActivities: [], hoursTolerance: 1, maxChain: 4, minDoctors: [0,0,0,0,0,0,0], minDoctorsBankHoliday: 0, bankHolidays: [], regularDaysOff: {}, excluded: [] }, snapshot: { days: {}, importedAt: {}, extrasTagged: true } };
  const snapshot = ws.swapFinder.snapshot;
  for (const date of dateRange(start, end)) if (weekday(date) === 0) snapshot.importedAt[date] = `${date}T12:00:00.000Z`;
  ws.profile.staff.forEach((person, index) => {
    snapshot.days[person.id] = {};
    for (const date of dateRange(start, end)) {
      if (weekday(date) > 4) { snapshot.days[person.id]![date] = { status: 'blank' }; continue; }
      const week = Math.floor((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / (7 * 86400000));
      const activity = activities[(index + week) % activities.length]!;
      snapshot.days[person.id]![date] = { status: 'dayJob', activity, sessions: ['am', 'pm'] };
    }
  });
  // Fixed kinds and extra markers remain visible to the safety checks.
  const extraDate = addDays(start, 1);
  if (snapshot.days['fairer-doctor-0']) snapshot.days['fairer-doctor-0'][extraDate] = { status: 'dayJob', activity: 'Elective C-Sections', sessions: ['am', 'pm'], extra: true };
  if (snapshot.days['fairer-doctor-1']) snapshot.days['fairer-doctor-1'][addDays(start, 2)] = { status: 'longDay', activity: 'Delivery Suite', sessions: ['am', 'pm', 'eve'] };
  if (snapshot.days['fairer-doctor-2']) snapshot.days['fairer-doctor-2'][addDays(start, 3)] = { status: 'night', activity: 'Nights CT', sessions: ['night'] };
  if (snapshot.days['fairer-doctor-3']) snapshot.days['fairer-doctor-3'][addDays(start, 4)] = { status: 'leave', activity: 'Annual leave' };
  ws.me = 'fairer-doctor-0';
  return ws;
}

/** Synthetic By activity list allocation for three ST doctors. */
export function fairerConsultantFixture(): Workspace {
  const ws = fairerFixture(3, 3);
  ws.profile.groups = [{ id: 'st1', name: 'ST1' }];
  ws.profile.staff = ws.profile.staff.map(person => ({ ...person, groupIds: ['st1'], locum: false, regularLocum: false }));
  const days = dateRange(ws.period.start, ws.period.end).filter(date => weekday(date) <= 4);
  for (const date of days) ws.profile.staff.forEach(person => {
    ws.swapFinder!.snapshot.days[person.id]![date] = { status: 'dayJob', activity: 'Elective C-Sections', sessions: ['am', 'pm'] };
  });
  attachMadeUpConsultantLists(ws);
  ws.consultantLists!.push({ date: '2026-11-08', placeId: 'fairer-place-0', activity: 'Elective C-Sections', session: 'am', staffIds: ['fairer-doctor-0'], consultants: ['Mr Vale'], unmatched: 0 });
  ws.consultantPairs = { 'fairer-doctor-0': ['Ms Quinn'] };
  ws.me = 'fairer-doctor-0';
  return ws;
}

export function attachMadeUpConsultantLists(ws: Workspace): Workspace {
  ws.profile.leads = [{ id: 'consultant-vale', name: 'Mr Vale' }, { id: 'consultant-quinn', name: 'Ms Quinn' }];
  ws.profile.roles = ws.profile.roles.filter(role => role.id !== 'list-vale' && role.id !== 'list-quinn');
  ws.profile.roles.push(
    { id: 'list-vale', name: 'Elective C-Sections · Mr Vale', parentId: 'fairer-place-0', leadIds: ['consultant-vale'] },
    { id: 'list-quinn', name: 'Elective C-Sections · Ms Quinn', parentId: 'fairer-place-0', leadIds: ['consultant-quinn'] },
  );
  const theatre = ws.sessions!.types.find(type => type.name === 'Theatre')!;
  ws.sessions!.sameConsultants = { groupIds: ['session-group-st12'], typeIds: [theatre.id] };
  const tierDoctors = ws.profile.staff.filter(person => !person.locum && !!person.groupIds?.length);
  const cells: NonNullable<Workspace['consultantLists']> = [];
  for (const person of tierDoctors) for (const [date, day] of Object.entries(ws.swapFinder!.snapshot.days[person.id] ?? {})) {
    if (day.status !== 'dayJob' || day.activity !== 'Elective C-Sections' || day.extra) continue;
    const doctorIndex = tierDoctors.indexOf(person);
    const dayIndex = dateRange(ws.period.start, date).length;
    const quinnCount = Math.max(1, Math.floor(tierDoctors.length / 3));
    const quinnIndexes = Array.from({ length: quinnCount }, (_, index) => 1 + ((dayIndex + index) % Math.max(1, tierDoctors.length - 1)));
    const vale = !quinnIndexes.includes(doctorIndex);
    cells.push({ date, placeId: 'fairer-place-0', activity: day.activity, session: 'am', staffIds: [person.id], consultants: [vale ? 'Mr Vale' : 'Ms Quinn'], unmatched: 0 });
  }
  ws.consultantLists = cells;
  return ws;
}

/** Made-up multi-grade benchmark with eighty one-trainee consultant list slots. */
export function fairerConsultantBenchmarkFixture(): Workspace {
  const ws = fairerFixture(9, 20);
  ws.profile.staff = ws.profile.staff.map((person, index) => ({
    ...person,
    groupIds: [index < 6 ? 'fy2' : index < 12 ? 'gpreg' : index < 16 ? 'st1' : 'st12'],
    locum: false, regularLocum: false,
  }));
  const consultants = [
    'Mr Vale', 'Ms Quinn', 'Mr Hart', 'Ms Moss', 'Mr Rowan', 'Ms Ellis', 'Mr Shore', 'Ms Lane', 'Mr Bell', 'Ms Reed',
    'Mr Frost', 'Ms King', 'Mr Cole', 'Ms Gray', 'Mr Wells', 'Ms Brooks', 'Mr Hayes', 'Ms James', 'Mr Young', 'Ms Price',
    'Mr Finch', 'Ms Lowe', 'Mr Webb', 'Ms Hunt', 'Mr Ford', 'Ms Cross', 'Mr Hill', 'Ms Park', 'Mr Dale', 'Ms Rice',
  ];
  ws.profile.leads = consultants.map((name, index) => ({ id: `benchmark-consultant-${index}`, name }));
  const theatre = ws.sessions!.types.find(type => type.name === 'Theatre')!;
  const electivePlace = ws.profile.roles.find(role => role.name === 'Elective C-Sections')!;
  const wcPlace = ws.profile.roles.find(role => role.name === 'WC Theatres') ?? { id: 'benchmark-wc-place', name: 'WC Theatres' };
  if (!ws.profile.roles.some(role => role.id === wcPlace.id)) ws.profile.roles.push(wcPlace);
  const electiveType = { ...theatre, id: 'benchmark-elective', name: 'Elective C-Sections', placeIds: [electivePlace.id] };
  const wcType = { ...theatre, id: 'benchmark-wc-theatres', name: 'WC Theatres', colour: 7, placeIds: [wcPlace.id] };
  ws.sessions!.types = ws.sessions!.types.flatMap(type => type.id === theatre.id ? [electiveType, wcType] : [type]);
  delete ws.sessions!.ratios[theatre.id];
  ws.sessions!.ratios[electiveType.id] = { 'session-group-fy2': 1, 'session-group-gps': 1, 'session-group-st12': 2 };
  ws.sessions!.ratios[wcType.id] = { 'session-group-fy2': 1, 'session-group-gps': 1, 'session-group-st12': 2 };
  ws.sessions!.sameConsultants = { groupIds: ['session-group-st12'], typeIds: [electiveType.id, wcType.id] };
  const dates = dateRange(ws.period.start, ws.period.end).filter(date => weekday(date) < 5);
  const counts = dates.map((date, index) => {
    const base = [1, 2, 3, 1, 2][weekday(date)]!;
    return index === dates.length - 1 ? base - 1 : base + (Math.floor(index / 5) % 3 === 1 && weekday(date) === 2 ? 1 : 0);
  });
  // Keep the benchmark at exactly eighty list slots while varying weekday demand.
  let difference = counts.reduce((sum, count) => sum + count, 0) - 80;
  for (let index = counts.length - 2; difference > 0; index--) {
    if (counts[index]! > 1) { counts[index]!--; difference--; }
  }
  for (let index = 0; difference < 0; index++) { counts[index]!++; difference++; }
  const remaining: number[] = consultants.map((_, index) => index < 20 ? 2 : 4);
  const consultantIds = consultants.map((_, index) => `benchmark-consultant-${index}`);
  const listRoles = [
    ...consultants.map((name, index) => ({ id: `benchmark-elective-list-${index}`, name: `Elective C-Sections · ${name}`, parentId: electivePlace.id, leadIds: [consultantIds[index]!] })),
    ...consultants.map((name, index) => ({ id: `benchmark-wc-list-${index}`, name: `WC Theatres · ${name}`, parentId: wcPlace.id, leadIds: [consultantIds[index]!] })),
  ];
  ws.profile.roles.push(...listRoles);
  const listRoleByPlaceAndConsultant = new Map<string, string>();
  for (let index = 0; index < consultants.length; index++) {
    listRoleByPlaceAndConsultant.set(`${electivePlace.id}|${consultants[index]}`, `benchmark-elective-list-${index}`);
    listRoleByPlaceAndConsultant.set(`${wcPlace.id}|${consultants[index]}`, `benchmark-wc-list-${index}`);
  }
  ws.consultantLists = [];
  let cursor = 0;
  for (const [dayIndex, date] of dates.entries()) {
    const week = Math.floor(dayIndex / 5);
    const fixedIds = new Set<string>();
    if (week >= 2 && week <= 6 && (weekday(date) === 1 || weekday(date) === 3)) {
      for (let index = 0; index < 2; index++) {
        const person = ws.profile.staff[(dayIndex * 3 + index * 7 + week) % ws.profile.staff.length]!;
        fixedIds.add(person.id);
        ws.swapFinder!.snapshot.days[person.id]![date] = { status: 'night', activity: 'Nights CT', sessions: ['night'] };
      }
    }
    if (week === 4 && weekday(date) === 4) {
      const person = ws.profile.staff[(dayIndex * 3 + 11) % ws.profile.staff.length]!;
      fixedIds.add(person.id);
      ws.swapFinder!.snapshot.days[person.id]![date] = { status: 'leave', activity: 'Annual leave' };
    }
    const available = ws.profile.staff.filter(person => !fixedIds.has(person.id));
    const theatrePeople = Array.from({ length: counts[dayIndex]! }, (_, index) => available[(dayIndex * 3 + index * 7) % available.length]!);
    const electiveCount = counts[dayIndex]! === 1 ? (dayIndex % 2 === 0 ? 1 : 0) : Math.max(1, Math.min(counts[dayIndex]! - 1, Math.floor(counts[dayIndex]! / 2) + (week % 2)));
    const selected = new Set(theatrePeople.map(person => person.id));
    const nonTheatre = available.filter(person => !selected.has(person.id));
    const wardCount = Math.floor(nonTheatre.length * ([0.4, 0.5, 0.3, 0.45, 0.35][weekday(date)]!));
    const mauCount = Math.floor((nonTheatre.length - wardCount) * ([0.5, 0.4, 0.6, 0.35, 0.55][(weekday(date) + week) % 5]!));
    const wardIds = new Set(nonTheatre.slice(0, wardCount).map(person => person.id));
    const mauIds = new Set(nonTheatre.slice(wardCount, wardCount + mauCount).map(person => person.id));
    ws.profile.staff.forEach(person => {
      const day = ws.swapFinder!.snapshot.days[person.id]!;
      if (fixedIds.has(person.id)) return;
      const theatreIndex = theatrePeople.findIndex(theatrePerson => theatrePerson.id === person.id);
      const activity = theatreIndex >= 0 ? theatreIndex < electiveCount ? 'Elective C-Sections' : 'WC Theatres' : wardIds.has(person.id) ? activities[1] : mauIds.has(person.id) ? activities[2] : activities[3];
      day[date] = { status: 'dayJob', activity, sessions: ['am', 'pm'] };
    });
    const todaysConsultants: number[] = [];
    for (let slot = 0; slot < counts[dayIndex]!; slot++) {
      let chosen = -1;
      for (let offset = 0; offset < remaining.length; offset++) {
        const candidate = (cursor + offset) % remaining.length;
        if (remaining[candidate]! > 0 && !todaysConsultants.includes(candidate)) { chosen = candidate; break; }
      }
      if (chosen < 0) throw new Error('Synthetic consultant benchmark ran out of list names.');
      remaining[chosen]!--;
      todaysConsultants.push(chosen);
      cursor = (chosen + 1) % remaining.length;
    }
    theatrePeople.forEach((person, index) => {
      const consultantIndex = todaysConsultants[index]!;
      const place = index < electiveCount ? electivePlace : wcPlace;
      const consultant = consultants[consultantIndex]!;
      ws.consultantLists!.push({ date, placeId: place.id, activity: place.name, session: 'am', staffIds: [person.id], consultants: [consultant], unmatched: 0 });
      // The dynamic list role must agree with the stored place and consultant cell.
      const listRole = listRoleByPlaceAndConsultant.get(`${place.id}|${consultant}`);
      if (!listRole) throw new Error('Synthetic consultant benchmark did not create a list role.');
    });
  }
  if (remaining.some(count => count !== 0)) throw new Error('Synthetic consultant benchmark did not use every planned consultant slot.');
  return ws;
}
