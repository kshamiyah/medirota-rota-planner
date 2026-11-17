import { describe, expect, it } from 'vitest';
import { isCountedWork } from '../src/engine/swaps';
import { applyPresetToWorkspace, type SetupPreset } from '../src/app/presets';
import { overviewAssignments, overviewGroups, overviewRange, overviewValidation, sessionFor, shortDays, workingCount } from '../src/app/overview';
import { overviewFixture } from './fixtures/overview-made-up';

describe('Stage 1 Overview', () => {
  it('maps configured places to session types and ignores removed or truncated activities', () => {
    const ws = overviewFixture();
    ws.sessions = { types: [{ id: 'theatre', name: 'Theatre', colour: 4, kind: 'day', placeIds: ['place-0'] }], groups: [], ratios: {} };
    expect(sessionFor('Elective C-Sections', ws.profile, ws.sessions)?.name).toBe('Theatre');
    expect(sessionFor('MAU CT [Removed]', ws.profile, ws.sessions)).toBeUndefined();
    expect(sessionFor('MAU CT…', ws.profile, ws.sessions)).toBeUndefined();
  });

  it('shows 28 calendar dates and shifts in four-week steps', () => {
    const current = overviewRange('2026-11-10');
    expect(current.start).toBe('2026-11-10');
    expect(current.dates).toHaveLength(28);
    expect(overviewRange('2026-11-10', 1).start).toBe('2026-11-17');
    expect(overviewRange('2026-11-10', -1).start).toBe('2026-11-03');
  });

  it('uses exact activity mappings for assignments and only reports hard-rule breaches', () => {
    const ws = overviewFixture();
    const snap = ws.swapFinder!.snapshot;
    snap.days['doctor-0']['2026-11-10'] = { status: 'dayJob', activity: 'MAU CT' };
    snap.days['doctor-1']['2026-11-10'] = { status: 'dayJob', activity: 'Other CT' };
    ws.profile.demands = [{ id: 'need', roleId: 'place-4', shiftTypeId: 'day', days: {}, min: 1, max: 2 }];
    for (const person of ws.profile.staff.slice(2)) delete snap.days[person.id]['2026-11-10'];
    const result = overviewValidation(ws.profile, snap, '2026-11-10', '2026-11-10');
    expect(result.assignments).toContainEqual({ staffId: 'doctor-0', date: '2026-11-10', shiftTypeId: 'day', roleId: 'place-4' });
    expect(result.gaps).toHaveLength(0);
    ws.profile.rules = [{ id: 'rest', name: 'Made-up Must rule', type: 'minRest', who: {}, hours: 11, hard: true }];
    const withRule = overviewValidation(ws.profile, snap, '2026-11-10', '2026-11-10');
    expect(withRule.violations.every(v => ws.profile.rules.find(r => r.id === v.ruleId)?.hard)).toBe(true);
  });

  it('uses configured physical minimums and does not substitute new values', () => {
    const ws = overviewFixture();
    const date = '2026-11-10';
    for (const doctor of ws.profile.staff) delete ws.swapFinder!.snapshot.days[doctor.id][date];
    for (const doctor of ws.profile.staff.slice(0, 5)) ws.swapFinder!.snapshot.days[doctor.id][date] = { status: 'dayJob', activity: 'MAU CT' };
    const short = shortDays(ws.swapFinder!.snapshot, ws.swapFinder!.settings, [date], ws.profile.staff.map(s => s.id));
    expect(short.get(date)).toBe(2); // Configured Tuesday minimum is 7; five made-up doctors work.
    expect(shortDays(ws.swapFinder!.snapshot, undefined, [date], ws.profile.staff.map(s => s.id)).size).toBe(0);
  });

  it('counts working locums in the configured minimum and short-day total', () => {
    const ws = overviewFixture();
    const date = '2026-11-10';
    const snapshot = ws.swapFinder!.snapshot;
    for (const person of ws.profile.staff) delete snapshot.days[person.id][date];
    ws.profile.staff[0].locum = true;
    snapshot.days['doctor-0'][date] = { status: 'dayJob', activity: 'MAU CT', sessions: ['am', 'pm'] };
    expect(shortDays(snapshot, ws.swapFinder!.settings, [date], []).get(date)).toBe(6);
  });

  it('includes regular locums as outlined rows and hides occasional locums from groups', () => {
    const ws = overviewFixture();
    const regular = ws.profile.staff[10];
    const occasional = ws.profile.staff[11];
    regular.locum = true; regular.regularLocum = true;
    occasional.locum = true;
    const rows = overviewGroups(ws.profile.staff.filter(person => !person.locum || person.regularLocum), ws.profile.groups);
    expect(rows.flatMap(group => group.people.map(person => person.id))).toContain(regular.id);
    expect(rows.flatMap(group => group.people.map(person => person.id))).not.toContain(occasional.id);
    const date = '2026-11-10';
    ws.profile.staff[10].locum = true;
    ws.profile.staff[10].regularLocum = true;
    ws.swapFinder!.snapshot.days[ws.profile.staff[10].id][date] = { status: 'longDay', activity: 'Delivery Suite' };
    ws.swapFinder!.snapshot.days[occasional.id][date] = { status: 'dayJob', activity: 'MAU CT' };
    expect(workingCount(ws.swapFinder!.snapshot, date)).toBeGreaterThan(0); // Both locum bookings remain physical cover.
    expect(shortDays(ws.swapFinder!.snapshot, ws.swapFinder!.settings, [date]).get(date)).toBeLessThan(7);
  });

  it('matches Working / minimum footer counting to shortDays (includes locums)', () => {
    const ws = overviewFixture();
    const date = '2026-11-10';
    const snapshot = ws.swapFinder!.snapshot;
    for (const person of ws.profile.staff) delete snapshot.days[person.id][date];
    ws.profile.staff[0].locum = true;
    ws.profile.staff[1].locum = true;
    snapshot.days['doctor-0'][date] = { status: 'dayJob', activity: 'MAU CT', sessions: ['am', 'pm'] };
    snapshot.days['doctor-1'][date] = { status: 'dayJob', activity: 'Float CT', sessions: ['am', 'pm'] };
    snapshot.days['doctor-2'][date] = { status: 'dayJob', activity: 'Delivery Suite', sessions: ['am', 'pm'] };
    const working = workingCount(snapshot, date);
    expect(working).toBe(3);
    const nonLocumOnly = ws.profile.staff.filter(s => !s.locum).filter(s => isCountedWork(snapshot.days[s.id]?.[date])).length;
    expect(nonLocumOnly).toBe(1);
    expect(shortDays(snapshot, ws.swapFinder!.settings, [date]).get(date)).toBe(4); // Tuesday minimum 7; three workers including locums
    expect(working).toBe(7 - (shortDays(snapshot, ws.swapFinder!.settings, [date]).get(date) ?? 0));
  });

  it('allocates parent-place doctors to consultant lists before parent-place minimums', () => {
    const ws = overviewFixture();
    const date = '2026-11-10';
    const { profile, swapFinder } = ws;
    const snapshot = swapFinder!.snapshot;
    for (const person of profile.staff) delete snapshot.days[person.id][date];
    profile.shiftTypes = [{ id: 'day', name: 'Day', start: '08:00', end: '17:00' }];
    profile.roles = [
      { id: 'place', name: 'Elective C-Sections' },
      { id: 'list-a', name: 'List A', parentId: 'place' },
      { id: 'list-b', name: 'List B', parentId: 'place' },
    ];
    profile.demands = [{ id: 'list-a-need', roleId: 'list-a', shiftTypeId: 'day', days: {}, min: 1, max: 1 }];
    const setWorkers = (ids: string[]) => {
      for (const id of ids) snapshot.days[id][date] = { status: 'dayJob', activity: 'Elective C-Sections', sessions: ['am', 'pm'] };
      return overviewValidation(profile, snapshot, date, date).gaps;
    };
    expect(setWorkers(['doctor-0'])).toEqual([]); // One list, one junior.
    profile.demands.push({ id: 'list-b-need', roleId: 'list-b', shiftTypeId: 'day', days: {}, min: 1, max: 1 });
    expect(setWorkers(['doctor-0'])).toHaveLength(1); // Two lists, one junior.
    profile.demands = [
      { id: 'list-a-need', roleId: 'list-a', shiftTypeId: 'day', days: {}, min: 1, max: 1 },
      { id: 'place-need', roleId: 'place', shiftTypeId: 'day', days: {}, min: 1, max: 2 },
    ];
    expect(setWorkers(['doctor-0', 'doctor-1'])).toEqual([]); // List first, remaining junior meets parent minimum.
  });

  it('counts only swap-engine counted work for working/minimum values', () => {
    expect(isCountedWork({ status: 'dayJob' })).toBe(true);
    expect(isCountedWork({ status: 'longDay' })).toBe(true);
    expect(isCountedWork({ status: 'partShift', sessions: ['am'] })).toBe(true);
    expect(isCountedWork({ status: 'partShift', sessions: ['eve'] })).toBe(false);
    expect(isCountedWork({ status: 'night' })).toBe(false);
    expect(isCountedWork({ status: 'zero' })).toBe(false);
    expect(isCountedWork({ status: 'leave' })).toBe(false);
    expect(isCountedWork({ status: 'training' })).toBe(false);
  });

  it('reports padded 72-hour rule breaches with described names and only in-range issues', () => {
    const ws = overviewFixture();
    const { profile, swapFinder } = ws;
    const snapshot = swapFinder!.snapshot;
    for (const day of Object.values(snapshot.days)) for (const date of Object.keys(day)) delete day[date];
    for (const date of ['2026-11-10','2026-11-11','2026-11-12','2026-11-13','2026-11-14','2026-11-15','2026-11-16']) snapshot.days['doctor-0'][date] = { status: 'longDay', activity: 'Gynae Onc Long Day CT', sessions: ['am','pm','eve'] };
    profile.shiftTypes = [{ id: 'long-12', name: 'Long Day', start: '08:00', end: '20:00' }, { id: 'night-12', name: 'Night', start: '20:00', end: '08:00' }];
    profile.roles = [{ id: 'onc', name: 'Gynae Onc Long Day CT' }];
    profile.demands = [{ id: 'onc-need', roleId: 'onc', shiftTypeId: 'long-12', days: {}, min: 0, max: 3 }];
    profile.rules = [{ id: 'max72', name: '', type: 'maxHours', hard: true, who: { staffIds: ['doctor-0'] }, hours: 72, windowDays: 7 }];
    const inside = overviewValidation(profile, snapshot, '2026-11-10', '2026-11-20');
    expect(inside.assignments.find(a => a.date === '2026-11-10')).toMatchObject({ shiftTypeId: 'long-12', roleId: 'onc' });
    expect(inside.violations.some(v => v.date === '2026-11-10')).toBe(true);
    expect(inside.violations.every(v => v.ruleName.length > 0 && v.date! >= '2026-11-10' && v.date! <= '2026-11-20')).toBe(true);
    const outside = overviewValidation(profile, snapshot, '2026-11-11', '2026-11-20');
    expect(outside.violations.some(v => v.date === '2026-11-10')).toBe(false);
  });

  it('lists ungraded doctors last and includes multi-grade doctors only in their first group', () => {
    const ws = overviewFixture();
    ws.profile.staff[0].groupIds = ['fy2', 'st12'];
    ws.profile.staff[1].groupIds = [];
    const groups = overviewGroups(ws.profile.staff.slice(0, 10), ws.profile.groups);
    expect(groups.map(group => group.name)).toEqual(['FY2', 'GPs', 'ST1-2', 'No group']);
    expect(groups.flatMap(group => group.people.map(person => person.id))).toEqual(['doctor-0', 'doctor-2', 'doctor-3', 'doctor-4', 'doctor-5', 'doctor-6', 'doctor-7', 'doctor-8', 'doctor-9', 'doctor-1']);
  });

  it('applies preset me by normalised name and ignores an old built-in marker', () => {
    const ws = overviewFixture();
    const local: SetupPreset = { version: 1, id: 'made-up-local', name: 'Local', description: 'Made-up', me: 'Rowan', setup: { profile: structuredClone(ws.profile), swapSettings: structuredClone(ws.swapFinder!.settings) } };
    applyPresetToWorkspace(ws, local);
    expect(ws.me).toBe('doctor-0');
    expect(ws.presetPeople?.me).toBe('Rowan');
    ws.me = 'doctor-1';
    const oldBuiltIn = { ...local, id: 'old-file', builtIn: true, me: undefined };
    applyPresetToWorkspace(ws, oldBuiltIn);
    expect(ws.me).toBe('doctor-1');
  });

  it('creates the requested made-up 20-doctor, eight-week snapshot', () => {
    const ws = overviewFixture();
    expect(ws.profile.staff).toHaveLength(20);
    expect(Object.keys(ws.swapFinder!.snapshot.importedAt)).toHaveLength(8);
    expect(Object.keys(ws.swapFinder!.snapshot.days['doctor-0'])).toHaveLength(56);
    expect(overviewAssignments(ws.profile, ws.swapFinder!.snapshot, ws.period.start, ws.period.end).length).toBeGreaterThan(0);
  });
});
