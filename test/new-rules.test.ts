import { describe, expect, it } from 'vitest';
import { solve } from '../src/engine/solve';
import { validate } from '../src/engine/validate';
import type { Assignment, Profile, RotaProblem, Rule } from '../src/engine/types';

function profile(rules: Rule[]): Profile {
  return {
    name: 't',
    shiftTypes: [{ id: 'D', name: 'Day', start: '08:00', end: '17:00' }, { id: 'N', name: 'Night', start: '20:00', end: '08:00' }],
    roles: [{ id: 'ward', name: 'Ward' }, { id: 'oc', name: 'On-call' }],
    groups: [{ id: 'st', name: 'ST' }, { id: 'fy', name: 'FY2' }],
    staff: [
      { id: 's1', name: 'ST 1', groupIds: ['st'], fte: 1 },
      { id: 's2', name: 'ST 2', groupIds: ['st'], fte: 1 },
      { id: 'f1', name: 'FY 1', groupIds: ['fy'], fte: 1 },
      { id: 'f2', name: 'FY 2', groupIds: ['fy'], fte: 1 },
    ],
    demands: [
      { id: 'n', roleId: 'oc', shiftTypeId: 'N', days: {}, min: 1, max: 1 },
      { id: 'd', roleId: 'ward', shiftTypeId: 'D', days: {}, min: 1, max: 1 },
    ],
    rules: [{ id: 'rest', name: 'rest', type: 'minRest', hard: true, hours: 11 }, ...rules],
    fairness: [{ id: 'h', name: 'Hours', unit: 'hours' }],
  };
}
const problem = (rules: Rule[], end = '2026-11-08'): RotaProblem => ({ profile: profile(rules), start: '2026-11-02', end, unavailability: [], fixed: [] });
const N = (staffId: string, date: string): Assignment => ({ staffId, date, shiftTypeId: 'N', roleId: 'oc' });

