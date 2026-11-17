import { describe, expect, it } from 'vitest';
import { solve } from '../src/engine/solve';
import { validate } from '../src/engine/validate';
import type { Profile, RotaProblem, Rule } from '../src/engine/types';

// Two C-Section lists a day: Mr A on Mon/Wed/Fri, Ms B on Tue/Thu; plus a ward. Three juniors.
function problem(rules: Rule[]): RotaProblem {
  const profile: Profile = {
    name: 't',
    shiftTypes: [{ id: 'D', name: 'Day', start: '08:00', end: '17:00' }],
    roles: [
      { id: 'cs', name: 'C-Sections', category: 'Theatre' },
      { id: 'cs-a', name: 'C-Sections – A', parentId: 'cs', leadIds: ['a'] },
      { id: 'cs-b', name: 'C-Sections – B', parentId: 'cs', leadIds: ['b'] },
      { id: 'ward', name: 'Ward' },
    ],
    leads: [{ id: 'a', name: 'Mr A' }, { id: 'b', name: 'Ms B' }],
    groups: [],
    staff: ['j1', 'j2', 'j3'].map(id => ({ id, name: id, groupIds: [], fte: 1 })),
    demands: [
      { id: 'a', roleId: 'cs-a', shiftTypeId: 'D', days: { weekdays: [0, 2, 4] }, min: 1, max: 1 },
      { id: 'b', roleId: 'cs-b', shiftTypeId: 'D', days: { weekdays: [1, 3] }, min: 1, max: 1 },
      { id: 'w', roleId: 'ward', shiftTypeId: 'D', days: { weekdays: [0, 1, 2, 3, 4] }, min: 2, max: 2 },
    ],
    rules,
    fairness: [],
  };
  return { profile, start: '2026-11-02', end: '2026-11-13', unavailability: [], fixed: [] };
}
const cs = (as: { roleId?: string; staffId: string }[], who: string, list?: string) =>
  as.filter(a => a.staffId === who && (list ? a.roleId === list : a.roleId?.startsWith('cs'))).length;

describe('consultant lists', () => {
  it('count as their parent place for existing rules', async () => {
    // "j1 can't work C-Sections" must keep j1 off both consultants' lists.
    const p = problem([{ id: 'f', name: '', type: 'forbid', hard: true, who: { staffIds: ['j1'] }, work: { roleIds: ['cs'] } }]);
    const res = await solve(p, { timeLimit: 20 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(cs(res.assignments, 'j1')).toBe(0);
    expect(validate(p, res.assignments).violations).toEqual([]);
  });

  it('pairing puts a junior on their consultant\'s lists', async () => {
    const p = problem([{ id: 'w', name: '', type: 'workWith', hard: false, who: { staffIds: ['j2'] }, work: { roleIds: ['cs'] }, leadIds: ['b'] }]);
    const res = await solve(p, { timeLimit: 20 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(cs(res.assignments, 'j2', 'cs-b')).toBe(4); // every Ms B list in the fortnight
  });

  it('fewest consultants keeps each junior with one consultant', async () => {
    const p = problem([{ id: 'f', name: '', type: 'fewLeads', hard: false, work: { roleIds: ['cs'] } }]);
    const res = await solve(p, { timeLimit: 20 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    for (const j of ['j1', 'j2', 'j3']) {
      const lists = new Set(res.assignments.filter(a => a.staffId === j && a.roleId?.startsWith('cs-')).map(a => a.roleId));
      expect(lists.size).toBeLessThanOrEqual(1);
    }
  });
});
