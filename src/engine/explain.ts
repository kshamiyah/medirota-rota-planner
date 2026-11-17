/**
 * Plain-language reasons why a slot is still empty: for each person, what would
 * stop them taking it. Built on the validator, so the reasons are exactly the
 * rules that would be broken.
 */
import { indexProfile, shiftInterval } from './calendar';
import type { Assignment, RotaProblem } from './types';
import { validate, type CoverageGap } from './validate';
import { withEmploymentDates } from './semantics';

export interface GapExplanation {
  gap: CoverageGap;
  candidates: { staffId: string; reasons: string[] }[];
}

export function explainGaps(input: RotaProblem, assignments: Assignment[], gaps: CoverageGap[]): GapExplanation[] {
  const problem = withEmploymentDates(input);
  const idx = indexProfile(problem.profile);
  const baseline = new Map<string, Set<string>>();
  const keyOf = (v: { ruleId: string; date?: string; message: string }) => `${v.ruleId}|${v.date}|${v.message}`;

  return gaps.map(gap => {
    const st = idx.shiftTypes.get(gap.shiftTypeId)!;
    const slot = shiftInterval(gap.date, st);
    const candidates = problem.profile.staff.map(s => {
      const off = problem.unavailability.find(u => u.staffId === s.id && u.date === gap.date && (!u.shiftTypeIds || u.shiftTypeIds.includes(gap.shiftTypeId)));
      if (off) return { staffId: s.id, reasons: [`Unavailable${off.reason ? ` (${off.reason})` : ''}`] };
      const busy = assignments.find(a => {
        if (a.staffId !== s.id) return false;
        const t = shiftInterval(a.date, idx.shiftTypes.get(a.shiftTypeId)!);
        return t.start < slot.end && slot.start < t.end;
      });
      if (busy) return { staffId: s.id, reasons: [`Already working: ${busy.roleId ? idx.roles.get(busy.roleId)?.name : 'outside commitment'} (${idx.shiftTypes.get(busy.shiftTypeId)?.name} ${busy.date})`] };
      if (!baseline.has(s.id)) baseline.set(s.id, new Set(validate(problem, assignments, { staffIds: [s.id] }).violations.map(keyOf)));
      const trial = [...assignments, { staffId: s.id, date: gap.date, shiftTypeId: gap.shiftTypeId, roleId: gap.roleId }];
      const added = validate(problem, trial, { staffIds: [s.id] }).violations.filter(v => !baseline.get(s.id)!.has(keyOf(v)) && v.staffId === s.id);
      const reasons = [...new Set(added.map(v => v.ruleName))];
      return { staffId: s.id, reasons: reasons.length > 0 ? reasons : ['No rule blocks this on its own (the solver needed them elsewhere)'] };
    });
    return { gap, candidates };
  });
}
