import { describe, expect, it, vi } from 'vitest';
import { addDays } from '../src/engine/calendar';
import { detectPatterns, type RotaSnapshot } from '../src/engine/swaps';
import { applyImport, planImport } from '../src/app/mediImport';
import { emptyWorkspace, getWorkspace, replaceWorkspace } from '../src/app/store';
import type { PersonRow, PersonWeek, Session } from '../src/app/medirota';

const person = (id: string, days: PersonRow['days'], label = `Fixture ${id}`): PersonRow => ({ id, rowName: label, label, role: 'Doctor', days });
const sessions = (...items: [Session, string][]): PersonRow['days'][string] => Object.fromEntries(items.map(([session, activity]) => [session, [activity]]));

describe('swap finder snapshot (Stage 1 acceptance)', () => {
  it('maps every DayStatus from activity treat and session shape', () => {
    const ws = emptyWorkspace();
    const start = '2026-11-02';
    const week: PersonWeek = {
      start,
      people: [person('status-grid', {
        [start]: sessions(['am', 'Ward Long'], ['pm', 'Ward Long'], ['eve', 'Ward Long']),
        [addDays(start, 1)]: sessions(['am', 'Clinic Day']),
        [addDays(start, 2)]: sessions(['night', 'Night List']),
        [addDays(start, 3)]: sessions(['am', 'Ward Long'], ['eve', 'Ward Long']),
        [addDays(start, 4)]: sessions(['am', 'Annual Leave']),
        [addDays(start, 5)]: sessions(['am', 'Study Day']),
        [addDays(start, 6)]: sessions(['am', 'Zero Day']),
      }), person('status-away', {
        [start]: sessions(['am', 'Available']),
        [addDays(start, 1)]: sessions(['am', 'Not Available']),
      })],
    };
    applyImport(ws, planImport(ws, [week], []));
    const id = ws.profile.staff.find(s => s.mediRotaId === 'status-grid')!.id;
    const awayId = ws.profile.staff.find(s => s.mediRotaId === 'status-away')!.id;
    const d = ws.swapFinder!.snapshot.days[id];
    expect(d[start]).toEqual({ status: 'longDay', activity: 'Ward Long', sessions: ['am', 'pm', 'eve'] });
    expect(d[addDays(start, 1)]).toMatchObject({ status: 'dayJob', activity: 'Clinic Day' });
    expect(d[addDays(start, 2)]).toMatchObject({ status: 'night', activity: 'Night List' });
    expect(d[addDays(start, 3)]).toMatchObject({ status: 'partShift', activity: 'Ward Long', sessions: ['am', 'eve'] });
    expect(d[addDays(start, 4)]).toMatchObject({ status: 'leave' });
    expect(d[addDays(start, 5)]).toMatchObject({ status: 'training' });
    expect(d[addDays(start, 6)]).toMatchObject({ status: 'zero' });
    expect(ws.swapFinder!.snapshot.days[awayId][start]).toMatchObject({ status: 'available' });
    expect(ws.swapFinder!.snapshot.days[awayId][addDays(start, 1)]).toMatchObject({ status: 'notAvailable' });
    expect(ws.swapFinder!.snapshot.days[awayId][addDays(start, 2)]).toEqual({ status: 'blank' });
  });

  it('uses mixed-day priority: night, then long day, then day job, then away statuses', () => {
    const ws = emptyWorkspace();
    const start = '2026-11-02';
    const week: PersonWeek = {
      start,
      people: [
        person('mix-night', { [start]: sessions(['night', 'Night Rota'], ['am', 'Zero Day CT'], ['am', 'Clinic Day']) }),
        person('mix-long', { [start]: sessions(['am', 'Delivery Suite'], ['pm', 'Delivery Suite'], ['eve', 'Delivery Suite'], ['night', 'Zero Day CT']) }),
        person('mix-job', { [start]: sessions(['am', 'Elective C-Sections'], ['pm', 'PROMPT Training']) }),
      ],
    };
    applyImport(ws, planImport(ws, [week], []));
    const nightId = ws.profile.staff.find(s => s.mediRotaId === 'mix-night')!.id;
    const longId = ws.profile.staff.find(s => s.mediRotaId === 'mix-long')!.id;
    const jobId = ws.profile.staff.find(s => s.mediRotaId === 'mix-job')!.id;
    expect(ws.swapFinder!.snapshot.days[nightId][start].status).toBe('night');
    expect(ws.swapFinder!.snapshot.days[longId][start].status).toBe('longDay');
    expect(ws.swapFinder!.snapshot.days[jobId][start].status).toBe('dayJob'); // day job before training in away order
  });

  it('strips [Extra] for activity names but keeps the underlying treat', () => {
    const ws = emptyWorkspace();
    const start = '2026-11-02';
    applyImport(ws, planImport(ws, [{ start, people: [person('extra', { [start]: sessions(['am', 'MAU CT [Extra]']) })] }], []));
    const id = ws.profile.staff[0].id;
    expect(ws.swapFinder!.snapshot.days[id][start]).toMatchObject({ status: 'dayJob', activity: 'MAU CT' });
  });

  it('records partShift sessions from every working activity that day', () => {
    const ws = emptyWorkspace();
    const start = '2026-11-02';
    applyImport(ws, planImport(ws, [{
      start,
      people: [person('part-mix', { [start]: sessions(['am', 'Postnatal Wards'], ['pm', 'Postnatal Wards'], ['eve', 'Delivery Suite']) })],
    }], []));
    const id = ws.profile.staff[0].id;
    expect(ws.swapFinder!.snapshot.days[id][start]).toEqual({
      status: 'partShift',
      activity: 'Delivery Suite',
      sessions: ['am', 'pm', 'eve'],
    });
  });

  it('stores day jobs in the snapshot when keepDayJobs is false (planner still skips booking them)', () => {
    const ws = emptyWorkspace();
    const start = '2026-11-02';
    const plan = planImport(ws, [{ start, people: [person('dj', { [addDays(start, 1)]: sessions(['am', 'Elective C-Sections']) })] }], []);
    expect(plan.keepDayJobs).toBe(false);
    applyImport(ws, plan);
    const id = ws.profile.staff[0].id;
    expect(ws.swapFinder!.snapshot.days[id][addDays(start, 1)]).toMatchObject({ status: 'dayJob' });
    expect(ws.fixed.some(f => f.date === addDays(start, 1))).toBe(false);
  });

  it('marks ignored activities as notAvailable, never blank, except Available alone', () => {
    const ws = emptyWorkspace();
    const start = '2026-11-02';
    const week: PersonWeek = { start, people: [person('ignored', { [start]: sessions(['am', 'Admin Block']) })] };
    const plan = planImport(ws, [week], []);
    const admin = plan.activities.find(a => a.name === 'Admin Block')!;
    applyImport(ws, { ...plan, activities: plan.activities.map(a => a === admin ? { ...a, treat: 'ignore' } : a) });
    const id = ws.profile.staff[0].id;
    expect(ws.swapFinder!.snapshot.days[id][start]).toMatchObject({ status: 'notAvailable', activity: 'Admin Block' });
  });

  it('maps treat unavailable to notAvailable status', () => {
    const ws = emptyWorkspace();
    const start = '2026-11-02';
    const plan = planImport(ws, [{ start, people: [person('unav', { [start]: sessions(['am', 'Not Available']) })] }], []);
    applyImport(ws, plan);
    const id = ws.profile.staff[0].id;
    expect(ws.swapFinder!.snapshot.days[id][start]).toMatchObject({ status: 'notAvailable', activity: 'Not Available' });
  });

  it('re-import replaces one week, keeps others, and refreshes importedAt for the replaced week only', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-01T09:00:00.000Z'));
    const ws = emptyWorkspace();
    const w1 = '2026-11-02';
    const w2 = '2026-11-09';
    applyImport(ws, planImport(ws, [{ start: w1, people: [person('re', { [w1]: sessions(['am', 'First Clinic']) })] }], []));
    const id = ws.profile.staff[0].id;
    const t1 = ws.swapFinder!.snapshot.importedAt[w1];
    vi.setSystemTime(new Date('2026-06-02T09:00:00.000Z'));
    applyImport(ws, planImport(ws, [{ start: w2, people: [person('re', { [w2]: sessions(['am', 'Second Clinic']) })] }], []));
    expect(ws.swapFinder!.snapshot.days[id][w1]).toMatchObject({ activity: 'First Clinic' });
    expect(ws.swapFinder!.snapshot.days[id][w2]).toMatchObject({ activity: 'Second Clinic' });
    expect(ws.swapFinder!.snapshot.importedAt[w1]).toBe(t1);
    vi.setSystemTime(new Date('2026-06-03T09:00:00.000Z'));
    applyImport(ws, planImport(ws, [{ start: w1, people: [person('re', { [w1]: sessions(['am', 'Replacement Clinic']) })] }], []));
    expect(ws.swapFinder!.snapshot.days[id][w1]).toMatchObject({ activity: 'Replacement Clinic' });
    expect(ws.swapFinder!.snapshot.days[id][w2]).toMatchObject({ activity: 'Second Clinic' });
    expect(ws.swapFinder!.snapshot.importedAt[w1]).not.toBe(t1);
    vi.useRealTimers();
  });

  it('fills blank for every date in an imported week for staff not listed that week', () => {
    const ws = emptyWorkspace();
    const start = '2026-11-02';
    applyImport(ws, planImport(ws, [{ start, people: [person('listed', { [start]: sessions(['am', 'Clinic']) })] }], []));
    applyImport(ws, planImport(ws, [{ start, people: [person('other', { [addDays(start, 1)]: sessions(['am', 'Clinic']) })] }], []));
    const listed = ws.profile.staff.find(s => s.mediRotaId === 'listed')!.id;
    expect(ws.swapFinder!.snapshot.days[listed][addDays(start, 1)]).toEqual({ status: 'blank' });
  });

  it('seeds default SwapSettings on first import and preserves settings across later imports', () => {
    const ws = emptyWorkspace();
    const start = '2026-11-02';
    applyImport(ws, planImport(ws, [{ start, people: [person('a', { [start]: sessions(['am', 'Clinic']) })] }], []));
    ws.swapFinder!.settings.hoursTolerance = 2;
    ws.swapFinder!.settings.weekendDayActivities = ['Postnatal Wards'];
    applyImport(ws, planImport(ws, [{ start: addDays(start, 7), people: [person('a', { [addDays(start, 7)]: sessions(['am', 'Clinic']) })] }], []));
    expect(ws.swapFinder!.settings.hoursTolerance).toBe(2);
    expect(ws.swapFinder!.settings.weekendDayActivities).toEqual(['Postnatal Wards']);
    expect(ws.swapFinder!.settings.bankHolidays).toEqual(['2026-08-31', '2026-12-25', '2026-12-28', '2027-01-01']);
  });

  it('does not bump workspace version or require swapFinder on load', () => {
    const legacy = {
      version: 1 as const,
      profile: emptyWorkspace().profile,
      staffExtras: {},
      period: { start: '2026-11-02', end: '2026-11-08' },
      unavailability: [],
      fixed: [],
    };
    expect(() => replaceWorkspace(legacy)).not.toThrow();
    const ws = getWorkspace();
    expect(ws.version).toBe(1);
    expect(ws.swapFinder).toBeUndefined();
  });
});

