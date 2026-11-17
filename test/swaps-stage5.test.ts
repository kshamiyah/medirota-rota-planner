/**
 * Independent Stage 5 checks. These follow the brief, not the builder's tests.
 * A failure here is reported as a builder bug and is left failing.
 */
import { describe, expect, it } from 'vitest';
import { addDays } from '../src/engine/calendar';
import { classifySwapDates, findSwaps, type SwapPlan, type SwapRequest } from '../src/engine/swaps';
import { swapDateSummary } from '../src/app/swapsView';
import { blankSnapshot, off, stage2Profile, stage2Request, stage2Settings, work } from './swaps-stage2-helpers';

const LONG = 'Long cover';
const NIGHT = 'Night ward';
const CLINIC = 'Clinic';
const TODAY = '2026-11-01';

function names(ids: string[]) {
  const profile = stage2Profile(ids, [LONG, NIGHT, CLINIC]);
  const labels: Record<string, string> = {
    rowan: 'Dr Rowan', ellis: 'Dr Ellis', hart: 'Dr Hart', moss: 'Dr Moss', vale: 'Dr Vale',
  };
  for (const person of profile.staff) person.name = labels[person.id] ?? person.name;
  return profile;
}

function planId(plan: SwapPlan): string {
  return plan.chains.map(chain => chain.links.map(link => `${link.staffId}:${link.gives.dates.join('+')}`).join('>')).sort().join('|');
}

function others(plan: SwapPlan, requester = 'requester'): string[] {
  return [...new Set(plan.chains.flatMap(chain => chain.links.map(link => link.staffId)).filter(id => id !== requester))];
}

function search(profile: ReturnType<typeof names>, snapshot: ReturnType<typeof blankSnapshot>, request: Partial<SwapRequest> & { leaveDates: string[] }, maxChain = 4) {
  return findSwaps(profile, snapshot, stage2Settings({ maxChain }), stage2Request('requester', request.leaveDates, { today: TODAY, ...request }));
}

