import { legacySessions } from "./fixtures/legacy-sessions";

import { describe, expect, it } from 'vitest';
import { leaveMinimumWarningsForSnapshot, findSwaps, type SwapPlan } from '../src/engine/swaps';
import { analyseLeaveCheck, leaveCheckDateLabel } from '../src/app/leaveCheck';
import { leaveCheckText } from '../src/app/leaveCheck';
import { annualLeaveInputs, completePlansFirst, partialCoverageTitle, staffingSummaryLine } from '../src/app/swapsView';
import { makeShareContent, shareText } from '../src/app/swapShare';
import { leaveCheckWorkedExample } from './rework-stage3-fixture';

describe('Stage 3 leave check', () => {
  it('shows the worked made-up example cost, grouped days and same-tier absences', () => {
    const { ws, dates } = leaveCheckWorkedExample();
    const check = analyseLeaveCheck(ws.profile, ws.swapFinder!.snapshot, ws.swapFinder!.settings, ws.profile.staff, ws.sessions ?? legacySessions(ws.profile), 'doctor-0', dates, false, '2026-11-10')!;
    expect(check.cost).toBe('8 days off for 3 days of annual leave and 1 swap');
    expect(check.days.map(row => [row.dates, row.activity, row.outcome])).toEqual([
      [['2026-12-20'], 'Gynae Ward CT', 'Needs a swap'],
      [['2026-12-21'], 'Zero Day', 'Zero day, nothing to do'],
      [['2026-12-22'], 'Float CT', 'Book as leave'],
      [['2026-12-23', '2026-12-24'], 'MAU CT', 'Book as leave'],
      [['2026-12-25'], '', 'Nothing on the rota'],
      [['2026-12-26', '2026-12-27'], 'Zero Day', 'Zero day, nothing to do'],
    ]);
    expect(check.othersOff).toEqual([
      'Every day: Dr Moss (Away)',
      'Mon 21 Dec: Dr Hart (Self Development Time)',
      'Tue 22 Dec: Dr Vale (Training Day CT)',
    ]);
    expect(leaveCheckText(check)).toContain('Wed 23 – Thu 24 Dec: MAU CT · Book as leave');
  });

  it('uses the same minimum warnings as findSwaps and flags baseline shortages', () => {
    const { ws } = leaveCheckWorkedExample();
    ws.swapFinder!.settings.minDoctors = [30, 30, 30, 30, 30, 30, 30];
    const request = { staffId: 'doctor-0', leaveDates: ['2026-12-23'], leaveType: 'annual' as const, today: '2026-11-10' };
    const expected = findSwaps(ws.profile, ws.swapFinder!.snapshot, ws.swapFinder!.settings, request);
    const preview = leaveMinimumWarningsForSnapshot(ws.profile, ws.swapFinder!.snapshot, ws.swapFinder!.settings, request);
    expect(preview.leaveWarnings).toEqual(expected.leaveWarnings);
    expect(preview.existingShortages).toEqual(expected.existingShortages);
    const check = analyseLeaveCheck(ws.profile, ws.swapFinder!.snapshot, ws.swapFinder!.settings, ws.profile.staff, ws.sessions ?? legacySessions(ws.profile), request.staffId, request.leaveDates, false, request.today)!;
    expect(check.minimum[0]).toContain('Wed 23 Dec: ');
    expect(check.minimum[0]).toContain('doctors working, minimum 30, already short');
  });

  it('counts an extra hand-back and a part shift separately from swaps', () => {
    const { ws } = leaveCheckWorkedExample();
    ws.swapFinder!.snapshot.days['doctor-0']['2026-12-20'] = { status: 'longDay', activity: 'Gynae Ward CT', sessions: ['am', 'pm', 'eve'], extra: true };
    ws.swapFinder!.snapshot.days['doctor-0']['2026-12-21'] = { status: 'partShift', activity: 'Float CT', sessions: ['am'] };
    const check = analyseLeaveCheck(ws.profile, ws.swapFinder!.snapshot, ws.swapFinder!.settings, ws.profile.staff, ws.sessions ?? legacySessions(ws.profile), 'doctor-0', ['2026-12-20', '2026-12-21'], false, '2026-11-10')!;
    expect(check.cost).toBe('2 days off for 0 days of annual leave and 0 swaps, 1 part shift to sort out, 1 extra shift to hand back');
    expect(check.days.map(row => row.outcome)).toEqual(['Hand back (extra)', 'Sort out by hand']);
  });

  it('counts a multi-night block as one swap and ignores rest days in Others off', () => {
    const { ws } = leaveCheckWorkedExample();
    ws.swapFinder!.snapshot.days['doctor-0']['2026-12-24'] = { status: 'night', activity: 'Nights CT', sessions: ['night'] };
    ws.swapFinder!.snapshot.days['doctor-0']['2026-12-25'] = { status: 'night', activity: 'Nights CT', sessions: ['night'] };
    ws.swapFinder!.snapshot.days['doctor-0']['2026-12-26'] = { status: 'night', activity: 'Nights CT', sessions: ['night'] };
    ws.swapFinder!.snapshot.days['doctor-1']['2026-12-24'] = { status: 'zero', activity: 'Rest after nights' };
    const check = analyseLeaveCheck(ws.profile, ws.swapFinder!.snapshot, ws.swapFinder!.settings, ws.profile.staff, ws.sessions ?? legacySessions(ws.profile), 'doctor-0', ['2026-12-24', '2026-12-25', '2026-12-26'], false, '2026-11-10')!;
    expect(check.cost).toBe('3 days off for 0 days of annual leave and 1 swap');
    expect(check.days).toEqual([{ dates: ['2026-12-24', '2026-12-25', '2026-12-26'], activity: 'Nights CT', outcome: 'Needs a swap' }]);
    expect(leaveCheckDateLabel(check.days[0].dates)).toBe('Thu 24 – Sat 26 Dec');
    expect(check.othersOff.every(line => !line.includes('Dr Ellis'))).toBe(true);
  });

  it('lists away doctors in every comparison group and omits days with nobody away', () => {
    const { ws } = leaveCheckWorkedExample();
    const sessions = ws.sessions ?? legacySessions(ws.profile);
    sessions.groups.find(group => group.name === 'GPs')!.grades.push('GPs');
    ws.swapFinder!.snapshot.days['doctor-5']['2026-12-24'] = { status: 'training', activity: 'GP Teaching' };
    const withCrossGroup = analyseLeaveCheck(ws.profile, ws.swapFinder!.snapshot, ws.swapFinder!.settings, ws.profile.staff, sessions, 'doctor-0', ['2026-12-24'], false, '2026-11-10')!;
    expect(withCrossGroup.othersOff.some(line => line.includes('Dr Quinn (GP Teaching)'))).toBe(true);
    expect(withCrossGroup.othersOff.every(line => !line.startsWith('Every day:'))).toBe(true);

    for (const person of ws.profile.staff) ws.swapFinder!.snapshot.days[person.id]['2026-12-24'] = { status: 'dayJob', activity: 'Float CT', sessions: ['am', 'pm'] };
    const nobodyAway = analyseLeaveCheck(ws.profile, ws.swapFinder!.snapshot, ws.swapFinder!.settings, ws.profile.staff, sessions, 'doctor-0', ['2026-12-24'], false, '2026-11-10')!;
    expect(nobodyAway.othersOff).toEqual(['Nobody else off']);
  });

  it('keeps consecutive long-day swaps as separate rows and skips past or outside days in the cost', () => {
    const longsFixture = leaveCheckWorkedExample();
    longsFixture.ws.swapFinder!.snapshot.days['doctor-0']['2026-12-22'] = { status: 'longDay', activity: 'Gynae Ward CT', sessions: ['am', 'pm', 'eve'] };
    longsFixture.ws.swapFinder!.snapshot.days['doctor-0']['2026-12-23'] = { status: 'longDay', activity: 'Gynae Ward CT', sessions: ['am', 'pm', 'eve'] };
    const longs = analyseLeaveCheck(longsFixture.ws.profile, longsFixture.ws.swapFinder!.snapshot, longsFixture.ws.swapFinder!.settings, longsFixture.ws.profile.staff, legacySessions(longsFixture.ws.profile), 'doctor-0', ['2026-12-22', '2026-12-23'], false, '2026-11-10')!;
    expect(longs.cost).toBe('2 days off for 0 days of annual leave and 2 swaps');
    expect(longs.days).toEqual([
      { dates: ['2026-12-22'], activity: 'Gynae Ward CT', outcome: 'Needs a swap' },
      { dates: ['2026-12-23'], activity: 'Gynae Ward CT', outcome: 'Needs a swap' },
    ]);

    const { ws } = leaveCheckWorkedExample();
    const mixed = analyseLeaveCheck(ws.profile, ws.swapFinder!.snapshot, ws.swapFinder!.settings, ws.profile.staff, legacySessions(ws.profile), 'doctor-0', ['2026-10-01', '2026-12-23', '2027-06-01'], false, '2026-11-10')!;
    expect(mixed.cost).toBe('1 day off for 1 day of annual leave and 0 swaps');
    expect(mixed.outsideCount).toBe(2);
  });

  it('uses Covers labels and keeps partial share options after complete options', () => {
    const unit = { staffId: 'rowan', kind: 'longDay' as const, activity: 'Delivery Suite', dates: ['2026-12-18'], dayType: 'weekday' as const, hours: 12 };
    const partialUnit = { ...unit, dates: ['2026-12-18'] };
    const plan: SwapPlan = { chains: [{ links: [{ staffId: 'rowan', gives: partialUnit }, { staffId: 'ellis', gives: { ...unit, staffId: 'ellis', dates: ['2026-12-19'] } }], payDifferent: false }], people: 1, shiftsMoved: 1, cleared: [partialUnit], remaining: [{ ...unit, dates: ['2026-12-20'] }], warnings: [] };
    expect(partialCoverageTitle(plan, 'rowan')).toBe('Covers Fri only');
    const complete: SwapPlan = { ...plan, remaining: [], cleared: [] };
    expect(completePlansFirst([plan, complete])).toEqual([complete, plan]);
    complete.chains = [{ links: [{ staffId: 'rowan', gives: { ...partialUnit, dates: ['2026-12-20'] } }, { staffId: 'ellis', gives: { ...unit, staffId: 'ellis', dates: ['2026-12-21'] } }], payDifferent: false }];
    const content = makeShareContent({ plans: [plan, complete], filter: 'all', requesterId: 'rowan', requesterName: 'Dr Rowan', nameFor: id => id, covered: [{ dates: ['2026-12-18', '2026-12-19'], activity: 'Delivery Suite', kind: 'longDay' }], existingShortages: [], limit: 'all' });
    expect(content.sections[0].rows[0].instead).not.toContain('Covers');
    expect(content.sections[0].rows[0].alternatives[0].dates).toContain('Covers Fri only:');
    expect(shareText(content)).toContain('Covers Fri only:');
  });

  it('treats saved study leave as annual when applied to the live leave check', () => {
    const saved = { staffId: 'doctor-0', leaveDates: ['2026-12-23'], leaveType: 'study' as const, cantWorkDates: [], excludedStaffIds: [], includeNormalDays: false };
    expect(annualLeaveInputs(saved).leaveType).toBe('annual');
  });

  it('formats the single staffing summary line and omits it when there are no warnings', () => {
    expect(staffingSummaryLine([{ date: '2026-12-23' }], [{ date: '2026-12-24' }, { date: '2026-12-25' }])).toBe('Staffing: 1 day below minimum with your leave, 2 days already short');
    expect(staffingSummaryLine([], [])).toBeUndefined();
  });
});
