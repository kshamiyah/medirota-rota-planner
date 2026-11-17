import { describe, expect, it } from 'vitest';
import { addDays } from '../src/engine/calendar';
import { detectPatterns, type RotaSnapshot } from '../src/engine/swaps';
import { applyImport, planImport } from '../src/app/mediImport';
import { emptyWorkspace } from '../src/app/store';
import type { PersonRow, PersonWeek, Session } from '../src/app/medirota';

const person = (id: string, days: PersonRow['days']): PersonRow => ({ id, rowName: `Fixture ${id}`, role: 'Doctor', days });
const sessions = (...items: [Session, string][]): PersonRow['days'][string] => Object.fromEntries(items.map(([session, activity]) => [session, [activity]]));

describe('swap finder import snapshot', () => {
  it('keeps every status, selected activity sessions, mixed-day priority, part shifts and Extra entries', () => {
    const ws = emptyWorkspace();
    const start = '2026-11-02';
    const week: PersonWeek = {
      start,
      people: [person('fixture-1', {
        [start]: sessions(['am', 'Ward Long'], ['pm', 'Ward Long'], ['eve', 'Ward Long']),
        [addDays(start, 1)]: sessions(['am', 'Clinic']),
        [addDays(start, 2)]: sessions(['night', 'Night Rota [Extra]'], ['eve', 'Ward Long']),
        [addDays(start, 3)]: sessions(['am', 'Routine Clinic [Extra]']),
        [addDays(start, 4)]: sessions(['am', 'Annual Leave']),
        [addDays(start, 5)]: sessions(['am', 'Teaching']),
        [addDays(start, 6)]: sessions(['am', 'Zero Day']),
      }), person('fixture-2', {
        [start]: sessions(['am', 'Available']),
        [addDays(start, 1)]: sessions(['am', 'Not Available']),
      })],
    };
    const plan = planImport(ws, [week], []);
    applyImport(ws, plan);

    const snapshot = ws.swapFinder!.snapshot;
    const first = ws.profile.staff.find(s => s.mediRotaId === 'fixture-1')!.id;
    const second = ws.profile.staff.find(s => s.mediRotaId === 'fixture-2')!.id;
    expect(snapshot.days[first][start]).toEqual({ status: 'longDay', activity: 'Ward Long', sessions: ['am', 'pm', 'eve'] });
    expect(snapshot.days[first][addDays(start, 1)]).toMatchObject({ status: 'dayJob', activity: 'Clinic', sessions: ['am'] });
    expect(snapshot.days[first][addDays(start, 2)]).toEqual({ status: 'night', activity: 'Night Rota', sessions: ['night'], extra: true });
    expect(snapshot.days[first][addDays(start, 3)]).toMatchObject({ status: 'dayJob', activity: 'Routine Clinic', extra: true });
    expect(snapshot.extrasTagged).toBe(true);
    expect(snapshot.days[first][addDays(start, 4)]).toMatchObject({ status: 'leave', activity: 'Annual Leave' });
    expect(snapshot.days[first][addDays(start, 5)]).toMatchObject({ status: 'training', activity: 'Teaching' });
    expect(snapshot.days[first][addDays(start, 6)]).toMatchObject({ status: 'zero', activity: 'Zero Day' });
    expect(snapshot.days[second][start]).toMatchObject({ status: 'available', activity: 'Available' });
    expect(snapshot.days[second][addDays(start, 1)]).toMatchObject({ status: 'notAvailable', activity: 'Not Available' });
    expect(snapshot.days[second][addDays(start, 2)]).toEqual({ status: 'blank' });
    expect(snapshot.importedAt[start]).toMatch(/^\d{4}-\d\d-\d\dT/);
    // With keepDayJobs false, the snapshot still has day jobs while the planner does not book them.
    expect(ws.fixed.some(f => f.date === addDays(start, 1))).toBe(false);
    expect(ws.swapFinder!.settings).toMatchObject({
      weekendDayActivities: [], hoursTolerance: 1, maxChain: 4, returnPattern: 'consecutive',
      minDoctors: [0, 0, 0, 0, 0, 0, 0], minDoctorsBankHoliday: 0,
      bankHolidays: ['2026-08-31', '2026-12-25', '2026-12-28', '2027-01-01'],
    });
  });

  it('marks incomplete long-day activities as part shifts', () => {
    const ws = emptyWorkspace();
    const start = '2026-11-02';
    const week: PersonWeek = { start, people: [person('fixture-part', { [start]: sessions(['am', 'Long Activity'], ['eve', 'Long Activity']) })] };
    applyImport(ws, planImport(ws, [week], []));
    const staffId = ws.profile.staff[0].id;
    expect(ws.swapFinder!.snapshot.days[staffId][start]).toMatchObject({ status: 'partShift', activity: 'Long Activity', sessions: ['am', 'eve'] });
  });

  it('keeps sessions from other activities on a part-shift day', () => {
    const ws = emptyWorkspace();
    const start = '2026-11-02';
    const week: PersonWeek = { start, people: [person('fixture-mixed-part', { [start]: sessions(['am', 'Postnatal Wards'], ['pm', 'Postnatal Wards'], ['eve', 'Delivery Suite']) })] };
    applyImport(ws, planImport(ws, [week], []));
    const staffId = ws.profile.staff[0].id;
    expect(ws.swapFinder!.snapshot.days[staffId][start]).toMatchObject({ status: 'partShift', activity: 'Delivery Suite', sessions: ['am', 'pm', 'eve'] });
  });

  it('replaces only re-imported weeks and leaves earlier weeks in the snapshot', () => {
    const ws = emptyWorkspace();
    const firstStart = '2026-11-02';
    const first: PersonWeek = { start: firstStart, people: [person('fixture-reimport', { [firstStart]: sessions(['am', 'First Clinic']) })] };
    applyImport(ws, planImport(ws, [first], []));
    const staffId = ws.profile.staff[0].id;
    const oldTimestamp = ws.swapFinder!.snapshot.importedAt[firstStart];
    const secondStart = '2026-11-09';
    const second: PersonWeek = { start: secondStart, people: [person('fixture-reimport', { [secondStart]: sessions(['am', 'Second Clinic']) })] };
    applyImport(ws, planImport(ws, [second], []));
    expect(ws.swapFinder!.snapshot.days[staffId][firstStart]).toMatchObject({ status: 'dayJob', activity: 'First Clinic' });
    expect(ws.swapFinder!.snapshot.days[staffId][secondStart]).toMatchObject({ status: 'dayJob', activity: 'Second Clinic' });
    expect(ws.swapFinder!.snapshot.importedAt[firstStart]).toBe(oldTimestamp);
    const replacement: PersonWeek = { start: firstStart, people: [person('fixture-reimport', { [firstStart]: sessions(['am', 'Replacement Clinic']) })] };
    applyImport(ws, planImport(ws, [replacement], []));
    expect(ws.swapFinder!.snapshot.days[staffId][firstStart]).toMatchObject({ status: 'dayJob', activity: 'Replacement Clinic' });
    expect(ws.swapFinder!.snapshot.days[staffId][secondStart]).toMatchObject({ status: 'dayJob', activity: 'Second Clinic' });
    expect(Object.keys(ws.swapFinder!.snapshot.importedAt).sort()).toEqual([firstStart, secondStart]);
  });

  it('marks ignored non-Available activities as not available', () => {
    const ws = emptyWorkspace();
    const start = '2026-11-02';
    const week: PersonWeek = { start, people: [person('fixture-ignored', { [start]: sessions(['am', 'Administrative Duty']) })] };
    const plan = planImport(ws, [week], []);
    const activity = plan.activities.find(item => item.name === 'Administrative Duty')!;
    applyImport(ws, { ...plan, activities: plan.activities.map(item => item === activity ? { ...item, treat: 'ignore' } : item) });
    const staffId = ws.profile.staff[0].id;
    expect(ws.swapFinder!.snapshot.days[staffId][start]).toMatchObject({ status: 'notAvailable', activity: 'Administrative Duty', sessions: ['am'] });
  });
});

