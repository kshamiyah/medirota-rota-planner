import { describe, expect, it } from 'vitest';
import { addDays, formatDate, parseDate } from '../src/engine/calendar';
import { findSwaps, type RotaSnapshot, type SwapPlan } from '../src/engine/swaps';
import type { ISODate } from '../src/engine/types';
import {
  appendSwapPlans, groupSwapPlans, hoursSuggestionText, peopleCountText, planFilterCounts, planIdentity, planMatchesFilter,
} from '../src/app/swapsView';
import {
  blankSnapshot, off, stage2Profile, stage2Request, stage2Settings, work,
} from './swaps-stage2-helpers';

const STAGE4_MONDAY = '2026-11-02';

function block(snapshot: RotaSnapshot, staffId: string, start: ISODate, len = 2) {
  for (let i = 0; i < len; i++) work(snapshot, staffId, addDays(start, i), 'night', 'Night ward');
}

describe('Stage 4 swap behaviour (tester)', () => {
  it('shows all ten direct returns from one partner before any longer chain', () => {
    const ids = ['requester', 'partner', 'middle', 'returner', 'third'];
    const snapshot = blankSnapshot(ids, 140);
    work(snapshot, 'requester', STAGE4_MONDAY, 'longDay', 'Long cover');
    off(snapshot, 'partner', STAGE4_MONDAY);
    off(snapshot, 'middle', STAGE4_MONDAY);
    off(snapshot, 'third', STAGE4_MONDAY);
    const partnerDates = Array.from({ length: 10 }, (_, index) => addDays('2026-11-10', index * 3));
    for (const date of partnerDates) {
      work(snapshot, 'partner', date, 'longDay', 'Long cover');
      off(snapshot, 'requester', date);
    }
    work(snapshot, 'middle', '2027-01-05', 'longDay', 'Long cover');
    off(snapshot, 'returner', '2027-01-05');
    work(snapshot, 'returner', '2027-01-12', 'longDay', 'Long cover');
    off(snapshot, 'requester', '2027-01-12');
    work(snapshot, 'third', '2027-01-19', 'longDay', 'Long cover');
    off(snapshot, 'middle', '2027-01-19');
    const result = findSwaps(
      stage2Profile(ids, ['Long cover']),
      snapshot,
      stage2Settings({ maxChain: 4 }),
      stage2Request('requester', [STAGE4_MONDAY]),
    );
    const partnerPlans = result.plans.filter(plan => plan.chains[0].links.length === 2 && plan.chains[0].links[1].staffId === 'partner');
    expect(partnerPlans.map(plan => plan.chains[0].links[1].gives.dates[0]).sort()).toEqual([...partnerDates].sort());
    const firstLonger = result.plans.findIndex(plan => plan.chains[0].links.length > 2);
    expect(firstLonger).toBeGreaterThanOrEqual(10);
    expect(result.plans.slice(0, 10)).toEqual(partnerPlans);
  });

  it('merges mirror whole-weekend plans into one card', () => {
    const ids = ['requester', 'cover'];
    const snapshot = blankSnapshot(ids);
    for (const date of ['2026-11-07', '2026-11-08']) {
      work(snapshot, 'requester', date, 'longDay', 'Long cover');
      off(snapshot, 'cover', date);
    }
    for (const date of ['2026-11-14', '2026-11-15']) {
      work(snapshot, 'cover', date, 'longDay', 'Long cover');
      off(snapshot, 'requester', date);
    }
    const result = findSwaps(
      stage2Profile(ids, ['Long cover']),
      snapshot,
      stage2Settings({ maxChain: 2 }),
      stage2Request('requester', ['2026-11-07', '2026-11-08']),
    );
    expect(result.plans.filter(plan => plan.wholeWeekend)).toHaveLength(1);
  });

  it('ranks more clashes cleared before fewer people', () => {
    const ids = ['requester', 'solo', 'split-a', 'split-b'];
    const snapshot = blankSnapshot(ids);
    const sat = '2026-11-07';
    const sun = '2026-11-08';
    work(snapshot, 'requester', sat, 'dayJob', 'Weekend List');
    work(snapshot, 'requester', sun, 'dayJob', 'Weekend List');
    off(snapshot, 'solo', sat);
    off(snapshot, 'solo', sun);
    off(snapshot, 'split-a', sat);
    work(snapshot, 'split-a', sun, 'dayJob', 'Weekend List');
    work(snapshot, 'split-b', sat, 'dayJob', 'Weekend List');
    off(snapshot, 'split-b', sun);
    work(snapshot, 'solo', '2026-11-14', 'dayJob', 'Weekend List');
    off(snapshot, 'requester', '2026-11-14');
    work(snapshot, 'split-a', '2026-11-15', 'dayJob', 'Weekend List');
    off(snapshot, 'requester', '2026-11-15');
    work(snapshot, 'split-b', '2026-11-16', 'dayJob', 'Weekend List');
    off(snapshot, 'requester', '2026-11-16');
    const result = findSwaps(
      stage2Profile(ids, ['Weekend List']),
      snapshot,
      stage2Settings({ weekendDayActivities: ['Weekend List'], maxChain: 2 }),
      stage2Request('requester', [sat, sun]),
    );
    const fullIdx = result.plans.findIndex(plan => plan.cleared.length === 2);
    const partialIdx = result.plans.findIndex(plan => plan.cleared.length === 1);
    expect(fullIdx).toBeLessThan(partialIdx);
  });

  it('ranks fewer shifts moved before return-pattern preference', () => {
    const ids = ['requester', 'clean-cover', 'heavy-cover'];
    const snapshot = blankSnapshot(ids);
    block(snapshot, 'requester', '2026-11-10');
    block(snapshot, 'clean-cover', '2026-11-24');
    block(snapshot, 'heavy-cover', '2026-12-08');
    for (const date of ['2026-11-10', '2026-11-11']) {
      off(snapshot, 'clean-cover', date);
      off(snapshot, 'heavy-cover', date);
    }
    for (const date of ['2026-11-24', '2026-11-25', '2026-12-08', '2026-12-09']) off(snapshot, 'requester', date);
    work(snapshot, 'heavy-cover', '2026-11-10', 'dayJob', 'Float clinic');
    off(snapshot, 'requester', '2026-11-09');
    const result = findSwaps(
      stage2Profile(ids, ['Night ward', 'Float clinic']),
      snapshot,
      stage2Settings({ maxChain: 2 }),
      stage2Request('requester', ['2026-11-10']),
    );
    expect(result.plans[0].chains[0].links[1].staffId).toBe('clean-cover');
  });

  it('applies return pattern only at the return-pattern rank step', () => {
    const ids = ['requester', 'partner'];
    const snapshot = blankSnapshot(ids);
    for (const date of ['2026-11-07', '2026-11-08']) {
      work(snapshot, 'requester', date, 'longDay', 'Long cover');
      off(snapshot, 'partner', date);
    }
    for (const date of ['2026-11-14', '2026-11-15', '2026-11-17', '2026-11-19']) {
      work(snapshot, 'partner', date, 'longDay', 'Long cover');
      off(snapshot, 'requester', date);
    }
    const profile = stage2Profile(ids, ['Long cover']);
    const base = stage2Request('requester', ['2026-11-07', '2026-11-08']);
    const returns = (pattern: 'consecutive' | 'separate' | 'noPreference') =>
      findSwaps(profile, snapshot, stage2Settings({ maxChain: 2 }), { ...base, returnPattern: pattern })
        .plans[0].chains.flatMap(chain => chain.links[1].gives.dates).sort();
    expect(returns('consecutive')).toEqual(['2026-11-14', '2026-11-15']);
    const separate = returns('separate');
    expect(addDays(separate[0], 1)).not.toBe(separate[1]);
    expect(returns('noPreference')).toEqual(['2026-11-14', '2026-11-15']);
  });

  it('pages each chain size and keeps direct order stable across searches', () => {
    const ids = ['requester', 'cover-one', 'cover-two', 'cover-three'];
    const snapshot = blankSnapshot(ids);
    work(snapshot, 'requester', '2026-11-10', 'longDay', 'Long cover');
    ids.slice(1).forEach((staffId, index) => {
      off(snapshot, staffId, '2026-11-10');
      const returnDate = addDays('2026-11-17', index * 7);
      work(snapshot, staffId, returnDate, 'longDay', 'Long cover');
      off(snapshot, 'requester', returnDate);
    });
    const profile = stage2Profile(ids, ['Long cover']);
    const base = stage2Request('requester', ['2026-11-10']);
    const directOnly = findSwaps(profile, snapshot, stage2Settings({ maxChain: 2 }), base);
    const fullChain = findSwaps(profile, snapshot, stage2Settings({ maxChain: 4 }), base);
    const directFromFull = fullChain.plans.filter(plan => plan.chains[0].links.length === 2);
    expect(directFromFull.map(plan => planIdentity(plan))).toEqual(directOnly.plans.map(plan => planIdentity(plan)));
    const first = findSwaps(profile, snapshot, stage2Settings({ maxChain: 2 }), { ...base, planLimits: { 2: 1 } });
    const second = findSwaps(profile, snapshot, stage2Settings({ maxChain: 2 }), { ...base, planLimits: { 2: 2 } });
    expect(second.plans[0].chains).toEqual(first.plans[0].chains);
    expect(second.plans.length).toBe(2);
    expect(first.morePlanSizes).toContain(2);
  });

  it('records NWD pass-back as leaveRequests and long day as toArrange', () => {
    const ids = ['requester', 'cover'];
    const snapshot = blankSnapshot(ids);
    block(snapshot, 'requester', '2026-11-10');
    block(snapshot, 'cover', '2026-11-24');
    off(snapshot, 'cover', '2026-11-10');
    off(snapshot, 'cover', '2026-11-11');
    off(snapshot, 'requester', '2026-11-24');
    off(snapshot, 'requester', '2026-11-25');
    work(snapshot, 'cover', '2026-11-10', 'dayJob', 'Float clinic');
    const dayJobPlan = findSwaps(
      stage2Profile(ids, ['Night ward', 'Float clinic']),
      snapshot,
      stage2Settings(),
      stage2Request('requester', ['2026-11-10']),
    ).plans[0];
    expect(dayJobPlan?.leaveRequests).toEqual([{ date: '2026-11-10', activity: 'Float clinic' }]);
    expect(dayJobPlan?.toArrange).toBeUndefined();

    const longSnapshot = blankSnapshot(ids);
    block(longSnapshot, 'requester', '2026-11-10');
    block(longSnapshot, 'cover', '2026-11-24');
    off(longSnapshot, 'cover', '2026-11-10');
    off(longSnapshot, 'cover', '2026-11-11');
    off(longSnapshot, 'requester', '2026-11-24');
    off(longSnapshot, 'requester', '2026-11-25');
    work(longSnapshot, 'cover', '2026-11-10', 'longDay', 'Long cover');
    const longPlan = findSwaps(
      stage2Profile(ids, ['Night ward', 'Long cover']),
      longSnapshot,
      stage2Settings(),
      stage2Request('requester', ['2026-11-10']),
    ).plans[0];
    expect(longPlan?.toArrange).toEqual([{ date: '2026-11-10', activity: 'Long cover' }]);
    expect(longPlan?.leaveRequests).toBeUndefined();
  });

  it('never moves training shifts in night packages', () => {
    const ids = ['requester', 'cover'];
    const snapshot = blankSnapshot(ids);
    block(snapshot, 'requester', '2026-11-10');
    block(snapshot, 'cover', '2026-11-24');
    off(snapshot, 'cover', '2026-11-10');
    off(snapshot, 'cover', '2026-11-11');
    off(snapshot, 'requester', '2026-11-24');
    off(snapshot, 'requester', '2026-11-25');
    snapshot.days.cover['2026-11-09'] = { status: 'training', activity: 'Teaching' };
    expect(findSwaps(
      stage2Profile(ids, ['Night ward']),
      snapshot,
      stage2Settings(),
      stage2Request('requester', ['2026-11-10']),
    ).plans).toHaveLength(0);
  });

  it('formats 72-hour suggestions with long dates, not ISO strings', () => {
    const text = hoursSuggestionText({ date: '2027-01-04', activity: 'Elective lists' });
    expect(text).toMatch(/Mon 4 Jan/);
    expect(text).not.toMatch(/2027-01-04/);
  });

  it('uses 1 person and 2 people wording', () => {
    expect(peopleCountText(1)).toBe('1 person');
    expect(peopleCountText(2)).toBe('2 people');
  });

  it('groups plans by people, filters empty groups, and keeps stable option indices', () => {
    const direct = {
      chains: [{ payDifferent: false, links: [
        { staffId: 'requester', gives: { kind: 'longDay' as const, staffId: 'requester', activity: 'Clinic', dates: ['2026-11-12'], dayType: 'weekday' as const, hours: 12.5 } },
        { staffId: 'b', gives: { kind: 'longDay' as const, staffId: 'b', activity: 'Clinic', dates: ['2026-11-24'], dayType: 'weekday' as const, hours: 12.5 } },
      ] }],
      people: 1, shiftsMoved: 2, cleared: [], remaining: [], warnings: [],
    } satisfies SwapPlan;
    const three = {
      ...direct,
      chains: [{ payDifferent: false, links: [...direct.chains[0].links, {
        staffId: 'c',
        gives: { kind: 'longDay' as const, staffId: 'c', activity: 'Clinic', dates: ['2026-11-28'], dayType: 'weekday' as const, hours: 12.5 },
      }] }],
      people: 2,
    } satisfies SwapPlan;
    const severalPartners = { ...direct, chains: [direct.chains[0], { ...direct.chains[0], links: [direct.chains[0].links[0], { ...direct.chains[0].links[1], staffId: 'c' }] }], people: 2 };
    const basePlans = [direct, { ...direct, shiftsMoved: 4 }, three];
    const plans = [...basePlans, severalPartners];
    expect(planFilterCounts(plans)).toEqual({ all: 4, ask1: 2, ask2: 2, ask3: 0, noAlerts: 4, wholeWeekend: 0 });
    expect(planMatchesFilter(severalPartners, 'ask2')).toBe(true);
    expect(planMatchesFilter(severalPartners, 'ask1')).toBe(false);
    expect(groupSwapPlans(plans, 'requester', 'ask2').flatMap(group => group.options)).toHaveLength(2);
    const groups = groupSwapPlans(basePlans, 'requester', 'all');
    expect(groups.map(g => g.options.map(o => o.index))).toEqual([[0, 1], [2]]);
    expect(groupSwapPlans(basePlans, 'requester', 'ask2')).toHaveLength(1);
    expect(groupSwapPlans(basePlans, 'requester', 'ask3')).toHaveLength(0);
    expect(appendSwapPlans([direct], [three, direct], 3)).toEqual([direct, three]);
  });

  /** BUILDER BUG: formatDate should normalise to zero-padded ISO (see src/engine/calendar.ts). */
  it('keeps padded ISO dates in the parseDate cache', () => {
    const ms = parseDate('2026-1-5' as ISODate);
    expect(formatDate(ms)).toBe('2026-01-05');
  });
});
