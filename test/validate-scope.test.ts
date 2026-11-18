import { describe, expect, it } from 'vitest';
import { validate } from '../src/engine/validate';
import type { Assignment, RotaProblem } from '../src/engine/types';
import { applyDefaultLimitRules, stage2Profile } from './swaps-stage2-helpers';

describe('validation options used by swap search', () => {
  const ids = ['rowan', 'ellis', 'hart'];
  const profile = stage2Profile(ids, ['Made-up long day', 'Made-up clinic']);
  applyDefaultLimitRules(profile);
  profile.demands = [{ id: 'clinic-demand', roleId: 'role-Made-up clinic', shiftTypeId: 'day', days: {}, min: 0, max: 3 }];
  profile.fairness = [{ id: 'clinic-share', name: 'Made-up clinic work', unit: 'shifts', work: { roleIds: ['role-Made-up clinic'] } }];
  const problem: RotaProblem = {
    profile, start: '2026-11-02', end: '2026-11-15', fixed: [],
    unavailability: [{ staffId: 'rowan', date: '2026-11-05', kind: 'leave', reason: 'Made-up leave' }],
  };
  const assignments: Assignment[] = [
    { staffId: 'rowan', date: '2026-11-02', shiftTypeId: 'long', roleId: 'role-Made-up long day' },
    { staffId: 'ellis', date: '2026-11-04', shiftTypeId: 'day', roleId: 'role-Made-up clinic' },
    { staffId: 'hart', date: '2026-11-06', shiftTypeId: 'long', roleId: 'role-Made-up long day' },
  ];

  it('skipping fairness leaves all violations unchanged', () => {
    const complete = validate(problem, assignments);
    const withoutFairness = validate(problem, assignments, { skipFairness: true });
    expect(withoutFairness.violations).toEqual(complete.violations);
    expect(withoutFairness.gaps).toEqual(complete.gaps);
    expect(withoutFairness.soft).toEqual(complete.soft);
    expect(complete.fairness.length).toBeGreaterThan(0);
    expect(withoutFairness.fairness).toEqual([]);
  });

  it('scoping people preserves affected-person and whole-team violations', () => {
    const full = validate(problem, assignments);
    const scoped = validate(problem, assignments, { scopeStaffIds: ['rowan'], skipFairness: true });
    const expected = full.violations.filter(violation => violation.staffId === 'rowan' || !violation.staffId);
    expect(scoped.violations).toEqual(expected);
    expect(scoped.gaps).toEqual(full.gaps);
    expect(scoped.soft).toEqual(full.soft.filter(item => item.staffId === 'rowan' || !item.staffId));
  });
});
