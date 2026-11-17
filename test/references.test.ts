import { describe, expect, it } from 'vitest';
import { removePerson, usesOf } from '../src/app/references';
import type { Workspace } from '../src/app/store';

function ws(): Workspace {
  return {
    version: 1,
    staffExtras: { a: { nonWorkingWeekdays: [4] } },
    period: { start: '2026-11-02', end: '2026-11-08' },
    unavailability: [{ staffId: 'a', date: '2026-11-03', reason: 'Annual leave' }],
    fixed: [{ staffId: 'a', date: '2026-11-04', shiftTypeId: 'N' }],
    profile: {
      name: 't',
      shiftTypes: [{ id: 'AM', name: 'AM', start: '08:00', end: '13:00' }, { id: 'N', name: 'Night', start: '20:00', end: '08:00' }],
      roles: [{ id: 'mau', name: 'MAU' }, { id: 'epu', name: 'EPU' }],
      groups: [{ id: 'fy', name: 'FY2' }],
      staff: [{ id: 'a', name: 'Dr A', groupIds: ['fy'], fte: 1 }, { id: 'b', name: 'Dr B', groupIds: [], fte: 1 }],
      demands: [{ id: 'd', roleId: 'mau', shiftTypeId: 'AM', days: {}, min: 1, max: 1 }],
      rules: [
        { id: 'n4', name: 'Max 4 nights', type: 'maxConsecutive', hard: true, work: { shiftTypeIds: ['N'] }, maxDays: 4 },
        { id: 'aEpu', name: 'Dr A: more EPU', type: 'preference', hard: false, who: { staffIds: ['a'] }, work: { roleIds: ['epu'] }, direction: 'more' },
        { id: 'ab', name: 'A and B no MAU Mondays', type: 'forbid', hard: true, who: { staffIds: ['a', 'b'] }, work: { roleIds: ['mau'] }, days: { weekdays: [0] } },
        { id: 'fyA', name: 'FY and A', type: 'forbid', hard: true, who: { groupIds: ['fy'], staffIds: ['a'] }, work: {} },
      ],
      fairness: [],
    },
    rota: { assignments: [{ staffId: 'a', date: '2026-11-02', shiftTypeId: 'AM', roleId: 'mau' }, { staffId: 'b', date: '2026-11-03', shiftTypeId: 'AM', roleId: 'mau' }], stages: [], seconds: 1, createdAt: '', locked: ['a|2026-11-02|AM|mau'] },
  };
}

describe('what uses what', () => {
  it('finds rules that use a shift, even with no staffing need', () => {
    expect(usesOf(ws(), 'shift', 'N')).toEqual(['rule: "Max 4 nights"', 'booked shifts']);
  });
  it('finds rules that use a place', () => {
    expect(usesOf(ws(), 'place', 'epu')).toEqual(['rule: "Dr A: more EPU"']);
    expect(usesOf(ws(), 'place', 'mau')[0]).toContain('"A and B no MAU Mondays"');
  });
  it('reports nothing for an unused item', () => {
    const w = ws();
    w.profile.shiftTypes.push({ id: 'PM', name: 'PM', start: '13:00', end: '17:00' });
    expect(usesOf(w, 'shift', 'PM')).toEqual([]);
  });
});

describe('removing a place everywhere', () => {
  it('removes needs, booked shifts and rota shifts, and never widens a rule', async () => {
    const { removePlace, previewRemovePlace } = await import('../src/app/references');
    const w = ws();
    w.fixed.push({ staffId: 'b', date: '2026-11-05', shiftTypeId: 'AM', roleId: 'mau' });
    w.profile.demands.push({ id: 'once', roleId: 'mau', shiftTypeId: 'AM', days: { dates: ['2026-11-06'] }, min: 0, max: 0 });
    w.profile.rules.push(
      { id: 'mauNight', name: 'FY no MAU nights', type: 'forbid', hard: true, who: { groupIds: ['fy'] }, work: { roleIds: ['mau'], shiftTypeIds: ['N'] } },
      { id: 'mauOrEpu', name: 'No MAU or EPU Fridays', type: 'forbid', hard: true, work: { roleIds: ['mau', 'epu'] }, days: { weekdays: [4] } },
      { id: 'link', name: 'MAU full day', type: 'linkShifts', hard: true, roleId: 'mau', shiftTypeIds: ['AM', 'N'] },
      { id: 'pair', name: 'Pair MAU with EPU', type: 'pairPreference', hard: false, a: { roleIds: ['mau'] }, b: { roleIds: ['epu'] } },
    );
    const before = structuredClone(w);
    const preview = previewRemovePlace(w, 'mau');
    expect(w).toEqual(before); // preview changes nothing

    const s = removePlace(w, 'mau');
    expect(s).toEqual(preview);
    expect(s.needs).toBe(2);
    expect(s.booked).toBe(1);
    expect(s.rotaShifts).toBe(2);
    // Rules only about MAU are deleted (not widened to "any place")...
    expect(s.rulesDeleted.sort()).toEqual(['A and B no MAU Mondays', 'FY no MAU nights', 'MAU full day', 'Pair MAU with EPU'].sort());
    // ...rules naming other places just lose MAU.
    expect(s.rulesChanged).toEqual(['No MAU or EPU Fridays']);
    const kept = w.profile.rules.find(r => r.id === 'mauOrEpu');
    expect(kept && kept.type === 'forbid' && kept.work.roleIds).toEqual(['epu']);
    expect(w.profile.roles.map(r => r.id)).toEqual(['epu']);
    expect(w.profile.demands).toEqual([]);
    expect(w.fixed.some(f => f.roleId === 'mau')).toBe(false);
    expect(w.rota!.assignments).toEqual([]);
    expect(w.rota!.locked).toEqual([]);
  });
});

