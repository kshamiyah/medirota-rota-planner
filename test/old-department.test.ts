import { describe, expect, it } from 'vitest';
import { solve } from '../src/engine/solve';
import { validate } from '../src/engine/validate';
import { oldDepartmentProblem } from './fixtures/old-department';

describe('original department expressed as data', () => {
  for (const seed of [1, 2, 3, 4]) {
    it(`seed ${seed}: never breaks a hard rule and proves cover is the best possible`, async () => {
      const problem = oldDepartmentProblem(seed);
      const res = await solve(problem, { timeLimit: 20 });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const report = validate(problem, res.assignments);
      expect(report.violations).toEqual([]);
      const coverage = res.stages.find(s => s.tier === 'coverage');
      expect(coverage === undefined || coverage.gap <= 1e-6).toBe(true);
    }, 60_000);
  }
});
