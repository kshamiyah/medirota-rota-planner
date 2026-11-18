/**
 * Differential fuzz: scoped+skipFairness validation used by findSwaps must match
 * a full validate() for every affected person and every whole-team check.
 */
import { describe, expect, it } from 'vitest';
import { addDays, dateRange } from '../src/engine/calendar';
import { validate, type Violation } from '../src/engine/validate';
import type { Assignment, ISODate, RotaProblem } from '../src/engine/types';
import { applyDefaultLimitRules, stage2Profile } from './swaps-stage2-helpers';

const SEED = 0x5a17_2026;
const PLAN_COUNT = 250;
const NAMES = [
  ['rowan', 'Dr Rowan'], ['ellis', 'Dr Ellis'], ['hart', 'Dr Hart'], ['moss', 'Dr Moss'],
  ['vale', 'Dr Vale'], ['quinn', 'Dr Quinn'], ['hayes', 'Dr Hayes'], ['pike', 'Dr Pike'],
  ['shaw', 'Dr Shaw'], ['lane', 'Dr Lane'], ['cross', 'Dr Cross'], ['frost', 'Dr Frost'],
] as const;

function mulberry32(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function keyOf(v: Violation): string {
  return `${v.ruleId}|${v.staffId ?? ''}|${v.date ?? ''}|${v.message}`;
}

function sortKeys(items: Violation[]): string[] {
  return items.map(keyOf).sort();
}

function expectedFromFull(full: Violation[], scope: Set<string>): string[] {
  return sortKeys(full.filter(v => !v.staffId || scope.has(v.staffId)));
}

function midSizedProblem(): { problem: RotaProblem; assignments: Assignment[] } {
  const ids = NAMES.map(([id]) => id);
  const profile = stage2Profile(ids, ['Made-up long day', 'Made-up clinic', 'Made-up night']);
  for (let i = 0; i < NAMES.length; i++) profile.staff[i].name = NAMES[i][1];
  applyDefaultLimitRules(profile);
  expect(profile.rules.map(r => r.type).sort()).toEqual([
    'count', 'maxConsecutive', 'maxConsecutive', 'maxConsecutive', 'maxHours', 'minRest', 'restAfterBlock', 'weekendFrequency',
  ].sort());
  profile.demands = [
    { id: 'clinic-min', roleId: 'role-Made-up clinic', shiftTypeId: 'day', days: {}, min: 1, max: 6 },
    { id: 'long-max', roleId: 'role-Made-up long day', shiftTypeId: 'long', days: {}, min: 0, max: 4 },
    { id: 'night-max', roleId: 'role-Made-up night', shiftTypeId: 'night', days: {}, min: 0, max: 3 },
  ];
  profile.fairness = [{ id: 'clinic-share', name: 'Made-up clinic work', unit: 'shifts', work: { roleIds: ['role-Made-up clinic'] } }];
  const start: ISODate = '2026-11-02';
  const end: ISODate = addDays(start, 10 * 7 - 1);
  const problem: RotaProblem = { profile, start, end, fixed: [], unavailability: [] };
  const assignments: Assignment[] = [];
  const random = mulberry32(SEED);
  const dates = dateRange(start, end);
  for (const date of dates) {
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    const longPool = [...ids].sort(() => random() - 0.5).slice(0, weekday === 0 || weekday === 6 ? 1 : 2);
    for (const staffId of longPool) {
      assignments.push({ staffId, date, shiftTypeId: 'long', roleId: 'role-Made-up long day' });
    }
    if (weekday !== 0 && weekday !== 6) {
      const clinicPool = ids.filter(id => !longPool.includes(id)).sort(() => random() - 0.5).slice(0, 4);
      for (const staffId of clinicPool) {
        assignments.push({ staffId, date, shiftTypeId: 'day', roleId: 'role-Made-up clinic' });
      }
    }
    if (weekday === 1 || weekday === 4) {
      const nightStaff = ids.filter(id => !longPool.includes(id)).sort(() => random() - 0.5).slice(0, 2);
      for (const staffId of nightStaff) {
        assignments.push({ staffId, date, shiftTypeId: 'night', roleId: 'role-Made-up night' });
      }
    }
  }
  return { problem, assignments };
}

function cloneAssignments(list: Assignment[]): Assignment[] {
  return list.map(item => ({ ...item }));
}

/** Swap whole-day packs between 2–4 people (multi-person plan). */
function applyRandomPlan(assignments: Assignment[], random: () => number, staffIds: string[]): { next: Assignment[]; affected: string[] } {
  const byStaffDate = new Map<string, Assignment>();
  for (const item of assignments) byStaffDate.set(`${item.staffId}|${item.date}`, item);
  const dates = [...new Set(assignments.map(a => a.date))].sort();
  const peopleCount = 2 + Math.floor(random() * 3);
  const people = [...staffIds].sort(() => random() - 0.5).slice(0, peopleCount);
  const picks = people.map(staffId => {
    const ownDates = dates.filter(date => byStaffDate.has(`${staffId}|${date}`));
    const date = ownDates[Math.floor(random() * ownDates.length)] ?? dates[Math.floor(random() * dates.length)];
    return { staffId, date, assignment: byStaffDate.get(`${staffId}|${date}`) };
  });
  const next = cloneAssignments(assignments).filter(item => !picks.some(pick => pick.staffId === item.staffId && pick.date === item.date));
  for (let i = 0; i < picks.length; i++) {
    const giver = picks[i];
    const receiver = picks[(i + 1) % picks.length];
    if (!giver.assignment) continue;
    next.push({ ...giver.assignment, staffId: receiver.staffId, date: giver.date });
  }
  return { next, affected: people };
}

describe('scoped validation differential fuzz (findSwaps options)', () => {
  const { problem, assignments: base } = midSizedProblem();
  const staffIds = problem.profile.staff.map(s => s.id);

  it('skipping fairness never changes hard violations, gaps or soft results', () => {
    const full = validate(problem, base);
    const fast = validate(problem, base, { skipFairness: true });
    expect(sortKeys(fast.violations)).toEqual(sortKeys(full.violations));
    expect(fast.gaps).toEqual(full.gaps);
    expect(fast.soft).toEqual(full.soft);
    expect(full.fairness.length).toBeGreaterThan(0);
    expect(fast.fairness).toEqual([]);
  });

  it(`matches full validate on ${PLAN_COUNT} seeded multi-person plans, including late-horizon, 48h and weekend cases`, () => {
    const random = mulberry32(SEED ^ 0x9e3779b9);
    let current = cloneAssignments(base);

    const lateDate = problem.end;
    const lateStaff = 'hayes';
    const latePlan = cloneAssignments(current).filter(a => !(a.staffId === lateStaff && a.date >= addDays(lateDate, -6)));
    for (const date of dateRange(addDays(lateDate, -6), lateDate)) {
      latePlan.push({ staffId: lateStaff, date, shiftTypeId: 'long', roleId: 'role-Made-up long day' });
    }
    const avgPlan = cloneAssignments(current).filter(a => a.staffId !== 'rowan');
    for (const date of dateRange(problem.start, problem.end)) {
      const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
      if (weekday === 0 || weekday === 6) continue;
      avgPlan.push({ staffId: 'rowan', date, shiftTypeId: 'long', roleId: 'role-Made-up long day' });
    }
    const weekendPlan = cloneAssignments(current).filter(a => a.staffId !== 'ellis');
    for (let week = 0; week < 8; week++) {
      const saturday = addDays(problem.start, 5 + week * 7);
      weekendPlan.push({ staffId: 'ellis', date: saturday, shiftTypeId: 'long', roleId: 'role-Made-up long day' });
      weekendPlan.push({ staffId: 'ellis', date: addDays(saturday, 1), shiftTypeId: 'long', roleId: 'role-Made-up long day' });
    }

    const specials: { next: Assignment[]; affected: string[]; label: string; match: (v: Violation) => boolean }[] = [
      { next: latePlan, affected: [lateStaff, 'moss'], label: 'late-horizon', match: v => v.staffId === lateStaff && !!v.date && v.date >= addDays(lateDate, -6) },
      { next: avgPlan, affected: ['rowan', 'vale'], label: '48h-average', match: v => v.ruleId === 'contract-48' && v.staffId === 'rowan' },
      { next: weekendPlan, affected: ['ellis', 'hart'], label: 'weekend-frequency', match: v => v.ruleId === 'contract-weekends' && v.staffId === 'ellis' },
    ];

    for (const special of specials) {
      const full = validate(problem, special.next);
      const scoped = validate(problem, special.next, { scopeStaffIds: special.affected, skipFairness: true });
      expect(sortKeys(scoped.violations), special.label).toEqual(expectedFromFull(full.violations, new Set(special.affected)));
      expect(scoped.gaps, special.label).toEqual(full.gaps);
      expect(full.violations.some(special.match), `${special.label} should raise its target breach`).toBe(true);
    }

    for (let i = 0; i < PLAN_COUNT; i++) {
      const { next, affected } = applyRandomPlan(current, random, staffIds);
      const full = validate(problem, next);
      const scoped = validate(problem, next, { scopeStaffIds: affected, skipFairness: true });
      expect(sortKeys(scoped.violations), `plan ${i}`).toEqual(expectedFromFull(full.violations, new Set(affected)));
      expect(scoped.gaps, `plan ${i} gaps`).toEqual(full.gaps);
      if (i % 17 === 0) current = next;
    }
  });
});
