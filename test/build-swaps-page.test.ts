import { describe, expect, it } from 'vitest';
import type { RotaSnapshot, SwapChain, SwapPlan, SwapSettings, SwapUnit } from '../src/engine/swaps';
import type { Staff } from '../src/engine/types';
import { appendSwapPlans, calendarColumns, chainSentences, datesOutsideImports, doctorCountText, groupSwapPlans, hoursSuggestionText, importedWeekFor, inclusiveDates, latestImport, localISODate, movedShiftSentence, pastLeaveWarning, peopleCountText, planFilterCounts, planIdentity, planMatchesHides, sameSwapFormInputs, swapGroupHeading, swapLimitMessages, swapResultIsCurrent, swapSettingsFingerprint, unitDescription, weekendActivities, withDeclinedDoctor, type SwapFormInputs } from '../src/app/swapsView';

const staff = [
  { id: 'requester', name: 'Dr Rowan' },
  { id: 'b', name: 'Dr Birch' },
  { id: 'c', name: 'Dr Hazel' },
  { id: 'd', name: 'Dr Moss' },
] as Staff[];

function unit(staffId: string, date: string, activity = 'Delivery Suite'): SwapUnit {
  return { kind: 'longDay', staffId, activity, dates: [date], dayType: 'weekday', hours: 12.5 };
}

