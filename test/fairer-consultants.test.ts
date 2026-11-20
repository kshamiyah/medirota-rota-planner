import { legacySessions } from "./fixtures/legacy-sessions";

import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { solve } from '../src/engine/solve';
import { allocateFairerConsultants, consultantReport, combineFairerAssignments, fairerConsultantBudget, fairerFallbackNote, fairerProgressPercent, fairerRemainingTimeLimit, fairerTimeLimit, fairnessAllowanceNote, fairnessWithinAllowance, prepareFairerModel, validateFairerResult } from '../src/app/fairer';
import { applyPresetToWorkspace, makePresetFromWorkspace } from '../src/app/presets';
import { analyseSessions, gradeSessionRates } from '../src/app/sessions';
import { FairerConsultantOutcome, FairerRatiosTable, favouredRatioHeadline, fairerChangeLimitHint, fairerConsultantSetting, fairerCountLabel, fairerGridInitialState, fairerSettingsCollapsed, fairerSettingsLine, fairerWeekAnchorDate, fairerWeekHeaderId, fairerWeekOptions, fairerWeekScrollTarget, getSummary, SameConsultantsControl, showFairerConsultantCard } from '../src/app/pages/FairerRota';
import { attachMadeUpConsultantLists, fairerConsultantBenchmarkFixture, fairerConsultantFixture, fairerFixture } from './fixtures/fairer-made-up';
import { dateRange, weekday } from '../src/engine/calendar';
import type { Assignment } from '../src/engine/types';

function bestConsultantFixture() {
  const ws = fairerFixture(2, 5);
  ws.profile.staff = ws.profile.staff.map((person, index) => ({ ...person, groupIds: [index < 3 ? 'st1' : 'fy2'], locum: false, regularLocum: false }));
  const theatre = ws.sessions!.types.find(type => type.name === 'Theatre')!;
  ws.sessions!.sameConsultants = { groupIds: ['session-group-st12'], typeIds: [theatre.id] };
  ws.profile.leads = [{ id: 'c1', name: 'Mr Vale' }, { id: 'c2', name: 'Ms Quinn' }, { id: 'c3', name: 'Mr Hart' }];
  const people = ws.profile.staff;
  const pattern = ['Mr Vale', 'Mr Vale', 'Ms Quinn', 'Ms Quinn', 'Mr Hart'];
  ws.consultantLists = [];
  for (const [dayIndex, date] of dateRange(ws.period.start, ws.period.end).filter(date => weekday(date) < 5).entries()) {
    for (const person of people) ws.swapFinder!.snapshot.days[person.id]![date] = { status: 'dayJob', activity: 'Elective C-Sections', sessions: ['am', 'pm'] };
    for (let index = 0; index < people.length; index++) {
      const person = people[(index + dayIndex) % people.length]!;
      ws.consultantLists.push({ date, placeId: 'fairer-place-0', activity: 'Elective C-Sections', session: 'am', staffIds: [person.id], consultants: [pattern[index]!], unmatched: 0 });
    }
  }
  ws.me = 'fairer-doctor-0';
  return ws;
}

