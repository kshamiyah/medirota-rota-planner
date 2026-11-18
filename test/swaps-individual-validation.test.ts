import { describe, expect, it } from 'vitest';
import { validate } from '../src/engine/validate';
import { stage7Fixture } from './swaps-stage7-fixture';
import { findSwaps } from '../src/engine/swaps';

describe('individual swap validation', () => {
  it('matches the full validator for every checked person on every stage 7 fixture', () => {
    for (const kind of ['sameAt', 'sameAbove', 'sameBelow', 'weekend', 'bankHoliday', 'only', 'excluded', 'regular', 'morning', 'afternoon', 'noSessions', 'training', 'threeWay', 'requesterTraining', 'nightDate', 'mandatoryRest', 'recommendedRest', 'ranking', 'mixed', 'paging'] as const) {
      const { ws, request } = stage7Fixture(kind);
      const { snapshot, settings } = ws.swapFinder!;
      const result = findSwaps(ws.profile, snapshot, settings, request);
      const assignmentByStaff = new Map<string, Parameters<typeof validate>[1]>();
      for (const plan of result.plans.slice(0, 3)) {
        const movements = plan.chains.flatMap(chain => chain.links.map((link, index) => ({ from: link.staffId, to: chain.links[(index + 1) % chain.links.length].staffId, unit: link.gives })));
        for (const staffId of new Set(movements.flatMap(move => [move.from, move.to]))) {
          const baseline = [...(assignmentByStaff.get(staffId) ?? [])];
          const removed = new Set(movements.filter(move => move.from === staffId).flatMap(move => move.unit.dates));
          const assignments = baseline.filter(item => !removed.has(item.date));
          for (const move of movements.filter(item => item.to === staffId)) {
            for (const date of move.unit.dates) {
              const day = snapshot.days[move.from]?.[date];
              const shiftTypeId = day?.status === 'night' ? 'night' : day?.status === 'longDay' ? 'long' : 'day';
              const roleId = day?.activity === 'Night cover' ? 'night' : day?.activity === 'Long cover' ? 'long' : 'day';
              assignments.push({ staffId, date, shiftTypeId, roleId });
            }
          }
          assignmentByStaff.set(staffId, assignments);
          const full = validate({ start: ws.period.start, end: ws.period.end, profile: ws.profile, fixed: [], unavailability: [] }, assignments, { staffIds: [staffId] });
          const fast = validate({ start: ws.period.start, end: ws.period.end, profile: ws.profile, fixed: [], unavailability: [] }, assignments, { staffIds: [staffId], individualOnly: true });
          expect(fast.violations.filter(v => v.staffId === staffId), `${kind}: ${staffId}`).toEqual(full.violations.filter(v => v.staffId === staffId));
        }
      }
    }
  });
});
