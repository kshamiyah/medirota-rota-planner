import { describe, expect, it } from 'vitest';
import { addDays, weekday } from '../src/engine/calendar';
import { findSwaps, minimumWarningsForSwap, type RotaSnapshot, type SnapshotDay, type SwapRequest, type SwapSettings } from '../src/engine/swaps';
import type { Profile, Rule } from '../src/engine/types';
import { limitDefs } from '../src/app/rules/grid';
import { planMatchesFilter } from '../src/app/swapsView';

const TODAY = '2026-10-01';
const MONDAY = '2026-11-02';
const DAY_SESSIONS = ['am', 'pm', 'eve'] as const;

function settings(patch: Partial<SwapSettings> = {}): SwapSettings {
  return {
    weekendDayActivities: [], hoursTolerance: 1, maxChain: 4,
    minDoctors: [7, 7, 7, 7, 7, 3, 3], minDoctorsBankHoliday: 4,
    bankHolidays: [], regularDaysOff: {}, excluded: [], ...patch,
  };
}

function profile(staffIds: string[], activities: string[], rules: Rule[] = []): Profile {
  return {
    name: 'Fixture rota',
    shiftTypes: [
      { id: 'night', name: 'Night', start: '20:00', end: '08:30' },
      { id: 'long', name: 'Long day', start: '08:00', end: '20:30' },
      { id: 'day', name: 'Day job', start: '08:00', end: '17:30' },
    ],
    roles: activities.map(activity => ({ id: `role-${activity}`, name: activity })),
    groups: [{ id: 'qualified', name: 'Qualified' }],
    staff: staffIds.map((id, index) => ({ id, name: `Fixture ${index + 1}`, groupIds: index === 0 ? ['qualified'] : [], fte: 1 })),
    demands: [], rules, fairness: [],
  };
}

function blankSnapshot(staffIds: string[], days = 56): RotaSnapshot {
  const snapshot: RotaSnapshot = { days: {}, importedAt: {} };
  for (let offset = 0; offset < days; offset += 7) {
    const start = addDays(MONDAY, offset);
    snapshot.importedAt[start] = '2026-11-04T12:00:00.000Z';
    for (const staffId of staffIds) {
      snapshot.days[staffId] ??= {};
      for (let day = 0; day < 7; day++) snapshot.days[staffId][addDays(start, day)] = { status: 'blank' };
    }
  }
  return snapshot;
}

function setDay(snapshot: RotaSnapshot, staffId: string, date: string, status: SnapshotDay['status'], activity = '', sessions?: SnapshotDay['sessions']) {
  snapshot.days[staffId] ??= {};
  snapshot.days[staffId][date] = { status, ...(activity ? { activity } : {}), ...(sessions ? { sessions } : {}) };
}

function work(snapshot: RotaSnapshot, staffId: string, date: string, status: SnapshotDay['status'], activity: string) {
  const sessions: NonNullable<SnapshotDay['sessions']> = status === 'night' ? ['night'] : status === 'longDay' ? [...DAY_SESSIONS] : ['am'];
  setDay(snapshot, staffId, date, status, activity, sessions);
}

function off(snapshot: RotaSnapshot, staffId: string, date: string) {
  setDay(snapshot, staffId, date, 'zero', 'Zero Day', ['am']);
}

function request(staffId = 'a', leaveDates = [MONDAY], patch: Partial<SwapRequest> = {}): SwapRequest {
  return { staffId, leaveDates, leaveType: 'annual', today: TODAY, ...patch };
}

function longSwapFixture() {
  const p = profile(['a', 'b'], ['Long'], []);
  const s = blankSnapshot(['a', 'b']);
  work(s, 'a', MONDAY, 'longDay', 'Long');
  off(s, 'b', MONDAY);
  const returnDate = '2026-11-10';
  work(s, 'b', returnDate, 'longDay', 'Long');
  off(s, 'a', returnDate);
  return { p, s, returnDate };
}