describe('Fairer rota consultant lists', () => {
  it('indexes and solves a 20-week, 40-doctor list rota within its total time budget', async () => {
    const ws = fairerFixture(20, 40);
    const workDates = dateRange(ws.period.start, ws.period.end).filter(date => weekday(date) <= 4);
    for (const days of Object.values(ws.swapFinder!.snapshot.days)) for (const date of workDates) days[date] = { status: 'blank' };
    for (let index = 0; index < 551; index++) {
      const dateIndex = Math.floor(index / 6), slot = index % 6, date = workDates[dateIndex]!;
      const staffIndex = (dateIndex * 7 + slot * 11) % ws.profile.staff.length;
      const person = ws.profile.staff[staffIndex]!;
      const typeIndex = (staffIndex + Math.floor(dateIndex / 5)) % 4;
      const activity = ['Elective C-Sections', 'Postnatal Wards CT', 'MAU CT', 'Float CT'][typeIndex]!;
      ws.swapFinder!.snapshot.days[person.id]![date] = { status: 'dayJob', activity, sessions: ['am', 'pm'] };
    }
    attachMadeUpConsultantLists(ws);
    const start = performance.now();
    const model = prepareFairerModel(ws, ws.period.start, ws.period.end, 'none', 'none', true);
    const setupSeconds = (performance.now() - start) / 1000;
    const solveStarted = performance.now();
    const result = await solve(model.problem, { timeLimit: fairerRemainingTimeLimit(20, setupSeconds), buildOptions: model.buildOptions,
      afterTier: (tier, assignments, context) => tier === 'fairness' ? allocateFairerConsultants(model, assignments, context.remainingSeconds, context.reportProgress, context.tierObjective) : Promise.resolve(undefined) });
    const solveSeconds = (performance.now() - solveStarted) / 1000;
    process.stdout.write(`Fairer rota 20-week 40-doctor setup with lists: ${setupSeconds.toFixed(2)}s; solver: ${solveSeconds.toFixed(2)}s; fallback: ${result.ok ? result.debug?.consultantFallbackCheck ?? 'none' : result.reason}\n`);
    expect(model.consultantPlan.enabled).toBe(true);
    expect(setupSeconds).toBeLessThan(10);
    expect(result.ok).toBe(true);
    expect(setupSeconds + solveSeconds).toBeLessThanOrEqual(fairerTimeLimit(20));
    if (result.ok) expect(result.debug?.consultantFallbackCheck).toBeUndefined();
    expect(fairerTimeLimit(9)).toBe(60);
    expect(fairerTimeLimit(13)).toBe(60);
    expect(fairerTimeLimit(20)).toBe(165);
    expect(fairerTimeLimit(30)).toBe(180);
    expect(fairerRemainingTimeLimit(20, 4)).toBe(160);
    expect(fairerConsultantBudget(40)).toBe(26);
    expect(fairerConsultantBudget(40)).toBeGreaterThanOrEqual(40 * 0.25);
  }, 180_000);

  it('allows up to three per cent worse fairness and rejects 3.1 per cent', () => {
    expect(fairnessWithinAllowance(100, 100.5)).toBe(true);
    expect(fairnessAllowanceNote(100, 100.5, 'Senior doctors')).toBe('Ratios are 0.5% less even, to keep Senior doctors with the same consultants.');
    expect(fairnessAllowanceNote(100, 100.3, 'Junior doctors')).toBe('Ratios are 0.3% less even, to keep Junior doctors with the same consultants.');
    expect(fairnessAllowanceNote(100, 100.04)).toBeUndefined();
    expect(fairnessAllowanceNote(28.858350951368926, 28.858350951368926 + 1e-5)).toBeUndefined();
    expect(fairnessWithinAllowance(100, 102.9)).toBe(true);
    expect(fairnessWithinAllowance(100, 103.1)).toBe(false);
    expect(fairerFallbackNote('time-budget')).toBe('Too many weeks to plan same consultants in time. Try a shorter range.');
    expect(fairerFallbackNote('solve-time-limit')).toBe('Too many weeks to plan same consultants in time. Try a shorter range.');
    expect(fairerFallbackNote('fairness-over-allowance', 100, 104.2)).toBe("Same consultants made the ratios 4.2% less even, so they weren't used. Try again: another run may keep them.");
    expect(fairerFallbackNote('fairness-over-allowance')).toBe('Same consultants were not used because their effect on ratios could not be measured. Try again: another run may keep it.');
    expect(fairerFallbackNote('fairness-over-allowance', 100)).toMatch(/could not be measured/);
    expect(fairerFallbackNote('list-slot-counts')).toBe("The consultant lists don't match the rota for some days, so same consultants was skipped.");
    expect(fairerFallbackNote('full-rota-infeasible')).toBe("Same consultants couldn't be planned for these dates, so the fairer ratios are shown without it.");
    for (const reason of ['time-budget', 'fairness-over-allowance', 'list-slot-counts', 'full-rota-infeasible', 'theatre-subproblem-infeasible']) {
      expect(fairerFallbackNote(reason)).not.toMatch(/ratios-stage|Stage 4 aims|objective|infeasible/i);
    }
  });

  it('keeps the long-range progress bar moving past 60 seconds', () => {
    expect(fairerProgressPercent(60, 13)).toBe(96);
    expect(fairerProgressPercent(60, 20)).toBeCloseTo((60 / 165) * 100, 5);
    expect(fairerProgressPercent(60, 20)).toBeLessThan(40);
    expect(fairerProgressPercent(120, 20)).toBeGreaterThan(fairerProgressPercent(60, 20));
    expect(fairerProgressPercent(165, 20)).toBe(96);
  });

  it('passes both fairness objectives into debug and the over-allowance fallback note', async () => {
    const ws = bestConsultantFixture();
    const theatre = ws.sessions!.types.find(type => type.name === 'Theatre')!;
    ws.sessions!.ratios[theatre.id] = { 'session-group-st12': 2, 'session-group-fy2': 1, 'session-group-gps': 1 };
    const model = prepareFairerModel(ws, ws.period.start, ws.period.end, 'none', 'none', true);
    const ratioResult = await solve(model.problem, { timeLimit: 30, buildOptions: model.buildOptions });
    expect(ratioResult.ok).toBe(true);
    if (!ratioResult.ok) return;
    const fairnessBefore = ratioResult.stages.find(stage => stage.tier === 'fairness')?.objective;
    expect(fairnessBefore).toBeGreaterThan(0);
    const forcedBefore = fairnessBefore! * 0.5;
    const fallback = await allocateFairerConsultants(model, ratioResult.assignments, 30, () => undefined, forcedBefore);
    expect(fallback?.debug?.consultantFallbackCheck).toBe('fairness-over-allowance');
    expect(fallback?.debug?.fairnessObjectiveBefore).toBe(forcedBefore);
    expect(fallback?.debug?.fairnessObjectiveAfter).toBeDefined();
    const expectedPercent = ((fallback!.debug!.fairnessObjectiveAfter! / forcedBefore - 1) * 100).toFixed(1);
    expect(fallback?.note).toBe(fairerFallbackNote('fairness-over-allowance', forcedBefore, fallback!.debug!.fairnessObjectiveAfter));
    expect(fallback?.note).toContain(`${expectedPercent}% less even`);
  }, 45_000);

  it('keeps the consultants card when same consultants is accepted, including with the 3% allowance note', () => {
    const ws = fairerConsultantFixture();
    const report = {
      rows: [{ staffId: 'fairer-doctor-0', name: 'Dr Rowan', theatreDays: 4, theatreDaysAfter: 3, differentBefore: 3, differentAfter: 2, matchedDaysBefore: 4, matchedDaysAfter: 4, repeatBefore: 1, repeatAfter: 2, consultantsBefore: [{ name: 'Mr Hart', days: 2 }], consultantsAfter: [{ name: 'Mr Vale', days: 2 }], pairedBefore: 0, pairedAfter: 1 }],
      averageBefore: 3, averageAfter: 2, repeatBefore: 25, repeatAfter: 50, doctorsThreeBefore: 1, doctorsThreeAfter: 0, fallbackDays: 0,
    };
    const base = { enabled: true, hasConsistency: true, hasReport: true as boolean };
    expect(showFairerConsultantCard({ ...base, fallbackCheck: undefined })).toBe(true);
    expect(showFairerConsultantCard({ ...base, fallbackCheck: 'time-budget' })).toBe(false);

    const allowance = fairnessAllowanceNote(100, 100.2)!;
    const withAllowance = renderToStaticMarkup(createElement(FairerConsultantOutcome, {
      notes: [allowance], enabled: true, hasConsistency: true, report, workspace: ws, viewId: 'fairer-doctor-0',
    }));
    expect(withAllowance).toContain(allowance.replace('Ratios', 'Shares'));
    expect(withAllowance).toContain('ST theatre consultants');
    expect(withAllowance).toContain('Dr Rowan');
    expect(withAllowance).toContain('Mr Vale 2');
    expect(withAllowance).toContain('Before: Mr Hart 2');

    const accepted = renderToStaticMarkup(createElement(FairerConsultantOutcome, {
      notes: [], enabled: true, hasConsistency: true, report, workspace: ws,
    }));
    expect(accepted).toContain('ST theatre consultants');
    expect(accepted).not.toContain('quiet-note');

    for (const reason of ['time-budget', 'fairness-over-allowance', 'list-slot-counts', 'full-rota-infeasible'] as const) {
      const note = fairerFallbackNote(reason);
      const markup = renderToStaticMarkup(createElement(FairerConsultantOutcome, {
        notes: [note], fallbackCheck: reason, enabled: true, hasConsistency: true, report, workspace: ws,
      }));
      const plain = markup.replace(/&#x27;/g, "'");
      expect(plain).toContain(note.replace(/\bratios\b/g, 'shares'));
      expect(plain).not.toContain('ST theatre consultants');
    }
  });

  it('uses the unchanged Stage 4 result for percentage runs and keeps the saved consultant choice', async () => {
    const ws = fairerConsultantFixture();
    const end = '2026-11-20';
    const savedChoice = prepareFairerModel(ws, ws.period.start, end, 20, 'none', true);
    const switchOff = prepareFairerModel(ws, ws.period.start, end, 20, 'none', false);
    expect(savedChoice.consultantPlan.enabled).toBe(false);
    expect(savedChoice.problem.profile).toEqual(switchOff.problem.profile);
    expect(savedChoice.buildOptions).toEqual(switchOff.buildOptions);

    const limitedMarkup = renderToStaticMarkup(createElement(SameConsultantsControl, {
      label: 'Keep ST1-2 with the same consultants in Theatre', savedChoice: true, changeLimit: 20, onChange: () => undefined,
    }));
    expect(limitedMarkup).toContain('Same consultants needs No limit.');
    expect(limitedMarkup).toContain('disabled=""');
    expect(limitedMarkup).not.toContain('checked=""');
    const unlimitedMarkup = renderToStaticMarkup(createElement(SameConsultantsControl, {
      label: 'Keep ST1-2 with the same consultants in Theatre', savedChoice: true, changeLimit: 'none', onChange: () => undefined,
    }));
    expect(unlimitedMarkup).toContain('checked=""');
    expect(unlimitedMarkup).not.toContain('Same consultants needs No limit.');

    const limitedOn = await solve(savedChoice.problem, { timeLimit: 20, buildOptions: savedChoice.buildOptions });
    const limitedOff = await solve(switchOff.problem, { timeLimit: 20, buildOptions: switchOff.buildOptions });
    expect(limitedOn.ok && limitedOff.ok).toBe(true);
    if (limitedOn.ok && limitedOff.ok) {
      const signature = (items: Assignment[]) => items.map(item => `${item.staffId}|${item.date}|${item.roleId}|${item.shiftTypeId}`).sort();
      expect(signature(limitedOn.assignments)).toEqual(signature(limitedOff.assignments));
    }
  }, 60_000);

  it('counts theatre days across both Elective C-Sections and WC Theatres and leaves existing workspaces unsplit', () => {
    const defaults = legacySessions(fairerFixture(1, 3).profile);
    expect(defaults.types.some(type => type.name === 'Theatre')).toBe(true);
    expect(defaults.types.some(type => type.name === 'Elective C-Sections')).toBe(false);
    expect(defaults.sameConsultants).toEqual({ groupIds: [], typeIds: [] });

    const ws = fairerConsultantBenchmarkFixture();
    const elective = ws.sessions!.types.find(type => type.name === 'Elective C-Sections')!;
    const wc = ws.sessions!.types.find(type => type.name === 'WC Theatres')!;
    const model = prepareFairerModel(ws, ws.period.start, ws.period.end, 'none', 'none', true);
    expect(model.consultantPlan.typeIds.sort()).toEqual([elective.id, wc.id].sort());
    const report = consultantReport(model, model.movable, ws);
    const selected = new Set(model.consultantPlan.selectedStaffIds);
    const selectedTheatre = model.movable.filter(item => selected.has(item.staffId) && model.consultantPlan.typeIds.includes(model.typeForRole[item.roleId ?? ''] ?? '')).length;
    expect(report.rows.reduce((sum, row) => sum + row.theatreDays, 0)).toBe(selectedTheatre);
    expect(selectedTheatre).toBeGreaterThan(0);
    expect(model.movable.some(item => model.typeForRole[item.roleId ?? ''] === elective.id)).toBe(true);
    expect(model.movable.some(item => model.typeForRole[item.roleId ?? ''] === wc.id)).toBe(true);
    expect(model.movable.some(item => selected.has(item.staffId) && model.typeForRole[item.roleId ?? ''] === elective.id)).toBe(true);
    expect(model.movable.some(item => selected.has(item.staffId) && model.typeForRole[item.roleId ?? ''] === wc.id)).toBe(true);
  });

  it('prefers a paired list, reduces each doctor’s new consultants after the ratio tier, and keeps the hard rules', async () => {
    const ws = fairerConsultantFixture();
    const start = '2026-11-09', end = '2026-11-20';
    const base = prepareFairerModel(ws, start, end, 'none', 'none', false);
    const model = prepareFairerModel(ws, start, end, 'none', 'none', true);
    expect(model.consultantPlan.metBeforeRangeByStaff['fairer-doctor-0']).toContain('Mr Vale');
    expect(model.problem.profile.tierOrder).toEqual(['fairness', 'paired', 'consultants', 'preference', 'extra']);
    const [baseResult, result] = await Promise.all([
      solve(base.problem, { timeLimit: 20, buildOptions: base.buildOptions }),
      solve(model.problem, { timeLimit: 20, buildOptions: model.buildOptions }),
    ]);
    expect(baseResult.ok && result.ok).toBe(true);
    if (!baseResult.ok || !result.ok) return;
    const fairness = (value: typeof result) => value.ok ? value.stages.find(stage => stage.tier === 'fairness')?.objective ?? 0 : 0;
    expect(fairness(result)).toBeLessThanOrEqual(fairness(baseResult) + 1e-6);
    const assignments = combineFairerAssignments(model, result.assignments);
    expect(validateFairerResult(model, assignments)).toBeUndefined();
    const pairedDays = assignments.filter(item => item.staffId === 'fairer-doctor-0' && item.date >= start && item.date <= end && model.consultantsByRole[item.roleId ?? '']?.includes('Ms Quinn'));
    expect(pairedDays).toHaveLength(10);
    const report = consultantReport(model, assignments, ws);
    const row0 = report.rows.find(row => row.staffId === 'fairer-doctor-0')!;
    const row1 = report.rows.find(row => row.staffId === 'fairer-doctor-1')!;
    expect(row0.pairedBefore).toBe(0);
    expect(row0.pairedAfter).toBe(10);
    expect(row1.differentAfter).toBeLessThan(row1.differentBefore);
  }, 45_000);

  it('counts mismatched stored lists as fallback days and preserves the Stage 4 result when switched off', async () => {
    const ws = fairerConsultantFixture();
    ws.consultantLists![0]!.unmatched = 1;
    const withUnmatchedNonTierJunior = prepareFairerModel(ws, '2026-11-09', '2026-11-13', 'none', 'none', true);
    expect(withUnmatchedNonTierJunior.consultantPlan.fallbackDays).toBe(0);
    const baseline = prepareFairerModel(ws, '2026-11-09', '2026-11-13', 'none', 'none', false);
    expect(baseline.problem.profile.tierOrder).toEqual(['fairness', 'preference', 'extra']);
    const theatre = ws.sessions!.types.find(type => type.name === 'Theatre')!;
    ws.consultantLists = ws.consultantLists!.filter(cell => !(cell.date === '2026-11-09' && cell.staffIds.includes('fairer-doctor-0')));
    const model = prepareFairerModel(ws, '2026-11-09', '2026-11-13', 'none', 'none', true);
    expect(model.consultantPlan.fallbackDays).toBe(1);
    expect(model.consultantPlan.typeIds).toContain(theatre.id);
    expect(model.buildOptions.allowedVariables?.some(variable => model.consultantsByRole[variable.roleId]?.length)).toBe(true);
    const noLists = structuredClone(ws);
    noLists.consultantLists = [];
    const stage4 = prepareFairerModel(noLists, '2026-11-09', '2026-11-13', 'none', 'none');
    expect(baseline.buildOptions.allowedVariables).toEqual(stage4.buildOptions.allowedVariables);
    const [offResult, stage4Result] = await Promise.all([
      solve(baseline.problem, { timeLimit: 15, buildOptions: baseline.buildOptions }),
      solve(stage4.problem, { timeLimit: 15, buildOptions: stage4.buildOptions,
        afterTier: (tier, assignments, context) => tier === 'fairness' ? allocateFairerConsultants(stage4, assignments, context.remainingSeconds, context.reportProgress, context.tierObjective) : Promise.resolve(undefined) }),
    ]);
    expect(offResult.ok && stage4Result.ok).toBe(true);
    if (offResult.ok && stage4Result.ok) {
      expect(offResult.assignments).toEqual(stage4Result.assignments);
      expect(stage4Result.notes).toBeUndefined();
    }
  });

  it('falls back to the Stage 4 result when list slots fail their count check', async () => {
    const ws = fairerConsultantFixture();
    const off = prepareFairerModel(ws, ws.period.start, '2026-11-20', 'none', 'none', false);
    const on = prepareFairerModel(ws, ws.period.start, '2026-11-20', 'none', 'none', true);
    const firstSlot = on.consultantPlan.slots[0]!;
    firstSlot.roles = [{ roleId: firstSlot.roles[0]!.roleId, count: on.movable.length + 1 }];
    const offResult = await solve(off.problem, { timeLimit: 20, buildOptions: off.buildOptions });
    const onResult = await solve(on.problem, {
      timeLimit: 20,
      buildOptions: on.buildOptions,
      afterTier: (tier, assignments, context) => tier === 'fairness'
        ? allocateFairerConsultants(on, assignments, context.remainingSeconds, context.reportProgress, context.tierObjective)
        : Promise.resolve(undefined),
    });
    expect(offResult.ok && onResult.ok).toBe(true);
    if (!offResult.ok || !onResult.ok) return;
    expect(onResult.debug?.consultantFallbackCheck).toBe('list-slot-counts');
    expect(onResult.notes?.[0]).toBe(fairerFallbackNote('list-slot-counts'));
    const distance = (model: ReturnType<typeof prepareFairerModel>, assignments: Assignment[]) => getSummary(model, assignments, ws)
      .reduce((sum, row) => sum + (row.capacity ? Math.abs(row.after / row.capacity - row.aim / row.capacity) : 0), 0);
    expect(distance(on, onResult.assignments)).toBeLessThanOrEqual(distance(off, offResult.assignments) + 1e-6);
  }, 60_000);

  it('round-trips the selected groups, types and per-doctor consultant pair through a preset', () => {
    const ws = fairerConsultantFixture();
    const preset = makePresetFromWorkspace(ws);
    expect(preset.sessions?.sameConsultants).toEqual({ groupIds: ['session-group-st12'], typeIds: [ws.sessions!.types.find(type => type.name === 'Theatre')!.id] });
    expect(preset.people?.find(person => person.name === 'Dr Rowan')?.consultants).toEqual(['Ms Quinn']);
    const restored = structuredClone(ws);
    restored.consultantPairs = {};
    applyPresetToWorkspace(restored, preset);
    expect(restored.sessions?.sameConsultants).toEqual(preset.sessions?.sameConsultants);
    expect(restored.consultantPairs?.['fairer-doctor-0']).toEqual(['Ms Quinn']);
  });

  it('uses the Stage 4 zero-limit path without enabling consultant allocation', async () => {
    const ws = fairerConsultantFixture();
    const model = prepareFairerModel(ws, '2026-11-09', '2026-11-13', 0, 'none', true);
    expect(model.consultantPlan.enabled).toBe(false);
    expect(model.problem.profile.tierOrder).toEqual(['fairness', 'preference', 'extra']);
    const result = await solve(model.problem, { timeLimit: 15, buildOptions: model.buildOptions });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const assignments = combineFairerAssignments(model, result.assignments);
    expect(validateFairerResult(model, assignments)).toBeUndefined();
    for (const item of model.movable) expect(assignments.some(next => next.staffId === item.staffId && next.date === item.date && next.roleId === (model.baselineRoleByStaffDate[`${item.staffId}|${item.date}`] ?? item.roleId))).toBe(true);
  }, 30_000);

  it('reports a consultant when a trainee moves onto a known theatre list from another place', () => {
    const ws = fairerConsultantFixture();
    const date = '2026-11-09';
    ws.swapFinder!.snapshot.days['fairer-doctor-0']![date] = { status: 'dayJob', activity: 'MAU CT', sessions: ['am', 'pm'] };
    ws.consultantLists = ws.consultantLists!.filter(cell => !(cell.date === date && cell.staffIds.includes('fairer-doctor-0')));
    const model = prepareFairerModel(ws, date, date, 'none', 'none', true);
    const rows = model.buildOptions.allowedVariables!;
    const targetRole = rows.find(variable => variable.staffId === 'fairer-doctor-0' && variable.date === date && model.consultantsByRole[variable.roleId]?.includes('Mr Vale'))?.roleId;
    expect(targetRole).toBeTruthy();
    const suggestion = model.movable.map(item => item.staffId === 'fairer-doctor-0' ? { ...item, roleId: targetRole! } : item);
    const row = consultantReport(model, suggestion, ws).rows.find(item => item.staffId === 'fairer-doctor-0')!;
    expect(row.differentAfter).toBe(1);
    expect(row.matchedDaysAfter).toBe(1);
    expect(row.consultantsAfter).toEqual([{ name: 'Mr Vale', days: 1 }]);
  });

  it('counts each consultant on matched theatre days, including both names on a joint list', () => {
    const ws = fairerConsultantFixture();
    const date = '2026-11-09';
    ws.consultantLists = ws.consultantLists!.filter(cell => !(cell.date === date && cell.staffIds.includes('fairer-doctor-0')));
    ws.consultantLists!.push({ date, placeId: 'fairer-place-0', activity: 'Elective C-Sections', session: 'pm', staffIds: ['fairer-doctor-0'], consultants: ['Mr Hart', 'Ms Quinn'], unmatched: 0 });
    const model = prepareFairerModel(ws, date, date, 'none', 'none', true);
    const row = consultantReport(model, model.movable, ws).rows.find(item => item.staffId === 'fairer-doctor-0')!;
    expect(row.matchedDaysBefore).toBe(1);
    expect(row.consultantsBefore.reduce((sum, item) => sum + item.days, 0)).toBe(2);
    expect(row.consultantsBefore).toEqual([{ name: 'Mr Hart', days: 1 }, { name: 'Ms Quinn', days: 1 }]);
  });

  it('reports theatre days before and after, so a move onto theatre is not shown as zero', () => {
    const ws = fairerConsultantFixture();
    const model = prepareFairerModel(ws, ws.period.start, ws.period.end, 'none', 'none', true);
    const person = model.consultantPlan.selectedStaffIds[0]!;
    const beforeTheatre = model.movable.filter(item => item.staffId === person && model.consultantPlan.typeIds.includes(model.typeForRole[item.roleId ?? ''] ?? ''));
    expect(beforeTheatre.length).toBeGreaterThan(0);
    const same = consultantReport(model, model.movable, ws).rows.find(row => row.staffId === person)!;
    expect(same.theatreDays).toBe(beforeTheatre.length);
    expect(same.theatreDaysAfter).toBe(beforeTheatre.length);

    const wardsRole = Object.entries(model.typeForRole).find(([, typeId]) => !model.consultantPlan.typeIds.includes(typeId))?.[0]
      ?? ws.profile.roles.find(role => role.name === 'Postnatal Wards CT')?.id;
    expect(wardsRole).toBeTruthy();
    const emptied = model.movable.map(item => item.staffId === person ? { ...item, roleId: wardsRole! } : item);
    const emptyRow = consultantReport(model, emptied, ws).rows.find(row => row.staffId === person)!;
    expect(emptyRow.theatreDays).toBe(beforeTheatre.length);
    expect(emptyRow.theatreDaysAfter).toBe(0);

    const theatreRole = beforeTheatre[0]!.roleId!;
    const restoredDates = new Set(beforeTheatre.slice(0, 3).map(item => item.date));
    const afterSuggestion = model.movable.map(item => {
      if (item.staffId !== person) return item;
      return restoredDates.has(item.date) ? { ...item, roleId: theatreRole } : { ...item, roleId: wardsRole! };
    });
    const afterRow = consultantReport(model, afterSuggestion, ws).rows.find(row => row.staffId === person)!;
    expect(afterRow.theatreDays).toBe(beforeTheatre.length);
    expect(afterRow.theatreDaysAfter).toBe(3);
    const markup = renderToStaticMarkup(createElement(FairerConsultantOutcome, {
      notes: [], enabled: true, hasConsistency: true,
      report: {
        rows: [{
          staffId: person, name: 'Dr Rowan', theatreDays: 0, theatreDaysAfter: 3, differentBefore: 0, differentAfter: 1,
          matchedDaysBefore: 0, matchedDaysAfter: 3, repeatBefore: 0, repeatAfter: 3,
          consultantsBefore: [], consultantsAfter: [{ name: 'Mr Vale', days: 3 }],
        }],
        averageBefore: 0, averageAfter: 1, repeatBefore: 0, repeatAfter: 100, doctorsThreeBefore: 0, doctorsThreeAfter: 0, fallbackDays: 0,
      },
      workspace: ws, viewId: person,
    }));
    expect(markup).toContain('consultant-before">0</span> → 3');
    expect(markup).toContain('Mr Vale 3');
  });

  it('uses singular and plural labels on the phone consultant card counts', () => {
    expect(fairerCountLabel(1, 'consultant', 'consultants')).toBe('1 consultant');
    expect(fairerCountLabel(2, 'consultant', 'consultants')).toBe('2 consultants');
    expect(fairerCountLabel(0, 'consultant', 'consultants')).toBe('0 consultants');
    expect(fairerCountLabel(1, 'theatre day', 'theatre days')).toBe('1 theatre day');
    expect(fairerCountLabel(3, 'theatre day', 'theatre days')).toBe('3 theatre days');
    const ws = fairerConsultantFixture();
    const report = {
      rows: [{
        staffId: 'fairer-doctor-0', name: 'Dr Rowan', theatreDays: 0, theatreDaysAfter: 1, differentBefore: 0, differentAfter: 1,
        matchedDaysBefore: 0, matchedDaysAfter: 1, repeatBefore: 0, repeatAfter: 1,
        consultantsBefore: [], consultantsAfter: [{ name: 'Mr Vale', days: 1 }],
      }],
      averageBefore: 0, averageAfter: 1, repeatBefore: 0, repeatAfter: 100, doctorsThreeBefore: 0, doctorsThreeAfter: 0, fallbackDays: 0,
    };
    const markup = renderToStaticMarkup(createElement(FairerConsultantOutcome, {
      notes: [], enabled: true, hasConsistency: true, report, workspace: ws, viewId: 'fairer-doctor-0',
    }));
    expect(markup).toContain('1 theatre day');
    expect(markup).toContain('1 consultant');
    expect(markup).not.toContain('1 theatre days');
    expect(markup).not.toContain('1 consultants');
  });

  it('combines favoured theatre types and scales ratios against the first other group', () => {
    const ws = fairerConsultantFixture();
    const settings = ws.sessions!;
    settings.groups = [{ id: 'st', name: 'ST1-2', grades: ['ST1'] }, { id: 'fy', name: 'FY2', grades: ['FY2'] }, { id: 'gp', name: 'GPs', grades: ['GP Reg'] }];
    const theatre = settings.types.find(type => type.name === 'Theatre')!;
    const types = [
      { ...theatre, id: 'elective', name: 'Elective C-Sections', placeIds: ['fairer-place-0'] },
      { ...theatre, id: 'wc', name: 'WC Theatres', placeIds: ['fairer-place-1'] },
    ];
    settings.types = [...settings.types.filter(type => type.id !== theatre.id), ...types];
    expect(types).toHaveLength(2);
    for (const type of settings.types) settings.ratios[type.id] = { st: 1, fy: 1, gp: 1 };
    for (const type of types) settings.ratios[type.id] = { st: 2.5, fy: 1, gp: 1 };
    const rows = types.flatMap(type => [
      { typeId: type.id, groupId: 'st', before: 5, after: 8, aim: 10, capacity: 10, groupName: 'ST1-2', typeName: type.name },
      { typeId: type.id, groupId: 'fy', before: 2.5, after: 2.5, aim: 2, capacity: 10, groupName: 'FY2', typeName: type.name },
      { typeId: type.id, groupId: 'gp', before: 1.25, after: 1.25, aim: 2, capacity: 10, groupName: 'GPs', typeName: type.name },
    ]);
    expect(favouredRatioHeadline(settings, rows, 'st')).toBe('ST1-2 in Elective C-Sections + WC Theatres: 2.0 : 1.0 : 0.5 → 3.2 : 1.0 : 0.5 (aim 5.0 : 1.0 : 1.0)');
    for (const type of types) settings.ratios[type.id] = { st: 1, fy: 1, gp: 1 };
    expect(favouredRatioHeadline(settings, rows, 'st')).toBeUndefined();
    expect(favouredRatioHeadline(settings, rows, undefined)).toBeUndefined();
  });

  it('folds settings after a result, supports Edit state, and starts the suggested grid closed with filtering on', () => {
    expect(fairerSettingsCollapsed(false, false)).toBe(false);
    expect(fairerSettingsCollapsed(true, false)).toBe(true);
    expect(fairerSettingsCollapsed(true, true)).toBe(false);
    expect(fairerSettingsLine('2026-11-02', '2026-11-08', 'none', true)).toBe('Mon 2 Nov to Sun 8 Nov · No limit · Same consultants on');
    expect(fairerSettingsLine('2026-11-02', '2026-11-08', 'none', 'not-used')).toBe('Mon 2 Nov to Sun 8 Nov · No limit · Same consultants: not used this time');
    expect(fairerSettingsLine('2026-11-02', '2026-11-08', 20, false)).not.toContain('(no limit)');
    expect(fairerSettingsLine('2026-11-02', '2026-11-08', 'none', false)).toContain('Same consultants off');
    expect(fairerConsultantSetting('time-budget', true)).toBe('not-used');
    expect(fairerConsultantSetting('fairness-over-allowance', true)).toBe('not-used');
    expect(fairerConsultantSetting(undefined, true)).toBe(true);
    expect(fairerConsultantSetting(undefined, false)).toBe(false);
    expect(fairerChangeLimitHint('none', 537)).toBe('');
    expect(fairerChangeLimitHint(20, 537)).toBe('Move at most 107 of the 537 day sessions (20%)');
    expect(fairerGridInitialState()).toEqual({ open: false, changedOnly: true });
  });

  it('renders an over-allowance note with a Try again action inside the summary box', () => {
    const markup = renderToStaticMarkup(createElement(FairerConsultantOutcome, {
      notes: ["Same consultants made the ratios 4.2% less even, so they weren't used. Try again: another run may keep them."],
      fallbackCheck: 'fairness-over-allowance', enabled: true, hasConsistency: true, workspace: fairerConsultantFixture(), onTryAgain: () => undefined,
    }));
    expect(markup).toContain('fairer-summary-box');
    expect(markup).toContain('4.2% less even');
    expect(markup).toContain('Try again');
    expect(markup).toContain('<button');
    expect(markup.indexOf('fairer-summary-box')).toBeLessThan(markup.indexOf('4.2% less even'));
  });

  it('anchors Week picker options to the first visible day when the range starts mid-week', () => {
    const dates = dateRange('2026-11-04', '2026-11-22');
    const weeks = fairerWeekOptions(dates);
    expect(weeks[0]).toBe('2026-11-02');
    expect(fairerWeekAnchorDate(weeks[0]!, dates)).toBe('2026-11-04');
    expect(fairerWeekAnchorDate(weeks[1]!, dates)).toBe('2026-11-09');
    expect(fairerWeekHeaderId(weeks[0]!)).toBe('fairer-week-2026-11-02');
    expect(dates).not.toContain(weeks[0]);
    expect(weeks[0]).toBe('2026-11-02');
    expect(weeks.every(week => week.length === 10)).toBe(true);
    expect(fairerWeekScrollTarget(40, 100, 460, 160)).toBe(240);
    expect(fairerWeekScrollTarget(0, 100, 180, 160)).toBe(0);
  });

  it('renders one share table, marks the viewing group, shows progress towards the aim, and omits inactive types', () => {
    const rows = [
      { groupId: 'fy', groupName: 'FY2', typeId: 'theatre', typeName: 'Theatre', before: 20, after: 12, aim: 15, capacity: 100 },
      { groupId: 'st', groupName: 'ST1-2', typeId: 'theatre', typeName: 'Theatre', before: 10, after: 18, aim: 15, capacity: 100 },
      { groupId: 'fy', groupName: 'FY2', typeId: 'wards', typeName: 'Wards', before: 0, after: 0, aim: 0, capacity: 100 },
    ];
    const markup = renderToStaticMarkup(createElement(FairerRatiosTable, {
      rows, types: [{ id: 'theatre', name: 'Theatre' }, { id: 'wards', name: 'Wards' }],
      groups: [{ id: 'fy', name: 'FY2', groupId: 'fy' }, { id: 'st', name: 'ST1-2', groupId: 'st' }], viewerGroupId: 'st',
    }));
    expect(markup.match(/Session type/g)).toHaveLength(1);
    expect(markup).toContain('Share of each place');
    expect(markup).toContain('MediRota → suggestion. ✓ closer to the aim, ✗ further from it.');
    expect(markup).toContain('You');
    expect(markup).not.toContain('is-off-target');
    expect(markup).toContain('aria-label="closer to the aim"');
    expect(markup).not.toContain('>Wards<');
    expect(markup).toContain('20% → 12%');
    expect(markup).toContain('Aim: FY2 15% · ST1-2 15%');
  });

  it('finds the known best repeat allocation for three STs and two FY2s across two weeks', async () => {
    const ws = bestConsultantFixture();
    const model = prepareFairerModel(ws, ws.period.start, ws.period.end, 'none', 'none', true);
    const exact = await allocateFairerConsultants(model, model.movable, 20, () => undefined);
    if (!exact) throw new Error('Expected consultant allocation for the enabled made-up fixture.');
    expect(exact.completeAssignments).toBeDefined();
    const exactReport = consultantReport(model, exact.completeAssignments ?? [], ws);
    expect(exactReport.rows.filter(row => row.staffId.startsWith('fairer-doctor-') && Number(row.staffId.slice(-1)) < 3).every(row => row.differentAfter === 1 && row.repeatAfter === 9)).toBe(true);
    expect(exact.stages?.some(stage => stage.tier === 'consultants' && stage.status === 'optimal' && stage.gap === 0 && stage.objective === -27)).toBe(true);
    const result = await solve(model.problem, {
      timeLimit: 30, buildOptions: model.buildOptions,
      afterTier: (tier, assignments, context) => tier === 'fairness' ? allocateFairerConsultants(model, assignments, context.remainingSeconds, context.reportProgress, context.tierObjective) : Promise.resolve(undefined),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.notes).toBeUndefined();
    const assignments = combineFairerAssignments(model, result.assignments);
    expect(validateFairerResult(model, assignments)).toBeUndefined();
    for (const staffId of ['fairer-doctor-0', 'fairer-doctor-1', 'fairer-doctor-2']) {
      const row = consultantReport(model, assignments, ws).rows.find(item => item.staffId === staffId)!;
      expect(row.differentAfter).toBe(1);
      expect(row.repeatAfter).toBe(9);
    }
    for (const date of model.dates.filter(date => weekday(date) < 5)) {
      expect(assignments.filter(item => item.date === date && ['fairer-doctor-0', 'fairer-doctor-1', 'fairer-doctor-2'].includes(item.staffId)).every(item => !!model.consultantsByRole[item.roleId ?? '']?.length)).toBe(true);
      expect(assignments.filter(item => item.date === date && ['fairer-doctor-3', 'fairer-doctor-4'].includes(item.staffId)).every(item => !!model.consultantsByRole[item.roleId ?? '']?.length)).toBe(true);
    }
  }, 45_000);

  it('compares the consultant switch and change limits on the realistic split-theatre benchmark', async () => {
    const ws = fairerConsultantBenchmarkFixture();
    const theatreTypes = ws.sessions!.types.filter(type => ['Elective C-Sections', 'WC Theatres'].includes(type.name));
    expect(theatreTypes).toHaveLength(2);
    expect(ws.consultantLists).toHaveLength(80);
    const frequency = new Map<string, number>();
    for (const cell of ws.consultantLists!) frequency.set(cell.consultants[0]!, (frequency.get(cell.consultants[0]!) ?? 0) + 1);
    expect(frequency.size).toBe(30);
    expect([...frequency.values()].every(count => count >= 1 && count <= 7)).toBe(true);

    const changedCount = (model: ReturnType<typeof prepareFairerModel>, assignments: Assignment[]) => model.movable.length - model.movable.filter(base => assignments.some(next => {
      if (next.staffId !== base.staffId || next.date !== base.date || next.shiftTypeId !== base.shiftTypeId) return false;
      const baselineList = model.baselineRoleByStaffDate[`${base.staffId}|${base.date}`];
      return baselineList ? next.roleId === baselineList : model.placeForRole[next.roleId ?? ''] === model.placeForRole[base.roleId ?? ''];
    })).length;
    const run = async (changeLimit: number | 'none', keepSameConsultants: boolean, useHook: boolean) => {
      const usesConsultants = keepSameConsultants && changeLimit === 'none';
      const setupStarted = performance.now();
      const model = prepareFairerModel(ws, ws.period.start, ws.period.end, changeLimit, 2, usesConsultants);
      const setupSeconds = (performance.now() - setupStarted) / 1000;
      const totalStarted = setupStarted;
      let ratioAssignments: Assignment[] = [];
      let candidateRepeatDays = 0, candidateGap: number | undefined, candidateStatus: string | undefined;
      let theatrePlanChanged = false;
      const solveStarted = performance.now();
      const result = await solve(model.problem, {
        timeLimit: fairerRemainingTimeLimit(9, setupSeconds),
        buildOptions: model.buildOptions,
        ...(model.consultantPlan.enabled ? { afterTierReserve: { tier: 'fairness' as const, fraction: 0.25 } } : {}),
        afterTier: async (tier, assignments, context) => {
          if (tier !== 'fairness') return undefined;
          ratioAssignments = assignments;
          if (!useHook || !model.consultantPlan.enabled) return undefined;
          const allocation = await allocateFairerConsultants(model, assignments, context.remainingSeconds, context.reportProgress, context.tierObjective);
          if (!allocation) throw new Error('Expected consultant allocation for the enabled benchmark fixture.');
          const consultantStage = allocation.stages?.find(stage => stage.tier === 'consultants');
          if (consultantStage) { candidateRepeatDays = -consultantStage.objective; candidateGap = consultantStage.gap; candidateStatus = consultantStage.status; }
          if (allocation.completeAssignments) theatrePlanChanged = allocation.completeAssignments.some(item => {
            if (!model.consultantPlan.typeIds.includes(model.typeForRole[item.roleId ?? ''] ?? '')) return false;
            const before = assignments.find(candidate => candidate.staffId === item.staffId && candidate.date === item.date);
            return !!before && before.roleId !== item.roleId;
          });
          process.stdout.write(`Benchmark hook ${changeLimit}: allocation ${allocation.stages?.map(stage => `${stage.tier}:${stage.status}:${stage.objective}`).join(',') ?? 'fallback-only'}; fallback ${allocation.debug?.consultantFallbackCheck ?? 'none'}; note ${allocation.note ?? 'none'}\n`);
          return allocation;
        },
      });
      const solveSeconds = (performance.now() - solveStarted) / 1000;
      const totalSeconds = (performance.now() - totalStarted) / 1000;
      expect(totalSeconds).toBeLessThanOrEqual(fairerTimeLimit(9) + 3);
      expect(result.ok).toBe(true);
      if (!result.ok) return { repeatDays: 0, matchedDays: 0, report: undefined, model, assignments: [] as Assignment[], changed: 0, fairness: undefined, debug: undefined, notes: undefined, ratioAssignments, candidateRepeatDays, candidateGap, candidateStatus, ratioFairnessStatus: undefined, theatrePlanChanged, setupSeconds, solveSeconds, totalSeconds };
      const ratioFairnessStatus = result.stages.find(stage => stage.tier === 'fairness')?.status;
      const assignments = combineFairerAssignments(model, result.assignments);
      expect(validateFairerResult(model, assignments)).toBeUndefined();
      expect(theatreTypes.every(type => model.dayTypes.some(dayType => dayType.id === type.id))).toBe(true);
      const reportModel = usesConsultants ? model : prepareFairerModel(ws, ws.period.start, ws.period.end, changeLimit, 2, true);
      const reportedAssignments = [...assignments];
      for (const slot of reportModel.consultantPlan.slots) {
        const counts = new Map(slot.roles.map(role => [role.roleId, role.count]));
        const onPlace = reportedAssignments.filter(item => item.date === slot.date && reportModel.placeForRole[item.roleId ?? ''] === slot.placeId);
        for (const item of onPlace) {
          const baselineRole = reportModel.baselineRoleByStaffDate[`${item.staffId}|${item.date}`];
          if (baselineRole && counts.has(baselineRole) && (counts.get(baselineRole) ?? 0) > 0) {
            item.roleId = baselineRole;
            counts.set(baselineRole, (counts.get(baselineRole) ?? 0) - 1);
          }
        }
        for (const item of onPlace.filter(item => !counts.has(item.roleId ?? '') || (counts.get(item.roleId ?? '') ?? 0) < 0)) {
          const role = [...counts].find(([, remaining]) => remaining > 0)?.[0];
          if (role) { item.roleId = role; counts.set(role, counts.get(role)! - 1); }
        }
        for (const item of onPlace.filter(item => !reportModel.consultantsByRole[item.roleId ?? ''])) {
          const role = [...counts].find(([, remaining]) => remaining > 0)?.[0];
          if (role) { item.roleId = role; counts.set(role, counts.get(role)! - 1); }
        }
      }
      const report = consultantReport(reportModel, usesConsultants ? reportedAssignments : reportModel.baseline, ws);
      let repeatDays = report.rows.reduce((sum, row) => sum + (usesConsultants ? row.repeatAfter : row.repeatBefore), 0);
      let matchedDays = report.rows.reduce((sum, row) => sum + (usesConsultants ? row.matchedDaysAfter : row.matchedDaysBefore), 0);
      if (!usesConsultants) {
        const selected = new Set(reportModel.consultantPlan.selectedStaffIds);
        const namesByStaffDate = new Map<string, string[]>();
        for (const cell of ws.consultantLists ?? []) if (cell.date >= ws.period.start && cell.date <= ws.period.end && reportModel.consultantPlan.typeIds.includes(ws.sessions!.types.find(type => type.placeIds.includes(cell.placeId))?.id ?? '')) {
          for (const staffId of cell.staffIds) if (selected.has(staffId)) namesByStaffDate.set(`${staffId}|${cell.date}`, [...new Set([...(namesByStaffDate.get(`${staffId}|${cell.date}`) ?? []), ...cell.consultants])]);
        }
        repeatDays = 0; matchedDays = 0;
        for (const staffId of selected) {
          const met = new Set<string>();
          for (const item of reportModel.movable.filter(item => item.staffId === staffId && reportModel.consultantPlan.typeIds.includes(reportModel.typeForRole[item.roleId ?? ''])).sort((a, b) => a.date.localeCompare(b.date))) {
            const names = namesByStaffDate.get(`${staffId}|${item.date}`) ?? [];
            if (!names.length) continue;
            matchedDays++;
            if (names.some(name => met.has(name.toLocaleLowerCase('en-GB')))) repeatDays++;
            names.forEach(name => met.add(name.toLocaleLowerCase('en-GB')));
          }
        }
      }
      const fairness = result.debug?.fairnessObjectiveAfter ?? [...result.stages].reverse().find(stage => stage.tier === 'fairness')?.objective;
      const otherSessionCountsChanged = usesConsultants && model.movable.some(base => ws.profile.staff.some(person => person.id === base.staffId && !person.locum) &&
        Object.values(model.typeForRole).some(typeId => !model.consultantPlan.typeIds.includes(typeId)) &&
        Object.entries(model.typeForRole).some(([, typeId]) => !model.consultantPlan.typeIds.includes(typeId)
          && assignments.filter(item => item.staffId === base.staffId && model.typeForRole[item.roleId ?? ''] === typeId).length
            !== ratioAssignments.filter(item => item.staffId === base.staffId && model.typeForRole[item.roleId ?? ''] === typeId).length));
      return { repeatDays, matchedDays, report, model, assignments, changed: changedCount(model, assignments), fairness, debug: result.debug, notes: result.notes, ratioAssignments, candidateRepeatDays, candidateGap, candidateStatus, ratioFairnessStatus, theatrePlanChanged, otherSessionCountsChanged, setupSeconds, solveSeconds, totalSeconds };
    };

    const noConsultants = await run('none', false, false);
    const unrestricted = await run('none', true, true);
    expect(unrestricted.ratioFairnessStatus).toContain('timeLimit');
    expect(unrestricted.notes).toBeUndefined();
    expect(unrestricted.repeatDays).toBeGreaterThan(noConsultants.repeatDays);
    expect(unrestricted.theatrePlanChanged).toBe(true);
    expect(unrestricted.candidateRepeatDays).toBeGreaterThan(0);
    expect(unrestricted.repeatDays).toBeGreaterThanOrEqual(unrestricted.candidateRepeatDays * 0.9);
    expect(unrestricted.debug?.consultantFallbackCheck).toBeUndefined();
    expect(unrestricted.candidateStatus).toBeDefined();
    expect(unrestricted.debug?.consultantFallbackCheck).not.toBe('time-budget');
    expect(unrestricted.debug?.consultantRepeatDays).toBeGreaterThanOrEqual(unrestricted.candidateRepeatDays * 0.9);
    expect(fairnessWithinAllowance(unrestricted.debug?.fairnessObjectiveBefore, unrestricted.debug?.fairnessObjectiveAfter)).toBe(true);
    expect(unrestricted.otherSessionCountsChanged).toBe(true);
    expect(noConsultants.notes).toBeUndefined();
    const analysis = analyseSessions(ws.profile, ws.swapFinder!.snapshot, ws.sessions!, ws.sessionSubGroups ?? {}, ws.period.start, ws.period.end);
    const gradeRows = gradeSessionRates(analysis, ws.sessions!);
    expect(gradeRows.some(row => row.totals[theatreTypes[0]!.id]! > 0)).toBe(true);
    expect(gradeRows.some(row => row.totals[theatreTypes[1]!.id]! > 0)).toBe(true);
    const ratioRows = getSummary(unrestricted.model, unrestricted.assignments, ws);
    expect(theatreTypes.every(type => ratioRows.some(row => row.typeId === type.id))).toBe(true);
    expect(unrestricted.report?.rows.reduce((sum, row) => sum + row.theatreDays, 0)).toBeGreaterThan(0);

    const limited = [];
    for (const percent of [20, 40, 60]) limited.push(await run(percent, true, true));
    expect(limited[1]!.repeatDays).toBeGreaterThanOrEqual(limited[0]!.repeatDays);
    expect(limited[2]!.repeatDays).toBeGreaterThanOrEqual(limited[1]!.repeatDays);
    type BenchmarkRun = Awaited<ReturnType<typeof run>>;
    const repeatLine = (result: BenchmarkRun) => `${result.repeatDays}/${result.matchedDays}`;
    const fairnessLine = (result: BenchmarkRun) => `${result.debug?.fairnessObjectiveBefore ?? result.fairness} -> ${result.fairness}`;
    process.stdout.write([
      `Nine-week split-theatre ratio tier ${unrestricted.ratioFairnessStatus}; best theatre-only result ${unrestricted.candidateRepeatDays} repeats, status ${unrestricted.candidateStatus}, gap ${Number.isFinite(unrestricted.candidateGap) ? `${(unrestricted.candidateGap! * 100).toFixed(1)}%` : 'not proven'}; no limit switch off: repeats ${repeatLine(noConsultants)}, changes ${noConsultants.changed}, fairness ${fairnessLine(noConsultants)}.`,
      `No limit switch on: repeats ${repeatLine(unrestricted)}, candidate ${unrestricted.candidateRepeatDays} repeats, gap ${Number.isFinite(unrestricted.candidateGap) ? `${(unrestricted.candidateGap! * 100).toFixed(1)}%` : 'not proven'}, changes ${unrestricted.changed}, fairness ${fairnessLine(unrestricted)}, fallback ${unrestricted.debug?.consultantFallbackCheck ?? 'none'}.`,
      `Nine-week indexed setup ${unrestricted.setupSeconds.toFixed(2)}s; solver ${unrestricted.solveSeconds.toFixed(2)}s.`,
      ...limited.map((run, index) => `${[20, 40, 60][index]}%: ${run.debug?.consultantFallbackCheck ? 'fallback' : 'accepted'}, repeats ${repeatLine(run)}, theatre candidate ${run.debug?.consultantRepeatDays ?? '—'}, changes ${run.changed}, fairness ${fairnessLine(run)}, check ${run.debug?.consultantFallbackCheck ?? 'none'}.`),
    ].join('\n') + '\n');
  }, 480_000);

  it('solves a thirteen-week made-up consultant-list rota within the app budget', async () => {
    const ws = fairerFixture(13, 8);
    ws.profile.staff = ws.profile.staff.map((person, index) => ({ ...person, groupIds: [index < 3 ? 'st1' : index < 5 ? 'fy2' : 'gpreg'] }));
    attachMadeUpConsultantLists(ws);
    const setupStarted = performance.now();
    const model = prepareFairerModel(ws, ws.period.start, ws.period.end, 'none', 'none', true);
    const setupSeconds = (performance.now() - setupStarted) / 1000;
    const started = performance.now();
    const result = await solve(model.problem, {
      timeLimit: fairerRemainingTimeLimit(13, setupSeconds),
      buildOptions: model.buildOptions,
      afterTierReserve: { tier: 'fairness', fraction: 0.25 },
      afterTier: (tier, assignments, context) => tier === 'fairness'
        ? allocateFairerConsultants(model, assignments, context.remainingSeconds, context.reportProgress, context.tierObjective)
        : Promise.resolve(undefined),
    });
    const seconds = (performance.now() - started) / 1000;
    process.stdout.write(`Fairer rota 13-week setup with consultant lists: ${setupSeconds.toFixed(2)}s; solver: ${seconds.toFixed(2)}s; total: ${(setupSeconds + seconds).toFixed(2)}s\n`);
    expect(setupSeconds + seconds).toBeLessThanOrEqual(fairerTimeLimit(13) + 3);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.notes).toBeUndefined();
      expect(validateFairerResult(model, combineFairerAssignments(model, result.assignments))).toBeUndefined();
    }
  }, 90_000);

});