describe('skill mix', () => {
  const rule: Rule = { id: 'mix', name: 'ST on nights', type: 'skillMix', hard: true, who: { groupIds: ['st'] }, work: { shiftTypeIds: ['N'] }, min: 1 };
  it('the solver always puts an ST on nights', async () => {
    const p = problem([rule]);
    const res = await solve(p, { timeLimit: 20 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(validate(p, res.assignments).violations).toEqual([]);
    for (const a of res.assignments.filter(x => x.shiftTypeId === 'N')) expect(a.staffId.startsWith('s')).toBe(true);
  });
  it('the checker catches a night with no ST', () => {
    const r = validate(problem([rule], '2026-11-02'), [N('f1', '2026-11-02'), { staffId: 's1', date: '2026-11-02', shiftTypeId: 'D', roleId: 'ward' }]);
    expect(r.violations.map(v => v.ruleId)).toEqual(['mix']);
  });
});

describe('nights in blocks', () => {
  const rule: Rule = { id: 'blk', name: 'Blocks of 2', type: 'minBlock', hard: true, work: { shiftTypeIds: ['N'] }, minDays: 2 };
  it('the solver never gives a single night inside the rota', async () => {
    const p = problem([rule]);
    const res = await solve(p, { timeLimit: 20 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(validate(p, res.assignments).violations).toEqual([]);
  });
  it('the checker catches a single night but allows one at the rota edge', () => {
    const p = problem([rule]);
    expect(validate(p, [N('s1', '2026-11-04')]).violations.map(v => v.ruleId)).toEqual(['blk']);
    expect(validate(p, [N('s1', '2026-11-08')]).violations).toEqual([]); // may continue after the rota
  });
});

describe('rest after a run', () => {
  const rule: Rule = { id: 'run', name: '48h after 3 nights', type: 'restAfterRun', hard: true, work: { shiftTypeIds: ['N'] }, runDays: 3, hours: 48 };
  it('the checker catches a shift too soon after a run', () => {
    const p = problem([rule]);
    const run = [N('s1', '2026-11-02'), N('s1', '2026-11-03'), N('s1', '2026-11-04')];
    // Run ends Thu 08:00; a Fri 08:00 day shift is only 24h later.
    expect(validate(p, [...run, { staffId: 's1', date: '2026-11-06', shiftTypeId: 'D', roleId: 'ward' }]).violations.map(v => v.ruleId)).toEqual(['run']);
    expect(validate(p, [...run, { staffId: 's1', date: '2026-11-07', shiftTypeId: 'D', roleId: 'ward' }]).violations).toEqual([]);
  });
  it('the solver respects it', async () => {
    const p = problem([rule]);
    const res = await solve(p, { timeLimit: 20 });
    expect(res.ok).toBe(true);
    if (res.ok) expect(validate(p, res.assignments).violations).toEqual([]);
  });
});

describe('continuity', () => {
  it('the solver keeps the same doctor on the ward for runs of days', async () => {
    const p = problem([{ id: 'c', name: 'Ward continuity', type: 'continuity', hard: false, roleId: 'ward', runDays: 3 }]);
    p.profile.demands = p.profile.demands.filter(d => d.roleId === 'ward');
    const res = await solve(p, { timeLimit: 20 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const ward = res.assignments.filter(a => a.roleId === 'ward').sort((a, b) => a.date.localeCompare(b.date)).map(a => a.staffId);
    const sameAsNext = ward.slice(0, -1).filter((s, i) => s === ward[i + 1]).length;
    expect(sameAsNext).toBeGreaterThanOrEqual(3);
  });
});

describe('share evenly within a group', () => {
  it('balances the work inside the group, allowing for time away', async () => {
    const share: Rule = { id: 'sh', name: 'ST share wards', type: 'share', hard: false, who: { groupIds: ['st'] }, work: { roleIds: ['ward'] } };
    const p = problem([share], '2026-11-15');
    p.profile.demands = [{ id: 'd', roleId: 'ward', shiftTypeId: 'D', days: {}, min: 1, max: 1 }];
    p.profile.fairness = [];
    // ST 2 is away the first week, so should do more of the ward in the second.
    p.unavailability = ['02', '03', '04', '05', '06', '07', '08'].map(d => ({ staffId: 's2', date: `2026-11-${d}`, kind: 'leave' as const }));
    p.profile.staff = p.profile.staff.filter(s => s.groupIds.includes('st'));
    const res = await solve(p, { timeLimit: 20 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const rep = validate(p, res.assignments);
    const rows = rep.fairness.filter(f => f.dimensionId === 'sh');
    expect(rows.map(r => r.staffId).sort()).toEqual(['s1', 's2']);
    const s2wk2 = res.assignments.filter(a => a.staffId === 's2' && a.date >= '2026-11-09').length;
    expect(s2wk2).toBeGreaterThanOrEqual(4); // ST 1 already did the first week
  });
});

describe('share with a bigger share for some', () => {
  it('gives the favoured group about N times as much per day available', async () => {
    const share: Rule = { id: 'sh', name: 'theatre', type: 'share', hard: false, work: { roleIds: ['ward'] }, favour: { who: { groupIds: ['st'] }, times: 2 } };
    const p = problem([share], '2026-11-29');
    p.profile.roles.push({ id: 'other', name: 'Other' });
    p.profile.demands = [
      { id: 'w', roleId: 'ward', shiftTypeId: 'D', days: {}, min: 2, max: 2 },
      { id: 'o', roleId: 'other', shiftTypeId: 'D', days: {}, min: 2, max: 2 },
    ];
    p.profile.fairness = [];
    const res = await solve(p, { timeLimit: 30 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const ward = (ids: string[]) => res.assignments.filter(a => a.roleId === 'ward' && ids.includes(a.staffId)).length;
    const st = ward(['s1', 's2']), fy = ward(['f1', 'f2']);
    expect(st / fy).toBeGreaterThan(1.6);
    expect(st / fy).toBeLessThan(2.5);
  });
});
