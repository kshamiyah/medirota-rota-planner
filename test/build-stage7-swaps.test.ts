import { describe, expect, it, vi } from 'vitest';
import { addDays } from '../src/engine/calendar';
import { findSwaps, type SwapPlan } from '../src/engine/swaps';
import { chainSentences, planMatchesFilter, swapPlanNotes } from '../src/app/swapsView';
import { makeShareContent, renderSharePng, shareText } from '../src/app/swapShare';
import { blankSnapshot, off, setDay, stage2Profile, stage2Request, stage2Settings, work } from './swaps-stage2-helpers';

const ids = ['Dr Rowan', 'Dr Ellis', 'Dr Hart', 'Dr Moss', 'Dr Vale', 'Dr Quinn'];
const [rowan, ellis, hart, moss, vale, quinn] = ids;
const date = '2026-12-07';
const returned = '2026-12-14';
const long = 'Long cover';
const clinic = 'MAU CT';
function fixture(working = 4, on = date) {
  const snapshot = blankSnapshot(ids);
  const profile = stage2Profile(ids, [long, clinic]);
  profile.staff.forEach(person => { person.name = person.id; });
  work(snapshot, rowan, on, 'longDay', long);
  ids.slice(1, working).forEach(id => setDay(snapshot, id, on, 'dayJob', clinic, ['am', 'pm']));
  const settings = stage2Settings({ maxChain: 2, minDoctors: [3, 3, 3, 3, 3, 3, 3] });
  const request = stage2Request(rowan, [on]);
  return { profile, snapshot, settings, request };
}
function search(f: ReturnType<typeof fixture>) { return findSwaps(f.profile, f.snapshot, f.settings, f.request); }
function sameDay(plan: SwapPlan) { return plan.chains.some(chain => chain.sameDay); }
function sharing(plans: SwapPlan[]) {
  return makeShareContent({ plans, filter: 'noAlerts', requesterId: rowan, requesterName: rowan, nameFor: id => id, covered: [{ dates: [date], activity: long, kind: 'longDay' }], existingShortages: [], limit: 'all' });
}