describe('detectPatterns (Stage 1, read-only flags)', () => {
  const makeSnapshot = (count: number, day: (staffId: string, week: number, weekday: number) => string): RotaSnapshot => {
    const snapshot: RotaSnapshot = { days: {}, importedAt: {} };
    const start = '2026-01-05';
    for (let week = 0; week < count; week++) {
      const weekStart = addDays(start, week * 7);
      snapshot.importedAt[weekStart] = '2026-11-04T12:00:00.000Z';
      for (const staffId of ['reg', 'one-day', 'below', 'exact']) {
        snapshot.days[staffId] ??= {};
        for (let weekday = 0; weekday < 7; weekday++) {
          snapshot.days[staffId][addDays(weekStart, weekday)] = { status: day(staffId, week, weekday) as RotaSnapshot['days'][string][string]['status'] };
        }
      }
    }
    return snapshot;
  };

  it('flags regular days off Mon–Fri only at ≥90% with ≥8 weeks in post', () => {
    const snapshot = makeSnapshot(8, (staffId, week, weekday) => {
      if (staffId === 'reg') return weekday === 2 && week < 8 ? 'zero' : weekday === 2 ? 'dayJob' : weekday === 0 ? 'dayJob' : 'blank';
      if (staffId === 'one-day') return weekday === 1 ? 'dayJob' : 'blank';
      if (staffId === 'below') return weekday === 3 && week < 7 ? 'zero' : weekday === 0 ? 'dayJob' : 'blank';
      if (staffId === 'exact') return weekday === 4 && week < 8 ? 'zero' : weekday === 0 ? 'dayJob' : 'blank';
      return 'blank';
    });
    const flags = detectPatterns(snapshot);
    expect(flags).toContainEqual({ staffId: 'reg', kind: 'regularDaysOff', weekdays: [2], weeksInPost: 8 });
    expect(flags).toContainEqual({ staffId: 'exact', kind: 'regularDaysOff', weekdays: [4], weeksInPost: 8 });
    expect(flags.filter(f => f.staffId === 'below' && f.kind === 'regularDaysOff')).toEqual([]);
    expect(flags.filter(f => f.kind === 'regularDaysOff' && (f.weekdays.includes(5) || f.weekdays.includes(6)))).toEqual([]);
  });

  it('never treats Saturday or Sunday Zero Days as regular days off', () => {
    const snapshot = makeSnapshot(8, (_staffId, _week, weekday) => {
      if (weekday === 5 || weekday === 6) return 'zero';
      return weekday === 0 ? 'dayJob' : 'blank';
    });
    expect(detectPatterns(snapshot).filter(f => f.kind === 'regularDaysOff')).toEqual([]);
  });

  it('flags one-weekday doctors at ≥90% and ignores just below threshold', () => {
    const snapshot = makeSnapshot(10, (staffId, week, weekday) => {
      if (staffId === 'one-day') return weekday === 1 ? 'dayJob' : 'blank';
      if (staffId === 'below') return weekday === 2 && week < 9 ? 'dayJob' : weekday === 0 ? 'dayJob' : 'blank';
      return weekday === 0 ? 'dayJob' : 'blank';
    });
    const flags = detectPatterns(snapshot);
    expect(flags).toContainEqual({ staffId: 'one-day', kind: 'oneWeekday', weekdays: [1], weeksInPost: 10 });
    expect(flags.some(f => f.staffId === 'below' && f.kind === 'oneWeekday')).toBe(false);
  });

  it('requires eight weeks in post before any pattern flag', () => {
    const snapshot = makeSnapshot(7, (_staffId, _week, weekday) => weekday === 0 ? 'dayJob' : 'blank');
    expect(detectPatterns(snapshot)).toEqual([]);
  });

  it('counts weeks in post only when the doctor has a non-blank day that week', () => {
    const snapshot: RotaSnapshot = { days: { sparse: {} }, importedAt: {} };
    const start = '2026-01-05';
    for (let week = 0; week < 10; week++) {
      const weekStart = addDays(start, week * 7);
      snapshot.importedAt[weekStart] = '2026-11-04T12:00:00.000Z';
      for (let weekday = 0; weekday < 7; weekday++) {
        const date = addDays(weekStart, weekday);
        if (week < 8 && weekday === 0) snapshot.days.sparse[date] = { status: 'dayJob' };
        else if (week === 8 && weekday === 2) snapshot.days.sparse[date] = { status: 'zero' };
        else snapshot.days.sparse[date] = { status: 'blank' };
      }
    }
    expect(detectPatterns(snapshot)).toEqual([]);
  });

  it('does not mutate snapshot or apply flags to settings', () => {
    const snapshot = makeSnapshot(8, (staffId, _week, weekday) => {
      if (staffId === 'reg') return weekday === 2 ? 'zero' : weekday === 0 ? 'dayJob' : 'blank';
      return weekday === 0 ? 'dayJob' : 'blank';
    });
    const clone = structuredClone(snapshot);
    const flags = detectPatterns(snapshot);
    expect(snapshot).toEqual(clone);
    expect(flags.length).toBeGreaterThan(0);
    const ws = emptyWorkspace();
    ws.swapFinder = { settings: { weekendDayActivities: [], hoursTolerance: 1, maxChain: 4, minDoctors: [7, 7, 7, 7, 7, 3, 3], minDoctorsBankHoliday: 4, bankHolidays: [], regularDaysOff: {}, excluded: [] }, snapshot };
    detectPatterns(ws.swapFinder.snapshot);
    expect(ws.swapFinder.settings.regularDaysOff).toEqual({});
  });
});