describe('findSwaps', () => {
  it('does not blame a swap for an existing doctor shortage it restores', () => {
    const { p, s, returnDate } = longSwapFixture();
    const cfg = settings({ minDoctors: [2, 2, 2, 2, 2, 2, 2] });
    const result = findSwaps(p, s, cfg, request());
    expect(result.clashes).toHaveLength(1);
    expect(result.plans.length).toBeGreaterThan(0);
    expect(result.plans[0].people).toBe(1);
    expect(result.plans[0].cleared).toHaveLength(1);
    expect(result.plans[0].warnings.map(warning => warning.date)).not.toContain(MONDAY);
    expect(result.existingShortages).toContainEqual({ date: MONDAY, doctors: 1, minimum: 2 });
    expect(result.existingShortages).toHaveLength(1);
    expect(planMatchesFilter(result.plans[0], 'noAlerts')).toBe(true);
    expect(result.leaveWarnings).toContainEqual({ date: MONDAY, doctors: 0, minimum: 2 });
    expect(result.noRulesWarning).toBe(true);
    expect(result.plans[0].chains[0].links.map(link => link.staffId)).toEqual(['a', 'b']);
    expect(result.plans[0].chains[0].links[1].gives.dates).toEqual([returnDate]);
  });

  it('keeps a minimum warning when a swap makes an already-short date worse', () => {
    const cfg = settings({ minDoctors: [7, 7, 7, 7, 7, 7, 7] });
    const before = new Map([[MONDAY, new Set(['a', 'b', 'c', 'd', 'e', 'f'])]]);
    const after = new Map([[MONDAY, new Set(['a', 'b', 'c', 'd', 'e'])]]);
    expect(minimumWarningsForSwap(before, after, [MONDAY], cfg)).toEqual([{ date: MONDAY, doctors: 5, minimum: 7 }]);
  });

  it('adds a missing shift type to the validation copy only', () => {
    const { p, s } = longSwapFixture();
    p.shiftTypes = [];
    const result = findSwaps(p, s, settings(), request());
    expect(result.plans.length).toBeGreaterThan(0);
    expect(p.shiftTypes).toEqual([]);
  });

  it('ranks a direct cycle ahead of a longer cycle for the same clash', () => {
    const p = profile(['a', 'b', 'c'], ['Long']);
    const s = blankSnapshot(['a', 'b', 'c']);
    work(s, 'a', MONDAY, 'longDay', 'Long'); off(s, 'b', MONDAY); off(s, 'c', MONDAY);
    work(s, 'b', '2026-11-10', 'longDay', 'Long'); off(s, 'a', '2026-11-10');
    work(s, 'c', '2026-11-11', 'longDay', 'Long'); off(s, 'a', '2026-11-11'); off(s, 'c', '2026-11-10');
    const result = findSwaps(p, s, settings(), request());
    const directOnly = findSwaps(p, s, settings({ maxChain: 2 }), request());
    const directKeys = (plans: ReturnType<typeof findSwaps>['plans']) => plans.flatMap(plan => plan.chains)
      .filter(chain => chain.links.length === 2)
      .map(chain => chain.links.map(link => `${link.staffId}:${link.gives.dates.join(',')}`).join('>'))
      .sort();
    expect(directKeys(result.plans)).toEqual(directKeys(directOnly.plans));
    expect(result.plans[0].people).toBe(1);
    expect(result.plans[0].chains[0].links).toHaveLength(2);
    expect(result.plans.some(plan => plan.chains[0].links.length === 3)).toBe(true);
  });

  it('ranks a full-cover plan above a partial plan', () => {
    const ids = ['a', 'b', 'c'];
    const p = profile(ids, ['Fixture Weekend']);
    const s = blankSnapshot(ids);
    const sat = '2026-11-07', sun = '2026-11-08';
    work(s, 'a', sat, 'dayJob', 'Fixture Weekend'); work(s, 'a', sun, 'dayJob', 'Fixture Weekend');
    off(s, 'b', sat); off(s, 'b', sun); off(s, 'c', sat); off(s, 'c', sun);
    work(s, 'b', '2026-11-14', 'dayJob', 'Fixture Weekend'); off(s, 'a', '2026-11-14'); off(s, 'c', '2026-11-14');
    work(s, 'c', '2026-11-15', 'dayJob', 'Fixture Weekend'); off(s, 'a', '2026-11-15'); off(s, 'b', '2026-11-15');
    const result = findSwaps(p, s, settings({ weekendDayActivities: ['Fixture Weekend'] }), request('a', [sat, sun]));
    const full = result.plans.findIndex(plan => plan.cleared.length === 2);
    const partial = result.plans.findIndex(plan => plan.cleared.length === 1);
    expect(full).toBeGreaterThanOrEqual(0);
    expect(partial).toBeGreaterThanOrEqual(0);
    expect(full).toBeLessThan(partial);
  });

  it('keeps separate options when the same doctor covers different dates', () => {
    const p = profile(['a', 'b'], ['Long']);
    const s = blankSnapshot(['a', 'b']);
    const saturday = '2026-11-07', sunday = '2026-11-08', returnDate = '2026-11-10';
    work(s, 'a', saturday, 'longDay', 'Long');
    work(s, 'a', sunday, 'longDay', 'Long');
    off(s, 'b', saturday); off(s, 'b', sunday);
    work(s, 'b', returnDate, 'longDay', 'Long'); off(s, 'a', returnDate);
    const result = findSwaps(p, s, settings({ maxChain: 2 }), request('a', [saturday, sunday]));
    expect(result.plans).toHaveLength(2);
    expect(result.truncated).toBe(false);
    expect(result.limits).toBeUndefined();
    expect(result.ruledOut.find(row => row.staffId === 'b')).toBeUndefined();
  });

  it('finds three and four person cycles', () => {
    for (const count of [3, 4]) {
      const ids = ['a', 'b', 'c', 'd'].slice(0, count);
      const p = profile(ids, ['Long']);
      const s = blankSnapshot(ids);
      work(s, 'a', MONDAY, 'longDay', 'Long');
      const returnDates = ['2026-11-10', '2026-11-18', '2026-11-26'];
      for (let i = 1; i < count; i++) {
        off(s, ids[i], MONDAY);
        work(s, ids[i], returnDates[i - 1], 'longDay', 'Long');
        off(s, i === count - 1 ? 'a' : ids[i + 1], returnDates[i - 1]);
      }
      const result = findSwaps(p, s, settings(), request());
      expect(result.plans.some(plan => plan.chains.some(chain => chain.links.length === count))).toBe(true);
    }
  });

  it('moves whole night blocks only and rejects a different block length', () => {
    const ids = ['a', 'b', 'c'];
    const p = profile(ids, ['Night']);
    const s = blankSnapshot(ids);
    for (let i = 0; i < 3; i++) {
      const date = addDays(MONDAY, i);
      work(s, 'a', date, 'night', 'Night');
      off(s, 'b', date);
      off(s, 'c', date);
    }
    for (let i = 0; i < 3; i++) {
      const date = addDays('2026-11-10', i);
      work(s, 'b', date, 'night', 'Night');
      off(s, 'a', date);
    }
    for (let i = 0; i < 2; i++) work(s, 'c', addDays('2026-11-17', i), 'night', 'Night');
    const result = findSwaps(p, s, settings(), request('a', [MONDAY]));
    expect(result.clashes[0].kind).toBe('nightBlock');
    expect(result.clashes[0].dates).toEqual([MONDAY, addDays(MONDAY, 1), addDays(MONDAY, 2)]);
    expect(result.plans.some(plan => plan.chains.some(chain => chain.links[1].gives.dates.length === 3))).toBe(true);
    expect(result.ruledOut.some(row => row.staffId === 'c')).toBe(true);
  });

  it('can cover a weekend with one doctor or split it between two', () => {
    const sat = '2026-11-07', sun = '2026-11-08';
    const bSat = '2026-11-14', bSun = '2026-11-15';
    const one = profile(['a', 'b'], ['Fixture Weekend']);
    const oneSnapshot = blankSnapshot(['a', 'b']);
    for (const [date, staffId] of [[sat, 'a'], [sun, 'a'], [bSat, 'b'], [bSun, 'b']] as const) work(oneSnapshot, staffId, date, 'dayJob', 'Fixture Weekend');
    off(oneSnapshot, 'b', sat); off(oneSnapshot, 'b', sun); off(oneSnapshot, 'a', bSat); off(oneSnapshot, 'a', bSun);
    const oneResult = findSwaps(one, oneSnapshot, settings({ weekendDayActivities: ['Fixture Weekend'] }), request('a', [sat, sun]));
    expect(oneResult.clashes).toHaveLength(2);
    expect(oneResult.plans.some(plan => plan.cleared.length === 2 && plan.people === 1)).toBe(true);

    const two = profile(['a', 'b', 'c'], ['Fixture Weekend']);
    const twoSnapshot = blankSnapshot(['a', 'b', 'c']);
    work(twoSnapshot, 'a', sat, 'dayJob', 'Fixture Weekend'); work(twoSnapshot, 'a', sun, 'dayJob', 'Fixture Weekend');
    off(twoSnapshot, 'b', sat); work(twoSnapshot, 'b', sun, 'dayJob', 'Fixture Weekend');
    off(twoSnapshot, 'c', sat); off(twoSnapshot, 'c', sun);
    work(twoSnapshot, 'b', bSat, 'dayJob', 'Fixture Weekend'); off(twoSnapshot, 'a', bSat);
    work(twoSnapshot, 'c', bSun, 'dayJob', 'Fixture Weekend'); off(twoSnapshot, 'a', bSun);
    off(twoSnapshot, 'c', bSat); off(twoSnapshot, 'b', bSun);
    const twoResult = findSwaps(two, twoSnapshot, settings({ weekendDayActivities: ['Fixture Weekend'] }), request('a', [sat, sun]));
    expect(twoResult.plans.some(plan => plan.cleared.length === 2 && plan.people === 2)).toBe(true);
  });

  it('keeps normal days under requestAsLeave by default and searches them only when enabled', () => {
    const ids = ['a', 'b'];
    const p = profile(ids, ['Sunday List', 'Clinic']);
    const s = blankSnapshot(ids);
    const sunday = '2026-11-08';
    work(s, 'a', sunday, 'dayJob', 'Sunday List');
    off(s, 'b', sunday);
    work(s, 'b', '2026-11-10', 'dayJob', 'Clinic');
    off(s, 'a', '2026-11-10');
    const defaultResult = findSwaps(p, s, settings(), request('a', [sunday]));
    expect(defaultResult.clashes).toEqual([]);
    expect(defaultResult.requestAsLeave).toEqual([{ date: sunday, activity: 'Sunday List' }]);
    expect(defaultResult.plans).toEqual([]);
    const enabledResult = findSwaps(p, s, settings(), request('a', [sunday], { includeNormalDays: true }));
    expect(enabledResult.clashes).toHaveLength(1);
    expect(enabledResult.plans.length).toBeGreaterThan(0);
    expect(enabledResult.plans[0].chains[0].payDifferent).toBe(true);
  });

  it('sets the pay label for long days across weekdays and weekends', () => {
    const p = profile(['a', 'b', 'c'], ['Long']);
    const s = blankSnapshot(['a', 'b', 'c']);
    const saturday = '2026-11-07';
    work(s, 'a', saturday, 'longDay', 'Long'); off(s, 'b', saturday); off(s, 'c', saturday);
    work(s, 'b', '2026-11-10', 'longDay', 'Long'); off(s, 'a', '2026-11-10');
    work(s, 'c', '2026-11-15', 'longDay', 'Long'); off(s, 'a', '2026-11-15');
    const result = findSwaps(p, s, settings(), request('a', [saturday]));
    expect(result.plans[0].chains[0].payDifferent).toBe(false);
    expect(result.plans.find(plan => plan.chains[0].links[1].staffId === 'b')?.chains[0].payDifferent).toBe(true);
  });

  it('classifies a night block by all its nights and applies its pay label', () => {
    const p = profile(['a', 'b'], ['Night']);
    const s = blankSnapshot(['a', 'b']);
    for (const date of ['2026-11-07', '2026-11-08']) { work(s, 'a', date, 'night', 'Night'); off(s, 'b', date); }
    for (const date of ['2026-11-14', '2026-11-15']) { work(s, 'b', date, 'night', 'Night'); off(s, 'a', date); }
    const result = findSwaps(p, s, settings({ bankHolidays: ['2026-11-07'] }), request('a', ['2026-11-07']));
    expect(result.clashes[0].dayType).toBe('bankHoliday');
    expect(result.plans[0].chains[0].payDifferent).toBe(false); // Bank holiday weekend to weekend has no pay label.

    const weekdaySnapshot = blankSnapshot(['a', 'b']);
    for (const date of ['2026-11-07', '2026-11-08']) { work(weekdaySnapshot, 'a', date, 'night', 'Night'); off(weekdaySnapshot, 'b', date); }
    for (const date of ['2026-11-10', '2026-11-11']) { work(weekdaySnapshot, 'b', date, 'night', 'Night'); off(weekdaySnapshot, 'a', date); }
    const weekdayResult = findSwaps(p, weekdaySnapshot, settings(), request('a', ['2026-11-07']));
    expect(weekdayResult.clashes[0].dayType).toBe('weekend');
    expect(weekdayResult.plans[0].chains[0].payDifferent).toBe(true);
  });

  it('labels and ranks a weekend return ahead of a weekday return', () => {
    const ids = ['a', 'b', 'c'];
    const p = profile(ids, ['Weekend Activity', 'Clinic']);
    const s = blankSnapshot(ids);
    const sat = '2026-11-07';
    work(s, 'a', sat, 'dayJob', 'Weekend Activity');
    off(s, 'b', sat); off(s, 'c', sat);
    const bankHoliday = '2026-11-11';
    work(s, 'b', bankHoliday, 'dayJob', 'Weekend Activity'); off(s, 'a', bankHoliday); off(s, 'c', bankHoliday);
    const weekdayReturn = '2026-11-10';
    work(s, 'c', weekdayReturn, 'dayJob', 'Clinic'); off(s, 'a', weekdayReturn); off(s, 'b', weekdayReturn);
    const result = findSwaps(p, s, settings({ weekendDayActivities: ['Weekend Activity'], bankHolidays: [bankHoliday] }), request('a', [sat], { includeNormalDays: true }));
    expect(result.plans.length).toBeGreaterThanOrEqual(2);
    expect(result.plans[0].chains.every(chain => !chain.payDifferent)).toBe(true);
    expect(result.plans[1].chains.some(chain => chain.payDifferent)).toBe(true);
  });

  it('treats a blank bank holiday as off only when the doctor is in post that week', () => {
    const ids = ['a', 'b', 'c'];
    const p = profile(ids, ['Long']);
    const s = blankSnapshot(ids);
    work(s, 'a', MONDAY, 'longDay', 'Long');
    // B has another entry in the same week, so its blank bank holiday is off.
    work(s, 'b', '2026-11-05', 'training', 'Training');
    work(s, 'b', '2026-11-10', 'longDay', 'Long'); off(s, 'a', '2026-11-10');
    // C has no entry in the week, so its bank holiday blank cannot cover the clash.
    work(s, 'c', '2026-11-17', 'longDay', 'Long'); off(s, 'a', '2026-11-17');
    const result = findSwaps(p, s, settings({ bankHolidays: [MONDAY] }), request());
    expect(result.plans.some(plan => plan.chains.some(chain => chain.links[1].staffId === 'b'))).toBe(true);
    expect(result.plans.some(plan => plan.chains.some(chain => chain.links[1].staffId === 'c'))).toBe(false);
  });

  it('does not give the requester a return shift during leave or cant-work dates', () => {
    const { p, s, returnDate } = longSwapFixture();
    const onLeave = findSwaps(p, s, settings(), request('a', [MONDAY, returnDate]));
    expect(onLeave.plans).toEqual([]);
    expect(onLeave.ruledOut.find(row => row.staffId === 'b')?.reason).toMatch(/leave or can’t-work/i);
    const cantWork = findSwaps(p, s, settings(), request('a', [MONDAY], { cantWorkDates: [returnDate] }));
    expect(cantWork.plans).toEqual([]);
    expect(cantWork.ruledOut.find(row => row.staffId === 'b')?.reason).toMatch(/leave or can’t-work/i);
  });

  it('does not use dates outside the imported weeks or past shifts', () => {
    const p = profile(['a', 'b'], ['Long']);
    const s = blankSnapshot(['a', 'b'], 7);
    work(s, 'a', MONDAY, 'longDay', 'Long'); off(s, 'b', MONDAY);
    work(s, 'b', '2026-11-10', 'longDay', 'Long'); off(s, 'a', '2026-11-10');
    const noImportedReturn = findSwaps(p, s, settings(), request('a', [MONDAY]));
    expect(noImportedReturn.plans).toEqual([]);
    const past = findSwaps(p, s, settings(), request('a', [MONDAY], { today: '2026-11-03' }));
    expect(past.clashes).toEqual([]);
    expect(past.plans).toEqual([]);
  });

  it('does not give the requester a return shift on today', () => {
    const leave = '2026-11-16';
    const returnToday = '2026-11-10';
    const p = profile(['a', 'b'], ['Long']);
    const s = blankSnapshot(['a', 'b']);
    work(s, 'a', leave, 'longDay', 'Long'); off(s, 'b', leave);
    work(s, 'b', returnToday, 'longDay', 'Long'); off(s, 'a', returnToday);
    const onToday = findSwaps(p, s, settings(), request('a', [leave], { today: returnToday }));
    expect(onToday.clashes).toHaveLength(1);
    expect(onToday.plans).toEqual([]);
    expect(onToday.ruledOut.find(row => row.staffId === 'b')?.reason).toMatch(/after today/i);
    const fromTomorrow = findSwaps(p, s, settings(), request('a', [leave], { today: addDays(returnToday, -1) }));
    expect(fromTomorrow.plans).toHaveLength(1);
    expect(fromTomorrow.plans[0].chains[0].links[1].gives.dates).toEqual([returnToday]);
  });

  it('does not reject a swap just because the unswapped rota already has a break', () => {
    const p = profile(['a', 'b', 'c'], ['Long', 'Forbidden']);
    p.rules.push({ id: 'existing-break', name: 'Existing restriction', type: 'forbid', hard: true, who: { staffIds: ['c'] }, work: { roleIds: ['role-Forbidden'] } });
    const s = blankSnapshot(['a', 'b', 'c']);
    work(s, 'a', MONDAY, 'longDay', 'Long'); off(s, 'b', MONDAY);
    work(s, 'b', '2026-11-10', 'longDay', 'Long'); off(s, 'a', '2026-11-10');
    work(s, 'c', MONDAY, 'dayJob', 'Forbidden');
    expect(findSwaps(p, s, settings(), request()).plans.length).toBeGreaterThan(0);
  });

  it('rejects candidates who are on leave, blank, on a regular day off, or excluded', () => {
    const ids = ['a', 'leave', 'blank', 'regular', 'excluded'];
    const p = profile(ids, ['Long']);
    const s = blankSnapshot(ids);
    work(s, 'a', MONDAY, 'longDay', 'Long');
    setDay(s, 'leave', MONDAY, 'leave', 'Annual Leave');
    setDay(s, 'blank', MONDAY, 'blank');
    off(s, 'regular', MONDAY);
    off(s, 'excluded', MONDAY);
    for (const [id, date] of [['leave', '2026-11-10'], ['blank', '2026-11-11'], ['regular', '2026-11-12'], ['excluded', '2026-11-13']] as const) {
      work(s, id, date, 'longDay', 'Long');
      off(s, 'a', date);
    }
    const result = findSwaps(p, s, settings({ regularDaysOff: { regular: [weekday(MONDAY)] }, excluded: [{ staffId: 'excluded' }] }), request());
    expect(result.plans).toEqual([]);
    expect(result.ruledOut.map(row => row.staffId).sort()).toEqual(ids.slice(1).sort());
    expect(result.ruledOut.find(row => row.staffId === 'blank')).toMatchObject({ group: 'notOnRota', reason: 'Not on the rota on these dates' });
    expect(result.ruledOut.find(row => row.staffId === 'regular')?.reason).toMatch(/regular day off/i);
    expect(result.ruledOut.find(row => row.staffId === 'excluded')?.reason).toMatch(/excluded/i);
  });

  it('rejects too-different hours and different night block lengths', () => {
    const p = profile(['a', 'b'], ['Long', 'Longer']);
    p.shiftTypes.push({ id: 'longer', name: 'Longer shift', start: '07:00', end: '21:00' });
    p.demands.push({ id: 'need-longer', roleId: 'role-Longer', shiftTypeId: 'longer', days: {}, min: 0, max: 1 });
    const s = blankSnapshot(['a', 'b']);
    work(s, 'a', MONDAY, 'longDay', 'Long'); off(s, 'b', MONDAY);
    work(s, 'b', '2026-11-10', 'longDay', 'Longer'); off(s, 'a', '2026-11-10');
    const hoursResult = findSwaps(p, s, settings(), request());
    expect(hoursResult.plans).toEqual([]);

    const nightProfile = profile(['a', 'b'], ['Night']);
    const nights = blankSnapshot(['a', 'b']);
    for (let i = 0; i < 3; i++) { work(nights, 'a', addDays(MONDAY, i), 'night', 'Night'); off(nights, 'b', addDays(MONDAY, i)); }
    for (let i = 0; i < 2; i++) { work(nights, 'b', addDays('2026-11-10', i), 'night', 'Night'); off(nights, 'a', addDays('2026-11-10', i)); }
    expect(findSwaps(nightProfile, nights, settings(), request()).plans).toEqual([]);
  });

  it('checks mandatory night rest and full team skill mix against the unswapped rota', () => {
    const ids = ['a', 'b'];
    const p = profile(ids, ['Night', 'Clinic'], [{ id: 'rest', name: 'Rest after nights', type: 'restAfterBlock', hard: true, work: { shiftTypeIds: ['night'] }, hours: 46 }]);
    p.shiftTypes.push({ id: 'day-late', name: 'Late clinic', start: '10:00', end: '18:00' });
    p.demands.push({ id: 'clinic-need', roleId: 'role-Clinic', shiftTypeId: 'day-late', days: { dates: ['2026-11-04'] }, min: 0, max: 1 });
    const s = blankSnapshot(ids);
    for (let i = 0; i < 2; i++) { work(s, 'a', addDays(MONDAY, i), 'night', 'Night'); off(s, 'b', addDays(MONDAY, i)); }
    work(s, 'b', '2026-11-04', 'dayJob', 'Clinic');
    for (let i = 0; i < 2; i++) { work(s, 'b', addDays('2026-11-06', i), 'night', 'Night'); off(s, 'a', addDays('2026-11-06', i)); }
    const restResult = findSwaps(p, s, settings(), request('a', [MONDAY]));
    expect(restResult.noRulesWarning).toBe(false);
    expect(restResult.plans).toHaveLength(0);
    expect(restResult.ruledOut.find(row => row.staffId === 'b')?.reason).toMatch(/mandatory rest-day shift/i);

    const skill = profile(ids, ['Night']);
    skill.demands.push({ id: 'night-demand', roleId: 'role-Night', shiftTypeId: 'night', days: {}, min: 0, max: 1 });
    skill.rules.push({ id: 'skill', name: 'Qualified night cover', type: 'skillMix', hard: true, who: { groupIds: ['qualified'] }, work: { shiftTypeIds: ['night'] }, min: 1 });
    const skillSnapshot = blankSnapshot(ids);
    for (let i = 0; i < 2; i++) { work(skillSnapshot, 'a', addDays(MONDAY, i), 'night', 'Night'); off(skillSnapshot, 'b', addDays(MONDAY, i)); }
    for (let i = 0; i < 2; i++) { work(skillSnapshot, 'b', addDays('2026-11-10', i), 'night', 'Night'); off(skillSnapshot, 'a', addDays('2026-11-10', i)); }
    const skillResult = findSwaps(skill, skillSnapshot, settings(), request('a', [MONDAY]));
    expect(skillResult.plans).toEqual([]);
    expect(skillResult.ruledOut.find(row => row.staffId === 'b')?.reason).toMatch(/Qualified night cover/);
  });

  it('returns no plans for no clashes, and does not mutate inputs', () => {
    const { p, s } = longSwapFixture();
    const before = structuredClone({ p, s });
    const result = findSwaps(p, s, settings(), request());
    expect(result.plans.length).toBeGreaterThan(0);
    expect({ p, s }).toEqual(before);
  });

  it('counts part shifts with a morning session for X, but lists them for hand sorting', () => {
    const p = profile(['a', 'b'], ['Long']);
    const s = blankSnapshot(['a', 'b']);
    setDay(s, 'a', MONDAY, 'partShift', 'Long', ['am', 'eve']);
    const result = findSwaps(p, s, settings({ minDoctors: [1, 1, 1, 1, 1, 1, 1] }), request());
    expect(result.sortByHand).toEqual([{ date: MONDAY, activity: 'Long' }]);
    expect(result.leaveWarnings).toEqual([{ date: MONDAY, doctors: 0, minimum: 1 }]);
    expect(result.clashes).toEqual([]);
  });

  it.skipIf(process.env.RUN_SWAP_BENCHMARKS !== '1')('benchmarks a single clash and a two-day weekend on a 34-week 50-person fixture', () => {
    const ids = Array.from({ length: 50 }, (_, index) => `fixture-${String(index).padStart(2, '0')}`);
    const rotaIds = ids;
    const p = profile(ids, ['Long', 'Night', 'Clinic']);
    const p0 = p.shiftTypes.find(shift => shift.id === 'long')!;
    p0.hours = 12.5;
    const limitValues: Record<string, number[]> = {
      rest: [11], hours7: [72, 7], avg: [48], days: [7], weekends: [1, 2],
      nights: [4], postnights: [46], nightblocks: [2], longdays: [4], postlongdays: [4, 48],
    };
    p.rules = limitDefs(p).map(definition => definition.make(limitValues[definition.id]));

    const s = blankSnapshot(ids, 34 * 7);
    const starts = Object.keys(s.importedAt).sort();
    for (let week = 0; week < starts.length; week++) {
      const start = starts[week];
      for (let day = 0; day < 5; day++) {
        const date = addDays(start, day);
        const base = (week * 7 + day * 11) % rotaIds.length;
        for (let slot = 0; slot < 3; slot++) work(s, rotaIds[(base + slot) % rotaIds.length], date, 'longDay', 'Long');
      }
    }
    expect(rotaIds.every(staffId => Object.values(s.days[staffId]).some(day => day.status === 'longDay'))).toBe(true);
    for (const start of starts) for (let day = 0; day < 5; day++) {
      const date = addDays(start, day);
      expect(rotaIds.filter(staffId => s.days[staffId][date].status === 'longDay')).toHaveLength(3);
    }
    // Every profile member works the rota. Fill about 45% of all cells with Zero Days.
    for (let week = 0; week < starts.length; week++) for (let day = 0; day < 7; day++) {
      const date = addDays(starts[week], day);
      for (let staff = 0; staff < rotaIds.length; staff++) {
        if (s.days[rotaIds[staff]][date].status !== 'blank') continue;
        if (((week * 19 + day * 23 + staff * 7) % 100) < 47) off(s, rotaIds[staff], date);
      }
    }
    // Fifteen doctors can cover both weekend days and each has several long-day
    // return shifts on which the requester is off.
    const weekend = addDays(starts[4], 5), weekendSunday = addDays(weekend, 1);
    const coverIds = rotaIds.slice(1).filter(staffId => Object.entries(s.days[staffId])
      .filter(([date, day]) => day.status === 'longDay' && s.days[rotaIds[0]][date].status !== 'longDay').length >= 3).slice(0, 15);
    expect(coverIds).toHaveLength(15);
    work(s, rotaIds[0], weekend, 'longDay', 'Long');
    work(s, rotaIds[0], weekendSunday, 'longDay', 'Long');
    for (const staffId of coverIds) {
      off(s, staffId, weekend);
      off(s, staffId, weekendSunday);
      for (const [date, day] of Object.entries(s.days[staffId])) {
        if (day.status === 'longDay' && s.days[rotaIds[0]][date].status !== 'longDay') off(s, rotaIds[0], date);
      }
    }
    work(s, rotaIds[0], MONDAY, 'longDay', 'Long');
    const singleCoverIds = coverIds.filter(staffId => s.days[staffId][MONDAY].status !== 'longDay').slice(0, 2);
    for (const staffId of rotaIds.slice(1)) {
      if (s.days[staffId][MONDAY].status !== 'longDay') setDay(s, staffId, MONDAY, 'blank');
    }
    for (const staffId of singleCoverIds) off(s, staffId, MONDAY);

    const bankHoliday = addDays(starts[8], 2);
    work(s, rotaIds[0], bankHoliday, 'longDay', 'Long');
    for (const staffId of coverIds) off(s, staffId, bankHoliday);

    const nightCoverIds = coverIds.slice(0, 10);
    const fridayNight = addDays(starts[12], 4);
    for (let offset = 0; offset < 3; offset++) work(s, rotaIds[0], addDays(fridayNight, offset), 'night', 'Night');
    const fridayReturn = addDays(starts[20], 4);
    for (const staffId of nightCoverIds) for (let offset = 0; offset < 3; offset++) {
      off(s, staffId, addDays(fridayNight, offset));
      work(s, staffId, addDays(fridayReturn, offset), 'night', 'Night');
      off(s, rotaIds[0], addDays(fridayReturn, offset));
    }

    const mondayNight = starts[16];
    for (let offset = 0; offset < 4; offset++) {
      for (const staffId of rotaIds.slice(1)) work(s, staffId, addDays(mondayNight, offset), 'dayJob', 'Clinic');
      work(s, rotaIds[0], addDays(mondayNight, offset), 'night', 'Night');
    }
    const mondayReturn = starts[24];
    for (const staffId of nightCoverIds.slice(0, 1)) for (let offset = 0; offset < 4; offset++) {
      off(s, staffId, addDays(mondayNight, offset));
      work(s, staffId, addDays(mondayReturn, offset), 'night', 'Night');
      off(s, rotaIds[0], addDays(mondayReturn, offset));
    }

    const zeroRate = Object.values(s.days).flatMap(days => Object.values(days)).filter(day => day.status === 'zero').length / (ids.length * 34 * 7);
    expect(zeroRate).toBeGreaterThan(0.4);
    expect(zeroRate).toBeLessThan(0.5);
    for (const staffId of coverIds) {
      const returns = Object.entries(s.days[staffId]).filter(([date, day]) => day.status === 'longDay' && s.days[rotaIds[0]][date].status === 'zero');
      expect(returns.length).toBeGreaterThanOrEqual(2);
    }

    const run = (maxChain: number, dates: readonly string[], patch: Partial<SwapSettings> = {}, planLimits?: SwapRequest['planLimits']) => {
      const started = performance.now();
      const result = findSwaps(p, s, settings({ maxChain, ...patch }), request(rotaIds[0], [...dates], { planLimits }));
      return { result, elapsed: performance.now() - started };
    };
    const cases: [string, number, string[], Partial<SwapSettings>][] = [
      ['single long day', 4, [MONDAY], {}],
      ['bank holiday long day', 4, [bankHoliday], { bankHolidays: [bankHoliday] }],
      ['two-day weekend', 4, [weekend, weekendSunday], {}],
      ['Fri to Sun night block', 4, [fridayNight], {}],
      ['Mon to Thu night block with day jobs', 4, [mondayNight], {}],
    ];
    const measurements: { label: string; maxChain: number; result: ReturnType<typeof findSwaps>; elapsed: number }[] = [];
    for (const [label, maxChain, dates, patch] of cases) {
      const item = { label, maxChain, ...run(maxChain, dates, patch) };
      measurements.push(item);
      console.log(`${item.label}, maxChain ${item.maxChain}: ${item.elapsed.toFixed(1)} ms (truncated=${item.result.truncated})`);
      expect(item.elapsed).toBeLessThan(60000);
    }
    expect(measurements[2].result.plans.some(plan => plan.people === 2)).toBe(true);
    for (const item of measurements.slice(2, 3)) {
      const groups = item.result.plans.map(plan => `${Math.max(...plan.chains.map(chain => chain.links.length))}|${[...new Set(plan.chains.flatMap(chain => chain.links.slice(1).map(link => link.staffId)))].sort().join('|')}`);
      expect(new Set(groups).size).toBeLessThan(groups.length);
    }
    for (const size of [2, 3, 4] as const) {
      const item = run(4, [weekend, weekendSunday], {}, { [size]: 100 });
      console.log(`Find 50 more ${size === 2 ? 'direct' : `${size}-way`}: ${item.elapsed.toFixed(1)} ms (truncated=${item.result.truncated})`);
      expect(item.elapsed).toBeLessThan(60000);
    }
  }, 300000);

  it('returns identical plans for blank-named and named contract rules', () => {
    const ids = ['req', 'cover'];
    const limitValues: Record<string, number[]> = {
      rest: [11], hours7: [72, 7], avg: [48], days: [7], weekends: [1, 2],
      nights: [4], postnights: [46], longdays: [4],
    };
    const makeProfile = (nameRules: boolean) => {
      const p = profile(ids, ['Long']);
      p.rules = limitDefs(p)
        .filter(def => !def.offByDefault)
        .map(def => {
          const rule = def.make(limitValues[def.id]!);
          return nameRules ? { ...rule, name: `Named ${def.id}` } : rule;
        });
      return p;
    };
    const s = blankSnapshot(ids);
    work(s, 'req', MONDAY, 'longDay', 'Long');
    off(s, 'cover', MONDAY);
    for (let i = 1; i <= 4; i++) work(s, 'cover', addDays(MONDAY, i), 'night', 'Night');
    work(s, 'cover', '2026-11-07', 'longDay', 'Long');
    work(s, 'cover', '2026-11-10', 'longDay', 'Long');
    off(s, 'req', '2026-11-10');
    const req = request('req');
    const blank = findSwaps(makeProfile(false), s, settings({ maxChain: 2 }), req);
    const named = findSwaps(makeProfile(true), s, settings({ maxChain: 2 }), req);
    expect(named.plans).toEqual(blank.plans);
    expect(named.truncated).toBe(blank.truncated);
    expect(blank.plans.some(plan => plan.alerts?.length)).toBe(true);
  });

  it('allows a swap when an existing 72-hour breach only moves reporting date', () => {
    const ids = ['req', 'cover'];
    const limitValues: Record<string, number[]> = {
      rest: [11], hours7: [72, 7], avg: [48], days: [7], weekends: [1, 2],
      nights: [4], postnights: [46], longdays: [4],
    };
    const p = profile(ids, ['Long']);
    p.rules = limitDefs(p).filter(def => !def.offByDefault).map(def => def.make(limitValues[def.id]!));
    const s = blankSnapshot(ids);
    work(s, 'req', MONDAY, 'longDay', 'Long');
    off(s, 'cover', MONDAY);
    for (let i = 1; i <= 4; i++) work(s, 'cover', addDays(MONDAY, i), 'night', 'Night');
    work(s, 'cover', '2026-11-07', 'longDay', 'Long');
    work(s, 'cover', '2026-11-08', 'longDay', 'Long');
    work(s, 'cover', '2026-11-14', 'longDay', 'Long');
    off(s, 'req', '2026-11-07');
    off(s, 'req', '2026-11-14');
    const result = findSwaps(p, s, settings({ maxChain: 2 }), request('req'));
    const moved = result.plans.find(plan => plan.chains.some(chain =>
      chain.links.some(link => link.staffId === 'cover' && link.gives.dates[0] === '2026-11-07')));
    expect(moved).toBeDefined();
    expect(moved?.alerts).toBeUndefined();
  });

  it('alerts for a real extra doctor-specific hours breach and ranks it below a clean plan', () => {
    const ids = ['req', 'cover-a', 'cover-b'];
    const limitValues: Record<string, number[]> = {
      rest: [11], hours7: [72, 7], avg: [48], days: [7], weekends: [1, 2],
      nights: [4], postnights: [46], longdays: [4],
    };
    const p = profile(ids, ['Long']);
    p.rules = limitDefs(p).filter(def => !def.offByDefault).map(def => def.make(limitValues[def.id]!));
    const s = blankSnapshot(ids);
    work(s, 'req', MONDAY, 'longDay', 'Long');
    off(s, 'cover-a', MONDAY);
    off(s, 'cover-b', MONDAY);
    work(s, 'cover-a', '2026-11-26', 'longDay', 'Long');
    off(s, 'req', '2026-11-26');
    for (let i = 1; i <= 4; i++) work(s, 'cover-b', addDays(MONDAY, i), 'night', 'Night');
    work(s, 'cover-b', '2026-11-07', 'longDay', 'Long');
    for (let offset = 0; offset < 6; offset++) work(s, 'cover-b', addDays('2026-11-14', offset), 'longDay', 'Long');
    work(s, 'cover-b', '2026-11-25', 'longDay', 'Long');
    off(s, 'req', '2026-11-07');
    off(s, 'req', '2026-11-25');
    const result = findSwaps(p, s, settings({ maxChain: 2 }), request('req'));
    const extra = result.plans.find(plan => plan.chains.some(chain =>
      chain.links.some(link => link.staffId === 'cover-b' && link.gives.dates[0] === '2026-11-25')));
    expect(extra?.alerts).toEqual(expect.arrayContaining([expect.objectContaining({
      staffId: 'cover-b', date: MONDAY, message: 'Would exceed 72 hours in 7 days',
    })]));
    expect(result.plans[0].chains[0].links[1].staffId).toBe('cover-a');
    expect(result.plans[0].alerts).toBeUndefined();
  });

  it('ignores a newly broken weekend-frequency rule', () => {
    const p = profile(['req', 'cover'], ['Long'], [{
      id: 'weekends', name: '', type: 'weekendFrequency', hard: true, maxWeekends: 1, inWeekends: 2,
    }]);
    const s = blankSnapshot(['req', 'cover']);
    work(s, 'cover', '2026-11-07', 'longDay', 'Long');
    work(s, 'req', '2026-11-14', 'longDay', 'Long'); off(s, 'cover', '2026-11-14');
    work(s, 'cover', '2026-11-17', 'longDay', 'Long'); off(s, 'req', '2026-11-17');
    const result = findSwaps(p, s, settings({ maxChain: 2 }), request('req', ['2026-11-14']));
    expect(result.plans).toHaveLength(1);
    expect(result.plans[0].alerts).toBeUndefined();
  });

  it('alerts for days, nights and long days in a row', () => {
    const cases = [
      { label: 'working days', status: 'dayJob' as const, activity: 'Clinic', work: {} },
      { label: 'nights', status: 'night' as const, activity: 'Night', work: { shiftTypeIds: ['night'] } },
      { label: 'long days', status: 'longDay' as const, activity: 'Long', work: { shiftTypeIds: ['long'] } },
    ];
    for (const item of cases) {
      const p = profile(['req', 'cover'], ['Long', 'Clinic', 'Night'], [{
        id: `run-${item.label}`, name: '', type: 'maxConsecutive', hard: true, work: item.work, maxDays: 3,
      }]);
      const s = blankSnapshot(['req', 'cover']);
      work(s, 'req', MONDAY, item.status === 'night' ? 'night' : 'longDay', item.status === 'night' ? 'Night' : 'Long');
      off(s, 'cover', MONDAY);
      for (let offset = 1; offset <= 3; offset++) work(s, 'cover', addDays(MONDAY, offset), item.status, item.activity);
      const returnDate = '2026-11-10';
      work(s, 'cover', returnDate, item.status === 'night' ? 'night' : 'longDay', item.status === 'night' ? 'Night' : 'Long');
      off(s, 'req', returnDate);
      const result = findSwaps(p, s, settings({ maxChain: 2 }), request('req'));
      const returned = result.plans.find(plan => plan.chains[0].links[1].gives.dates.includes(returnDate));
      expect(returned?.alerts).toContainEqual({
        staffId: 'cover', date: '2026-11-05', message: `Would work more than 3 ${item.label} in a row`,
      });
    }
  });

  it('returns a plan with an alert for a new minimum-rest breach', () => {
    const p = profile(['req', 'cover'], ['Long', 'Clinic'], [{
      id: 'minimum-rest', name: '', type: 'minRest', hard: true, hours: 11,
    }]);
    p.shiftTypes.push({ id: 'late-clinic', name: 'Late clinic', start: '12:00', end: '22:00' });
    p.demands.push({
      id: 'late-clinic-demand', roleId: 'role-Clinic', shiftTypeId: 'late-clinic',
      days: { dates: [MONDAY] }, min: 0, max: 1,
    });
    const s = blankSnapshot(['req', 'cover']);
    work(s, 'cover', MONDAY, 'dayJob', 'Clinic');
    const clashDate = '2026-11-03';
    work(s, 'req', clashDate, 'longDay', 'Long'); off(s, 'cover', clashDate);
    work(s, 'cover', '2026-11-10', 'longDay', 'Long'); off(s, 'req', '2026-11-10');
    const result = findSwaps(p, s, settings({ maxChain: 2 }), request('req', [clashDate]));
    expect(result.plans[0].alerts).toContainEqual({
      staffId: 'cover', date: clashDate, message: 'Would have less than 11 hours between shifts',
    });
  });

  it('alerts the requester when their return shift creates a working-time breach', () => {
    const p = profile(['req', 'cover'], ['Long', 'Clinic'], [{
      id: 'requester-run', name: '', type: 'maxConsecutive', hard: true, work: {}, maxDays: 3,
    }]);
    const s = blankSnapshot(['req', 'cover']);
    work(s, 'req', MONDAY, 'longDay', 'Long'); off(s, 'cover', MONDAY);
    for (const date of ['2026-11-08', '2026-11-09', '2026-11-10']) work(s, 'req', date, 'dayJob', 'Clinic');
    work(s, 'cover', '2026-11-11', 'longDay', 'Long'); off(s, 'req', '2026-11-11');
    const result = findSwaps(p, s, settings({ maxChain: 2 }), request('req'));
    expect(result.plans[0].alerts).toContainEqual({
      staffId: 'req', date: '2026-11-11', message: 'Would work more than 3 working days in a row',
    });
  });

  it('alerts for minimum blocks and per-week-average count limits', () => {
    const blockProfile = profile(['req', 'cover'], ['Long'], [{
      id: 'minimum-block', name: '', type: 'minBlock', hard: true, work: { shiftTypeIds: ['long'] }, minDays: 2,
    }]);
    const blockSnapshot = blankSnapshot(['req', 'cover']);
    work(blockSnapshot, 'req', MONDAY, 'longDay', 'Long'); off(blockSnapshot, 'cover', MONDAY);
    work(blockSnapshot, 'cover', '2026-11-10', 'longDay', 'Long');
    work(blockSnapshot, 'cover', '2026-11-11', 'longDay', 'Long');
    off(blockSnapshot, 'req', '2026-11-10');
    const blockResult = findSwaps(blockProfile, blockSnapshot, settings({ maxChain: 2 }), request('req'));
    expect(blockResult.plans[0].alerts?.some(alert => alert.staffId === 'cover' && alert.message === 'Would create a work block shorter than 2 days')).toBe(true);

    const averageProfile = profile(['req', 'cover'], ['Selected', 'Other'], [{
      id: 'average-hours', name: '', type: 'count', hard: true, work: { roleIds: ['role-Selected'] },
      period: 'horizon', unit: 'hours', max: 1, perWeekAverage: true,
    }]);
    const averageSnapshot = blankSnapshot(['req', 'cover']);
    work(averageSnapshot, 'req', MONDAY, 'longDay', 'Selected'); off(averageSnapshot, 'cover', MONDAY);
    work(averageSnapshot, 'cover', '2026-11-10', 'longDay', 'Other'); off(averageSnapshot, 'req', '2026-11-10');
    const averageResult = findSwaps(averageProfile, averageSnapshot, settings({ maxChain: 2 }), request('req'));
    expect(averageResult.plans[0].alerts).toContainEqual({
      staffId: 'cover', date: MONDAY, message: 'Would exceed an average of 1 hours per week',
    });
  });

  it('rejects newly created overlaps and hard forbid breaches', () => {
    const overlapProfile = profile(['req', 'cover'], ['Long', 'Night']);
    const overlapSnapshot = blankSnapshot(['req', 'cover']);
    work(overlapSnapshot, 'cover', MONDAY, 'night', 'Night');
    const clashDate = '2026-11-03';
    work(overlapSnapshot, 'req', clashDate, 'longDay', 'Long'); off(overlapSnapshot, 'cover', clashDate);
    work(overlapSnapshot, 'cover', '2026-11-10', 'longDay', 'Long'); off(overlapSnapshot, 'req', '2026-11-10');
    expect(findSwaps(overlapProfile, overlapSnapshot, settings({ maxChain: 2 }), request('req', [clashDate])).plans).toEqual([]);

    const forbidProfile = profile(['req', 'cover'], ['Long'], [{
      id: 'forbid-cover', name: '', type: 'forbid', hard: true,
      who: { staffIds: ['cover'] }, work: { roleIds: ['role-Long'] }, days: { dates: [MONDAY] },
    }]);
    const forbidSnapshot = blankSnapshot(['req', 'cover']);
    work(forbidSnapshot, 'req', MONDAY, 'longDay', 'Long'); off(forbidSnapshot, 'cover', MONDAY);
    work(forbidSnapshot, 'cover', '2026-11-10', 'longDay', 'Long'); off(forbidSnapshot, 'req', '2026-11-10');
    expect(findSwaps(forbidProfile, forbidSnapshot, settings({ maxChain: 2 }), request('req')).plans).toEqual([]);
  });

  it('finds a planted four-person chain after eight locally invalid candidates', () => {
    const ids = ['requester', ...Array.from({ length: 9 }, (_, index) => [`cover-${index}`, `middle-${index}`, `return-${index}`]).flat()];
    const p = profile(ids, ['Long']);
    p.rules.push({
      id: 'first-eight-invalid', name: 'First eight invalid', type: 'forbid', hard: true,
      who: { staffIds: Array.from({ length: 8 }, (_, index) => `cover-${index}`) },
      work: { roleIds: ['role-Long'] }, days: { dates: [MONDAY] },
    });
    const s = blankSnapshot(ids, 140);
    work(s, 'requester', MONDAY, 'longDay', 'Long');
    for (let index = 0; index < 9; index++) {
      const first = addDays(MONDAY, 7 + index * 3);
      const second = addDays(first, 1);
      const third = addDays(first, 2);
      off(s, `cover-${index}`, MONDAY);
      work(s, `cover-${index}`, first, 'longDay', 'Long');
      off(s, `middle-${index}`, first);
      work(s, `middle-${index}`, second, 'longDay', 'Long');
      off(s, `return-${index}`, second);
      work(s, `return-${index}`, third, 'longDay', 'Long');
      off(s, 'requester', third);
    }
    const result = findSwaps(p, s, settings({ maxChain: 4 }), request('requester'));
    expect(result.plans.some(plan => plan.chains.some(chain => chain.links.length === 4 && chain.links[1].staffId === 'cover-8'))).toBe(true);
  });
});