describe('removing a shift everywhere', () => {
  it('deletes rules that were limited to it instead of widening them', async () => {
    const { removeShift, previewRemoveShift } = await import('../src/app/references');
    const w = ws();
    w.unavailability.push({ staffId: 'b', date: '2026-11-05', shiftTypeIds: ['N'], reason: 'Teaching' });
    w.unavailability.push({ staffId: 'b', date: '2026-11-06', shiftTypeIds: ['N', 'AM'], reason: 'Teaching' });
    w.profile.rules.push({ id: 'mauAnyShift', name: 'MAU limit', type: 'count', hard: true, work: { roleIds: ['mau'], shiftTypeIds: ['AM', 'N'] }, period: 'week', unit: 'shifts', max: 3 });
    const before = structuredClone(w);
    const preview = previewRemoveShift(w, 'N');
    expect(w).toEqual(before);
    const s = removeShift(w, 'N');
    expect(s).toEqual(preview);
    // "Max 4 nights" must not become "max 4 days of anything".
    expect(s.rulesDeleted).toEqual(['Max 4 nights']);
    expect(s.rulesChanged).toEqual(['MAU limit']);
    expect(s.booked).toBe(1);
    expect(s.leave).toBe(1);
    expect(w.unavailability.find(u => u.date === '2026-11-06')!.shiftTypeIds).toEqual(['AM']);
    expect(w.profile.shiftTypes.map(x => x.id)).toEqual(['AM']);
  });
});

describe('removing a group everywhere', () => {
  it('takes it off people and deletes rules only for that group', async () => {
    const { removeGroup } = await import('../src/app/references');
    const w = ws();
    w.profile.rules.push({ id: 'fyOnly', name: 'FY no nights', type: 'forbid', hard: true, who: { groupIds: ['fy'] }, work: { shiftTypeIds: ['N'] } });
    const s = removeGroup(w, 'fy');
    expect(s.people).toBe(1);
    // A rule only for FY must not start applying to everyone.
    expect(s.rulesDeleted).toEqual(['FY no nights']);
    // "FY and A" still names Dr A, so it stays, just without the group.
    expect(s.rulesChanged).toEqual(['FY and A']);
    expect(w.profile.staff.find(x => x.id === 'a')!.groupIds).toEqual([]);
    expect(w.profile.groups).toEqual([]);
  });
});

describe('removing a person', () => {
  it('cleans up leave, booked shifts, the rota and rules', () => {
    const w = ws();
    const deleted = removePerson(w, 'a');
    expect(deleted).toEqual(['Dr A: more EPU']); // only about Dr A: deleted, not left applying to everyone
    expect(w.profile.rules.map(r => r.id)).toEqual(['n4', 'ab', 'fyA']);
    expect(w.profile.rules.find(r => r.id === 'ab')!.who).toEqual({ staffIds: ['b'] });
    expect(w.profile.rules.find(r => r.id === 'fyA')!.who).toEqual({ groupIds: ['fy'], staffIds: [] });
    expect(w.unavailability).toEqual([]);
    expect(w.fixed).toEqual([]);
    expect(w.staffExtras).toEqual({});
    expect(w.rota!.assignments.map(a => a.staffId)).toEqual(['b']);
    expect(w.rota!.locked).toEqual([]);
    expect(w.rota!.edited).toBe(true);
  });
});
