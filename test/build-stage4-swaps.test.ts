import { describe, expect, it } from 'vitest';
import { addDays } from '../src/engine/calendar';
import { findSwaps, type RotaSnapshot } from '../src/engine/swaps';
import { blankSnapshot, off, stage2Profile, stage2Request, stage2Settings, work } from './swaps-stage2-helpers';

function block(snapshot: RotaSnapshot, staffId: string, start: string) {
  work(snapshot, staffId, start, 'night', 'Night ward');
  work(snapshot, staffId, addDays(start, 1), 'night', 'Night ward');
}

function nightDateFixture(kind: 'dayJob' | 'longDay') {
  const ids = ['requester', 'cover'];
  const snapshot = blankSnapshot(ids);
  block(snapshot, 'requester', '2026-11-10');
  block(snapshot, 'cover', '2026-11-24');
  work(snapshot, 'cover', '2026-11-10', kind, kind === 'dayJob' ? 'Float clinic' : 'Long cover');
  off(snapshot, 'cover', '2026-11-11');
  off(snapshot, 'requester', '2026-11-24'); off(snapshot, 'requester', '2026-11-25');
  const profile = stage2Profile(ids, ['Night ward', 'Float clinic', 'Long cover']);
  const request = stage2Request('requester', ['2026-11-10']);
  return { snapshot, profile, request };
}