describe('Stage 5 who to ask', () => {
  it('keeps every link of a four-way chain inside Only these people', () => {
    const ids = ['requester', 'rowan', 'ellis', 'hart', 'vale'];
    const profile = names(ids);
    const snapshot = blankSnapshot(ids, 16);
    const leave = '2026-11-10';
    work(snapshot, 'requester', leave, 'longDay', LONG);
    off(snapshot, 'rowan', leave);
    work(snapshot, 'rowan', '2026-11-17', 'longDay', LONG);
    work(snapshot, 'requester', '2026-11-17', 'dayJob', CLINIC);
    off(snapshot, 'ellis', '2026-11-17');
    work(snapshot, 'ellis', '2026-11-18', 'longDay', LONG);
    work(snapshot, 'requester', '2026-11-18', 'dayJob', CLINIC);
    off(snapshot, 'hart', '2026-11-18');
    work(snapshot, 'hart', '2026-11-19', 'longDay', LONG);
    off(snapshot, 'requester', '2026-11-19');
    off(snapshot, 'vale', leave);
    work(snapshot, 'vale', '2026-11-26', 'longDay', LONG);
    off(snapshot, 'requester', '2026-11-26');

    const withoutVale = search(profile, snapshot, { leaveDates: [leave], askMode: 'only', askStaffIds: ['rowan', 'ellis', 'hart'] });
    const withVale = search(profile, snapshot, { leaveDates: [leave], askMode: 'only', askStaffIds: ['rowan', 'ellis', 'hart', 'vale'] });
    const four = withVale.plans.filter(plan => plan.chains.some(chain => chain.links.length === 4));
    expect(four.length).toBeGreaterThan(0);
    expect(withoutVale.plans.every(plan => !others(plan).includes('vale'))).toBe(true);
    expect(withVale.plans.every(plan => others(plan).every(id => ['rowan', 'ellis', 'hart', 'vale'].includes(id)))).toBe(true);
    expect(withoutVale.plans.some(plan => plan.chains.some(chain => chain.links.length === 4))).toBe(true);
  });

  it('matches the chosen section to Only these people at the same page limits, including Find 50 more', () => {
    const ids = ['requester', 'rowan', 'ellis', 'hart', 'moss', 'vale'];
    const profile = names(ids);
    const snapshot = blankSnapshot(ids, 16);
    const leave = '2026-11-10';
    work(snapshot, 'requester', leave, 'longDay', LONG);
    const directs: [string, string][] = [['rowan', '2026-12-01'], ['ellis', '2026-12-08'], ['hart', '2026-12-15'], ['moss', '2026-12-22'], ['vale', '2026-12-29']];
    for (const [id, date] of directs) {
      off(snapshot, id, leave);
      work(snapshot, id, date, 'longDay', LONG);
      off(snapshot, 'requester', date);
    }
    off(snapshot, 'rowan', leave);
    work(snapshot, 'rowan', '2026-11-17', 'longDay', LONG);
    work(snapshot, 'requester', '2026-11-17', 'dayJob', CLINIC);
    off(snapshot, 'ellis', '2026-11-17');
    work(snapshot, 'ellis', '2026-11-18', 'longDay', LONG);
    work(snapshot, 'requester', '2026-11-18', 'dayJob', CLINIC);
    off(snapshot, 'hart', '2026-11-18');
    work(snapshot, 'hart', '2026-11-19', 'longDay', LONG);
    off(snapshot, 'requester', '2026-11-19');

    const askStaffIds = ['rowan', 'ellis', 'hart'];
    const chosenIds = (result: ReturnType<typeof search>) => result.plans.filter(plan => plan.chosenPeople).map(planId).sort();
    const onlyIds = (result: ReturnType<typeof search>) => result.plans.map(planId).sort();
    const compare = (planLimits?: { 2: number; 3: number; 4: number }) => {
      const request = { leaveDates: [leave], askStaffIds, ...(planLimits ? { planLimits } : {}) };
      const only = search(profile, snapshot, { ...request, askMode: 'only' });
      const prefer = search(profile, snapshot, { ...request, askMode: 'prefer' });
      expect(chosenIds(prefer)).toEqual(onlyIds(only));
      const firstOther = prefer.plans.findIndex(plan => !plan.chosenPeople);
      expect(firstOther === -1 || prefer.plans.slice(0, firstOther).every(plan => plan.chosenPeople)).toBe(true);
      expect(new Set(prefer.plans.map(planId)).size).toBe(prefer.plans.length);
      return { only, prefer };
    };

    const smallLimits = { 2: 1, 3: 1, 4: 1 } as const;
    const small = compare(smallLimits);
    expect(small.only.plans.some(plan => plan.chains.some(chain => chain.links.length === 3))).toBe(true);
    expect(small.only.plans.some(plan => plan.chains.some(chain => chain.links.length === 4))).toBe(true);
    const defaults = compare();
    expect(defaults.prefer.plans.some(plan => !plan.chosenPeople)).toBe(true);

    for (const size of [2, 3, 4] as const) {
      const extended = { ...smallLimits, [size]: smallLimits[size] + 50 };
      const more = compare(extended);
      const added = (before: string[], after: string[]) => after.filter(id => !before.includes(id)).sort();
      const onlyAdded = added(onlyIds(small.only), onlyIds(more.only));
      expect(onlyAdded.length).toBeGreaterThan(0);
      expect(added(chosenIds(small.prefer), chosenIds(more.prefer))).toEqual(onlyAdded);
    }
  });
});

