import { describe, expect, it } from 'vitest';
import { addDays, dateRange, shiftHours, shiftInterval, weekday, weekendOf, periodBuckets } from '../src/engine/calendar';
import { solve } from '../src/engine/solve';
import { validate } from '../src/engine/validate';
import type { Profile, RotaProblem } from '../src/engine/types';

describe('calendar', () => {
  it('handles weekdays, ranges and overnight shifts', () => {
    expect(weekday('2026-11-02')).toBe(0); // Monday
    expect(weekday('2026-11-08')).toBe(6); // Sunday
    expect(dateRange('2026-10-30', '2026-11-02')).toEqual(['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02']);
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    const night = { id: 'N', name: 'Night', start: '20:00', end: '08:30' };
    const { start, end } = shiftInterval('2026-11-02', night);
    expect((end - start) / 60).toBe(12.5);
    expect(shiftHours(night)).toBe(12.5);
  });

  it('treats a Friday night as weekend work', () => {
    const night = { id: 'N', name: 'Night', start: '20:00', end: '08:30' };
    const am = { id: 'AM', name: 'AM', start: '08:00', end: '13:00' };
    expect(weekendOf('2026-11-06', night)).toBe('2026-11-07'); // Fri night touches Sat
    expect(weekendOf('2026-11-06', am)).toBeNull();
    expect(weekendOf('2026-11-08', am)).toBe('2026-11-07'); // Sunday belongs to Sat's weekend
  });

  it('splits periods and reports partial weeks', () => {
    const b = periodBuckets('week', dateRange('2026-11-05', '2026-11-12'));
    expect(b.map(x => [x.key, x.dates.length])).toEqual([['2026-11-02', 4], ['2026-11-09', 4]]);
    expect(b[0].fraction).toBeCloseTo(4 / 7);
  });
});

function tinyProfile(): Profile {
  return {
    name: 'Tiny',
    shiftTypes: [
      { id: 'AM', name: 'AM', start: '08:00', end: '13:00' },
      { id: 'PM', name: 'PM', start: '13:00', end: '17:00' },
      { id: 'N', name: 'Night', start: '20:00', end: '08:00' },
    ],
    roles: [
      { id: 'ward', name: 'Ward', category: 'Wards' },
      { id: 'theatre', name: 'Theatre', category: 'Theatre' },
      { id: 'oncall', name: 'On call', category: 'On-call' },
    ],
    groups: [{ id: 'jr', name: 'Junior' }],
    staff: ['A', 'B', 'C', 'D'].map(id => ({ id, name: `Dr ${id}`, groupIds: ['jr'], fte: 1 })),
    demands: [
      { id: 'd1', roleId: 'ward', shiftTypeId: 'AM', days: {}, min: 1, max: 1 },
      { id: 'd2', roleId: 'ward', shiftTypeId: 'PM', days: {}, min: 1, max: 1 },
      { id: 'd3', roleId: 'theatre', shiftTypeId: 'AM', days: { weekdays: [0, 1, 2, 3, 4] }, min: 1, max: 1 },
      { id: 'd4', roleId: 'oncall', shiftTypeId: 'N', days: {}, min: 1, max: 1 },
    ],
    rules: [
      { id: 'rest', name: '11h rest', type: 'minRest', hard: true, hours: 11 },
      { id: 'link', name: 'Ward full day', type: 'linkShifts', hard: true, roleId: 'ward', shiftTypeIds: ['AM', 'PM'] },
      { id: 'nights', name: 'Max 3 nights', type: 'maxConsecutive', hard: true, work: { shiftTypeIds: ['N'] }, maxDays: 3 },
      { id: 'postn', name: '46h after nights', type: 'restAfterBlock', hard: true, work: { shiftTypeIds: ['N'] }, hours: 46 },
      { id: 'noD', name: 'D never in theatre', type: 'forbid', hard: true, who: { staffIds: ['D'] }, work: { roleIds: ['theatre'] } },
    ],
    fairness: [{ id: 'hours', name: 'Hours', unit: 'hours' }],
  };
}

describe('solver + validator', () => {
  it('fills a small week with no hard-rule breaks', async () => {
    const problem: RotaProblem = { profile: tinyProfile(), start: '2026-11-02', end: '2026-11-08', unavailability: [{ staffId: 'A', date: '2026-11-03' }], fixed: [] };
    const res = await solve(problem, { timeLimit: 20 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const report = validate(problem, res.assignments);
    expect(report.violations).toEqual([]);
    expect(report.gaps).toEqual([]);
    // Dr D never gets theatre, Dr A not booked on their day off.
    expect(res.assignments.some(a => a.staffId === 'D' && a.roleId === 'theatre')).toBe(false);
    expect(res.assignments.some(a => a.staffId === 'A' && a.date === '2026-11-03')).toBe(false);
  });

  it('the validator catches a broken rota', () => {
    const problem: RotaProblem = { profile: tinyProfile(), start: '2026-11-02', end: '2026-11-08', unavailability: [{ staffId: 'A', date: '2026-11-03' }], fixed: [] };
    const report = validate(problem, [
      { staffId: 'A', date: '2026-11-03', shiftTypeId: 'AM', roleId: 'ward' }, // unavailable, and no PM (link)
      { staffId: 'B', date: '2026-11-02', shiftTypeId: 'N', roleId: 'oncall' },
      { staffId: 'B', date: '2026-11-03', shiftTypeId: 'AM', roleId: 'theatre' }, // overlaps night end / no rest
      { staffId: 'D', date: '2026-11-04', shiftTypeId: 'AM', roleId: 'theatre' }, // forbidden
    ]);
    const ids = report.violations.map(v => v.ruleId).sort();
    expect(ids).toEqual(expect.arrayContaining(['availability', 'link', 'noD', 'postn', 'rest']));
  });

  it('explains an impossible rota instead of failing silently', async () => {
    const profile = tinyProfile();
    // Hard: everyone must do at least 5 theatre sessions this week, but there are only 5 lists for 4 people.
    profile.rules.push({ id: 'tooMuch', name: 'At least 5 theatre each', type: 'count', hard: true, work: { roleIds: ['theatre'] }, period: 'horizon', unit: 'shifts', min: 5, who: { staffIds: ['A', 'B'] } });
    const problem: RotaProblem = { profile, start: '2026-11-02', end: '2026-11-08', unavailability: [], fixed: [] };
    const res = await solve(problem, { timeLimit: 20 });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.conflicts.map(c => c.ruleId)).toContain('tooMuch');
  });
});
