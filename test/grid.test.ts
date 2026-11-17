import { describe, expect, it } from 'vitest';
import { gridCellOf, gridRows, limitDefs, ruleHome, readAccess, readTarget, writeAccess, writeTarget } from '../src/app/rules/grid';
import type { Profile } from '../src/engine/types';

function profile(): Profile {
  return {
    name: 't',
    shiftTypes: [{ id: 'LD', name: 'Long Day', start: '08:00', end: '20:30' }, { id: 'N', name: 'Night', start: '20:00', end: '08:30' }],
    roles: [{ id: 'mau', name: 'MAU' }, { id: 'obs', name: 'Obstetric on-call' }],
    groups: [{ id: 'fy', name: 'FY2' }, { id: 'gp', name: 'GP trainees' }],
    staff: [{ id: 'a', name: 'Dr A', groupIds: ['fy'], fte: 1 }],
    demands: [],
    rules: [],
    fairness: [],
  };
}
const fy = { kind: 'group' as const, id: 'fy' };

describe('who-can-work-where grid', () => {
  it('starts as allowed everywhere', () => {
    expect(readAccess(profile(), fy, 'mau')).toEqual({ never: false, avoid: false, blockedShifts: [] });
  });

  it('round-trips never, blocked shifts and limits through rules', () => {
    const p = profile();
    writeAccess(p, fy, 'obs', { never: false, avoid: false, blockedShifts: ['N'], limit: { max: 2, period: 'week' } });
    expect(readAccess(p, fy, 'obs')).toEqual({ never: false, avoid: false, blockedShifts: ['N'], limit: { max: 2, period: 'week' } });
    expect(p.rules.map(r => r.type)).toEqual(['forbid', 'count']);
    writeAccess(p, fy, 'obs', { never: true, avoid: false, blockedShifts: [] });
    expect(readAccess(p, fy, 'obs').never).toBe(true);
    expect(p.rules).toHaveLength(1);
    writeAccess(p, fy, 'obs', { never: false, avoid: false, blockedShifts: [] });
    expect(p.rules).toEqual([]);
  });

  it('only touches its own cell', () => {
    const p = profile();
    writeAccess(p, fy, 'mau', { never: true, avoid: false, blockedShifts: [] });
    writeAccess(p, { kind: 'group', id: 'gp' }, 'mau', { never: false, avoid: true, blockedShifts: [] });
    writeAccess(p, fy, 'mau', { never: false, avoid: false, blockedShifts: [] });
    expect(readAccess(p, { kind: 'group', id: 'gp' }, 'mau').avoid).toBe(true);
  });

  it('leaves rules that do not fit a cell to "Other rules"', () => {
    const p = profile();
    p.rules.push({ id: 'x', name: '', type: 'forbid', hard: true, who: { groupIds: ['fy', 'gp'] }, work: { roleIds: ['mau'] } });
    expect(gridCellOf(p.rules[0])).toBeUndefined();
    expect(ruleHome(p, p.rules[0])).toBe('other');
  });
});

describe('training grid', () => {
  it('round-trips a target and shows people who have one', () => {
    const p = profile();
    const a = { kind: 'person' as const, id: 'a' };
    writeTarget(p, a, 'mau', { min: 3, period: 'month', partTimeLess: true });
    expect(readTarget(p, a, 'mau')).toEqual({ min: 3, period: 'month', partTimeLess: true });
    expect(gridRows(p, 'training').map(r => r.id)).toEqual(['fy', 'gp', 'a']);
    writeTarget(p, a, 'mau', undefined);
    expect(readTarget(p, a, 'mau')).toBeUndefined();
  });
});

describe('working-time limits', () => {
  it('finds existing limits and offers nights rules when there are night shifts', () => {
    const p = profile();
    const defs = limitDefs(p);
    expect(defs.map(d => d.id)).toEqual(['rest', 'hours7', 'avg', 'days', 'weekends', 'nights', 'postnights', 'nightblocks', 'longdays', 'postlongdays']);
    const nights = defs.find(d => d.id === 'nights')!;
    const rule = nights.make([3]);
    expect(nights.matches(rule)).toBe(true);
    expect(nights.values(rule)).toEqual([3]);
    expect(defs.find(d => d.id === 'longdays')!.matches(rule)).toBe(false);
  });

  it('puts limits for a group under the checklist, not in "Other rules"', () => {
    const p = profile();
    const forGroup = { id: 'g', name: '', type: 'maxConsecutive' as const, hard: true, who: { groupIds: ['fy'] }, work: { shiftTypeIds: ['LD'] }, maxDays: 3 };
    const standard = limitDefs(p).find(d => d.id === 'longdays')!.make([4]);
    expect(ruleHome(p, standard)).toBe('limits');
    expect(ruleHome(p, forGroup)).toBe('customLimit');
  });
});
