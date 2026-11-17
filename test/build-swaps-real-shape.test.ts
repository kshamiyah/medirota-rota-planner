import { describe, expect, it } from 'vitest';
import { addDays, weekday } from '../src/engine/calendar';
import { findSwaps, type SnapshotDay, type SwapRequest } from '../src/engine/swaps';
import { applyDefaultLimitRules, blankSnapshot, setDay, stage2Profile, stage2Request, stage2Settings, work } from './swaps-stage2-helpers';

const WEEKS = 34;
const DOCTORS = 53;

function score(staff: number, week: number, day: number, salt: number): number {
  let value = (staff + 1) * 2654435761 + (week + 3) * 2246822519 + (day + 7) * 3266489917 + salt * 668265263;
  value ^= value >>> 13;
  return value >>> 0;
}

function inPost(staff: number, week: number): boolean {
  if (staff < 10) return true;
  if (staff < 20) return week <= 17;
  if (staff < 30) return week >= 16;
  if (staff < 40) return week >= 15 && week <= 17;
  const start = ((staff - 40) * 5) % 30;
  return week >= start && week < Math.min(WEEKS, start + 4);
}

export function makeRealShapeFixture() {
  const ids = Array.from({ length: DOCTORS }, (_, index) => `shape-${String(index).padStart(2, '0')}`);
  const activities = Array.from({ length: 27 }, (_, index) => `Activity ${String(index + 1).padStart(2, '0')}`);
  const profile = stage2Profile(ids, activities);
  applyDefaultLimitRules(profile);
  const snapshot = blankSnapshot(ids, WEEKS);
  const starts = Object.keys(snapshot.importedAt).sort();
  const requester = ids[0];
  const scenarios = {
    single: addDays(starts[5], 1),
    bankHoliday: starts[7],
    weekend: addDays(starts[9], 5),
    weekendSunday: addDays(starts[9], 6),
    fridayNights: addDays(starts[11], 4),
    mondayNights: starts[13],
  };

  const nights = new Set<string>();
  const blocks: { staff: number; start: string; length: number }[] = [];
  const addBlock = (staff: number, start: string, length: number) => {
    for (let offset = 0; offset < length; offset++) nights.add(`${staff}|${addDays(start, offset)}`);
    blocks.push({ staff, start, length });
  };
  addBlock(0, scenarios.fridayNights, 3);
  addBlock(0, scenarios.mondayNights, 4);
  const lengths = [...Array(64).fill(3), ...Array(64).fill(4), ...Array(3).fill(1), ...Array(3).fill(2), ...Array(3).fill(5)] as number[];
  let cursor = 0;
  for (const length of lengths) {
    let placed = false;
    for (let attempt = 0; attempt < 20000 && !placed; attempt++, cursor++) {
      const staff = 1 + (cursor * 17) % (DOCTORS - 1);
      const week = (cursor * 11 + length * 3) % WEEKS;
      const day = length === 3 ? 4 : length === 4 ? 0 : (cursor * 3) % Math.max(1, 8 - length);
      if (!inPost(staff, week) || !inPost(staff, Math.min(WEEKS - 1, week + (day + length - 1 >= 7 ? 1 : 0)))) continue;
      const start = addDays(starts[week], day);
      const keys = Array.from({ length }, (_, offset) => `${staff}|${addDays(start, offset)}`);
      if (keys.some(key => nights.has(key))) continue;
      addBlock(staff, start, length);
      placed = true;
    }
    if (!placed) throw new Error(`Could not place fixture night block of ${length}`);
  }

  const longDays = new Set<string>([
    `0|${scenarios.single}`, `0|${scenarios.bankHoliday}`,
    `0|${scenarios.weekend}`, `0|${scenarios.weekendSunday}`,
  ]);
  const cells = ids.flatMap((_, staff) => starts.flatMap((start, week) => inPost(staff, week)
    ? Array.from({ length: 7 }, (_, day) => ({ staff, week, day, date: addDays(start, day) })) : []));
  const addLongDays = (weekend: boolean, target: number) => {
    const candidates = cells.filter(cell => (cell.day >= 5) === weekend && !nights.has(`${cell.staff}|${cell.date}`) && !longDays.has(`${cell.staff}|${cell.date}`))
      .sort((a, b) => score(a.staff, a.week, a.day, weekend ? 31 : 29) - score(b.staff, b.week, b.day, weekend ? 31 : 29));
    const existing = [...longDays].filter(key => weekday(key.split('|')[1]) >= 5 === weekend).length;
    for (const cell of candidates.slice(0, target - existing)) longDays.add(`${cell.staff}|${cell.date}`);
  };
  addLongDays(false, 469);
  addLongDays(true, 136);

  for (const { staff, start, length } of blocks) for (let offset = 0; offset < length; offset++) work(snapshot, ids[staff], addDays(start, offset), 'night', activities[1]);
  for (const key of longDays) {
    const [staff, date] = key.split('|');
    work(snapshot, ids[Number(staff)], date, 'longDay', activities[2 + Number(staff) % 5]);
  }

  const assigned = new Set([...nights, ...longDays]);
  const shares: [SnapshotDay['status'], number, number][] = [
    ['dayJob', 0.30, 0.08], ['zero', 0.24, 0.66], ['leave', 0.10, 0.04],
    ['training', 0.07, 0], ['available', 0.03, 0.01], ['partShift', 0.02, 0], ['notAvailable', 0.01, 0],
  ];
  for (const weekend of [false, true]) {
    const all = cells.filter(cell => (cell.day >= 5) === weekend);
    for (let statusIndex = 0; statusIndex < shares.length; statusIndex++) {
      const [status, weekdayShare, weekendShare] = shares[statusIndex];
      const target = Math.round(all.length * (weekend ? weekendShare : weekdayShare));
      const candidates = all.filter(cell => !assigned.has(`${cell.staff}|${cell.date}`))
        .sort((a, b) => score(a.staff, a.week, a.day, 100 + statusIndex) - score(b.staff, b.week, b.day, 100 + statusIndex));
      for (const cell of candidates.slice(0, target)) {
        const key = `${cell.staff}|${cell.date}`;
        assigned.add(key);
        const activity = status === 'zero' ? 'Zero Day' : status === 'leave' ? 'Annual Leave' : status === 'training' ? 'Teaching' : status === 'available' ? 'Available' : status === 'notAvailable' ? 'Administrative Duty' : weekend ? activities[0] : activities[3 + (cell.staff + cell.day) % 24];
        const sessions: SnapshotDay['sessions'] = status === 'partShift' ? ['am', 'eve'] : ['am'];
        setDay(snapshot, ids[cell.staff], cell.date, status, activity, sessions);
      }
    }
  }

  // Plant realistic direct night-block candidates so the Stage 3 comparison
  // searches the same kind of work instead of returning immediately.
  const reservedRequesterDates = new Set([
    scenarios.single, scenarios.bankHoliday, scenarios.weekend, scenarios.weekendSunday,
    ...Array.from({ length: 3 }, (_, offset) => addDays(scenarios.fridayNights, offset)),
    ...Array.from({ length: 4 }, (_, offset) => addDays(scenarios.mondayNights, offset)),
  ]);
  for (const [clashStart, length] of [[scenarios.fridayNights, 3], [scenarios.mondayNights, 4]] as const) {
    const candidates = blocks.filter(block => block.staff !== 0 && block.length === length &&
      Array.from({ length }, (_, offset) => addDays(block.start, offset)).every(date => !reservedRequesterDates.has(date) && !['night', 'longDay'].includes(snapshot.days[requester][date].status)) &&
      Array.from({ length }, (_, offset) => addDays(clashStart, offset)).every(date => !['night', 'longDay'].includes(snapshot.days[ids[block.staff]][date].status))).slice(0, 8);
    for (const candidate of candidates) for (let offset = 0; offset < length; offset++) {
      setDay(snapshot, ids[candidate.staff], addDays(clashStart, offset), 'zero', 'Zero Day', ['am']);
      setDay(snapshot, requester, addDays(candidate.start, offset), 'zero', 'Zero Day', ['am']);
    }
  }

  const settings = stage2Settings({ weekendDayActivities: [activities[0]], bankHolidays: [scenarios.bankHoliday], maxChain: 4 });
  const requests: Record<string, SwapRequest> = {
    single: stage2Request(requester, [scenarios.single]),
    bankHoliday: stage2Request(requester, [scenarios.bankHoliday]),
    fridayNights: stage2Request(requester, [scenarios.fridayNights]),
    mondayNights: stage2Request(requester, [scenarios.mondayNights]),
    weekend: stage2Request(requester, [scenarios.weekend, scenarios.weekendSunday]),
  };
  return { ids, profile, snapshot, settings, requests, scenarios, blocks, longDays };
}

