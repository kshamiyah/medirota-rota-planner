import { describe, expect, it } from 'vitest';
import { describeRule } from '../src/app/rules/sentence';
import { ruleWarning } from '../src/app/rules/warnings';
import type { Profile } from '../src/engine/types';

const p: Profile = {
  name: 't',
  shiftTypes: [{ id: 'day', name: 'Day', start: '08:00', end: '17:30' }, { id: 'N', name: 'Night', start: '20:00', end: '08:30' }],
  roles: [{ id: 'mau', name: 'MAU' }, { id: 'pn', name: 'Postnatal Ward' }],
  groups: [{ id: 'fy', name: 'FY2' }],
  staff: [],
  demands: [{ id: 'a', roleId: 'mau', shiftTypeId: 'day', days: {}, min: 1, max: 1 }, { id: 'b', roleId: 'pn', shiftTypeId: 'day', days: {}, min: 1, max: 1 }],
  rules: [],
  fairness: [],
};

describe('rule sentences', () => {
  it('reads as plain English', () => {
    expect(describeRule(p, { id: '1', name: '', type: 'forbid', hard: true, who: { groupIds: ['fy'] }, work: { roleIds: ['mau'] }, days: { weekdays: [3] } }))
      .toBe("FY2 can't work MAU on Thursdays");
    expect(describeRule(p, { id: '2', name: '', type: 'count', hard: false, who: { groupIds: ['fy'] }, work: { roleIds: ['pn'] }, period: 'week', unit: 'shifts', max: 2 }))
      .toBe('FY2 should work at most 2 shifts of Postnatal Ward a week');
  });
  it('flags rules that can have no effect', () => {
    // One day shift: nobody can do MAU and Postnatal on the same day anyway.
    expect(ruleWarning(p, { id: '3', name: '', type: 'notSameDay', hard: true, a: { roleIds: ['mau'] }, b: { roleIds: ['pn'] } })).toMatch(/no effect/);
    expect(ruleWarning(p, { id: '4', name: '', type: 'forbid', hard: true, work: { roleIds: ['mau'] } })).toBeUndefined();
  });
});

describe('every kind of rule reads as a sentence', () => {
  const cases: [import('../src/engine/types').Rule, string][] = [
    [{ id: 'a', name: '', type: 'minRest', hard: true, hours: 11 }, 'Everyone must have at least 11 hours off between shifts'],
    [{ id: 'b', name: '', type: 'maxHours', hard: true, hours: 72, windowDays: 7 }, 'Everyone can work at most 72 hours in any 7 days'],
    [{ id: 'c', name: '', type: 'count', hard: true, work: {}, period: 'horizon', unit: 'hours', max: 48, perWeekAverage: true, scaleByFte: true }, 'Everyone can work at most 48 hours a week on average (less for part-timers)'],
    [{ id: 'd', name: '', type: 'maxConsecutive', hard: true, work: { shiftTypeIds: ['N'] }, maxDays: 4 }, 'Everyone can work at most 4 Night shifts in a row'],
    [{ id: 'e', name: '', type: 'maxConsecutive', hard: true, work: {}, maxDays: 7 }, 'Everyone can work at most 7 days in a row'],
    [{ id: 'f', name: '', type: 'restAfterBlock', hard: true, work: { shiftTypeIds: ['N'] }, hours: 46 }, 'Everyone must have 46 hours off after a run of Night shifts'],
    [{ id: 'g', name: '', type: 'weekendFrequency', hard: true, maxWeekends: 1, inWeekends: 2 }, 'Everyone can work at most 1 in every 2 weekends'],
    [{ id: 'h', name: '', type: 'count', hard: false, tier: 'training', who: { groupIds: ['fy'] }, work: { roleIds: ['mau'] }, period: 'month', unit: 'shifts', min: 4 }, 'FY2 should get at least 4 shifts of MAU a month'],
    [{ id: 'i', name: '', type: 'preference', hard: false, who: { groupIds: ['fy'] }, work: { roleIds: ['mau'] }, direction: 'less' }, 'FY2 should get less MAU'],
    [{ id: 'j', name: '', type: 'notSameDay', hard: true, a: { roleIds: ['mau'] }, b: { roleIds: ['pn'] } }, 'No one does MAU and Postnatal Ward on the same day'],
    [{ id: 'k', name: '', type: 'forbid', hard: false, who: { groupIds: ['fy'] }, work: {}, days: { weekdays: [0] } }, 'FY2 should avoid any work on Mondays'],
  ];
  const q: Profile = { ...p, shiftTypes: [...p.shiftTypes, { id: 'N', name: 'Night', start: '20:00', end: '08:00' }] };
  for (const [rule, text] of cases) it(text, () => expect(describeRule(q, rule)).toBe(text));
});