describe('Stage 7 NWD swaps', () => {
  it.each([{ working: 4, expected: 3 }, { working: 5, expected: 4 }])('offers a full day job with $expected of 3 working after leave', ({ working, expected }) => {
    const f = fixture(working);
    f.settings.hoursTolerance = 0;
    f.request.cantWorkDates = [date];
    f.request.returnWindow = { kind: 'dates', from: returned, to: returned };
    const result = search(f);
    const plan = result.plans.find(plan => plan.chains[0].links[1].staffId === ellis)!;
    expect(plan).toMatchObject({ people: 1, leaveRequests: [{ date, activity: clinic }], warnings: [] });
    expect(plan.chains).toHaveLength(1);
    expect(plan.chains[0]).toMatchObject({ sameDay: { doctors: expected, minimum: 3 }, payDifferent: false });
    expect(plan.alerts).toBeUndefined();
    expect(planMatchesFilter(plan, 'ask1')).toBe(true);
    expect(planMatchesFilter(plan, 'noAlerts')).toBe(true);
    expect(chainSentences(plan.chains[0], f.profile.staff, rowan)).toEqual([`NWD swap: Dr Ellis works your long day; you take their MAU CT and request it as annual leave.`]);
    expect(swapPlanNotes(plan, id => id)).toContain(`Mon 7 Dec: ${expected} of 3 working after leave`);
  });

  it('rules out below the minimum with the activity and numbers', () => {
    const f = fixture(3);
    const result = search(f);
    expect(result.plans).toEqual([]);
    expect(result.ruledOut.find(item => item.staffId === ellis)).toMatchObject({ group: 'working', reason: "Leave on their MAU CT day would leave 2 of 3 working, so it's likely to be refused" });
  });

  it('counts day jobs, long days and daytime part shifts, but excludes evening parts, nights and training', () => {
    const f = fixture(2);
    f.settings.minDoctors[0] = 2;
    setDay(f.snapshot, hart, date, 'partShift', long, ['pm']);
    setDay(f.snapshot, moss, date, 'partShift', long, ['eve']);
    setDay(f.snapshot, vale, date, 'night', 'Night cover', ['night']);
    setDay(f.snapshot, quinn, date, 'training', 'Training');
    expect(search(f).plans.filter(sameDay)[0].chains[0].sameDay?.doctors).toBe(2);
    setDay(f.snapshot, hart, date, 'partShift', long, ['eve']);
    expect(search(f).plans.filter(sameDay)).toEqual([]);
  });

  it.each(['2026-12-12', '2026-12-13', '2026-12-25'])('keeps a day-job colleague working on a weekend or bank holiday (%s)', on => {
    const f = fixture(5, on);
    if (on === '2026-12-25') f.settings.bankHolidays = [on];
    expect(search(f).plans).toEqual([]);
    expect(search(f).ruledOut.find(item => item.staffId === ellis)).toMatchObject({ group: 'working', reason: `Working MAU CT on ${on}` });
  });

  it('requires a full requester long day and a full colleague day job', () => {
    const f = fixture();
    setDay(f.snapshot, ellis, date, 'partShift', clinic, ['am']);
    expect(search(f).plans.some(plan => plan.chains[0].links[1].staffId === ellis)).toBe(false);
    setDay(f.snapshot, rowan, date, 'partShift', long, ['am', 'pm']);
    expect(search(f).plans).toEqual([]);
    expect(search(f).sortByHand).toEqual([{ date, activity: long }]);
  });

  it('does not offer a morning-only day job as a NWD swap', () => {
    const f = fixture();
    setDay(f.snapshot, ellis, date, 'dayJob', clinic, ['am']);
    const result = search(f);
    expect(result.plans.some(plan => plan.chains.some(chain => chain.sameDay && chain.links[1].staffId === ellis))).toBe(false);
    expect(result.ruledOut.find(item => item.staffId === ellis)).toMatchObject({ group: 'working', reason: `Working MAU CT on ${date}` });
  });

  it.each(['excluded', 'regular', 'leaveOut', 'only'] as const)('respects %s restrictions for a same-day colleague', restriction => {
    const f = fixture();
    if (restriction === 'excluded') f.settings.excluded = [{ staffId: ellis }];
    if (restriction === 'regular') f.settings.regularDaysOff = { [ellis]: [0] };
    if (restriction === 'leaveOut') f.request.excludeStaffIds = [ellis];
    if (restriction === 'only') { f.request.askMode = 'only'; f.request.askStaffIds = [hart]; }
    expect(search(f).plans.some(plan => plan.chains.some(chain => chain.links[1].staffId === ellis))).toBe(false);
  });

  it('explains when a valid NWD option is cut by paging', () => {
    const f = fixture();
    f.request.planLimits = { 2: 1 };
    const result = search(f);
    expect(result.plans).toHaveLength(1);
    expect(result.ruledOut.find(item => item.staffId === hart)).toMatchObject({ group: 'other', reason: "A valid swap exists but wasn't shown because of the plan limit." });
  });

  it('still applies full team skill-mix checks to a NWD swap', () => {
    const f = fixture();
    f.profile.demands = [{ id: 'long-cover', roleId: `role-${long}`, shiftTypeId: 'long', days: {}, min: 1, max: 1 }];
    f.profile.rules = [{ id: 'qualified-cover', name: 'Qualified cover', type: 'skillMix', hard: true, work: { roleIds: [`role-${long}`] }, who: { groupIds: ['qualified'] }, min: 1 }];
    expect(search(f).plans).toEqual([]);
    expect(search(f).ruledOut.find(item => item.staffId === ellis)?.reason).toBe('Qualified cover');
  });

  it('leaves the source profile, snapshot, settings and request unchanged', () => {
    const f = fixture();
    const before = structuredClone(f);
    search(f);
    expect(f).toEqual(before);
  });

  it('includes chosen NWD colleagues in the preferred section', () => {
    const f = fixture();
    f.request.askMode = 'prefer'; f.request.askStaffIds = [hart]; f.request.planLimits = { 2: 1 };
    const plan = search(f).plans[0];
    expect(plan.chosenPeople).toBe(true);
    expect(plan.chains[0].links[1].staffId).toBe(hart);
  });

  it('checks the colleague long day for working-time alerts and removes their day job from the check', () => {
    const f = fixture();
    f.profile.rules = [{ id: 'hours', name: 'Hours', type: 'maxHours', hard: true, hours: 11, windowDays: 1 }];
    const plan = search(f).plans.find(plan => plan.chains[0].links[1].staffId === ellis)!;
    expect(plan.alerts).toEqual([expect.objectContaining({ staffId: ellis, hours: expect.objectContaining({ totalHours: 12.5, limitHours: 11 }) })]);
    expect(plan.alerts?.some(alert => alert.staffId === rowan)).toBe(false);
    f.request.noAlertsOnly = true;
    expect(search(f).plans).toEqual([]);
  });

  it('ranks an ordinary option above a NWD option with the same number of people', () => {
    const f = fixture();
    off(f.snapshot, vale, date); work(f.snapshot, vale, returned, 'longDay', long); off(f.snapshot, rowan, returned);
    const result = search(f);
    expect(result.plans[0].chains[0].links[1].staffId).toBe(vale);
    expect(result.plans.some(sameDay)).toBe(true);
  });

  it('combines a NWD swap with an ordinary swap in multi-date leave', () => {
    const f = fixture();
    const second = addDays(date, 1);
    work(f.snapshot, rowan, second, 'longDay', long); off(f.snapshot, ellis, second);
    work(f.snapshot, ellis, returned, 'longDay', long); off(f.snapshot, rowan, returned);
    f.request.leaveDates.push(second);
    const plan = search(f).plans.find(plan => plan.people === 1 && plan.cleared.length === 2)!;
    expect(plan.chains.filter(chain => chain.sameDay)).toHaveLength(1);
    expect(plan.leaveRequests).toEqual([{ date, activity: clinic }]);
    expect(plan.blockLength).toBeUndefined();
    expect(planMatchesFilter(plan, 'ask1')).toBe(true);
    const text = shareText(sharing([plan]));
    expect(text).toContain('You work: Mon 14 Dec (Long cover)');
    expect(text).toContain('Mon 7 Dec: Same-day swap: they work your long day, you take their day job as leave (MAU CT)');
    expect(text).not.toContain('Dr Ellis works your long day');
  });
});