describe('Stage 5 block swaps', () => {
  function runFixture(leave: string[], returns: string[]) {
    const ids = ['requester', 'rowan', 'ellis'];
    const profile = names(ids);
    const snapshot = blankSnapshot(ids, 16);
    for (const date of leave) {
      work(snapshot, 'requester', date, 'longDay', LONG);
      off(snapshot, 'rowan', date);
      off(snapshot, 'ellis', date);
    }
    for (const date of returns) {
      work(snapshot, 'rowan', date, 'longDay', LONG);
      off(snapshot, 'requester', date);
    }
    const split = returns.map((_, index) => addDays('2026-12-01', index * 2));
    for (const date of split) {
      work(snapshot, 'ellis', date, 'longDay', LONG);
      off(snapshot, 'requester', date);
    }
    const result = search(profile, snapshot, { leaveDates: leave }, 2);
    const block = result.plans.find(plan => plan.blockLength === leave.length && others(plan).includes('rowan'));
    return { result, block, splitDates: split };
  }

  it('swaps runs of 2, 3 and 4 long days for one doctor on consecutive dates', () => {
    for (const length of [2, 3, 4]) {
      const leave = Array.from({ length }, (_, index) => addDays('2026-11-10', index));
      const returns = Array.from({ length }, (_, index) => addDays('2026-11-24', index));
      const { block } = runFixture(leave, returns);
      expect(block, `length ${length}`).toBeTruthy();
      const taken = block!.chains.flatMap(chain => chain.links[1].gives.dates).sort();
      expect(taken).toEqual(returns);
      expect(new Set(block!.chains.map(chain => chain.links[1].staffId))).toEqual(new Set(['rowan']));
    }
  });

  it('labels a block when the weekday and weekend mix differs, and not when it matches', () => {
    const leave = ['2026-12-04', '2026-12-05', '2026-12-06'];
    const weekdayReturn = ['2026-12-08', '2026-12-09', '2026-12-10'];
    const sameMix = ['2026-12-11', '2026-12-12', '2026-12-13'];
    const ids = ['requester', 'rowan', 'ellis'];
    const profile = names(ids);
    const snapshot = blankSnapshot(ids, 16);
    for (const date of [...leave, ...weekdayReturn, ...sameMix]) {
      if (leave.includes(date)) work(snapshot, 'requester', date, 'longDay', LONG);
      else off(snapshot, 'requester', date);
    }
    for (const date of leave) { off(snapshot, 'rowan', date); off(snapshot, 'ellis', date); }
    for (const date of weekdayReturn) work(snapshot, 'rowan', date, 'longDay', LONG);
    for (const date of sameMix) work(snapshot, 'ellis', date, 'longDay', LONG);
    const result = search(profile, snapshot, { leaveDates: leave }, 2);
    const mixed = result.plans.find(plan => plan.blockLength === 3 && others(plan).includes('rowan'));
    const matched = result.plans.find(plan => plan.blockLength === 3 && others(plan).includes('ellis'));
    expect(mixed?.chains.some(chain => chain.payDifferent)).toBe(true);
    expect(matched?.chains.some(chain => chain.payDifferent)).toBe(false);
  });

  it('ranks a split plan below the block and still returns every block when the page limit is 1', () => {
    const leave = ['2026-11-10', '2026-11-11'];
    const ids = ['requester', 'ellis', ...Array.from({ length: 8 }, (_, index) => `block-${index}`)];
    const profile = names(['requester', 'ellis']);
    for (let index = 0; index < 8; index++) profile.staff.push({ id: `block-${index}`, name: `Dr Block ${index}`, groupIds: [], fte: 1 });
    const snapshot = blankSnapshot(ids, 20);
    for (const date of leave) {
      work(snapshot, 'requester', date, 'longDay', LONG);
      for (const id of ids.slice(1)) off(snapshot, id, date);
    }
    for (let index = 0; index < 8; index++) {
      const start = addDays('2026-11-24', index * 7);
      work(snapshot, `block-${index}`, start, 'longDay', LONG);
      work(snapshot, `block-${index}`, addDays(start, 1), 'longDay', LONG);
      off(snapshot, 'requester', start);
      off(snapshot, 'requester', addDays(start, 1));
    }
    work(snapshot, 'ellis', '2026-12-01', 'longDay', LONG);
    work(snapshot, 'ellis', '2026-12-03', 'longDay', LONG);
    off(snapshot, 'requester', '2026-12-01');
    off(snapshot, 'requester', '2026-12-03');
    const capped = search(profile, snapshot, { leaveDates: leave, planLimits: { 2: 1 } }, 2);
    expect(capped.plans.filter(plan => plan.blockLength === 2)).toHaveLength(8);
    expect(capped.plans.some(plan => !plan.blockLength && others(plan).join() === 'ellis')).toBe(true);
    const roomy = search(profile, snapshot, { leaveDates: leave, planLimits: { 2: 20 } }, 2);
    const splitAt = roomy.plans.findIndex(plan => !plan.blockLength && others(plan).join() === 'ellis');
    expect(splitAt).toBeGreaterThan(0);
    expect(roomy.plans.slice(0, splitAt).every(plan => plan.blockLength === 2)).toBe(true);
  });

  it('returns a split plan as well as both blocks when the direct page limit is 1', () => {
    const ids = ['requester', 'rowan', 'ellis', 'hart'];
    const profile = names(ids);
    const snapshot = blankSnapshot(ids, 12);
    const leave = ['2026-11-10', '2026-11-11'];
    for (const date of leave) {
      work(snapshot, 'requester', date, 'longDay', LONG);
      for (const id of ids.slice(1)) off(snapshot, id, date);
    }
    for (const [id, start] of [['rowan', '2026-11-17'], ['ellis', '2026-11-24']] as const) {
      work(snapshot, id, start, 'longDay', LONG);
      work(snapshot, id, addDays(start, 1), 'longDay', LONG);
      off(snapshot, 'requester', start);
      off(snapshot, 'requester', addDays(start, 1));
    }
    work(snapshot, 'hart', '2026-12-01', 'longDay', LONG);
    work(snapshot, 'hart', '2026-12-03', 'longDay', LONG);
    off(snapshot, 'requester', '2026-12-01');
    off(snapshot, 'requester', '2026-12-03');
    const result = search(profile, snapshot, { leaveDates: leave, planLimits: { 2: 1 } }, 2);
    expect(result.plans.filter(plan => plan.blockLength === 2)).toHaveLength(2);
    const split = result.plans.find(plan => !plan.blockLength && others(plan).join() === 'hart');
    expect(split).toBeTruthy();
    const splitAt = result.plans.indexOf(split!);
    expect(result.plans.slice(0, splitAt).every(plan => plan.blockLength === 2)).toBe(true);
  });

  it('does not treat a night block as a long-day block', () => {
    const ids = ['requester', 'rowan'];
    const profile = names(ids);
    const snapshot = blankSnapshot(ids, 12);
    for (const date of ['2026-11-16', '2026-11-17']) {
      work(snapshot, 'requester', date, 'night', NIGHT);
      off(snapshot, 'rowan', date);
    }
    for (const date of ['2026-11-23', '2026-11-24']) {
      work(snapshot, 'rowan', date, 'night', NIGHT);
      off(snapshot, 'requester', date);
    }
    const result = search(profile, snapshot, { leaveDates: ['2026-11-16', '2026-11-17'] }, 2);
    expect(result.plans.length).toBeGreaterThan(0);
    expect(result.plans.every(plan => plan.blockLength === undefined)).toBe(true);
  });
});

