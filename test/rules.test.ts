import { describe, expect, it } from 'vitest';
import { breaksRest, countBounds } from '../src/engine/semantics';
import { validate } from '../src/engine/validate';
import type { MinRestRule, Profile, RotaProblem, Rule } from '../src/engine/types';

const rest: MinRestRule = { id: 'r', name: 'rest', type: 'minRest', hard: true, hours: 11 };

describe('rest rule meaning', () => {
  it('treats back-to-back sessions as one duty', () => {
    expect(breaksRest(rest, 0, 9)).toBe(false); // AM 08-13 + PM 13-17
    expect(breaksRest(rest, 0.5, 9.5)).toBe(false); // with a lunch break
  });
  it('does not merge into an over-long duty', () => {
    expect(breaksRest(rest, 0, 17)).toBe(true); // night ending 08:00 then AM
  });
  it('requires the full rest otherwise', () => {
    expect(breaksRest(rest, 3, 20)).toBe(true); // PM ends 17:00, night 20:00
    expect(breaksRest(rest, 11, 30)).toBe(false);
  });
});

describe('count rule bounds', () => {
  const rule = { id: 'c', name: 'c', type: 'count', hard: true, work: {}, period: 'week', unit: 'shifts', min: 2, max: 3, scaleByFte: true } as const;
  it('scales by FTE and rounds hard minimums down in part weeks', () => {
    expect(countBounds(rule, { id: 'a', name: 'a', groupIds: [], fte: 1 }, 1)).toEqual({ min: 2, max: 3 });
    const lt = countBounds(rule, { id: 'a', name: 'a', groupIds: [], fte: 0.6 }, 1);
    expect(lt.min).toBe(1);
    expect(lt.max).toBeCloseTo(1.8);
    expect(countBounds(rule, { id: 'a', name: 'a', groupIds: [], fte: 1 }, 3 / 7)).toEqual({ min: 0, max: 3 });
  });
});

function profile(rules: Rule[]): Profile {
  return {
    name: 't',
    shiftTypes: [{ id: 'D', name: 'Day', start: '08:00', end: '20:00' }, { id: 'N', name: 'Night', start: '20:00', end: '08:00' }],
    roles: [{ id: 'w', name: 'Ward' }],
    groups: [],
    staff: [{ id: 'a', name: 'A', groupIds: [], fte: 1 }],
    demands: [{ id: 'd', roleId: 'w', shiftTypeId: 'D', days: {}, min: 0, max: 1 }, { id: 'n', roleId: 'w', shiftTypeId: 'N', days: {}, min: 0, max: 1 }],
    rules,
    fairness: [],
  };
}

describe('gap explanations', () => {
  it('names the rule that stops each person taking an empty shift', async () => {
    const { explainGaps } = await import('../src/engine/explain');
    const p: RotaProblem = {
      profile: { ...profile([{ id: 'rest', name: '11h rest', type: 'minRest', hard: true, hours: 11 }]), demands: [{ id: 'd', roleId: 'w', shiftTypeId: 'D', days: {}, min: 1, max: 1 }] },
      start: '2026-11-03', end: '2026-11-03', unavailability: [], fixed: [{ staffId: 'a', date: '2026-11-03', shiftTypeId: 'N', roleId: undefined }],
    };
    // Dr A has an outside night shift starting 20:00; a 08:00–20:00 day ends with 0h rest and a 24h duty.
    const [e] = explainGaps(p, [{ staffId: 'a', date: '2026-11-03', shiftTypeId: 'N', fixed: true }], [{ roleId: 'w', shiftTypeId: 'D', date: '2026-11-03', required: 1, assigned: 0 }]);
    expect(e.candidates).toEqual([{ staffId: 'a', reasons: ['11h rest'] }]);
  });
});

describe('validator rules', () => {
  it('counts a Friday night as a weekend worked', () => {
    const p: RotaProblem = {
      profile: profile([{ id: 'wk', name: '1 in 2', type: 'weekendFrequency', hard: true, maxWeekends: 1, inWeekends: 2 }]),
      start: '2026-11-02', end: '2026-11-15', unavailability: [], fixed: [],
    };
    const r = validate(p, [
      { staffId: 'a', date: '2026-11-06', shiftTypeId: 'N', roleId: 'w' }, // Friday night → weekend of 7th
      { staffId: 'a', date: '2026-11-14', shiftTypeId: 'D', roleId: 'w' }, // Saturday → weekend of 14th
    ]);
    expect(r.violations.map(v => v.ruleId)).toEqual(['wk']);
  });

  it('allows a run of nights but not a shift too soon after the block', () => {
    const p: RotaProblem = {
      profile: profile([{ id: 'post', name: '46h', type: 'restAfterBlock', hard: true, work: { shiftTypeIds: ['N'] }, hours: 46 }]),
      start: '2026-11-02', end: '2026-11-08', unavailability: [], fixed: [],
    };
    const nights = ['2026-11-02', '2026-11-03', '2026-11-04'].map(date => ({ staffId: 'a', date, shiftTypeId: 'N', roleId: 'w' }));
    expect(validate(p, nights).violations).toEqual([]);
    // Block ends Thu 08:00; a Fri 08:00 day shift is only 24h later.
    expect(validate(p, [...nights, { staffId: 'a', date: '2026-11-06', shiftTypeId: 'D', roleId: 'w' }]).violations.map(v => v.ruleId)).toEqual(['post']);
    // Sat 08:00 is 48h later: fine.
    expect(validate(p, [...nights, { staffId: 'a', date: '2026-11-07', shiftTypeId: 'D', roleId: 'w' }]).violations).toEqual([]);
  });
});

describe('example values', () => {
  it('a rule with parts still to set is ignored', async () => {
    const { activeRules } = await import('../src/engine/semantics');
    const p = profile([
      { id: 'set', name: 'set', type: 'minRest', hard: true, hours: 11 },
      { id: 'draft', name: 'draft', type: 'forbid', hard: true, work: {}, unset: ['who'] },
    ]);
    expect(activeRules(p).map(r => r.id)).toEqual(['set']);
  });
});
