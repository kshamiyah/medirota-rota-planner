/** Independent checks of section 9b, plus the lead's AM-and-PM clarification. */
import { describe, expect, it } from 'vitest';
import { findSwaps, type SwapPlan } from '../src/engine/swaps';
import { appendSwapPlans, groupSwapPlans, planFilterCounts, planIdentity, planMatchesFilter, planMatchesHides, visibleSwapPlans } from '../src/app/swapsView';
import { makeShareContent, shareText } from '../src/app/swapShare';
import { stage7Fixture, STAGE7_DATE, type Stage7Case } from './swaps-stage7-fixture';
function run(kind: Stage7Case) {
  const f = stage7Fixture(kind);
  const { profile } = f.ws, { snapshot, settings } = f.ws.swapFinder!;
  return { ...f, result: findSwaps(profile, snapshot, settings, f.request) };
}
const special = (plan: SwapPlan) => plan.chains.some(chain => chain.sameDay) || !!plan.missedTraining?.length;

describe('Stage 7 independent engine acceptance', () => {
  it('ends progress with the exact number of returned plans', () => {
    const { ws, request } = stage7Fixture('sameAt');
    let lastProgress: { stage: string; optionsFound: number } | undefined;
    const result = findSwaps(ws.profile, ws.swapFinder!.snapshot, ws.swapFinder!.settings, request, progress => { lastProgress = progress; });
    expect(lastProgress).toMatchObject({ stage: 'Search complete', optionsFound: result.plans.length });
  });

  it('keeps unlimited output repeatable and marks a bounded search', () => {
    const { ws, request } = stage7Fixture('paging');
    const settings = ws.swapFinder!.settings;
    const baseline = findSwaps(ws.profile, ws.swapFinder!.snapshot, settings, request);
    expect(findSwaps(ws.profile, ws.swapFinder!.snapshot, settings, request)).toEqual(baseline);
    const progress: string[] = [];
    const started = Date.now();
    const bounded = findSwaps(ws.profile, ws.swapFinder!.snapshot, settings, { ...request, deadlineMs: 1 }, message => { progress.push(message.stage); });
    expect(Date.now() - started).toBeLessThan(1500);
    expect(bounded.stoppedEarly).toBe('time');
    expect(bounded.ruledOut).toHaveLength(0);
    expect(bounded.notCheckedYet?.length).toBeGreaterThan(0);
    expect(progress.length).toBeGreaterThan(1);
    expect(bounded.plans.every(plan => baseline.plans.some(item => JSON.stringify(item) === JSON.stringify(plan)))).toBe(true);
    const baselinePositions = bounded.plans.map(plan => baseline.plans.findIndex(item => JSON.stringify(item) === JSON.stringify(plan)));
    expect(baselinePositions).toEqual([...baselinePositions].sort((a, b) => a - b));
  });
  it.each([['sameAt', 7], ['sameAbove', 8]] as const)('offers %s with the actual weekday staffing margin', (kind, doctors) => {
    const { result } = run(kind);
    expect(result.plans).toHaveLength(1);
    expect(result.plans[0]).toMatchObject({ people: 1, remaining: [], leaveRequests: [{ date: STAGE7_DATE, activity: 'MAU CT' }], warnings: [] });
    expect(result.plans[0].chains[0].sameDay).toEqual({ doctors, minimum: 7 });
    expect(result.plans[0].alerts).toBeUndefined();
  });
  it('rejects the NWD pair at six of seven with the activity and numbers', () => {
    const { result } = run('sameBelow');
    expect(result.plans).toHaveLength(0);
    expect(result.ruledOut.find(item => item.staffId === 'ellis')).toMatchObject({ group: 'working', reason: "Leave on their MAU CT day would leave 6 of 7 working, so it's likely to be refused" });
  });
  it.each(['weekend', 'bankHoliday', 'morning', 'afternoon', 'noSessions'] as const)('rules out %s as working', kind => {
    const { result } = run(kind);
    expect(result.plans).toHaveLength(0);
    expect(result.ruledOut.find(item => item.staffId === 'ellis')).toMatchObject({ group: 'working', reason: expect.stringMatching(/^Working MAU CT on /) });
  });
  it('needs both AM and PM, independent of their order and extra sessions', () => {
    const f = stage7Fixture();
    f.ws.swapFinder!.snapshot.days.ellis[STAGE7_DATE].sessions = ['pm', 'am', 'eve'];
    expect(findSwaps(f.ws.profile, f.ws.swapFinder!.snapshot, f.ws.swapFinder!.settings, f.request).plans).toHaveLength(1);
  });
  it('obeys Only these people at every link', () => {
    const { result } = run('only');
    expect(result.plans).toHaveLength(1);
    expect(result.plans.every(plan => plan.chains.every(chain => chain.links.slice(1).every(link => link.staffId === 'ellis')))).toBe(true);
    const f = stage7Fixture('threeWay'); f.request.askMode = 'only'; f.request.askStaffIds = ['ellis'];
    expect(findSwaps(f.ws.profile, f.ws.swapFinder!.snapshot, f.ws.swapFinder!.settings, f.request).plans).toHaveLength(0);
  });
  it.each(['excluded', 'regular'] as const)('does not offer a same-day colleague marked %s', kind => {
    const { result } = run(kind);
    expect(result.plans).toHaveLength(0);
    expect(result.ruledOut.find(item => item.staffId === 'ellis')?.group).toBe(kind === 'excluded' ? 'excluded' : 'other');
  });
  it('lets a colleague miss training for a direct long day, with a note and no alert', () => {
    const { result } = run('training');
    expect(result.plans).toHaveLength(1);
    expect(result.plans[0].missedTraining).toEqual([{ staffId: 'ellis', date: STAGE7_DATE }]);
    expect(result.plans[0].alerts).toBeUndefined();
    expect(result.ruledOut.find(item => item.staffId === 'ellis')).toBeUndefined();
  });
  it('allows training in both receiving links of a three-way chain without passing it on', () => {
    const { result } = run('threeWay');
    expect(result.plans).toHaveLength(1);
    expect(result.plans[0].people).toBe(2);
    expect(result.plans[0].missedTraining).toEqual([{ staffId: 'ellis', date: STAGE7_DATE }, { staffId: 'hart', date: '2026-12-14' }]);
    expect(result.plans[0].movedShifts).toBeUndefined();
  });
  it.each(['requesterTraining', 'nightDate', 'mandatoryRest'] as const)('keeps %s blocking', kind => {
    expect(run(kind).result.plans).toHaveLength(0);
  });
  it('keeps recommended night rest training as an alert rather than a missed-training note', () => {
    const { result } = run('recommendedRest');
    expect(result.plans).toHaveLength(1);
    expect(result.plans[0].alerts).toEqual([expect.objectContaining({ message: expect.stringContaining('recommended rest day contains training') })]);
    expect(result.plans[0].missedTraining).toBeUndefined();
    expect(planMatchesFilter(result.plans[0], 'noAlerts')).toBe(false);
  });
  it('ranks equal Zero Day cover first and keeps both new notes in Ask 1 and No alerts', () => {
    const { result } = run('ranking');
    expect(result.plans).toHaveLength(3);
    expect(result.plans[0].chains[0].links[1].staffId).toBe('moss');
    expect(special(result.plans[0])).toBe(false);
    expect(result.plans.slice(1).every(special)).toBe(true);
    expect(result.plans.every(plan => planMatchesFilter(plan, 'ask1') && planMatchesFilter(plan, 'noAlerts'))).toBe(true);
  });
  it('reserves lower-ranked direct places so training appears on the first page above every 3-way', () => {
    const f = stage7Fixture('paging'); const { snapshot, settings } = f.ws.swapFinder!;
    const first = findSwaps(f.ws.profile, snapshot, settings, f.request);
    const more = findSwaps(f.ws.profile, snapshot, settings, { ...f.request, planLimits: { 2: 100 } });
    expect(first.plans.filter(plan => plan.people === 1 && !special(plan)).length).toBeGreaterThanOrEqual(50);
    expect(first.plans.some(plan => plan.people === 1 && !!plan.missedTraining?.length)).toBe(true);
    expect(first.plans.some(plan => plan.people > 1)).toBe(true);
    expect(first.morePlanSizes).toContain(2);
    const firstTraining = first.plans.findIndex(plan => plan.people === 1 && !!plan.missedTraining?.length);
    const firstLonger = first.plans.findIndex(plan => plan.people > 1);
    expect(firstTraining).toBeGreaterThanOrEqual(50);
    expect(firstLonger).toBeGreaterThan(firstTraining);
    expect(first.plans.slice(0, firstTraining).every(plan => plan.people === 1 && !special(plan))).toBe(true);
    const firstDirectIds = new Set(first.plans.filter(plan => plan.people === 1).map(planIdentity));
    const moreDirectIds = more.plans.filter(plan => plan.people === 1).map(planIdentity);
    expect(moreDirectIds.length).toBeGreaterThan(firstDirectIds.size);
    expect([...firstDirectIds].every(id => moreDirectIds.includes(id))).toBe(true);
    expect(new Set(moreDirectIds).size).toBe(moreDirectIds.length);
    const appended = appendSwapPlans(first.plans, more.plans, 2);
    expect(appended.length).toBeGreaterThan(first.plans.length);
    expect(new Set(appended.map(planIdentity)).size).toBe(appended.length);
  });
  it('combines NWD annual leave and an ordinary return, contacting one person', () => {
    const { result } = run('mixed');
    const plan = result.plans.find(plan => plan.cleared.length === 2)!;
    expect(plan.people).toBe(1); expect(plan.remaining).toHaveLength(0);
    expect(plan.chains.filter(chain => chain.sameDay)).toHaveLength(1);
    expect(plan.leaveRequests).toEqual([{ date: STAGE7_DATE, activity: 'MAU CT' }]);
    expect(plan.chains.find(chain => !chain.sameDay)?.links[1].gives.dates).toEqual(['2026-12-14']);
  });
  it.each(['sameAt', 'training'] as const)('shares %s notes without treating them as alerts', kind => {
    const { ws, result } = run(kind);
    const text = shareText(makeShareContent({ plans: result.plans, filter: 'noAlerts', requesterId: 'rowan', requesterName: 'Dr Rowan', nameFor: id => ws.profile.staff.find(person => person.id === id)!.name, covered: result.clashes, existingShortages: [], limit: 'all' }));
    if (kind === 'sameAt') {
      expect(text).toContain('1. *Dr Ellis*: Same-day swap: they work your long day, you take their day job as leave (MAU CT)');
      expect(text).toContain('7 doctors at work (minimum 7)');
      expect(text).toContain('Different shift lengths: 9.5 h for your 12.5 h');
    } else {
      expect(text).toContain('Misses training on Mon 7 Dec');
      expect(text).not.toContain('Dr Ellis: Misses training');
    }
    expect(text).not.toContain('⚠');
  });
  it('hides NWD and missed-training plans independently and updates filter counts and share', () => {
    const { ws, result } = run('ranking');
    const plans = result.plans;
    expect(plans).toHaveLength(3);
    expect(planFilterCounts(plans)).toMatchObject({ all: 3, ask1: 3, noAlerts: 3 });
    expect(planFilterCounts(plans, { hideSameDay: true })).toMatchObject({ all: 2, ask1: 2, noAlerts: 2 });
    expect(planFilterCounts(plans, { hideMissedTraining: true })).toMatchObject({ all: 2, ask1: 2, noAlerts: 2 });
    expect(planFilterCounts(plans, { hideSameDay: true, hideMissedTraining: true })).toMatchObject({ all: 1, ask1: 1, noAlerts: 1 });
    expect(visibleSwapPlans(plans, 'ask1', { hideSameDay: true }).every(plan => !plan.chains.some(chain => chain.sameDay))).toBe(true);
    expect(visibleSwapPlans(plans, 'noAlerts', { hideMissedTraining: true }).every(plan => !plan.missedTraining?.length)).toBe(true);
    expect(groupSwapPlans(plans, 'rowan', 'all', undefined, { hideSameDay: true })).toHaveLength(2);
    expect(plans.every(plan => planMatchesHides(plan, {}))).toBe(true);
    const shareInput = { plans, filter: 'all' as const, requesterId: 'rowan', requesterName: 'Dr Rowan', nameFor: (id: string) => ws.profile.staff.find(person => person.id === id)!.name, covered: result.clashes, existingShortages: [] as { date: string; doctors: number; minimum: number }[], limit: 'all' as const };
    const hiddenSameDay = shareText(makeShareContent({ ...shareInput, hides: { hideSameDay: true } }));
    expect(hiddenSameDay).not.toContain('Same-day swap');
    expect(hiddenSameDay).toContain('Misses training');
    const hiddenTraining = shareText(makeShareContent({ ...shareInput, hides: { hideMissedTraining: true } }));
    expect(hiddenTraining).toContain('Same-day swap');
    expect(hiddenTraining).not.toContain('Misses training');
    const both = makeShareContent({ ...shareInput, hides: { hideSameDay: true, hideMissedTraining: true }, limit: 5 });
    expect(both.sections.flatMap(section => section.rows)).toHaveLength(1);
    expect(both.more).toBe(0);
  });
});