describe('Stage 5 return window and day type', () => {
  it('keeps requester returns inside N weeks and between two dates, and leaves other dates alone', () => {
    const ids = ['requester', 'rowan', 'ellis', 'hart'];
    const profile = names(ids);
    const snapshot = blankSnapshot(ids, 16);
    const leave = '2026-11-16';
    work(snapshot, 'requester', leave, 'longDay', LONG);
    off(snapshot, 'rowan', leave);
    off(snapshot, 'ellis', leave);
    work(snapshot, 'rowan', '2026-11-23', 'longDay', LONG);
    off(snapshot, 'requester', '2026-11-23');
    work(snapshot, 'rowan', '2026-12-21', 'longDay', LONG);
    off(snapshot, 'requester', '2026-12-21');
    work(snapshot, 'ellis', '2026-11-18', 'longDay', LONG);
    work(snapshot, 'requester', '2026-11-18', 'dayJob', CLINIC);
    off(snapshot, 'hart', '2026-11-18');
    work(snapshot, 'hart', '2026-11-20', 'longDay', LONG);
    off(snapshot, 'requester', '2026-11-20');

    const weeks = search(profile, snapshot, { leaveDates: [leave], returnWindow: { kind: 'weeks', weeks: 1 } }, 3);
    const dates = weeks.plans.flatMap(plan => plan.chains.flatMap(chain => chain.links.at(-1)!.gives.dates));
    expect(dates).toContain('2026-11-23');
    expect(dates).not.toContain('2026-12-21');
    const three = weeks.plans.find(plan => plan.chains.some(chain => chain.links.length === 3));
    expect(three).toBeTruthy();
    const middle = three!.chains[0].links[1].gives.dates;
    expect(middle).toContain('2026-11-18');

    const between = search(profile, snapshot, { leaveDates: [leave], returnWindow: { kind: 'dates', from: '2026-11-20', to: '2026-11-23' } }, 2);
    const betweenDates = between.plans.flatMap(plan => plan.chains.flatMap(chain => chain.links.at(-1)!.gives.dates));
    expect(betweenDates.every(date => date >= '2026-11-20' && date <= '2026-11-23')).toBe(true);
    expect(betweenDates).not.toContain('2026-12-21');
  });

  it('does not apply the return window to a night-package shift that is passed on', () => {
    const ids = ['requester', 'rowan'];
    const profile = names(ids);
    const snapshot = blankSnapshot(ids, 12);
    for (const date of ['2026-11-16', '2026-11-17']) {
      work(snapshot, 'requester', date, 'night', NIGHT);
      off(snapshot, 'rowan', date);
    }
    work(snapshot, 'rowan', '2026-11-18', 'dayJob', CLINIC);
    off(snapshot, 'requester', '2026-11-18');
    for (const date of ['2026-11-20', '2026-11-21']) {
      work(snapshot, 'rowan', date, 'night', NIGHT);
      off(snapshot, 'requester', date);
    }
    const result = search(profile, snapshot, {
      leaveDates: ['2026-11-16', '2026-11-17'],
      returnWindow: { kind: 'dates', from: '2026-11-20', to: '2026-11-21' },
    }, 2);
    const plan = result.plans.find(plan => plan.movedShifts?.some(move => move.date === '2026-11-18'));
    expect(plan).toBeTruthy();
    expect(plan!.chains.flatMap(chain => chain.links.at(-1)!.gives.dates).every(date => date >= '2026-11-20' && date <= '2026-11-21')).toBe(true);
  });

  it('ranks return day type immediately after the return pattern', () => {
    const ids = ['requester', 'rowan', 'ellis'];
    const profile = names(ids);
    const snapshot = blankSnapshot(ids, 12);
    const leave = ['2026-11-10', '2026-11-11'];
    for (const date of leave) {
      work(snapshot, 'requester', date, 'longDay', LONG);
      off(snapshot, 'rowan', date);
      off(snapshot, 'ellis', date);
    }
    for (const date of ['2026-11-12', '2026-11-13']) {
      work(snapshot, 'rowan', date, 'longDay', LONG);
      off(snapshot, 'requester', date);
    }
    for (const date of ['2026-11-14', '2026-11-21']) {
      work(snapshot, 'ellis', date, 'longDay', LONG);
      off(snapshot, 'requester', date);
    }
    const weekends = search(profile, snapshot, { leaveDates: leave, returnPattern: 'consecutive', returnDayType: 'weekends' }, 2);
    expect(weekends.plans[0].chains.every(chain => chain.links[1].staffId === 'rowan')).toBe(true);
    const noPattern = search(profile, snapshot, { leaveDates: leave, returnPattern: 'noPreference', returnDayType: 'weekends' }, 2);
    expect(noPattern.plans[0].chains.every(chain => chain.links[1].staffId === 'ellis')).toBe(true);
    const weekdays = search(profile, snapshot, { leaveDates: leave, returnPattern: 'noPreference', returnDayType: 'weekdays' }, 2);
    expect(weekdays.plans[0].chains.every(chain => chain.links[1].staffId === 'rowan')).toBe(true);
  });

  it('ranks a weekday bank holiday with weekend returns for both day-type preferences', () => {
    const ids = ['requester', 'rowan', 'ellis', 'hart'];
    const profile = names(ids);
    const snapshot = blankSnapshot(ids, 8);
    const leave = '2026-11-10';
    const bankHoliday = '2026-11-17';
    work(snapshot, 'requester', leave, 'longDay', LONG);
    const returns: [string, string][] = [['rowan', '2026-11-14'], ['ellis', bankHoliday], ['hart', '2026-11-18']];
    for (const [id, date] of returns) {
      off(snapshot, id, leave);
      work(snapshot, id, date, 'longDay', LONG);
      off(snapshot, 'requester', date);
    }
    const settings = stage2Settings({ maxChain: 2, bankHolidays: [bankHoliday] });
    const order = (returnDayType: 'weekends' | 'weekdays') => findSwaps(profile, snapshot, settings, stage2Request('requester', [leave], { today: TODAY, returnDayType })).plans
      .filter(plan => plan.chains.length === 1 && plan.chains[0].links.length === 2)
      .map(plan => plan.chains[0].links[1].staffId);
    expect(order('weekends').slice(0, 3)).toEqual(['rowan', 'ellis', 'hart']);
    expect(order('weekdays').slice(0, 3)).toEqual(['hart', 'rowan', 'ellis']);
  });
});

