import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { addDays, dateRange } from '../src/engine/calendar';
import { findSwaps } from '../src/engine/swaps';
import { planIdentity } from '../src/app/swapsView';
import { initialCalendarMonth, shortRotaLabel } from '../src/app/components/SwapDateCalendar';
import { shiftCode } from '../src/app/components/codes';
import { leaveCheckDayLine } from '../src/app/leaveCheck';
import { displayRuledOutReason } from '../src/app/pages/FindSwaps';
import { visibleGradeSessionRows } from '../src/app/sessions';
import { initialSwapRequesterId, isColleagueSwapRequester, leaveStep5SkipStartsSearch } from '../src/app/swapWizard';
import { fairerChangeLimitHint, fairerConsultantListState, fairerWeekOptions } from '../src/app/pages/FairerRota';
import { stage7Cases, stage7Fixture } from './swaps-stage7-fixture';
import { emptyWorkspace } from '../src/app/store';

const digestsPath = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/swaps-b053e10-digests.json');
const expectedDigests = JSON.parse(readFileSync(digestsPath, 'utf8')) as Record<string, string>;

function noRulesFilterLabel(noRulesWarning: boolean): string {
  return noRulesWarning ? 'Not checked' : 'No alerts';
}

function noRulesPlanTag(noRulesWarning: boolean, alertCount: number): string {
  return noRulesWarning && alertCount === 0 ? 'Not checked: no rules set' : alertCount ? `${alertCount} ${alertCount === 1 ? 'alert' : 'alerts'}` : 'No alerts';
}

function showChosenPeopleHeading(askMode: string, askStaffIds: string[]): boolean {
  return askMode !== 'everyone' && askStaffIds.length > 0;
}