describe('Stage 4 swap rules', () => {
  it('passes a day job on a night date to the requester and records annual leave', () => {
    const fixture = nightDateFixture('dayJob');
    const plan = findSwaps(fixture.profile, fixture.snapshot, stage2Settings(), fixture.request).plans[0];
    expect(plan?.movedShifts).toContainEqual({ fromStaffId: 'cover', toStaffId: 'requester', date: '2026-11-10', activity: 'Float clinic', kind: 'dayJob' });
    expect(plan?.leaveRequests).toEqual([{ date: '2026-11-10', activity: 'Float clinic' }]);
    expect(plan?.toArrange).toBeUndefined();
  });

  it('passes a long day on a night date but records it as still to arrange', () => {
    const fixture = nightDateFixture('longDay');
    const plan = findSwaps(fixture.profile, fixture.snapshot, stage2Settings(), fixture.request).plans[0];
    expect(plan?.movedShifts).toContainEqual({ fromStaffId: 'cover', toStaffId: 'requester', date: '2026-11-10', activity: 'Long cover', kind: 'longDay' });
    expect(plan?.toArrange).toEqual([{ date: '2026-11-10', activity: 'Long cover' }]);
    expect(plan?.leaveRequests).toBeUndefined();
  });

  it('never passes a night-date shift to the requester on a cannot-work date', () => {
    const fixture = nightDateFixture('dayJob');
    fixture.request.cantWorkDates = ['2026-11-10'];
    expect(findSwaps(fixture.profile, fixture.snapshot, stage2Settings(), fixture.request).plans).toEqual([]);
  });

  it('marks a Saturday and Sunday exchanged for another weekend as whole weekend', () => {
    const ids = ['requester', 'cover'];
    const snapshot = blankSnapshot(ids);
    for (const date of ['2026-11-07', '2026-11-08']) { work(snapshot, 'requester', date, 'longDay', 'Long cover'); off(snapshot, 'cover', date); }
    for (const date of ['2026-11-14', '2026-11-15']) { work(snapshot, 'cover', date, 'longDay', 'Long cover'); off(snapshot, 'requester', date); }
    const result = findSwaps(stage2Profile(ids, ['Long cover']), snapshot, stage2Settings({ maxChain: 2 }), stage2Request('requester', ['2026-11-07', '2026-11-08']));
    expect(result.plans.filter(plan => plan.wholeWeekend)).toHaveLength(1);
    expect(result.plans[0].wholeWeekend).toBe(true);
  });

  it('pages each chain size independently and keeps the first option stable', () => {
    const ids = ['requester', 'cover-one', 'cover-two', 'cover-three'];
    const snapshot = blankSnapshot(ids);
    work(snapshot, 'requester', '2026-11-10', 'longDay', 'Long cover');
    ids.slice(1).forEach((staffId, index) => {
      off(snapshot, staffId, '2026-11-10');
      const returnDate = addDays('2026-11-17', index * 7);
      work(snapshot, staffId, returnDate, 'longDay', 'Long cover');
      off(snapshot, 'requester', returnDate);
    });
    const base = stage2Request('requester', ['2026-11-10']);
    const first = findSwaps(stage2Profile(ids, ['Long cover']), snapshot, stage2Settings({ maxChain: 2 }), { ...base, planLimits: { 2: 1 } });
    const second = findSwaps(stage2Profile(ids, ['Long cover']), snapshot, stage2Settings({ maxChain: 2 }), { ...base, planLimits: { 2: 2 } });
    expect(first.plans).toHaveLength(1);
    expect(first.morePlanSizes).toContain(2);
    expect(second.plans).toHaveLength(2);
    expect(second.plans[0].chains).toEqual(first.plans[0].chains);
  });

  it('never marks a night block as a whole-weekend plan', () => {
    const ids = ['requester', 'cover'];
    const snapshot = blankSnapshot(ids);
    for (const date of ['2026-11-06', '2026-11-07', '2026-11-08']) work(snapshot, 'requester', date, 'night', 'Night ward');
    for (const date of ['2026-11-20', '2026-11-21', '2026-11-22']) { work(snapshot, 'cover', date, 'night', 'Night ward'); off(snapshot, 'requester', date); }
    for (const date of ['2026-11-06', '2026-11-07', '2026-11-08']) off(snapshot, 'cover', date);
    const result = findSwaps(stage2Profile(ids, ['Night ward']), snapshot, stage2Settings({ maxChain: 2 }), stage2Request('requester', ['2026-11-07', '2026-11-08']));
    expect(result.plans.length).toBeGreaterThan(0);
    expect(result.plans.every(plan => !plan.wholeWeekend)).toBe(true);
  });

  it('ranks fewer moved shifts before later ranking criteria', () => {
    const ids = ['requester', 'clean-cover', 'extra-move'];
    const snapshot = blankSnapshot(ids);
    block(snapshot, 'requester', '2026-11-10');
    block(snapshot, 'clean-cover', '2026-11-24');
    block(snapshot, 'extra-move', '2026-12-08');
    for (const date of ['2026-11-10', '2026-11-11']) { off(snapshot, 'clean-cover', date); off(snapshot, 'extra-move', date); }
    for (const date of ['2026-11-24', '2026-11-25', '2026-12-08', '2026-12-09']) off(snapshot, 'requester', date);
    work(snapshot, 'extra-move', '2026-11-10', 'dayJob', 'Float clinic');
    const result = findSwaps(stage2Profile(ids, ['Night ward', 'Float clinic']), snapshot, stage2Settings({ maxChain: 2 }), stage2Request('requester', ['2026-11-10']));
    expect(result.plans[0].chains[0].links[1].staffId).toBe('clean-cover');
    expect(result.plans[0].shiftsMoved).toBeLessThan(result.plans.find(plan => plan.chains[0].links[1].staffId === 'extra-move')!.shiftsMoved);
  });

  it('keeps every distinct return date for one partner and ranks direct plans first', () => {
    const ids = ['requester', 'partner', 'middle', 'returner', 'third'];
    const snapshot = blankSnapshot(ids, 140);
    work(snapshot, 'requester', '2026-11-02', 'longDay', 'Long cover');
    off(snapshot, 'partner', '2026-11-02'); off(snapshot, 'middle', '2026-11-02'); off(snapshot, 'third', '2026-11-02');
    const partnerDates = Array.from({ length: 10 }, (_, index) => addDays('2026-11-10', index * 3));
    for (const date of partnerDates) { work(snapshot, 'partner', date, 'longDay', 'Long cover'); off(snapshot, 'requester', date); }
    work(snapshot, 'middle', '2027-01-05', 'longDay', 'Long cover'); off(snapshot, 'returner', '2027-01-05');
    work(snapshot, 'returner', '2027-01-12', 'longDay', 'Long cover'); off(snapshot, 'requester', '2027-01-12');
    work(snapshot, 'third', '2027-01-19', 'longDay', 'Long cover'); off(snapshot, 'middle', '2027-01-19');
    const result = findSwaps(stage2Profile(ids, ['Long cover']), snapshot, stage2Settings({ maxChain: 4 }), stage2Request('requester', ['2026-11-02']));
    const partnerPlans = result.plans.filter(plan => plan.chains[0].links.length === 2 && plan.chains[0].links[1].staffId === 'partner');
    expect(partnerPlans.map(plan => plan.chains[0].links[1].gives.dates[0]).sort()).toEqual([...partnerDates].sort());
    const firstLonger = result.plans.findIndex(plan => plan.chains[0].links.length > 2);
    expect(firstLonger).toBeGreaterThanOrEqual(10);
    expect(result.plans.slice(0, 10)).toEqual(partnerPlans);
  });

  it('ranks consecutive or separate return dates according to the request', () => {
    const ids = ['requester', 'partner'];
    const snapshot = blankSnapshot(ids);
    for (const date of ['2026-11-07', '2026-11-08']) { work(snapshot, 'requester', date, 'longDay', 'Long cover'); off(snapshot, 'partner', date); }
    for (const date of ['2026-11-14', '2026-11-15', '2026-11-17', '2026-11-19']) { work(snapshot, 'partner', date, 'longDay', 'Long cover'); off(snapshot, 'requester', date); }
    const profile = stage2Profile(ids, ['Long cover']);
    const base = stage2Request('requester', ['2026-11-07', '2026-11-08']);
    const returns = (pattern: 'consecutive' | 'separate' | 'noPreference') => findSwaps(profile, snapshot, stage2Settings({ maxChain: 2 }), { ...base, returnPattern: pattern }).plans[0].chains.map(chain => chain.links[1].gives.dates[0]).sort();
    expect(returns('consecutive')).toEqual(['2026-11-14', '2026-11-15']);
    const separate = returns('separate');
    expect(addDays(separate[0], 1)).not.toBe(separate[1]);
    expect(returns('noPreference')).toEqual(['2026-11-14', '2026-11-15']);
  });

  it('groups ruled-out doctors with the new plain reasons', () => {
    const ids = ['requester', 'blank', 'working', 'leave', 'training', 'excluded'];
    const snapshot = blankSnapshot(ids);
    work(snapshot, 'requester', '2026-11-10', 'longDay', 'Long cover');
    work(snapshot, 'working', '2026-11-10', 'dayJob', 'Clinic');
    snapshot.days.working['2026-11-10'].sessions = ['am', 'pm'];
    snapshot.days.leave['2026-11-10'] = { status: 'leave', activity: 'Annual leave' };
    snapshot.days.training['2026-11-10'] = { status: 'training', activity: 'Teaching' };
    off(snapshot, 'excluded', '2026-11-10');
    const result = findSwaps(stage2Profile(ids, ['Long cover', 'Clinic']), snapshot, stage2Settings({ excluded: [{ staffId: 'excluded' }] }), stage2Request('requester', ['2026-11-10']));
    expect(result.ruledOut.find(row => row.staffId === 'blank')).toMatchObject({ group: 'notOnRota', reason: 'Not on the rota on these dates' });
    expect(result.ruledOut.find(row => row.staffId === 'working')).toMatchObject({ group: 'working', reason: "Leave on their Clinic day would leave 1 of 7 working, so it's likely to be refused" });
    expect(result.ruledOut.find(row => row.staffId === 'leave')).toMatchObject({ group: 'leave', reason: 'On leave on 2026-11-10' });
    expect(result.ruledOut.find(row => row.staffId === 'training')).toMatchObject({ group: 'other', reason: 'No compatible return shifts complete a valid chain.' });
    expect(result.ruledOut.find(row => row.staffId === 'excluded')).toMatchObject({ group: 'excluded' });
  });

  it('suggests one normal day of annual leave when it clears requester 72-hour alerts', () => {
    const ids = ['requester', 'cover'];
    const snapshot = blankSnapshot(ids);
    work(snapshot, 'requester', '2026-11-02', 'longDay', 'Long cover'); off(snapshot, 'cover', '2026-11-02');
    for (const date of ['2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08']) work(snapshot, 'requester', date, 'dayJob', 'Clinic');
    work(snapshot, 'requester', '2026-11-09', 'longDay', 'Long cover');
    work(snapshot, 'cover', '2026-11-10', 'longDay', 'Long cover'); off(snapshot, 'requester', '2026-11-10');
    const profile = stage2Profile(ids, ['Long cover', 'Clinic'], [{ id: 'hours', name: '', type: 'maxHours', hard: true, hours: 72, windowDays: 7 }]);
    const plan = findSwaps(profile, snapshot, stage2Settings({ maxChain: 2 }), stage2Request('requester', ['2026-11-02'])).plans[0];
    const alert = plan?.alerts?.find(item => item.staffId === 'requester');
    expect(alert?.suggestion).toEqual(expect.objectContaining({ activity: 'Clinic', date: expect.stringMatching(/^2026-11-0[4-8]$/) }));
    expect(alert?.hours).toMatchObject({
      startDate: '2026-11-04', endDate: '2026-11-10', totalHours: 72.5, limitHours: 72, suggestionTotalHours: 63,
    });
    expect(alert?.hours?.shifts).toHaveLength(7);
    expect(alert?.hours?.shifts.filter(shift => shift.fromSwap)).toEqual([
      { date: '2026-11-10', activity: 'Long cover', hours: 12.5, fromSwap: true },
    ]);
  });
});