describe('swap page presentation helpers', () => {
  const inputs: SwapFormInputs = {
    staffId: 'requester', leaveDates: ['2026-11-12'], leaveType: 'annual',
    cantWorkDates: ['2026-11-24'], excludedStaffIds: ['c'], includeNormalDays: false,
  };

  it('invalidates displayed results when any search input changes', () => {
    expect(sameSwapFormInputs(inputs, structuredClone(inputs))).toBe(true);
    const changes: SwapFormInputs[] = [
      { ...inputs, staffId: 'b' },
      { ...inputs, leaveDates: ['2026-11-13'] },
      { ...inputs, leaveType: 'study' },
      { ...inputs, cantWorkDates: ['2026-11-25'] },
      { ...inputs, excludedStaffIds: ['d'] },
      { ...inputs, includeNormalDays: true },
    ];
    for (const changed of changes) expect(sameSwapFormInputs(inputs, changed)).toBe(false);
  });

  it('adds a declined doctor to the result request without changing its doctor', () => {
    const next = withDeclinedDoctor(inputs, 'b');
    expect(next.staffId).toBe('requester');
    expect(next.excludedStaffIds).toEqual(['c', 'b']);
    expect(withDeclinedDoctor(next, 'b').excludedStaffIds).toEqual(['c', 'b']);
  });

  it('names one, two and three people in group headings with option plurals', () => {
    expect(swapGroupHeading(['Dr Rowan'], 8)).toBe('Dr Rowan · 8 options');
    expect(swapGroupHeading(['Dr Rowan', 'Dr Ellis'], 3)).toBe('Dr Rowan and Dr Ellis · 3 options');
    expect(swapGroupHeading(['Avery Reed', 'Bailey Hart', 'Casey Moss'], 2)).toBe('Avery Reed, Bailey Hart and Casey Moss · 2 options');
    expect(swapGroupHeading(['Robin Vale'], 1)).toBe('Robin Vale · 1 option');
  });

  it('invalidates displayed results when any saved finder setting changes', () => {
    const settings: SwapSettings = {
      weekendDayActivities: [], hoursTolerance: 1, maxChain: 4,
      minDoctors: [7, 7, 7, 7, 7, 3, 3], minDoctorsBankHoliday: 4,
      bankHolidays: [], regularDaysOff: {}, excluded: [],
    };
    const original = swapSettingsFingerprint(settings);
    const changes: SwapSettings[] = [
      { ...settings, weekendDayActivities: ['Weekend ward'] },
      { ...settings, hoursTolerance: 2 },
      { ...settings, maxChain: 2 },
      { ...settings, returnPattern: 'separate' },
      { ...settings, minDoctors: [6, 7, 7, 7, 7, 3, 3] },
      { ...settings, minDoctorsBankHoliday: 3 },
      { ...settings, bankHolidays: ['2026-12-25'] },
      { ...settings, regularDaysOff: { b: [0] } },
      { ...settings, excluded: [{ staffId: 'b' }] },
      { ...settings, nightRestDaysBefore: 3 },
      { ...settings, nightRestDaysAfter: 4 },
    ];
    expect(swapSettingsFingerprint(structuredClone(settings))).toBe(original);
    expect(swapResultIsCurrent(inputs, original, structuredClone(inputs), original)).toBe(true);
    for (const changed of changes) {
      const changedFingerprint = swapSettingsFingerprint(changed);
      expect(changedFingerprint).not.toBe(original);
      expect(swapResultIsCurrent(inputs, original, inputs, changedFingerprint)).toBe(false);
    }
  });

  it('uses the local date during British Summer Time and names past leave dates', () => {
    const localClock = {
      getFullYear: () => 2026, getMonth: () => 6, getDate: () => 1,
      toISOString: () => '2026-06-30T23:30:00.000Z',
    } as Date;
    expect(localISODate(localClock)).toBe('2026-07-01');
    expect(pastLeaveWarning(['2026-11-04', '2026-11-02', '2026-11-03'], '2026-11-04'))
      .toBe('These leave dates are before today and cannot be searched: Mon 2 Nov, Tue 3 Nov.');
    expect(pastLeaveWarning(['2026-11-04', '2026-11-05'], '2026-11-04')).toBeUndefined();
  });

  it('expands date ranges, counts filters and collapses calendar gaps', () => {
    expect(inclusiveDates('2026-11-07', '2026-11-09')).toEqual(['2026-11-07', '2026-11-08', '2026-11-09']);
    expect(inclusiveDates('2026-11-09', '2026-11-07')).toEqual([]);
    const direct = { chains: [{ payDifferent: false, links: [{ staffId: 'requester', gives: unit('requester', '2026-11-12') }, { staffId: 'b', gives: unit('b', '2026-11-24') }] }], people: 1, shiftsMoved: 2, cleared: [], remaining: [], warnings: [], wholeWeekend: true } as SwapPlan;
    const three = { ...direct, chains: [{ payDifferent: false, links: [...direct.chains[0].links, { staffId: 'c', gives: unit('c', '2026-11-28') }] }], people: 2, wholeWeekend: undefined, alerts: [{ staffId: 'c', date: '2026-11-28', message: 'Check hours' }] } as SwapPlan;
    expect(planFilterCounts([direct, three])).toEqual({ all: 2, ask1: 1, ask2: 1, ask3: 0, noAlerts: 1, wholeWeekend: 1 });
    const sameDay = { ...direct, wholeWeekend: undefined, chains: [{ ...direct.chains[0], sameDay: { doctors: 7, minimum: 7 } }] } as SwapPlan;
    const missed = { ...direct, wholeWeekend: undefined, missedTraining: [{ staffId: 'b', date: '2026-11-12' }] } as SwapPlan;
    expect(planMatchesHides(sameDay, { hideSameDay: true })).toBe(false);
    expect(planMatchesHides(missed, { hideMissedTraining: true })).toBe(false);
    expect(planFilterCounts([direct, sameDay, missed], { hideSameDay: true })).toEqual({ all: 2, ask1: 2, ask2: 0, ask3: 0, noAlerts: 2, wholeWeekend: 1 });
    expect(planFilterCounts([direct, sameDay, missed], { hideMissedTraining: true })).toEqual({ all: 2, ask1: 2, ask2: 0, ask3: 0, noAlerts: 2, wholeWeekend: 1 });
    expect(groupSwapPlans([direct, sameDay, missed], 'requester', 'all', undefined, { hideSameDay: true, hideMissedTraining: true })).toHaveLength(1);
    expect(calendarColumns(['2026-11-05', '2026-11-20'])).toEqual(['2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '…', '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21', '2026-11-22']);
    expect(doctorCountText(1)).toBe('1 doctor');
    expect(doctorCountText(2)).toBe('2 doctors');
    expect(peopleCountText(1)).toBe('1 person');
    expect(peopleCountText(2)).toBe('2 people');
    expect(hoursSuggestionText({ date: '2026-12-14', activity: 'Clinic' })).toBe('To stay under 72 hours, you could request Clinic on Mon 14 Dec as annual leave.');
    expect(swapLimitMessages(['chainSample', 'planCap'])).toEqual([
      'All direct swaps are shown. Some 3- and 4-person chains may be missing, because the search only checks those closest in date.',
      'The first page is shown for each chain size. Use Find 50 more to extend a page.',
    ]);
    expect(swapLimitMessages(['planSample'])).toEqual(['Some combinations may be missing because the search limits how many plans it builds. Direct whole-weekend swaps are still checked in full.']);
    expect(planIdentity(direct)).toBe('requester:longDay:2026-11-12>b:longDay:2026-11-24');
    expect(appendSwapPlans([direct], [three, direct], 3)).toEqual([direct, three]);
    expect(appendSwapPlans([direct], [three], 2)).toEqual([direct]);
    const groups = groupSwapPlans([direct, { ...direct, shiftsMoved: 4 }, three], 'requester', 'all');
    expect(groups.map(group => [group.people, group.options.map(option => option.index)])).toEqual([
      [['b'], [0, 1]],
      [['b', 'c'], [2]],
    ]);
    expect(groupSwapPlans([direct, three], 'requester', 'ask2')[0].options[0].index).toBe(1);
  });

  it('finds leave dates outside imported weeks and the latest import', () => {
    const snapshot: RotaSnapshot = {
      days: {},
      importedAt: { '2026-11-02': '2026-11-03T09:00:00.000Z', '2026-11-16': '2026-11-18T10:00:00.000Z' },
    };
    expect(importedWeekFor('2026-11-08')).toBe('2026-11-02');
    expect(datesOutsideImports(snapshot, ['2026-11-05', '2026-11-12', '2026-11-22'])).toEqual(['2026-11-12']);
    expect(latestImport(snapshot)).toBe('2026-11-18T10:00:00.000Z');
  });

  it('lists only day-job activities seen at weekends or on bank holidays', () => {
    const snapshot: RotaSnapshot = {
      importedAt: { '2026-11-02': '2026-11-03T09:00:00.000Z' },
      days: { alpha: {
        '2026-11-06': { status: 'dayJob', activity: 'Clinic' },
        '2026-11-07': { status: 'dayJob', activity: 'Postnatal Wards' },
        '2026-11-09': { status: 'dayJob', activity: 'Holiday Theatre' },
        '2026-11-08': { status: 'longDay', activity: 'Delivery Suite' },
      } },
    };
    expect(weekendActivities(snapshot, ['2026-11-09'])).toEqual(['Holiday Theatre', 'Postnatal Wards']);
  });

  it('writes a direct swap in plain language', () => {
    const chain: SwapChain = { payDifferent: false, links: [
      { staffId: 'requester', gives: unit('requester', '2026-11-12') },
      { staffId: 'b', gives: unit('b', '2026-11-24') },
    ] };
    expect(chainSentences(chain, staff, 'requester')).toEqual([
      'Dr Birch takes your long day (Delivery Suite) on Thu 12 Nov.',
      "You take Dr Birch's long day (Delivery Suite) on Tue 24 Nov.",
    ]);
  });

  it('names every handover in 3-way and 4-way chains', () => {
    const three: SwapChain = { payDifferent: false, links: [
      { staffId: 'requester', gives: unit('requester', '2026-11-12') },
      { staffId: 'b', gives: unit('b', '2026-11-17') },
      { staffId: 'c', gives: unit('c', '2026-11-23') },
    ] };
    expect(chainSentences(three, staff, 'requester')).toEqual([
      'Dr Birch takes your long day (Delivery Suite) on Thu 12 Nov.',
      "Dr Hazel takes Dr Birch's long day (Delivery Suite) on Tue 17 Nov.",
      "You take Dr Hazel's long day (Delivery Suite) on Mon 23 Nov.",
    ]);
    const four: SwapChain = { payDifferent: false, links: [...three.links.slice(0, 2), { staffId: 'c', gives: unit('c', '2026-11-23') }, { staffId: 'd', gives: unit('d', '2026-11-27') }] };
    expect(chainSentences(four, staff, 'requester')).toHaveLength(4);
    expect(chainSentences(four, staff, 'requester')[2]).toContain("Dr Moss takes Dr Hazel's");
    expect(chainSentences(four, staff, 'requester')[3]).toContain("You take Dr Moss'");
  });

  it('describes a whole night block as one unit', () => {
    const nights: SwapUnit = { kind: 'nightBlock', staffId: 'b', activity: 'Night', dates: ['2026-11-13', '2026-11-14', '2026-11-15'], dayType: 'weekend', hours: 36 };
    expect(unitDescription(nights)).toBe('night block (Night) on Fri 13 Nov to Sun 15 Nov');
  });

  it('describes a rest-day shift passed back with names and a date', () => {
    expect(movedShiftSentence({ fromStaffId: 'b', toStaffId: 'requester', date: '2026-11-16', activity: 'Float', kind: 'dayJob' }, staff, 'requester'))
      .toBe("You also take Dr Birch's Float on Mon 16 Nov.");
    expect(movedShiftSentence({ fromStaffId: 'requester', toStaffId: 'b', date: '2026-11-09', activity: 'Long cover', kind: 'longDay' }, staff, 'requester'))
      .toBe('Dr Birch also takes your Long cover on Mon 9 Nov.');
  });
});