describe('swap finder fixed-pattern detection', () => {
  const makeSnapshot = (count: number, day: (staffId: string, week: number, weekday: number) => string): RotaSnapshot => {
    const snapshot: RotaSnapshot = { days: {}, importedAt: {} };
    const start = '2026-01-05';
    for (let week = 0; week < count; week++) {
      const weekStart = addDays(start, week * 7);
      snapshot.importedAt[weekStart] = '2026-11-04T12:00:00.000Z';
      for (const staffId of ['fixture-regular', 'fixture-one-day', 'fixture-below']) {
        snapshot.days[staffId] ??= {};
        for (let weekday = 0; weekday < 7; weekday++) {
          snapshot.days[staffId][addDays(weekStart, weekday)] = { status: day(staffId, week, weekday) as RotaSnapshot['days'][string][string]['status'] };
        }
      }
    }
    return snapshot;
  };

  it('flags repeat zero days and one-weekday patterns at 90%, but not just below it', () => {
    const snapshot = makeSnapshot(8, (staffId, week, weekday) => {
      if (staffId === 'fixture-regular') return weekday === 2 && week < 8 ? 'zero' : weekday === 2 ? 'dayJob' : weekday === 0 ? 'dayJob' : 'blank';
      if (staffId === 'fixture-one-day') return weekday === 1 ? 'dayJob' : 'blank';
      if (staffId === 'fixture-below') return weekday === 3 && week < 7 ? 'zero' : weekday === 0 ? 'dayJob' : 'blank';
      return 'blank';
    });
    const flags = detectPatterns(snapshot);
    expect(flags).toContainEqual({ staffId: 'fixture-regular', kind: 'regularDaysOff', weekdays: [2], weeksInPost: 8 });
    expect(flags).toContainEqual({ staffId: 'fixture-one-day', kind: 'oneWeekday', weekdays: [1], weeksInPost: 8 });
    expect(flags.some(flag => flag.staffId === 'fixture-below')).toBe(false);
  });

  it('does not flag patterns with fewer than eight weeks in post', () => {
    const snapshot = makeSnapshot(7, (_staffId, _week, weekday) => weekday === 0 ? 'dayJob' : 'blank');
    expect(detectPatterns(snapshot)).toEqual([]);
  });

  it('never flags Saturday or Sunday Zero Days as regular days off', () => {
    const snapshot = makeSnapshot(8, (_staffId, _week, weekday) => weekday === 5 || weekday === 6 ? 'zero' : weekday === 0 ? 'dayJob' : 'blank');
    expect(detectPatterns(snapshot).filter(flag => flag.kind === 'regularDaysOff')).toEqual([]);
  });
});
