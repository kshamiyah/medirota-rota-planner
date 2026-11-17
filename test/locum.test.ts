import { describe, expect, it } from 'vitest';
import { solve } from '../src/engine/solve';
import { validate } from '../src/engine/validate';
import type { RotaProblem } from '../src/engine/types';

function problem(perDay: number): RotaProblem {
  return {
    start: '2026-11-02', end: '2026-11-08', unavailability: [],
    fixed: [{ staffId: 'loc', date: '2026-11-04', shiftTypeId: 'D', roleId: 'ward' }],
    profile: {
      name: 't',
      shiftTypes: [{ id: 'D', name: 'Day', start: '08:00', end: '17:00' }],
      roles: [{ id: 'ward', name: 'Ward' }],
      groups: [],
      staff: [
        { id: 'a', name: 'A', groupIds: [], fte: 1 },
        { id: 'b', name: 'B', groupIds: [], fte: 1 },
        { id: 'loc', name: 'Locum', groupIds: [], fte: 1, locum: true },
      ],
      demands: [{ id: 'd', roleId: 'ward', shiftTypeId: 'D', days: {}, min: perDay, max: 3 }],
      rules: [{ id: 'run', name: 'At most 4 in a row', type: 'maxConsecutive', hard: true, work: {}, maxDays: 4 }],
      fairness: [{ id: 'h', name: 'Hours', unit: 'hours' }],
      useSpareCapacity: true,
    },
  };
}
const locumShifts = (as: { staffId: string }[]) => as.filter(a => a.staffId === 'loc').length;

describe('locums', () => {
  it('keep their booked shift and get nothing else', async () => {
    const p = problem(1);
    const res = await solve(p, { timeLimit: 20 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(validate(p, res.assignments).gaps).toEqual([]);
    expect(locumShifts(res.assignments)).toBe(1); // the booked one, not spare-capacity extras
  });

  it('are never given extra shifts, even to fill gaps, and are left out of fairness', async () => {
    const p = problem(2); // 14 shifts; A and B can do at most 12 between them with runs of 4
    const res = await solve(p, { timeLimit: 20 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const rep = validate(p, res.assignments);
    expect(rep.gaps.length).toBeGreaterThan(0);
    expect(locumShifts(res.assignments)).toBe(1);
    expect(rep.fairness.find(f => f.staffId === 'loc')!.eligible).toBe(false);
  });
});

describe('Minimums and people who are not working', () => {
  it("don't apply to someone away the whole month, not yet started, or a locum", async () => {
    const { minimumApplies } = await import('../src/engine/semantics');
    const dates = ['2026-11-02', '2026-11-03'];
    const base = { id: 'a', name: 'A', groupIds: [], fte: 1 };
    const problem = { profile: {} as never, start: dates[0], end: dates[1], fixed: [], unavailability: [
      { staffId: 'away', date: '2026-11-02', kind: 'leave' as const }, { staffId: 'away', date: '2026-11-03', kind: 'leave' as const },
      { staffId: 'half', date: '2026-11-02', kind: 'leave' as const },
    ] };
    expect(minimumApplies(problem, base, dates)).toBe(true);
    expect(minimumApplies(problem, { ...base, id: 'half' }, dates)).toBe(true);
    expect(minimumApplies(problem, { ...base, id: 'away' }, dates)).toBe(false);
    expect(minimumApplies(problem, { ...base, startDate: '2026-11-30' }, dates)).toBe(false);
    expect(minimumApplies(problem, { ...base, endDate: '2026-08-09' }, dates)).toBe(false);
    expect(minimumApplies(problem, { ...base, locum: true }, dates)).toBe(false);
  });
});