function planSignature(plan: ReturnType<typeof findSwaps>['plans'][number]): string {
  return plan.chains.map(chain => chain.links.map(link => `${link.staffId}:${link.gives.dates.join('+')}`).join('>')).sort().join('|');
}

describe('real-shaped swap benchmark', () => {
  it('has the requested anonymous shape', () => {
    const fixture = makeRealShapeFixture();
    const starts = Object.keys(fixture.snapshot.importedAt).sort();
    const inPostCounts = starts.map((_, week) => fixture.ids.filter((__, staff) => inPost(staff, week) && Object.values(fixture.snapshot.days[fixture.ids[staff]]).slice(week * 7, week * 7 + 7).some(day => day.status !== 'blank')).length);
    expect(fixture.ids).toHaveLength(53);
    expect(starts).toHaveLength(34);
    expect(fixture.profile.roles).toHaveLength(27);
    expect(fixture.profile.shiftTypes).toHaveLength(3);
    expect(fixture.profile.rules).toHaveLength(8);
    expect(fixture.blocks).toHaveLength(139);
    const actualLongDays = fixture.ids.flatMap(id => Object.entries(fixture.snapshot.days[id])).filter(([, day]) => day.status === 'longDay');
    expect(actualLongDays).toHaveLength(605);
    expect(actualLongDays.filter(([date]) => weekday(date) >= 5)).toHaveLength(136);
    expect(Math.min(...inPostCounts)).toBeGreaterThanOrEqual(20);
    expect(Math.max(...inPostCounts)).toBeGreaterThanOrEqual(40);
  });

  it('returns the same complete direct page in direct-only and full searches', () => {
    const fixture = makeRealShapeFixture();
    const directRequest = fixture.requests.weekend;
    const directOnly = findSwaps(fixture.profile, fixture.snapshot, { ...fixture.settings, maxChain: 2 }, directRequest).plans.filter(plan => Math.max(...plan.chains.map(chain => chain.links.length)) === 2).map(planSignature);
    const full = findSwaps(fixture.profile, fixture.snapshot, { ...fixture.settings, maxChain: 4 }, directRequest).plans.filter(plan => Math.max(...plan.chains.map(chain => chain.links.length)) === 2).map(planSignature);
    expect(directOnly).toHaveLength(50);
    expect(full).toEqual(directOnly);
  }, 120_000);

  it.skipIf(process.env.RUN_SWAP_REAL_BENCHMARKS !== '1')('times the five real-shaped searches and checks direct-page parity', () => {
    const fixture = makeRealShapeFixture();
    for (const [label, request] of Object.entries(fixture.requests)) {
      const started = performance.now();
      const result = findSwaps(fixture.profile, fixture.snapshot, fixture.settings, request);
      const elapsed = performance.now() - started;
      const suggestions = result.plans.flatMap(plan => plan.alerts ?? []).filter(alert => alert.suggestion).length;
      console.log(`${label}: ${elapsed.toFixed(1)} ms; plans=${result.plans.length}; ruledOut=${result.ruledOut.length}; suggestions=${suggestions}; limits=${result.limits?.join(',') ?? 'none'}`);
      expect(elapsed).toBeLessThan(60000);
    }
    const directRequest = fixture.requests.weekend;
    const directOnly = findSwaps(fixture.profile, fixture.snapshot, { ...fixture.settings, maxChain: 2 }, directRequest).plans.filter(plan => Math.max(...plan.chains.map(chain => chain.links.length)) === 2).map(planSignature);
    const full = findSwaps(fixture.profile, fixture.snapshot, { ...fixture.settings, maxChain: 4 }, directRequest).plans.filter(plan => Math.max(...plan.chains.map(chain => chain.links.length)) === 2).map(planSignature);
    expect(full).toEqual(directOnly);
  }, 600000);

  it.skipIf(process.env.RUN_SWAP_REAL_BENCHMARKS !== '1')('times everyone, only and chosen-people-first on the same request', () => {
    const fixture = makeRealShapeFixture();
    const selected = fixture.ids.slice(1, 9);
    const time = (askMode: 'everyone' | 'only' | 'prefer') => {
      const started = performance.now();
      const result = findSwaps(fixture.profile, fixture.snapshot, fixture.settings, { ...fixture.requests.weekend, askMode, askStaffIds: selected });
      return { elapsed: performance.now() - started, plans: result.plans.length };
    };
    const everyone = time('everyone'), only = time('only'), first = time('prefer');
    const noAlertsStarted = performance.now();
    const noAlertsResult = findSwaps(fixture.profile, fixture.snapshot, fixture.settings, { ...fixture.requests.weekend, noAlertsOnly: true });
    const noAlertsElapsed = performance.now() - noAlertsStarted;
    const planSize = (plan: (typeof noAlertsResult.plans)[number]) => Math.max(...plan.chains.map(chain => chain.links.length));
    console.log(`who-to-ask everyone: ${everyone.elapsed.toFixed(1)} ms; only: ${only.elapsed.toFixed(1)} ms; first: ${first.elapsed.toFixed(1)} ms; no-alerts: ${noAlertsElapsed.toFixed(1)} ms; plans=${everyone.plans}/${only.plans}/${first.plans}/${noAlertsResult.plans.length}`);
    expect(first.elapsed).toBeLessThan(everyone.elapsed * 1.25);
    expect(noAlertsElapsed).toBeLessThan(everyone.elapsed * 1.5);
    expect(noAlertsResult.plans.filter(plan => planSize(plan) === 3).length).toBeLessThanOrEqual(10);
    expect(noAlertsResult.plans.filter(plan => planSize(plan) === 4).length).toBeLessThanOrEqual(10);
  }, 120000);
});
