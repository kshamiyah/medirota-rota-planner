import { describe, expect, it } from 'vitest';
import { addCalendarRange, calendarMonthDates, calendarPointerAnchor, initialCalendarMonth, keyboardCalendarDate, rotaShortCode, shortRotaLabel, toggleCalendarDate } from '../src/app/components/SwapDateCalendar';
import { sameSwapFormInputs, swapDateSummary, type SwapFormInputs } from '../src/app/swapsView';
import { blankSnapshot, stage2Settings, work } from './swaps-stage2-helpers';

describe('Stage 5 search form helpers', () => {
  it('picks calendar dates by click, range and keyboard', () => {
    expect(toggleCalendarDate([], '2026-11-03')).toEqual(['2026-11-03']);
    expect(toggleCalendarDate(['2026-11-03'], '2026-11-03')).toEqual([]);
    expect(addCalendarRange([], '2026-11-05', '2026-11-03')).toEqual(['2026-11-03', '2026-11-04', '2026-11-05']);
    expect(keyboardCalendarDate('2026-11-10', 'ArrowRight')).toBe('2026-11-11');
    expect(keyboardCalendarDate('2026-11-10', 'ArrowDown')).toBe('2026-11-17');
    expect(calendarMonthDates('2026-11').filter(Boolean)).toHaveLength(30);
    expect(shortRotaLabel('zero')).toBe('Zero Day');
    expect(rotaShortCode('longDay')).toBe('LD');
    expect(initialCalendarMonth(['2026-10-26', '2026-11-02'], '2026-11-06')).toBe('2026-11');
    expect(initialCalendarMonth(['2026-12-07', '2026-12-14'], '2026-11-06')).toBe('2026-12');
    expect(initialCalendarMonth(['2026-12-07'], '2026-11-06', '2026-12-15')).toBe('2026-12');
  });

  it('keeps the previous anchor when shift-clicking a range', () => {
    let anchor = calendarPointerAnchor(undefined, '2026-11-10', false);
    let dates = toggleCalendarDate([], '2026-11-10');
    anchor = calendarPointerAnchor(anchor, '2026-11-12', true);
    dates = addCalendarRange(dates, anchor, '2026-11-12');
    expect(dates).toEqual(['2026-11-10', '2026-11-11', '2026-11-12']);
  });

  it('summarises leave consistently and offers the missing part of a long-day run', () => {
    const snapshot = blankSnapshot(['Dr Rowan']);
    for (const date of ['2026-12-04', '2026-12-05', '2026-12-06']) work(snapshot, 'Dr Rowan', date, 'longDay', 'Long cover');
    work(snapshot, 'Dr Rowan', '2026-12-07', 'dayJob', 'Clinic');
    snapshot.days['Dr Rowan']['2026-12-08'] = { status: 'partShift', activity: 'Ward', sessions: ['am', 'eve'] };
    const summary = swapDateSummary(snapshot, stage2Settings(), 'Dr Rowan', ['2026-12-05', '2026-12-06', '2026-12-07', '2026-12-08'], false);
    expect(summary.clashes.map(item => item.date)).toEqual(['2026-12-05', '2026-12-06']);
    expect(summary.requestAsLeave.map(item => item.date)).toEqual(['2026-12-07']);
    expect(summary.sortByHand.map(item => item.date)).toEqual(['2026-12-08']);
    expect(summary.partialRun).toEqual({ dates: ['2026-12-04', '2026-12-05', '2026-12-06'], missing: ['2026-12-04'] });
  });

  it('treats every More options control as part of the current search', () => {
    const base: SwapFormInputs = { staffId: 'Dr Rowan', leaveDates: ['2026-11-10'], leaveType: 'annual', cantWorkDates: [], excludedStaffIds: [], includeNormalDays: false, askMode: 'everyone', askStaffIds: [], returnPattern: 'consecutive', returnDayType: 'noPreference', returnWindow: { kind: 'any' }, noAlertsOnly: false, maxChain: 4 };
    const changes: SwapFormInputs[] = [
      { ...base, returnPattern: 'separate' }, { ...base, returnDayType: 'weekends' }, { ...base, returnWindow: { kind: 'weeks', weeks: 3 } },
      { ...base, noAlertsOnly: true }, { ...base, maxChain: 2 }, { ...base, excludedStaffIds: ['Dr Ellis'] }, { ...base, includeNormalDays: true },
    ];
    expect(changes.every(value => !sameSwapFormInputs(base, value))).toBe(true);
  });
});
