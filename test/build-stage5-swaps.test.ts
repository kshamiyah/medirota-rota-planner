import { describe, expect, it } from 'vitest';
import { findSwaps } from '../src/engine/swaps';
import { addDays } from '../src/engine/calendar';
import { blankSnapshot, off, stage2Profile, stage2Request, stage2Settings, work } from './swaps-stage2-helpers';

const LONG = 'Long cover';

describe('Stage 5 swap options', () => {
  it('uses only chosen people at every link of a longer chain', () => {
    const ids = ['requester', 'Dr Rowan', 'Dr Ellis'];
    const snapshot = blankSnapshot(ids);
    work(snapshot, 'requester', '2026-11-02', 'longDay', LONG); off(snapshot, 'Dr Rowan', '2026-11-02');
    work(snapshot, 'Dr Rowan', '2026-11-10', 'longDay', LONG); off(snapshot, 'Dr Ellis', '2026-11-10');
    work(snapshot, 'Dr Ellis', '2026-11-18', 'longDay', LONG); off(snapshot, 'requester', '2026-11-18');
    const profile = stage2Profile(ids, [LONG]);
    const one = findSwaps(profile, snapshot, stage2Settings({ maxChain: 3 }), stage2Request('requester', ['2026-11-02'], { askMode: 'only', askStaffIds: ['Dr Rowan'] }));
    const both = findSwaps(profile, snapshot, stage2Settings({ maxChain: 3 }), stage2Request('requester', ['2026-11-02'], { askMode: 'only', askStaffIds: ['Dr Rowan', 'Dr Ellis'] }));
    expect(one.plans).toEqual([]);
    expect(both.plans.some(plan => plan.chains.some(chain => chain.links.length === 3))).toBe(true);
    expect(one.ruledOut.every(row => row.staffId === 'Dr Rowan')).toBe(true);
  });

  it('puts chosen people first even when the everyone page is full', () => {
    const covers = Array.from({ length: 5 }, (_, index) => `cover-${index}`);
    const ids = ['requester', ...covers];
    const snapshot = blankSnapshot(ids, 12);
    work(snapshot, 'requester', '2026-11-02', 'longDay', LONG);
    covers.forEach((id, index) => { off(snapshot, id, '2026-11-02'); work(snapshot, id, addDays('2026-11-09', index * 7), 'longDay', LONG); off(snapshot, 'requester', addDays('2026-11-09', index * 7)); });
    const result = findSwaps(stage2Profile(ids, [LONG]), snapshot, stage2Settings({ maxChain: 2 }), stage2Request('requester', ['2026-11-02'], { askMode: 'prefer', askStaffIds: ['cover-4'], planLimits: { 2: 1 } }));
    expect(result.plans[0].chosenPeople).toBe(true);
    expect(result.plans[0].chains[0].links[1].staffId).toBe('cover-4');
    expect(result.plans.filter(plan => plan.chosenPeople)).toHaveLength(1);
  });

  it('keeps chosen-only three-way chains in the chosen section', () => {
    const ids = ['requester', 'Dr Rowan', 'Dr Ellis', 'Dr Hart'];
    const snapshot = blankSnapshot(ids);
    work(snapshot, 'requester', '2026-11-02', 'longDay', LONG);
    off(snapshot, 'Dr Rowan', '2026-11-02');
    work(snapshot, 'Dr Ellis', '2026-11-02', 'longDay', LONG);
    work(snapshot, 'Dr Rowan', '2026-11-10', 'longDay', LONG);
    work(snapshot, 'requester', '2026-11-10', 'dayJob', 'Clinic');
    off(snapshot, 'Dr Ellis', '2026-11-10');
    work(snapshot, 'Dr Ellis', '2026-11-18', 'longDay', LONG);
    off(snapshot, 'requester', '2026-11-18');
    const profile = stage2Profile(ids, [LONG, 'Clinic']);
    const request = stage2Request('requester', ['2026-11-02'], { askStaffIds: ['Dr Rowan', 'Dr Ellis'] });
    const only = findSwaps(profile, snapshot, stage2Settings({ maxChain: 3 }), { ...request, askMode: 'only' });
    const first = findSwaps(profile, snapshot, stage2Settings({ maxChain: 3 }), { ...request, askMode: 'prefer' });
    const identity = (plan: (typeof only.plans)[number]) => plan.chains.map(chain => chain.links.map(link => `${link.staffId}:${link.gives.dates.join(',')}`).join('>')).join('|');
    const chosenThreeWay = first.plans.filter(plan => plan.chosenPeople && plan.chains.some(chain => chain.links.length === 3));
    expect(only.plans.length).toBeGreaterThan(0);
    expect(only.plans.every(plan => plan.chains.some(chain => chain.links.length === 3))).toBe(true);
    expect(chosenThreeWay.map(identity)).toEqual(only.plans.map(identity));
  });

  it('limits only requester return dates and ranks the requested day type', () => {
    const ids = ['requester', 'Dr Rowan'];
    const snapshot = blankSnapshot(ids, 12);
    work(snapshot, 'requester', '2026-11-02', 'longDay', LONG); off(snapshot, 'Dr Rowan', '2026-11-02');
    for (const date of ['2026-11-14', '2026-11-16', '2026-12-20']) { work(snapshot, 'Dr Rowan', date, 'longDay', LONG); off(snapshot, 'requester', date); }
    const profile = stage2Profile(ids, [LONG]);
    const limited = findSwaps(profile, snapshot, stage2Settings({ maxChain: 2 }), stage2Request('requester', ['2026-11-02'], { returnWindow: { kind: 'weeks', weeks: 2 } }));
    expect(limited.plans.flatMap(plan => plan.chains[0].links[1].gives.dates)).not.toContain('2026-12-20');
    const weekends = findSwaps(profile, snapshot, stage2Settings({ maxChain: 2 }), stage2Request('requester', ['2026-11-02'], { returnDayType: 'weekends' }));
    expect(weekends.plans[0].chains[0].links[1].gives.dates[0]).toBe('2026-11-14');
  });

  it('treats a bank holiday as a weekend-rate return day in both preferences', () => {
    const ids = ['requester', 'Dr Rowan', 'Dr Ellis'];
    const snapshot = blankSnapshot(ids);
    work(snapshot, 'requester', '2026-11-02', 'longDay', LONG);
    off(snapshot, 'Dr Rowan', '2026-11-02'); off(snapshot, 'Dr Ellis', '2026-11-02');
    work(snapshot, 'Dr Rowan', '2026-11-16', 'longDay', LONG); off(snapshot, 'requester', '2026-11-16');
    work(snapshot, 'Dr Ellis', '2026-11-17', 'longDay', LONG); off(snapshot, 'requester', '2026-11-17');
    const profile = stage2Profile(ids, [LONG]);
    const settings = stage2Settings({ maxChain: 2, bankHolidays: ['2026-11-16'] });
    const firstReturn = (returnDayType: 'weekdays' | 'weekends') => findSwaps(profile, snapshot, settings, stage2Request('requester', ['2026-11-02'], { returnDayType })).plans[0].chains[0].links[1].gives.dates[0];
    expect(firstReturn('weekends')).toBe('2026-11-16');
    expect(firstReturn('weekdays')).toBe('2026-11-17');
  });

  it('drops alerting plans during search when no-alert options are requested', () => {
    const ids = ['requester', 'Dr Rowan', 'Dr Ellis'];
    const snapshot = blankSnapshot(ids);
    work(snapshot, 'requester', '2026-11-02', 'longDay', LONG);
    for (const id of ids.slice(1)) off(snapshot, id, '2026-11-02');
    work(snapshot, 'Dr Rowan', '2026-11-10', 'longDay', LONG); off(snapshot, 'requester', '2026-11-10');
    work(snapshot, 'Dr Ellis', '2026-11-17', 'longDay', LONG); off(snapshot, 'requester', '2026-11-17');
    for (let offset = 0; offset < 6; offset++) work(snapshot, 'Dr Rowan', addDays('2026-11-04', offset), 'longDay', LONG);
    const rules = [{ id: 'hours', name: '', type: 'maxHours', hard: true, hours: 72, windowDays: 7 }] as ReturnType<typeof stage2Profile>['rules'];
    const result = findSwaps(stage2Profile(ids, [LONG], rules), snapshot, stage2Settings({ maxChain: 2 }), stage2Request('requester', ['2026-11-02'], { noAlertsOnly: true }));
    expect(result.plans.every(plan => !plan.alerts?.length)).toBe(true);
    expect(result.plans.some(plan => plan.chains[0].links[1].staffId === 'Dr Ellis')).toBe(true);
  });

  it('keeps validating past higher-ranked alert plans until the no-alert page is full', () => {
    const alerting = Array.from({ length: 40 }, (_, index) => `alert-${index}`);
    const clean = Array.from({ length: 60 }, (_, index) => `clean-${index}`);
    const ids = ['requester', ...alerting, ...clean];
    const snapshot = blankSnapshot(ids, 40);
    work(snapshot, 'requester', '2026-11-02', 'longDay', LONG);
    [...alerting, ...clean].forEach((id, index) => {
      off(snapshot, id, '2026-11-02');
      const returnDate = addDays('2026-11-10', index);
      work(snapshot, id, returnDate, 'longDay', LONG); off(snapshot, 'requester', returnDate);
    });
    for (const id of alerting) for (const date of ['2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07']) work(snapshot, id, date, 'longDay', LONG);
    const rules = [{ id: 'hours', name: '', type: 'maxHours', hard: true, hours: 72, windowDays: 7 }] as ReturnType<typeof stage2Profile>['rules'];
    const result = findSwaps(stage2Profile(ids, [LONG], rules), snapshot, stage2Settings({ maxChain: 2 }), stage2Request('requester', ['2026-11-02'], { noAlertsOnly: true }));
    expect(result.plans).toHaveLength(50);
    expect(result.plans.every(plan => !plan.alerts?.length)).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.limits).toContain('planCap');
  });

  it('keeps the no-alert first page to ten longer-chain plans per size', () => {
    const middles = Array.from({ length: 15 }, (_, index) => `Dr Middle ${index + 1}`);
    const ends = Array.from({ length: 15 }, (_, index) => `Dr End ${index + 1}`);
    const firstLinks = Array.from({ length: 12 }, (_, index) => `Dr First ${index + 1}`);
    const secondLinks = Array.from({ length: 12 }, (_, index) => `Dr Second ${index + 1}`);
    const finalLinks = Array.from({ length: 12 }, (_, index) => `Dr Final ${index + 1}`);
    const ids = ['requester', ...middles, ...ends, ...firstLinks, ...secondLinks, ...finalLinks];
    const snapshot = blankSnapshot(ids, 20);
    work(snapshot, 'requester', '2026-11-02', 'longDay', LONG);
    middles.forEach((middle, index) => {
      const middleDate = addDays('2026-11-10', index * 3);
      const endDate = addDays(middleDate, 1);
      off(snapshot, middle, '2026-11-02');
      work(snapshot, middle, middleDate, 'longDay', LONG);
      work(snapshot, 'requester', middleDate, 'dayJob', 'Clinic');
      off(snapshot, ends[index], middleDate);
      work(snapshot, ends[index], '2026-11-02', 'dayJob', 'Clinic');
      work(snapshot, ends[index], endDate, 'longDay', LONG);
      off(snapshot, 'requester', endDate);
    });
    firstLinks.forEach((first, index) => {
      const firstDate = addDays('2027-01-20', index * 4);
      const secondDate = addDays(firstDate, 1);
      const finalDate = addDays(firstDate, 2);
      off(snapshot, first, '2026-11-02');
      work(snapshot, first, firstDate, 'longDay', LONG);
      work(snapshot, 'requester', firstDate, 'dayJob', 'Clinic');
      work(snapshot, secondLinks[index], '2026-11-02', 'dayJob', 'Clinic');
      off(snapshot, secondLinks[index], firstDate);
      work(snapshot, secondLinks[index], secondDate, 'longDay', LONG);
      work(snapshot, 'requester', secondDate, 'dayJob', 'Clinic');
      work(snapshot, finalLinks[index], '2026-11-02', 'dayJob', 'Clinic');
      off(snapshot, finalLinks[index], secondDate);
      work(snapshot, finalLinks[index], finalDate, 'longDay', LONG);
      off(snapshot, 'requester', finalDate);
    });
    const result = findSwaps(stage2Profile(ids, [LONG, 'Clinic']), snapshot, stage2Settings({ maxChain: 4 }), stage2Request('requester', ['2026-11-02'], { noAlertsOnly: true }));
    const size = (plan: (typeof result.plans)[number]) => Math.max(...plan.chains.map(chain => chain.links.length));
    const fourWay = result.plans.filter(plan => size(plan) === 4);
    expect(result.plans.filter(plan => size(plan) === 3)).toHaveLength(10);
    expect(fourWay.length).toBeGreaterThan(0);
    expect(fourWay.length).toBeLessThanOrEqual(10);
  });

  it('finds weekday and Friday-to-Sunday block swaps and ranks them above split plans', () => {
    const ids = ['requester', 'Dr Rowan', 'Dr Ellis'];
    const snapshot = blankSnapshot(ids, 12);
    const leave = ['2026-11-03', '2026-11-04', '2026-11-05'];
    leave.forEach(date => { work(snapshot, 'requester', date, 'longDay', LONG); off(snapshot, 'Dr Rowan', date); off(snapshot, 'Dr Ellis', date); });
    const returnRun = ['2026-11-13', '2026-11-14', '2026-11-15'];
    returnRun.forEach(date => { work(snapshot, 'Dr Rowan', date, 'longDay', LONG); off(snapshot, 'requester', date); });
    ['2026-11-20', '2026-11-22', '2026-11-24'].forEach(date => { work(snapshot, 'Dr Ellis', date, 'longDay', LONG); off(snapshot, 'requester', date); });
    const result = findSwaps(stage2Profile(ids, [LONG]), snapshot, stage2Settings({ maxChain: 2 }), stage2Request('requester', leave));
    expect(result.plans[0].blockLength).toBe(3);
    expect(result.plans[0].chains.some(chain => chain.payDifferent)).toBe(true);
    expect(result.plans.some(plan => !plan.blockLength)).toBe(true);
  });

  it('does not let block plans use the validation slot for a split plan', () => {
    const ids = ['requester', 'Dr Rowan', 'Dr Ellis', 'Dr Hart'];
    const snapshot = blankSnapshot(ids, 12);
    const leave = ['2026-11-03', '2026-11-04'];
    leave.forEach(date => {
      work(snapshot, 'requester', date, 'longDay', LONG);
      ids.slice(1).forEach(id => off(snapshot, id, date));
    });
    for (const [id, dates] of [
      ['Dr Rowan', ['2026-11-10', '2026-11-11']],
      ['Dr Ellis', ['2026-11-17', '2026-11-18']],
      ['Dr Hart', ['2026-11-24', '2026-11-26']],
    ] as const) for (const date of dates) { work(snapshot, id, date, 'longDay', LONG); off(snapshot, 'requester', date); }
    const result = findSwaps(stage2Profile(ids, [LONG]), snapshot, stage2Settings({ maxChain: 2 }), stage2Request('requester', leave, { planLimits: { 2: 1 } }));
    expect(result.plans.filter(plan => plan.blockLength === 2)).toHaveLength(2);
    expect(result.plans.filter(plan => !plan.blockLength)).toHaveLength(1);
  });
});