describe('Stage 5 no alerts, classification and hours', () => {
  it('fills the first page with no-alert directs and reports the cap', () => {
    const clean = Array.from({ length: 55 }, (_, index) => `clean-${index}`);
    const alerting = Array.from({ length: 5 }, (_, index) => `alert-${index}`);
    const ids = ['requester', ...alerting, ...clean];
    const snapshot = blankSnapshot(ids, 70);
    const leave = '2026-11-10';
    work(snapshot, 'requester', leave, 'longDay', LONG);
    [...alerting, ...clean].forEach((id, index) => {
      off(snapshot, id, leave);
      const ret = addDays('2026-11-17', index);
      work(snapshot, id, ret, 'longDay', LONG);
      off(snapshot, 'requester', ret);
    });
    for (const id of alerting) for (let offset = 0; offset < 6; offset++) work(snapshot, id, addDays('2026-11-11', offset), 'longDay', LONG);
    const rules = [{ id: 'hours', name: '', type: 'maxHours' as const, hard: true, hours: 72, windowDays: 7 }];
    const profile = stage2Profile(ids, [LONG], rules);
    const result = findSwaps(profile, snapshot, stage2Settings({ maxChain: 2 }), stage2Request('requester', [leave], { today: TODAY, noAlertsOnly: true }));
    expect(result.plans).toHaveLength(50);
    expect(result.plans.every(plan => !plan.alerts?.length)).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.limits).toContain('planCap');
  });

  it('keeps the first no-alert page to ten three-way and ten four-way plans', () => {
    const middles = Array.from({ length: 12 }, (_, index) => `middle-${index}`);
    const ends = Array.from({ length: 12 }, (_, index) => `end-${index}`);
    const ids = ['requester', ...middles, ...ends];
    const snapshot = blankSnapshot(ids, 40);
    const leave = ['2026-11-16', '2026-11-17'];
    for (const date of leave) work(snapshot, 'requester', date, 'night', NIGHT);
    middles.forEach((middle, index) => {
      const middleStart = addDays('2026-11-23', index * 7);
      const endStart = addDays('2026-12-01', index * 7);
      for (const date of leave) off(snapshot, middle, date);
      work(snapshot, middle, middleStart, 'night', NIGHT);
      work(snapshot, middle, addDays(middleStart, 1), 'night', NIGHT);
      off(snapshot, ends[index], middleStart);
      off(snapshot, ends[index], addDays(middleStart, 1));
      work(snapshot, ends[index], endStart, 'night', NIGHT);
      work(snapshot, ends[index], addDays(endStart, 1), 'night', NIGHT);
      off(snapshot, 'requester', endStart);
      off(snapshot, 'requester', addDays(endStart, 1));
    });
    const profile = stage2Profile(ids, [NIGHT]);
    const result = findSwaps(profile, snapshot, stage2Settings({ maxChain: 3 }), stage2Request('requester', leave, { today: TODAY, noAlertsOnly: true }));
    const three = result.plans.filter(plan => plan.chains.some(chain => chain.links.length === 3));
    expect(three).toHaveLength(10);
    expect(three.every(plan => !plan.alerts?.length)).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.limits).toContain('planCap');
  });

  it('keeps the first no-alert page to ten four-way plans', () => {
    const first = Array.from({ length: 12 }, (_, index) => `first-${index}`);
    const second = Array.from({ length: 12 }, (_, index) => `second-${index}`);
    const third = Array.from({ length: 12 }, (_, index) => `third-${index}`);
    const ids = ['requester', ...first, ...second, ...third];
    const snapshot = blankSnapshot(ids, 80);
    const leave = ['2026-11-16', '2026-11-17'];
    for (const date of leave) work(snapshot, 'requester', date, 'night', NIGHT);
    first.forEach((id, index) => {
      const a = addDays('2026-11-23', index * 14);
      const b = addDays(a, 3);
      const c = addDays(a, 6);
      const pair = (staffId: string, start: string) => {
        work(snapshot, staffId, start, 'night', NIGHT);
        work(snapshot, staffId, addDays(start, 1), 'night', NIGHT);
      };
      const free = (staffId: string, start: string) => {
        off(snapshot, staffId, start);
        off(snapshot, staffId, addDays(start, 1));
      };
      free(id, leave[0]);
      pair(id, a);
      free(second[index], a);
      pair(second[index], b);
      free(third[index], b);
      pair(third[index], c);
      free('requester', c);
    });
    const result = findSwaps(stage2Profile(ids, [NIGHT]), snapshot, stage2Settings({ maxChain: 4 }), stage2Request('requester', leave, { today: TODAY, noAlertsOnly: true }));
    const four = result.plans.filter(plan => plan.chains.some(chain => chain.links.length === 4));
    expect(four).toHaveLength(10);
    expect(four.every(plan => !plan.alerts?.length)).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.limits).toContain('planCap');
  });

  it('classifies the same clashes, leave requests and hand-sorts as the search', () => {
    const ids = ['requester', 'rowan'];
    const profile = names(ids);
    const snapshot = blankSnapshot(ids, 8);
    const settings = stage2Settings({ weekendDayActivities: ['Saturday clinic'] });
    const leave = ['2026-11-10', '2026-11-11', '2026-11-14', '2026-11-16', '2026-11-17'];
    work(snapshot, 'requester', '2026-11-10', 'longDay', LONG);
    work(snapshot, 'requester', '2026-11-11', 'dayJob', CLINIC);
    work(snapshot, 'requester', '2026-11-14', 'dayJob', 'Saturday clinic', );
    setPart(snapshot, 'requester', '2026-11-16');
    work(snapshot, 'requester', '2026-11-17', 'night', NIGHT);
    work(snapshot, 'requester', '2026-11-18', 'night', NIGHT);
    const request = stage2Request('requester', leave, { today: TODAY });
    const classified = classifySwapDates(snapshot, settings, request);
    const found = findSwaps(profile, snapshot, settings, request);
    const clashDates = (kind: string) => classified.clashes.filter(item => item.kind === kind).map(item => item.date).sort();
    const searchDates = (kind: string) => found.clashes.filter(item => item.kind === kind).flatMap(item => item.dates).sort();
    const onLeave = (dates: string[]) => dates.filter(date => leave.includes(date)).sort();
    expect(clashDates('longDay')).toEqual(onLeave(searchDates('longDay')));
    expect(clashDates('dayShift')).toEqual(onLeave(searchDates('dayShift')));
    expect(clashDates('nightBlock')).toEqual(onLeave(searchDates('nightBlock')));
    expect(classified.requestAsLeave.map(item => item.date).sort()).toEqual(found.requestAsLeave.map(item => item.date).sort());
    expect(classified.sortByHand.map(item => item.date).sort()).toEqual(found.sortByHand.map(item => item.date).sort());
  });

  it('hints only when leave covers part of a long-day run', () => {
    const ids = ['requester'];
    const snapshot = blankSnapshot(ids, 8);
    const settings = stage2Settings();
    for (const date of ['2026-12-04', '2026-12-05', '2026-12-06']) work(snapshot, 'requester', date, 'longDay', LONG);
    work(snapshot, 'requester', '2026-12-08', 'longDay', LONG);
    const partial = swapDateSummary(snapshot, settings, 'requester', ['2026-12-05', '2026-12-06'], false, TODAY);
    expect(partial.partialRun?.dates).toEqual(['2026-12-04', '2026-12-05', '2026-12-06']);
    expect(partial.partialRun?.missing).toEqual(['2026-12-04']);
    const whole = swapDateSummary(snapshot, settings, 'requester', ['2026-12-04', '2026-12-05', '2026-12-06'], false, TODAY);
    expect(whole.partialRun).toBeUndefined();
    const single = swapDateSummary(snapshot, settings, 'requester', ['2026-12-08'], false, TODAY);
    expect(single.partialRun).toBeUndefined();
  });

  it('attaches an hours breakdown that adds up to the engine total', () => {
    const ids = ['requester', 'rowan'];
    const snapshot = blankSnapshot(ids, 8);
    work(snapshot, 'requester', '2026-11-10', 'longDay', LONG);
    off(snapshot, 'rowan', '2026-11-10');
    work(snapshot, 'rowan', '2026-11-24', 'longDay', LONG);
    off(snapshot, 'requester', '2026-11-24');
    for (let offset = 0; offset < 5; offset++) work(snapshot, 'rowan', addDays('2026-11-11', offset), 'longDay', LONG);
    const rules = [{ id: 'hours', name: '', type: 'maxHours' as const, hard: true, hours: 72, windowDays: 7 }];
    const profile = stage2Profile(ids, [LONG], rules);
    const result = findSwaps(profile, snapshot, stage2Settings({ maxChain: 2 }), stage2Request('requester', ['2026-11-10'], { today: TODAY }));
    const alert = result.plans.flatMap(plan => plan.alerts ?? []).find(item => item.hours);
    expect(alert?.hours).toBeTruthy();
    const hours = alert!.hours!;
    const sum = hours.shifts.reduce((total, shift) => total + shift.hours, 0);
    expect(sum).toBeCloseTo(hours.totalHours);
    expect(hours.limitHours).toBe(72);
    expect(hours.totalHours).toBeGreaterThan(72);
    expect(hours.shifts.some(shift => shift.fromSwap)).toBe(true);
  });

  it('does not change fixed shifts, unavailability or the rota', () => {
    const ids = ['requester', 'rowan'];
    const profile = names(ids);
    const snapshot = blankSnapshot(ids, 8);
    work(snapshot, 'requester', '2026-11-10', 'longDay', LONG);
    off(snapshot, 'rowan', '2026-11-10');
    work(snapshot, 'rowan', '2026-11-17', 'longDay', LONG);
    off(snapshot, 'requester', '2026-11-17');
    const settings = stage2Settings({ maxChain: 2 });
    const beforeProfile = JSON.stringify(profile);
    const beforeSnapshot = JSON.stringify(snapshot);
    const beforeSettings = JSON.stringify(settings);
    findSwaps(profile, snapshot, settings, stage2Request('requester', ['2026-11-10'], { today: TODAY }));
    expect(JSON.stringify(profile)).toBe(beforeProfile);
    expect(JSON.stringify(snapshot)).toBe(beforeSnapshot);
    expect(JSON.stringify(settings)).toBe(beforeSettings);
  });
});

function setPart(snapshot: ReturnType<typeof blankSnapshot>, staffId: string, date: string) {
  snapshot.days[staffId][date] = { status: 'partShift', activity: 'Morning clinic', sessions: ['am'] };
}