describe('Stage 7 training colleagues', () => {
  function trainingFixture() {
    const f = fixture(1);
    setDay(f.snapshot, ellis, date, 'training', 'Training');
    work(f.snapshot, ellis, returned, 'longDay', long); off(f.snapshot, rowan, returned);
    return f;
  }
  it('offers training as a long-day alternative, notes it, and ranks an equal Zero Day first', () => {
    const f = trainingFixture();
    off(f.snapshot, hart, date); work(f.snapshot, hart, returned, 'longDay', long);
    f.request.noAlertsOnly = true;
    const result = search(f);
    expect(result.plans[0].chains[0].links[1].staffId).toBe(hart);
    const plan = result.plans.find(plan => plan.chains[0].links[1].staffId === ellis)!;
    expect(plan.missedTraining).toEqual([{ staffId: ellis, date }]);
    expect(plan.alerts).toBeUndefined();
    expect(planMatchesFilter(plan, 'noAlerts')).toBe(true);
    expect(result.ruledOut.some(item => item.staffId === ellis)).toBe(false);
    expect(swapPlanNotes(plan, id => id)).toContain('Misses training on Mon 7 Dec');
    expect(swapPlanNotes(plan, id => id).some(note => note.includes('Dr Ellis:'))).toBe(false);
    expect(shareText(sharing([plan]))).toContain('Misses training on Mon 7 Dec');
    expect(shareText(sharing([plan]))).not.toContain('Dr Ellis: Misses training');
  });

  it('permits training in an intermediate link and never passes the training on', () => {
    const f = trainingFixture();
    f.settings.maxChain = 3;
    setDay(f.snapshot, rowan, returned, 'blank');
    setDay(f.snapshot, hart, returned, 'training', 'Training');
    work(f.snapshot, hart, '2026-12-21', 'longDay', long); off(f.snapshot, rowan, '2026-12-21');
    const plan = search(f).plans.find(plan => plan.people === 2)!;
    expect(plan.missedTraining).toEqual([{ staffId: ellis, date }, { staffId: hart, date: returned }]);
    expect(plan.movedShifts).toBeUndefined();
  });

  it('leaves requester training unavailable as a return date', () => {
    const f = trainingFixture();
    setDay(f.snapshot, rowan, returned, 'training', 'Training');
    expect(search(f).plans).toEqual([]);
    expect(search(f).ruledOut.find(item => item.staffId === ellis)?.group).not.toBe('training');
  });

  it.each(['nightDate', 'mandatoryRest', 'recommendedRest'] as const)('keeps training on a night package %s unchanged', placement => {
    const f = trainingFixture();
    work(f.snapshot, rowan, date, 'night', 'Night cover');
    work(f.snapshot, ellis, returned, 'night', 'Night cover');
    off(f.snapshot, ellis, date); off(f.snapshot, rowan, returned);
    const trainingDate = placement === 'nightDate' ? date : addDays(date, placement === 'mandatoryRest' ? 1 : 2);
    setDay(f.snapshot, ellis, trainingDate, 'training', 'Training');
    const result = search(f);
    if (placement === 'recommendedRest') {
      expect(result.plans).toHaveLength(1);
      expect(result.plans[0].alerts?.some(alert => alert.message.includes('training'))).toBe(true);
      expect(result.plans[0].missedTraining).toBeUndefined();
    } else expect(result.plans).toEqual([]);
  });

  it('does not let a night-package owner take a passed long day over their training', () => {
    const f = trainingFixture();
    work(f.snapshot, rowan, date, 'night', 'Night cover');
    work(f.snapshot, ellis, returned, 'night', 'Night cover');
    off(f.snapshot, ellis, date); off(f.snapshot, rowan, returned);
    work(f.snapshot, ellis, addDays(date, 1), 'longDay', long);
    setDay(f.snapshot, rowan, addDays(date, 1), 'training', 'Training');
    expect(search(f).plans).toEqual([]);
  });
});