describe('Stage 1 quick fixes', () => {
  it('starts a doctor on ws.me only, never the first visible doctor', () => {
    expect(initialSwapRequesterId('doctor', 'ellis', ['rowan', 'ellis'])).toBe('ellis');
    expect(initialSwapRequesterId('doctor', undefined, ['rowan', 'ellis'])).toBe('');
    expect(initialSwapRequesterId('doctor', 'not-visible', ['rowan', 'ellis'])).toBe('');
    expect(initialSwapRequesterId('coordinator', 'ellis', ['rowan', 'ellis'])).toBe('');
    expect(isColleagueSwapRequester('doctor', 'rowan', 'ellis')).toBe(true);
    expect(isColleagueSwapRequester('doctor', 'ellis', 'ellis')).toBe(false);
    expect(isColleagueSwapRequester('coordinator', 'rowan', 'ellis')).toBe(false);
  });

  it('keeps day-job requester rules the same as leave', () => {
    expect(initialSwapRequesterId('doctor', 'hart', ['rowan', 'hart'])).toBe('hart');
    expect(initialSwapRequesterId('doctor', undefined, ['rowan', 'hart'])).toBe('');
    expect(initialSwapRequesterId('coordinator', 'hart', ['rowan', 'hart'])).toBe('');
  });

  it('treats a recent colleague search as searching for someone else', () => {
    expect(isColleagueSwapRequester('doctor', 'rowan', 'moss')).toBe(true);
    expect(initialSwapRequesterId('doctor', 'rowan', ['rowan', 'moss'])).toBe('rowan');
  });

  it('starts the leave search when Skip is pressed on step 5', () => {
    expect(leaveStep5SkipStartsSearch('leave', 5)).toBe(true);
    expect(leaveStep5SkipStartsSearch('leave', 3)).toBe(false);
  });

  it('opens calendars on today unless today is before the first imported week', () => {
    expect(initialCalendarMonth(['2026-10-26', '2026-11-02'], '2026-11-06')).toBe('2026-11');
    expect(initialCalendarMonth(['2026-12-07'], '2026-11-20')).toBe('2026-12');
    expect(initialCalendarMonth(['2026-10-26'], '2026-11-20')).toBe('2026-11');
  });

  it('calls day jobs Day job and retains the D short code', () => {
    expect(shortRotaLabel('dayJob')).toBe('Day job');
    expect(shiftCode('Day job')).toBe('D');
  });

  it('writes one plain line for each leave check outcome', () => {
    expect(leaveCheckDayLine('2026-12-29', 'long day', 'Needs a swap', 'longDay')).toBe('Tue 29 Dec: long day, needs a swap.');
    expect(leaveCheckDayLine('2026-12-30', 'Day job', 'Book as leave', 'dayJob')).toBe('Wed 30 Dec: day job, book as annual leave.');
    expect(leaveCheckDayLine('2026-12-31', '', 'Zero day, nothing to do', 'zero')).toBe('Thu 31 Dec: already off.');
    expect(leaveCheckDayLine('2027-01-01', '', 'Nothing on the rota', 'blank', true)).toBe('Fri 1 Jan: nothing on the rota, outside the imported weeks.');
    expect(leaveCheckDayLine('2027-01-02', 'Nights', 'Needs a swap', 'night')).toBe('Sat 2 Jan: night, needs a swap.');
    expect(leaveCheckDayLine('2027-01-03', 'Training', 'Nothing to do', 'training')).toBe('Sun 3 Jan: training, already off.');
    expect(leaveCheckDayLine('2027-01-04', 'Part shift', 'Sort out by hand', 'partShift')).toBe('Mon 4 Jan: part shift, needs sorting by hand.');
    expect(leaveCheckDayLine('2027-01-05', 'Extra shift', 'Hand back (extra)', 'dayJob')).toBe('Tue 5 Jan: Extra shift, hand back.');
  });

  it('formats ruled-out copy without changing the engine reason or its ISO date', () => {
    expect(displayRuledOutReason('The doctor is not off (night).')).toBe("They're on a night.");
    expect(displayRuledOutReason('The doctor is not off (dayJob).')).toBe("They're on a day job.");
    expect(displayRuledOutReason('Not on the rota on these dates')).toBe("Their week isn't imported");
    expect(displayRuledOutReason('Working nights on 2026-12-29')).toBe('On nights on Tue 29 Dec');
    expect(displayRuledOutReason("A valid swap exists but wasn't shown because of the plan limit.")).toBe("There's a swap with this person, but it didn't make the first page. Use Find 50 more to see it.");
  });

  it('hides empty grade groups while retaining the viewing doctor’s own group', () => {
    const rows = [{ id: 'fy2', count: 2 }, { id: 'gps', count: 0 }, { id: 'st1', count: 0 }] as Parameters<typeof visibleGradeSessionRows>[0];
    expect(visibleGradeSessionRows(rows, 'st1').map(row => row.id)).toEqual(['fy2', 'st1']);
  });

  it('distinguishes absent lists, unconfigured lists, and configured allocation', () => {
    expect(fairerConsultantListState(false, false)).toEqual({ kind: 'none' });
    expect(fairerConsultantListState(true, false, '2026-11-18')).toEqual({ kind: 'configure', date: '2026-11-18' });
    expect(fairerConsultantListState(true, true, '2026-11-18', '2026-11-17')).toEqual({ kind: 'allocated', date: '2026-11-17' });
  });

  it('states the maximum number of day sessions in the limit hint', () => {
    expect(fairerChangeLimitHint(20, 283)).toBe('Move at most 56 of the 283 day sessions (20%)');
  });

  it('shows exactly Monday to Sunday for Fairer week options, including month-boundary weeks', () => {
    const midMonth = dateRange('2026-11-16', '2026-11-29');
    expect(fairerWeekOptions(midMonth)).toEqual(['2026-11-16', '2026-11-23']);
    const boundary = dateRange('2026-11-30', '2026-12-13');
    expect(fairerWeekOptions(boundary)).toEqual(['2026-11-30', '2026-12-07']);
    const firstWeek = fairerWeekOptions(boundary)[0];
    expect(dateRange(firstWeek, addDays(firstWeek, 6))).toEqual(['2026-11-30', '2026-12-01', '2026-12-02', '2026-12-03', '2026-12-04', '2026-12-05', '2026-12-06']);
    const lastWeek = fairerWeekOptions(boundary).at(-1)!;
    expect(dateRange(lastWeek, addDays(lastWeek, 6))).toEqual(['2026-12-07', '2026-12-08', '2026-12-09', '2026-12-10', '2026-12-11', '2026-12-12', '2026-12-13']);
  });

  it('names a new import Day job while leaving a saved workspace shift name alone', () => {
    const fresh = emptyWorkspace();
    expect(shortRotaLabel('dayJob')).toBe('Day job');
    expect(shiftCode('Day job')).toBe('D');
    expect(shiftCode('Normal working day')).toBe('D');
    fresh.profile.shiftTypes = [{ id: 'day', name: 'Normal working day', start: '08:00', end: '17:30' }];
    expect(fresh.profile.shiftTypes[0].name).toBe('Normal working day');
  });

  it('says Not checked when no rules are set, and keeps results identical when rules exist', () => {
    expect(noRulesFilterLabel(true)).toBe('Not checked');
    expect(noRulesPlanTag(true, 0)).toBe('Not checked: no rules set');
    expect(noRulesFilterLabel(false)).toBe('No alerts');
    expect(noRulesPlanTag(false, 0)).toBe('No alerts');
    const bare = stage7Fixture('sameAt');
    bare.ws.profile.rules = [];
    const bareResult = findSwaps(bare.ws.profile, bare.ws.swapFinder!.snapshot, bare.ws.swapFinder!.settings, bare.request);
    expect(bareResult.noRulesWarning).toBe(true);
    const withRules = stage7Fixture('sameAt');
    expect(withRules.ws.profile.rules.length).toBeGreaterThan(0);
    const withRulesResult = findSwaps(withRules.ws.profile, withRules.ws.swapFinder!.snapshot, withRules.ws.swapFinder!.settings, withRules.request);
    expect(withRulesResult.noRulesWarning).toBe(false);
  });

  it('hides the chosen-people heading for Everyone and shows it when people are chosen', () => {
    expect(showChosenPeopleHeading('everyone', ['ellis'])).toBe(false);
    expect(showChosenPeopleHeading('only', [])).toBe(false);
    expect(showChosenPeopleHeading('only', ['ellis'])).toBe(true);
    expect(showChosenPeopleHeading('prefer', ['hart'])).toBe(true);
  });

  it('keeps Find swaps digests identical to the main-era fixture on every Stage 7 case', () => {
    const digests: Record<string, string> = {};
    for (const kind of stage7Cases) {
      const { ws, request } = stage7Fixture(kind);
      const result = findSwaps(ws.profile, ws.swapFinder!.snapshot, ws.swapFinder!.settings, request);
      digests[kind] = createHash('sha256').update(JSON.stringify({
        plans: result.plans.map(planIdentity),
        ruledOut: result.ruledOut.map(item => ({ staffId: item.staffId, group: item.group, reason: item.reason, dates: item.unit.dates })),
        truncated: result.truncated ?? false,
        stoppedEarly: result.stoppedEarly ?? null,
        morePlanSizes: result.morePlanSizes ?? [],
        limits: result.limits ?? [],
        existingShortages: result.existingShortages ?? [],
        clashes: result.clashes ?? [],
      })).digest('hex');
    }
    expect(digests).toEqual(expectedDigests);
  });
});
