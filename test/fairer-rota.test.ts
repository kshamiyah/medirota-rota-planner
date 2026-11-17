import { legacySessions } from "./fixtures/legacy-sessions";

import { describe, expect, it } from 'vitest';
import { solve } from '../src/engine/solve';
import { getSummary, limitReachedNote } from '../src/app/pages/FairerRota';
import { combineFairerAssignments, fairerRemainingTimeLimit, fairerTimeLimit, findFairerMovableAssignments, prepareFairerModel, validateFairerResult } from '../src/app/fairer';
import { fairerFixture } from './fixtures/fairer-made-up';

const same = (a: { staffId: string; date: string; roleId?: string; shiftTypeId: string }, b: { staffId: string; date: string; roleId?: string; shiftTypeId: string }) => a.staffId === b.staffId && a.date === b.date && a.roleId === b.roleId && a.shiftTypeId === b.shiftTypeId;

describe('Fairer rota', () => {
  it('keeps fixed work and doctor-days, preserves place counts, and honours 0% unchanged', async () => {
    const ws = fairerFixture(4, 20);
    const start = ws.period.start, end = '2026-11-29';
    const model = prepareFairerModel(ws, start, end, 0, 'none');
    expect(model.movable.length).toBeGreaterThan(100);
    expect(model.baseline.some(item => ws.swapFinder!.snapshot.days[item.staffId]?.[item.date]?.extra)).toBe(true);
    const started = performance.now();
    const result = await solve(model.problem, { timeLimit: 60, buildOptions: model.buildOptions });
    console.info(`Fairer rota 4-week solve: ${((performance.now() - started) / 1000).toFixed(2)}s`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const assignments = combineFairerAssignments(model, result.assignments);
    expect(validateFairerResult(model, assignments)).toBeUndefined();
    for (const item of model.movable) expect(assignments.some(next => same(item, next))).toBe(true);
    for (const item of model.baseline.filter(item => !model.movable.some(move => same(move, item)))) expect(assignments.some(next => same(item, next))).toBe(true);
    const doctorDays = new Set(model.movable.map(item => `${item.staffId}|${item.date}`));
    for (const day of doctorDays) expect(assignments.filter(item => `${item.staffId}|${item.date}` === day && !item.fixed && model.typeForRole[item.roleId ?? '']).length).toBe(1);
    const beforeSlots = new Map<string, number>();
    const afterSlots = new Map<string, number>();
    for (const item of model.movable) { const slot = `${model.placeForRole[item.roleId!]}|${item.date}`; beforeSlots.set(slot, (beforeSlots.get(slot) ?? 0) + 1); }
    for (const item of assignments.filter(item => !item.fixed && model.typeForRole[item.roleId ?? ''])) { const slot = `${model.placeForRole[item.roleId!]}|${item.date}`; afterSlots.set(slot, (afterSlots.get(slot) ?? 0) + 1); }
    expect([...afterSlots.entries()].sort()).toEqual([...beforeSlots.entries()].sort());
  }, 120_000);

  it('works out ratio aims by hand using group capacity across movable day sessions', () => {
    const ws = fairerFixture(1, 3);
    ws.profile.groups = [{ id: 'fy2', name: 'FY2' }, { id: 'gpreg', name: 'GP Reg' }, { id: 'st1', name: 'ST1' }];
    ws.profile.staff = ws.profile.staff.map((person, index) => ({ ...person, locum: false, regularLocum: false, groupIds: [[ 'fy2', 'gpreg', 'st1' ][index]!] }));
    ws.sessions = legacySessions(ws.profile);
    const snap = ws.swapFinder!.snapshot;
    snap.days = Object.fromEntries(ws.profile.staff.map(person => [person.id, {}]));
    const theatre = ws.sessions.types.find(type => type.name === 'Theatre')!;
    ws.sessions.ratios[theatre.id] = { 'session-group-fy2': 2, 'session-group-gps': 1, 'session-group-st12': 1 };
    const assign = (staff: number, day: number, activity: string) => { snap.days[`fairer-doctor-${staff}`]![`2026-11-${String(day).padStart(2, '0')}`] = { status: 'dayJob', activity, sessions: ['am', 'pm'] }; };
    assign(0, 2, 'Elective C-Sections'); assign(0, 3, 'Elective C-Sections');
    assign(1, 2, 'Elective C-Sections'); assign(1, 3, 'Postnatal Wards CT'); assign(1, 4, 'Postnatal Wards CT'); assign(1, 5, 'Postnatal Wards CT');
    assign(2, 2, 'Elective C-Sections'); assign(2, 3, 'Postnatal Wards CT');
    const baseModel = prepareFairerModel(ws, '2026-11-02', '2026-11-08', 100, 'none');
    const baseSummary = getSummary(baseModel, baseModel.movable, ws);
    const noGroup = { id: 'fairer-unassigned', name: 'Dr Cedar', groupIds: [], fte: 1 };
    ws.profile.staff.push(noGroup);
    snap.days[noGroup.id] = { '2026-11-06': { status: 'dayJob', activity: 'Elective C-Sections', sessions: ['am', 'pm'] } };
    const model = prepareFairerModel(ws, '2026-11-02', '2026-11-08', 100, 'none');
    const summary = getSummary(model, model.movable, ws);
    const theatreRows = summary.filter(row => row.typeId === theatre.id);
    // Capacities are Rowan 2, Ellis 4, Hart 2. With ratios 2:1:1, weights are 4:4:2.
    // Four Theatre sessions therefore aim for 1.6, 1.6 and 0.8.
    expect(theatreRows.map(row => row.before)).toEqual([2, 1, 1]);
    expect(theatreRows[0]!.aim).toBeCloseTo(1.6);
    expect(theatreRows[1]!.aim).toBeCloseTo(1.6);
    expect(theatreRows[2]!.aim).toBeCloseTo(0.8);
    expect(theatreRows.map(row => row.capacity ? Math.round(row.before / row.capacity * 100) : 0)).toEqual([100, 25, 50]);
    expect(theatreRows.map(row => row.capacity ? Math.round(row.aim / row.capacity * 100) : 0)).toEqual([80, 40, 40]);
    expect(summary.map(row => [row.typeId, row.groupId, row.aim])).toEqual(baseSummary.map(row => [row.typeId, row.groupId, row.aim]));
    expect(model.problem.profile.fairness.every(dimension => !dimension.who?.staffIds?.includes(noGroup.id))).toBe(true);
  });

  it('keeps the baseline when it already meets the ratios, before considering changes', async () => {
    const ws = fairerFixture(1, 2);
    ws.profile.staff = ws.profile.staff.map((person, index) => ({ ...person, locum: false, regularLocum: false, groupIds: [index === 0 ? 'fy2' : 'gpreg'] }));
    ws.profile.groups = [{ id: 'fy2', name: 'FY2' }, { id: 'gpreg', name: 'GP Reg' }];
    ws.sessions = legacySessions(ws.profile);
    const theatre = ws.sessions.types.find(type => type.name === 'Theatre')!;
    const wards = ws.sessions.types.find(type => type.name === 'Wards')!;
    theatre.placeIds = ['fairer-place-0', 'fairer-place-1'];
    wards.placeIds = [];
    const snapshot = ws.swapFinder!.snapshot;
    snapshot.days = Object.fromEntries(ws.profile.staff.map(person => [person.id, {}]));
    for (const date of ['2026-11-02', '2026-11-03']) {
      snapshot.days['fairer-doctor-0']![date] = { status: 'dayJob', activity: 'Elective C-Sections', sessions: ['am','pm'] };
      snapshot.days['fairer-doctor-1']![date] = { status: 'dayJob', activity: 'Postnatal Wards CT', sessions: ['am','pm'] };
    }
    const model = prepareFairerModel(ws, '2026-11-02', '2026-11-03', 100, 'none');
    const result = await solve(model.problem, { timeLimit: 15, buildOptions: model.buildOptions });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(model.movable.every(item => result.assignments.some(next => same(item, next)))).toBe(true);
    expect(validateFairerResult(model, combineFairerAssignments(model, result.assignments))).toBeUndefined();
  }, 30_000);

  it('sets ordered ratio, place-run and fewest-change objectives, with a change ceiling', () => {
    const ws = fairerFixture(4, 20);
    const model = prepareFairerModel(ws, ws.period.start, '2026-11-29', 20, 2);
    expect(model.problem.profile.tierOrder).toEqual(['fairness', 'preference', 'extra']);
    expect(model.problem.profile.fairness).toHaveLength(4);
    expect(model.problem.profile.rules.every(rule => rule.type === 'maxConsecutive' && rule.maxDays === 2 && rule.tier === 'preference')).toBe(true);
    expect(model.buildOptions.additionalObjectives?.[0]?.tier).toBe('extra');
    const limit = model.buildOptions.additionalRows?.at(-1);
    expect(limit?.lower).toBe(model.movable.length - Math.floor(model.movable.length * 0.2));
    const noLimit = prepareFairerModel(ws, ws.period.start, '2026-11-29', 20, 'none');
    expect(noLimit.problem.profile.rules).toEqual([]);
  });

  it('leaves split-place doctor-days, extras and locums fixed, and limits the date range', () => {
    const ws = fairerFixture(4, 20);
    const settings = ws.sessions!;
    const snapshot = ws.swapFinder!.snapshot;
    const roles = ws.profile.roles;
    const placeForRole = Object.fromEntries(roles.map(role => [role.id, role.parentId ?? role.id]));
    const typeForRole = Object.fromEntries(roles.map(role => [role.id, settings.types.find(type => type.placeIds.includes(role.id))?.id]).filter(([, typeId]) => typeId));
    const date = '2026-11-10';
    const single = { staffId: 'fairer-doctor-1', date, roleId: roles[0]!.id, shiftTypeId: 'day' };
    const split = [
      { ...single, staffId: 'fairer-doctor-2', roleId: roles[0]!.id },
      { ...single, staffId: 'fairer-doctor-2', roleId: roles[1]!.id },
    ];
    snapshot.days['fairer-doctor-2']![date] = { status: 'dayJob', activity: 'Elective C-Sections', sessions: ['am', 'pm'] };
    snapshot.days['fairer-doctor-3']![date] = { status: 'dayJob', activity: 'Elective C-Sections', sessions: ['am', 'pm'], extra: true };
    const locum = { ...single, staffId: 'fairer-doctor-19' };
    const movable = findFairerMovableAssignments([single, ...split, { ...single, staffId: 'fairer-doctor-3' }, locum], snapshot, ws.profile, settings, {}, placeForRole, typeForRole);
    expect(movable).toEqual([single]);
    const model = prepareFairerModel(ws, '2026-11-09', '2026-11-15', 100, 'none');
    expect(model.dates).toEqual(['2026-11-09','2026-11-10','2026-11-11','2026-11-12','2026-11-13','2026-11-14','2026-11-15']);
    expect(model.movable.every(item => !ws.profile.staff.find(person => person.id === item.staffId)?.locum)).toBe(true);
  });

  it('applies the selected consecutive-days aim after fairness', async () => {
    const ws = fairerFixture(4, 20);
    const noLimit = prepareFairerModel(ws, ws.period.start, '2026-11-29', 100, 'none');
    const limited = prepareFairerModel(ws, ws.period.start, '2026-11-29', 100, 2);
    const result = await solve(limited.problem, { timeLimit: 15, buildOptions: limited.buildOptions });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const longest = (assignments: typeof result.assignments, model: typeof limited) => {
      const staffIds = new Set(model.movable.map(item => item.staffId));
      let longestRun = 0;
      for (const staffId of staffIds) {
        let run = 0, place = '';
        for (const date of model.dates) {
          const current = assignments.find(item => item.staffId === staffId && item.date === date && !item.fixed && item.roleId && model.typeForRole[item.roleId]);
          const next = current?.roleId ? model.placeForRole[current.roleId] : '';
          if (next && next === place) run++; else if (next) { place = next; run = 1; } else { place = ''; run = 0; }
          longestRun = Math.max(longestRun, run);
        }
      }
      return longestRun;
    };
    expect(noLimit.problem.profile.rules).toEqual([]);
    expect(limited.problem.profile.rules.length).toBeGreaterThan(0);
    const before = longest(limited.movable, limited), after = longest(result.assignments, limited);
    console.info(`Place run limit: ${before} → ${after}`);
    expect(after).toBeLessThan(before);
  }, 30_000);

  it('solves a thirteen-week, thirty-doctor made-up rota in under sixty seconds', async () => {
    const ws = fairerFixture(13, 30);
    const started = performance.now();
    const model = prepareFairerModel(ws, ws.period.start, ws.period.end, 20, 'none');
    const setupSeconds = (performance.now() - started) / 1000;
    const result = await solve(model.problem, { timeLimit: fairerRemainingTimeLimit(13, setupSeconds), buildOptions: model.buildOptions });
    const totalSeconds = (performance.now() - started) / 1000;
    console.info(`Fairer rota 13-week setup: ${setupSeconds.toFixed(2)}s; total: ${totalSeconds.toFixed(2)}s`);
    expect(totalSeconds).toBeLessThanOrEqual(fairerTimeLimit(13) + 3);
    expect(result.ok).toBe(true);
    if (result.ok) expect(validateFairerResult(model, combineFairerAssignments(model, result.assignments))).toBeUndefined();
  }, 75_000);

  it('keeps part shifts, training, zero days and unmapped places fixed, and only notes a positive change limit', () => {
    const ws = fairerFixture(2, 12);
    const snapshot = ws.swapFinder!.snapshot;
    const date = '2026-11-10';
    snapshot.days['fairer-doctor-4']![date] = { status: 'partShift', activity: 'Float CT', sessions: ['am'] };
    snapshot.days['fairer-doctor-5']![date] = { status: 'training', activity: 'Teaching' };
    snapshot.days['fairer-doctor-6']![date] = { status: 'zero', activity: 'Zero Day' };
    snapshot.days['fairer-doctor-7']![date] = { status: 'dayJob', activity: 'Unmapped Clinic', sessions: ['am', 'pm'] };
    const model = prepareFairerModel(ws, '2026-11-09', '2026-11-15', 20, 3);
    const movableKeys = new Set(model.movable.map(item => `${item.staffId}|${item.date}`));
    expect(movableKeys.has(`fairer-doctor-4|${date}`)).toBe(false);
    expect(movableKeys.has(`fairer-doctor-5|${date}`)).toBe(false);
    expect(movableKeys.has(`fairer-doctor-6|${date}`)).toBe(false);
    expect(movableKeys.has(`fairer-doctor-7|${date}`)).toBe(false);
    expect(model.problem.profile.rules.every(rule => rule.type === 'maxConsecutive' && rule.maxDays === 3)).toBe(true);
    expect(prepareFairerModel(ws, '2026-11-09', '2026-11-15', 20, 4).problem.profile.rules.every(rule => rule.type === 'maxConsecutive' && rule.maxDays === 4)).toBe(true);
    expect(limitReachedNote(0, 0, 0)).toBe(false);
    expect(limitReachedNote(20, 57, 57)).toBe(true);
    expect(limitReachedNote(20, 10, 57)).toBe(false);
    expect(limitReachedNote(100, 57, 57)).toBe(false);
    expect(limitReachedNote('none', 257, 257)).toBe(false);
    const unlimited = prepareFairerModel(ws, '2026-11-09', '2026-11-15', 'none', 2);
    const percent = prepareFairerModel(ws, '2026-11-09', '2026-11-15', 100, 2);
    expect(unlimited.maxChanges).toBe(unlimited.movable.length);
    expect(unlimited.buildOptions.additionalRows).toHaveLength((percent.buildOptions.additionalRows?.length ?? 0) - 1);
    expect(unlimited.buildOptions.additionalObjectives?.some(objective => objective.tier === 'extra')).toBe(true);
  });

  it('keeps MediRota and suggestion shares near 100% across day types for each group', async () => {
    const ws = fairerFixture(1, 9);
    const theatre = ws.sessions!.types.find(type => type.name === 'Theatre')!;
    ws.sessions!.ratios[theatre.id] = { 'session-group-fy2': 2, 'session-group-gps': 1, 'session-group-st12': 1 };
    const model = prepareFairerModel(ws, ws.period.start, ws.period.end, 50, 'none');
    const result = await solve(model.problem, { timeLimit: 15, buildOptions: model.buildOptions });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const summary = getSummary(model, combineFairerAssignments(model, result.assignments), ws);
    for (const groupId of [...new Set(summary.map(row => row.groupId))]) {
      const rows = summary.filter(row => row.groupId === groupId);
      const capacity = rows[0]?.capacity ?? 0;
      if (!capacity) continue;
      const before = rows.reduce((sum, row) => sum + row.before / capacity, 0);
      const after = rows.reduce((sum, row) => sum + row.after / capacity, 0);
      expect(before).toBeCloseTo(1, 5);
      expect(after).toBeCloseTo(1, 5);
    }
  }, 30_000);
});