describe('Stage 7 sharing', () => {
  it('uses the NWD wording and notes without an alert, including when grouped as an alternative', async () => {
    const f = fixture();
    const plan = search(f).plans.find(plan => plan.chains[0].links[1].staffId === ellis)!;
    const content = sharing([plan]);
    const text = shareText(content);
    expect(text).toContain('1. *Dr Ellis*: Same-day swap: they work your long day, you take their day job as leave (MAU CT)');
    expect(text).toContain('Different shift lengths: 9.5 h for your 12.5 h');
    expect(text).toContain('3 doctors at work (minimum 3)');
    expect(text).not.toContain('⚠');
    const ordinaryFixture = fixture();
    off(ordinaryFixture.snapshot, ellis, date);
    work(ordinaryFixture.snapshot, ellis, returned, 'longDay', long); off(ordinaryFixture.snapshot, rowan, returned);
    const ordinary = search(ordinaryFixture).plans.find(plan => plan.chains[0].links[1].staffId === ellis)!;
    const all = sharing([ordinary, plan]);
    expect(shareText(all)).toContain('Other dates:\n• Mon 7 Dec: Same-day swap: they work your long day, you take their day job as leave (MAU CT; 3 doctors at work (minimum 3))');
    await assertImage(content, ['Same-day swap: they work your long day, you take their day job as leave (MAU CT)', '3 doctors at work (minimum 3)']);
  });

  it('keeps long alert reasons and NWD notes apart in the image', async () => {
    const f = fixture();
    const plan = search(f).plans[0];
    plan.alerts = [{ staffId: ellis, date, message: 'Minimum rest between shifts needs checking before this swap can be agreed' }];
    const content = makeShareContent({ plans: [plan], filter: 'all', requesterId: rowan, requesterName: rowan, nameFor: id => id, covered: [{ dates: [date], activity: long, kind: 'longDay' }], existingShortages: [], limit: 'all' });
    await assertImage(content, ['3 doctors at work (minimum 3)']);
  });

  it('includes the training note in the image', async () => {
    const f = fixture(1);
    setDay(f.snapshot, ellis, date, 'training', 'Training');
    work(f.snapshot, ellis, returned, 'longDay', long); off(f.snapshot, rowan, returned);
    await assertImage(sharing(search(f).plans), ['Misses training on Mon 7 Dec']);
  });
});

async function assertImage(content: ReturnType<typeof sharing>, expected: string[]) {
  const calls: { text: string; x: number; y: number; width: number }[] = [];
  const context = {
    fillStyle: '', font: '', textAlign: '', strokeStyle: '', fillRect: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(), roundRect: vi.fn(), fill: vi.fn(),
    fillText: (text: string, x: number, y: number) => calls.push({ text, x, y, width: text.length * 7 }), measureText: (text: string) => ({ width: text.length * 7 }),
  };
  const canvas = { width: 0, height: 0, getContext: () => context, toBlob: (callback: BlobCallback) => callback(new Blob(['png'], { type: 'image/png' })) } as unknown as HTMLCanvasElement;
  const blob = await renderSharePng(content, () => canvas);
  expect(blob.type).toBe('image/png'); expect(canvas.width).toBe(720);
  const text = calls.map(call => call.text).join(' ');
  expected.forEach(value => expect(text).toContain(value));
  calls.forEach(call => expect(call.y).toBeLessThan(canvas.height));
  const details = calls.filter(call => call.y > 250);
  for (let a = 0; a < details.length; a++) for (let b = a + 1; b < details.length; b++) {
    const first = details[a], second = details[b];
    if (Math.abs(first.y - second.y) < 14) expect(first.x + first.width <= second.x || second.x + second.width <= first.x, `${first.text} overlaps ${second.text}`).toBe(true);
  }
}
