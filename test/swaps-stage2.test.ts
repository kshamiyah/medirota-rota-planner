import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { addDays, weekday } from '../src/engine/calendar';
import { assignmentsForSwapValidation, extraNightRestDisposition, findSwaps, nightPackageForChains, type SwapChain, type SwapPlan, type SwapUnit } from '../src/engine/swaps';
import { applyImport, planImport } from '../src/app/mediImport';
import { isActivityWeek, isPersonWeek, parsePersonWeek } from '../src/app/medirota';
import { emptyWorkspace } from '../src/app/store';
import {
  STAGE2_MONDAY, alertStaffOnPlan, applyDefaultLimitRules, blankSnapshot, buildSeededRandomRota, buildTestContext,
  directSwapSignatures, doctorOffForUnit, enumerateDirectSwaps, expectedAlertStaff,
  newRejectingBreaches, off, stage2Profile, stage2Request, stage2Settings, setDay, unitKey, work,
} from './swaps-stage2-helpers';
import type { TestContext } from './swaps-stage2-helpers';

const ROTA_PAGES_DIR = process.env.ROTA_PAGES_DIR;
const ROTA_REQUESTER_NAME = process.env.ROTA_REQUESTER_NAME;
const ROTA_LEAVE_DATES = process.env.ROTA_LEAVE_DATES;

function directKeysFromResult(plans: SwapPlan[]): string[] {
  return directSwapSignatures(plans).map(entry => entry.key);
}

function bruteSignatureList(brute: ReturnType<typeof enumerateDirectSwaps>) {
  return [...brute.signatures.entries()]
    .map(([key, alertStaff]) => ({ key, alertStaff }))
    .sort((a, b) => a.key.localeCompare(b.key) || a.alertStaff.join(',').localeCompare(b.alertStaff.join(',')));
}

function assertEveryReturnedPlan(context: TestContext, plans: SwapPlan[]) {
  for (const plan of plans) {
    expect(newRejectingBreaches(context, plan.chains), `plan rejects ${JSON.stringify(plan.chains)}`).toEqual([]);
    expect(alertStaffOnPlan(plan), `alert staff for ${JSON.stringify(plan.chains)}`).toEqual(expectedAlertStaff(context, plan.chains));
  }
}

function returnDatesInPlans(plans: SwapPlan[], staffId: string): string[] {
  return plans.flatMap(plan => plan.chains.flatMap(chain => chain.links
    .filter(link => link.staffId === staffId)
    .flatMap(link => link.gives.dates))).sort();
}

function receiverOffOnTaken(snapshot: ReturnType<typeof blankSnapshot>, chain: SwapChain, settings: ReturnType<typeof stage2Settings>, request: ReturnType<typeof stage2Request>): boolean {
  for (let i = 0; i < chain.links.length; i++) {
    const giver = chain.links[i];
    const receiver = chain.links[(i + 1) % chain.links.length];
    if (!doctorOffForUnit(snapshot, settings, receiver.staffId, giver.gives, request)) return false;
  }
  return true;
}

function shiftsUsedOnce(chains: SwapChain[]): boolean {
  const seen = new Set<string>();
  for (const chain of chains) for (const link of chain.links) {
    const key = unitKey(link.gives);
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}

function runWithStaffOrder(ids: string[], build: (order: string[]) => { p: ReturnType<typeof stage2Profile>; s: ReturnType<typeof blankSnapshot>; request: ReturnType<typeof stage2Request> }) {
  const forward = build(ids);
  const backward = build([...ids].reverse());
  const settings = stage2Settings({ maxChain: 2 });
  const a = findSwaps(forward.p, structuredClone(forward.s), settings, forward.request);
  const b = findSwaps(backward.p, structuredClone(backward.s), settings, backward.request);
  return { a, b };
}

describe('Stage 2 swap search (tester)', () => {
  describe('1. Brute-force direct swaps', () => {
    it('matches findSwaps at maxChain 2 on hand-built rotas (both directions)', () => {
      const cases = [
        () => {
          const p = stage2Profile(['req', 'cover-a', 'cover-b'], ['Long List']);
          const s = blankSnapshot(['req', 'cover-a', 'cover-b']);
          work(s, 'req', STAGE2_MONDAY, 'longDay', 'Long List');
          off(s, 'cover-a', STAGE2_MONDAY);
          off(s, 'cover-b', STAGE2_MONDAY);
          work(s, 'cover-a', '2026-11-10', 'longDay', 'Long List');
          off(s, 'req', '2026-11-10');
          work(s, 'cover-b', '2026-11-12', 'longDay', 'Long List');
          off(s, 'req', '2026-11-12');
          return { p, s, request: stage2Request('req') };
        },
        () => {
          const p = stage2Profile(['req', 'cover-a'], ['Night List']);
          const s = blankSnapshot(['req', 'cover-a']);
          for (let i = 0; i < 2; i++) {
            work(s, 'req', addDays(STAGE2_MONDAY, i), 'night', 'Night List');
            off(s, 'cover-a', addDays(STAGE2_MONDAY, i));
          }
          for (let i = 0; i < 2; i++) {
            work(s, 'cover-a', addDays('2026-11-10', i), 'night', 'Night List');
            off(s, 'req', addDays('2026-11-10', i));
          }
          return { p, s, request: stage2Request('req', [STAGE2_MONDAY]) };
        },
      ];
      for (const build of cases) {
        const { p, s, request } = build();
        const settings = stage2Settings({ maxChain: 2 });
        const found = findSwaps(p, s, settings, request);
        const brute = enumerateDirectSwaps(p, s, settings, request, found.clashes);
        expect(bruteSignatureList(brute)).toEqual(directSwapSignatures(found.plans));
      }
    });

    it('uses contract rules on seeded random rotas and rejects some pairs on validate()', () => {
      const p = stage2Profile(['req', 'cover-a', 'cover-b', 'cover-c'], ['Long List', 'Night List']);
      applyDefaultLimitRules(p);
      p.rules.push({
        id: 'block-c-monday', name: '', type: 'forbid', hard: true,
        who: { staffIds: ['cover-c'] }, work: { roleIds: ['role-Long List'] }, days: { dates: [STAGE2_MONDAY] },
      });
      const s = blankSnapshot(['req', 'cover-a', 'cover-b', 'cover-c']);
      work(s, 'req', STAGE2_MONDAY, 'longDay', 'Long List');
      off(s, 'cover-a', STAGE2_MONDAY);
      off(s, 'cover-b', STAGE2_MONDAY);
      off(s, 'cover-c', STAGE2_MONDAY);
      work(s, 'cover-a', '2026-11-10', 'longDay', 'Long List');
      off(s, 'req', '2026-11-10');
      work(s, 'cover-c', '2026-11-12', 'longDay', 'Long List');
      off(s, 'req', '2026-11-12');
      for (let i = 1; i <= 4; i++) work(s, 'cover-b', addDays(STAGE2_MONDAY, i), 'night', 'Night List');
      work(s, 'cover-b', '2026-11-07', 'longDay', 'Long List');
      work(s, 'cover-b', '2026-11-14', 'longDay', 'Long List');
      off(s, 'req', '2026-11-07');
      off(s, 'req', '2026-11-14');
      const settings = stage2Settings({ maxChain: 2 });
      const req = stage2Request('req');
      const ruleCheck = findSwaps(p, s, settings, req);
      const probe = enumerateDirectSwaps(p, s, settings, req, ruleCheck.clashes);
      expect(probe.rejectedCount).toBeGreaterThan(0);
      expect(probe.alertOnlyCount).toBeGreaterThan(0);

      for (const seed of [11, 29, 83, 101, 202]) {
        const random = buildSeededRandomRota(seed);
        applyDefaultLimitRules(random.profile);
        const randFound = findSwaps(random.profile, random.snapshot, settings, random.request);
        expect(randFound.clashes.length, `seed ${seed}`).toBeGreaterThan(0);
        const randBrute = enumerateDirectSwaps(random.profile, random.snapshot, settings, random.request, randFound.clashes);
        expect(bruteSignatureList(randBrute)).toEqual(directSwapSignatures(randFound.plans));
      }
    });
  });

  describe('2. Per-doctor cache and search order', () => {
    it('drops the rule-breaking return but keeps the valid one, regardless of staff order', () => {
      const ids = ['req', 'good', 'bad', 'other'];
      const validReturn = '2026-11-10';
      const invalidReturn = '2026-11-06';
      const build = (order: string[]) => {
        const p = stage2Profile(order, ['Long List'], [{
          id: 'bad-no-monday', name: '', type: 'forbid', hard: true,
          who: { staffIds: ['bad'] }, work: { roleIds: ['role-Long List'] }, days: { dates: [STAGE2_MONDAY] },
        }]);
        const s = blankSnapshot(order);
        work(s, 'req', STAGE2_MONDAY, 'longDay', 'Long List');
        off(s, 'good', STAGE2_MONDAY);
        off(s, 'bad', STAGE2_MONDAY);
        work(s, 'good', validReturn, 'longDay', 'Long List');
        off(s, 'req', validReturn);
        work(s, 'bad', invalidReturn, 'longDay', 'Long List');
        off(s, 'req', invalidReturn);
        work(s, 'other', '2026-11-15', 'longDay', 'Long List');
        off(s, 'req', '2026-11-15');
        return { p, s, request: stage2Request('req') };
      };
      const { a, b } = runWithStaffOrder(ids, build);
      for (const result of [a, b]) {
        expect(returnDatesInPlans(result.plans, 'good')).toContain(validReturn);
        expect(returnDatesInPlans(result.plans, 'bad')).not.toContain(invalidReturn);
      }
      expect(directKeysFromResult(a.plans)).toEqual(directKeysFromResult(b.plans));
    });
  });

  describe('3. Shown plans and validate()', () => {
    it('returns cover-b 2026-11-14 with a 72-hour alert for cover-b', () => {
      const p = stage2Profile(['req', 'cover-a', 'cover-b'], ['Long List', 'Night List']);
      applyDefaultLimitRules(p);
      const s = blankSnapshot(['req', 'cover-a', 'cover-b']);
      work(s, 'req', STAGE2_MONDAY, 'longDay', 'Long List');
      off(s, 'cover-a', STAGE2_MONDAY);
      off(s, 'cover-b', STAGE2_MONDAY);
      work(s, 'cover-a', '2026-11-10', 'longDay', 'Long List');
      off(s, 'req', '2026-11-10');
      for (let i = 1; i <= 4; i++) work(s, 'cover-b', addDays(STAGE2_MONDAY, i), 'night', 'Night List');
      work(s, 'cover-b', '2026-11-07', 'longDay', 'Long List');
      work(s, 'cover-b', '2026-11-14', 'longDay', 'Long List');
      off(s, 'req', '2026-11-07');
      off(s, 'req', '2026-11-14');
      const settings = stage2Settings({ maxChain: 2 });
      const req = stage2Request('req');
      const result = findSwaps(p, s, settings, req);
      const plan = result.plans.find(entry => entry.chains.some(chain =>
        chain.links.some(link => link.staffId === 'cover-b' && link.gives.dates[0] === '2026-11-14'),
      ));
      expect(plan).toBeDefined();
      expect(plan!.alerts?.some(alert => alert.staffId === 'cover-b' && /72 hours in 7 days/i.test(alert.message))).toBe(true);
      assertEveryReturnedPlan(buildTestContext(p, s, settings, req)!, result.plans);
    });

    it('adds no new rejecting breach for every returned plan (fixed: [], zero days removed on take)', () => {
      const p = stage2Profile(['req', 'cover-a', 'cover-b'], ['Long List']);
      const s = blankSnapshot(['req', 'cover-a', 'cover-b']);
      work(s, 'req', STAGE2_MONDAY, 'longDay', 'Long List');
      off(s, 'cover-a', STAGE2_MONDAY);
      off(s, 'cover-b', STAGE2_MONDAY);
      work(s, 'cover-a', '2026-11-10', 'longDay', 'Long List');
      off(s, 'req', '2026-11-10');
      work(s, 'cover-b', '2026-11-12', 'longDay', 'Long List');
      off(s, 'req', '2026-11-12');
      const settings = stage2Settings();
      const result = findSwaps(p, s, settings, stage2Request('req'));
      assertEveryReturnedPlan(buildTestContext(p, s, settings, stage2Request('req'))!, result.plans);
    });

    it('allows a moved doctor-attached breach when the swap does not add a new one', () => {
      const p = stage2Profile(['req', 'cover-a', 'cover-b'], ['Long List', 'Night List']);
      applyDefaultLimitRules(p);
      const s = blankSnapshot(['req', 'cover-a', 'cover-b']);
      work(s, 'req', STAGE2_MONDAY, 'longDay', 'Long List');
      off(s, 'cover-a', STAGE2_MONDAY);
      off(s, 'cover-b', STAGE2_MONDAY);
      work(s, 'cover-a', '2026-11-10', 'longDay', 'Long List');
      off(s, 'req', '2026-11-10');
      for (let i = 1; i <= 4; i++) work(s, 'cover-b', addDays(STAGE2_MONDAY, i), 'night', 'Night List');
      work(s, 'cover-b', '2026-11-07', 'longDay', 'Long List');
      work(s, 'cover-b', '2026-11-14', 'longDay', 'Long List');
      off(s, 'req', '2026-11-07');
      off(s, 'req', '2026-11-14');
      const settings = stage2Settings({ maxChain: 2 });
      const req = stage2Request('req');
      const result = findSwaps(p, s, settings, req);
      expect(result.plans.some(plan => plan.chains.some(chain =>
        chain.links.some(link => link.staffId === 'cover-b' && link.gives.dates[0] === '2026-11-07'),
      ))).toBe(true);
      assertEveryReturnedPlan(buildTestContext(p, s, settings, req)!, result.plans);
    });

    it('rejects a combined weekend plan but keeps a single-chain plan when returns do not pre-break the rule', () => {
      const sat = '2026-11-07';
      const sun = '2026-11-08';
      const p = stage2Profile(['req', 'solo', 'split-a', 'split-b'], ['Weekend List', 'Clinic List']);
      p.rules.push({
        id: 'solo-max-one-weekend', name: '', type: 'count', hard: true,
        who: { staffIds: ['solo'] }, work: { roleIds: ['role-Weekend List'] }, max: 1,
        period: 'week', unit: 'shifts', days: { weekdays: [5, 6] },
      });
      const s = blankSnapshot(['req', 'solo', 'split-a', 'split-b']);
      work(s, 'req', sat, 'dayJob', 'Weekend List');
      work(s, 'req', sun, 'dayJob', 'Weekend List');
      off(s, 'solo', sat); off(s, 'solo', sun);
      off(s, 'split-a', sat); work(s, 'split-a', sun, 'dayJob', 'Weekend List');
      work(s, 'split-b', sat, 'dayJob', 'Weekend List'); off(s, 'split-b', sun);
      work(s, 'solo', '2026-11-10', 'dayJob', 'Clinic List'); off(s, 'req', '2026-11-10');
      work(s, 'solo', '2026-11-11', 'dayJob', 'Clinic List'); off(s, 'req', '2026-11-11');
      work(s, 'split-a', '2026-11-16', 'dayJob', 'Weekend List'); off(s, 'req', '2026-11-16');
      work(s, 'split-b', '2026-11-17', 'dayJob', 'Weekend List'); off(s, 'req', '2026-11-17');
      const settings = stage2Settings({ weekendDayActivities: ['Weekend List'], maxChain: 2 });
      const weekendReq = (dates: string[]) => stage2Request('req', dates, { includeNormalDays: true });
      const context = buildTestContext(p, s, settings, weekendReq([sat, sun]))!;
      const satClash = findSwaps(p, s, settings, weekendReq([sat, sun])).clashes.find(c => c.dates.includes(sat))!;
      const sunClash = findSwaps(p, s, settings, weekendReq([sat, sun])).clashes.find(c => c.dates.includes(sun))!;
      const soloReturnSat = [...context.unitRecords.values()].find(r => r.unit.staffId === 'solo' && r.unit.dates.includes('2026-11-10'))!;
      const soloReturnSun = [...context.unitRecords.values()].find(r => r.unit.staffId === 'solo' && r.unit.dates.includes('2026-11-11'))!;
      const oneChain: SwapChain[] = [{ links: [{ staffId: 'req', gives: satClash }, { staffId: 'solo', gives: soloReturnSat.unit }], payDifferent: false }];
      const bothChains: SwapChain[] = [
        { links: [{ staffId: 'req', gives: satClash }, { staffId: 'solo', gives: soloReturnSat.unit }], payDifferent: false },
        { links: [{ staffId: 'req', gives: sunClash }, { staffId: 'solo', gives: soloReturnSun.unit }], payDifferent: false },
      ];
      expect(newRejectingBreaches(context, oneChain)).toEqual([]);
      expect(newRejectingBreaches(context, bothChains).length).toBeGreaterThan(0);
      const satOnly = findSwaps(p, s, settings, weekendReq([sat]));
      expect(satOnly.plans.some(plan => plan.chains.length === 1 && plan.chains[0].links[1].staffId === 'solo')).toBe(true);
      const bothDays = findSwaps(p, s, settings, weekendReq([sat, sun]));
      expect(bothDays.plans.some(plan => plan.chains.length === 2 && plan.chains.every(c => c.links[1].staffId === 'solo'))).toBe(false);
      assertEveryReturnedPlan(context, bothDays.plans);
    });
  });

  describe('4. Night blocks', () => {
    it('keeps requester extras out of swaps, splits extra nights from rostered blocks, and excludes locums as candidates', () => {
      const ids = ['req', 'cover', 'locum'];
      const p = stage2Profile(ids, ['Night List', 'Long List']);
      p.staff[2].locum = true;
      const s = blankSnapshot(ids);
      const nights = [STAGE2_MONDAY, addDays(STAGE2_MONDAY, 1), addDays(STAGE2_MONDAY, 2)];
      for (const date of nights) { work(s, 'req', date, 'night', 'Night List'); off(s, 'cover', date); off(s, 'locum', date); }
      const extraNight = addDays(STAGE2_MONDAY, 3);
      work(s, 'req', extraNight, 'night', 'Night List'); s.days.req[extraNight].extra = true;
      work(s, 'cover', '2026-11-17', 'night', 'Night List'); off(s, 'req', '2026-11-17');
      work(s, 'locum', '2026-11-18', 'night', 'Night List'); off(s, 'req', '2026-11-18');
      const result = findSwaps(p, s, stage2Settings({ maxChain: 2 }), stage2Request('req', [addDays(STAGE2_MONDAY, 1)]));
      expect(result.clashes).toHaveLength(1);
      expect(result.clashes[0].dates).toEqual(nights);
      expect(result.extraShiftsToHandBack).toEqual([]); // The extra night is not part of the requested leave dates.
      const extraLeave = findSwaps(p, s, stage2Settings({ maxChain: 2 }), stage2Request('req', [extraNight]));
      expect(extraLeave.extraShiftsToHandBack).toContainEqual({ date: extraNight, activity: 'Night List' });
      expect(result.plans.every(plan => plan.chains.every(chain => chain.links[1].staffId !== 'locum'))).toBe(true);
    });

    it('does not offer a colleague extra shift as a return unit', () => {
      const p = stage2Profile(['req', 'cover'], ['Long List']);
      const s = blankSnapshot(['req', 'cover']);
      work(s, 'req', STAGE2_MONDAY, 'longDay', 'Long List'); off(s, 'cover', STAGE2_MONDAY);
      const extraDate = '2026-11-10';
      work(s, 'cover', extraDate, 'longDay', 'Long List'); s.days.cover[extraDate].extra = true; off(s, 'req', extraDate);
      const result = findSwaps(p, s, stage2Settings({ maxChain: 2 }), stage2Request('req'));
      expect(result.plans).toEqual([]);
      expect(result.ruledOut.find(item => item.staffId === 'cover')?.reason).not.toMatch(/dates \(Long List\)/);
    });

    it('rejects a mandatory extra rest-day shift and alerts on a recommended extra rest-day shift', () => {
      const ids = ['req', 'cover', 'extra-worker'];
      const p = stage2Profile(ids, ['Night List', 'Long List']);
      const s = blankSnapshot(ids);
      const nights = [STAGE2_MONDAY, addDays(STAGE2_MONDAY, 1), addDays(STAGE2_MONDAY, 2)];
      for (const date of nights) { work(s, 'req', date, 'night', 'Night List'); off(s, 'cover', date); off(s, 'extra-worker', date); }
      work(s, 'cover', '2026-11-20', 'night', 'Night List'); off(s, 'req', '2026-11-20');
      const mandatoryDate = addDays(STAGE2_MONDAY, 4);
      // The receiving doctor's separate block ends the day before the extra shift.
      const returnNights = [addDays(STAGE2_MONDAY, 5), addDays(STAGE2_MONDAY, 6), addDays(STAGE2_MONDAY, 7)];
      for (const date of returnNights) { work(s, 'extra-worker', date, 'night', 'Night List'); off(s, 'req', date); }
      work(s, 'extra-worker', mandatoryDate, 'longDay', 'Long List'); s.days['extra-worker'][mandatoryDate].extra = true;
      const request = stage2Request('req', [addDays(STAGE2_MONDAY, 1)]);
      const mandatory = findSwaps(p, s, stage2Settings({ maxChain: 2 }), request);
      expect(mandatory.plans.every(plan => !plan.chains.some(item => item.links.some(link => link.gives.dates.includes(mandatoryDate))))).toBe(true);
      expect(extraNightRestDisposition(true).reject).toMatch(/mandatory rest-day extra shift/);

      s.days['extra-worker'][mandatoryDate].status = 'zero';
      const recommendedDate = addDays(STAGE2_MONDAY, 8);
      work(s, 'extra-worker', recommendedDate, 'longDay', 'Long List'); s.days['extra-worker'][recommendedDate].extra = true;
      expect(extraNightRestDisposition(false).alert).toMatch(/recommended rest-day extra shift/);
    });

    it('alerts for an extra receiver night before a Friday to Sunday block, but rejects an extra day job inside the block', () => {
      const p = stage2Profile(['req', 'cover'], ['Night List']);
      const s = blankSnapshot(['req', 'cover']);
      const requesterBlock = ['2026-11-06', '2026-11-07', '2026-11-08'];
      const receiverBlock = ['2026-11-13', '2026-11-14', '2026-11-15'];
      for (const date of requesterBlock) { work(s, 'req', date, 'night', 'Night List'); off(s, 'cover', date); }
      for (const date of receiverBlock) { work(s, 'cover', date, 'night', 'Night List'); off(s, 'req', date); }
      const extraNight = '2026-11-05';
      work(s, 'cover', extraNight, 'night', 'Night List');
      s.days.cover[extraNight].extra = true;
      const request = stage2Request('req', requesterBlock);
      const settings = stage2Settings({ maxChain: 2 });
      const withExtraNight = findSwaps(p, s, settings, request);
      const offered = withExtraNight.plans.find(plan => plan.chains.some(chain => chain.links.some(link => link.staffId === 'cover' && link.gives.dates.join() === receiverBlock.join())));
      expect(offered).toBeDefined();
      expect(offered!.alerts?.some(alert => alert.staffId === 'cover' && alert.message === 'The night block runs into existing nights')).toBe(true);
      expect(offered!.warnings).toEqual([]);
      const requesterUnit: SwapUnit = { staffId: 'req', kind: 'nightBlock', dates: requesterBlock, activity: 'Night List', dayType: 'weekend', hours: 36 };
      const receiverUnit: SwapUnit = { ...requesterUnit, staffId: 'cover', dates: receiverBlock };
      const chain: SwapChain = { links: [{ staffId: 'req', gives: requesterUnit }, { staffId: 'cover', gives: receiverUnit }], payDifferent: false };
      const packageWithExtraNight = nightPackageForChains([chain], s, settings, request, p);
      expect(packageWithExtraNight.rejectReason).toBeUndefined();
      expect(packageWithExtraNight.alerts).toContainEqual({ staffId: 'cover', date: extraNight, message: 'The night block runs into existing nights' });

      work(s, 'cover', '2026-11-07', 'dayJob', 'Night List');
      s.days.cover['2026-11-07'].extra = true;
      const withBlockExtra = findSwaps(p, s, settings, request);
      expect(withBlockExtra.plans.some(plan => plan.chains.some(chain => chain.links.some(link => link.staffId === 'cover' && link.gives.dates.join() === receiverBlock.join())))).toBe(false);
      expect(nightPackageForChains([chain], s, settings, request, p).rejectReason).toMatch(/mandatory rest-day extra shift/);
    });

    it('does not count the requester extra night on a leave date when validating the next leave day', () => {
      const p = stage2Profile(['req', 'cover'], ['Night List', 'Long List']);
      p.rules = [{ id: 'rest', name: 'Made-up rest rule', type: 'minRest', who: {}, hours: 11, hard: true }];
      const s = blankSnapshot(['req', 'cover']);
      const extraNightDate = '2026-11-04';
      const clashDate = '2026-11-05';
      work(s, 'req', extraNightDate, 'night', 'Night List');
      s.days.req[extraNightDate].extra = true;
      work(s, 'req', clashDate, 'longDay', 'Long List');
      work(s, 'cover', clashDate, 'dayJob', 'Long List');
      s.days.cover[clashDate].sessions = ['am', 'pm'];
      const request = stage2Request('req', [extraNightDate, clashDate]);
      const validationAssignments = assignmentsForSwapValidation([
        { staffId: 'req', date: extraNightDate, shiftTypeId: 'night' },
        { staffId: 'req', date: clashDate, shiftTypeId: 'long' },
        { staffId: 'cover', date: extraNightDate, shiftTypeId: 'night' },
      ], s, request);
      expect(validationAssignments).toEqual([
        { staffId: 'req', date: clashDate, shiftTypeId: 'long' },
        { staffId: 'cover', date: extraNightDate, shiftTypeId: 'night' },
      ]);
      const result = findSwaps(p, s, stage2Settings({ minDoctors: [0, 0, 0, 0, 0, 0, 0], minDoctorsBankHoliday: 0, maxChain: 2 }), request);
      expect(result.extraShiftsToHandBack).toContainEqual({ date: extraNightDate, activity: 'Night List' });
      expect(result.plans.some(plan => plan.chains.some(chain => chain.sameDay && chain.links.some(link => link.staffId === 'cover')))).toBe(true);
    });

    it('clashes on any night in a block and moves the whole block at equal length only', () => {
      const p = stage2Profile(['req', 'cover-a', 'cover-b'], ['Night List']);
      const s = blankSnapshot(['req', 'cover-a', 'cover-b']);
      const nights = [STAGE2_MONDAY, addDays(STAGE2_MONDAY, 1), addDays(STAGE2_MONDAY, 2)];
      for (const d of nights) { work(s, 'req', d, 'night', 'Night List'); off(s, 'cover-a', d); off(s, 'cover-b', d); }
      for (const d of nights) { work(s, 'cover-a', addDays(d, 7), 'night', 'Night List'); off(s, 'req', addDays(d, 7)); }
      for (let i = 0; i < 2; i++) work(s, 'cover-b', addDays('2026-11-20', i), 'night', 'Night List');
      const leaveNight = addDays(STAGE2_MONDAY, 1);
      const result = findSwaps(p, s, stage2Settings({ maxChain: 2 }), stage2Request('req', [leaveNight]));
      expect(result.clashes).toHaveLength(1);
      expect(result.clashes[0].dates).toEqual(nights);
      expect(result.plans.every(plan => plan.chains.every(chain => chain.links[1].gives.dates.length === 3))).toBe(true);
      expect(result.plans.some(plan => plan.chains.some(chain => chain.links[1].staffId === 'cover-b'))).toBe(false);
    });
  });

  describe('5. Off rules', () => {
    it('treats Zero Day as off and a blank bank holiday as off only when in post that week', () => {
      const p = stage2Profile(['req', 'in-post', 'out-post'], ['Long List']);
      const s = blankSnapshot(['req', 'in-post', 'out-post']);
      const bh = STAGE2_MONDAY;
      work(s, 'req', bh, 'longDay', 'Long List');
      work(s, 'in-post', addDays(bh, 3), 'training', 'Study');
      work(s, 'in-post', '2026-11-10', 'longDay', 'Long List');
      off(s, 'req', '2026-11-10');
      work(s, 'out-post', '2026-11-17', 'longDay', 'Long List');
      off(s, 'req', '2026-11-17');
      const settings = stage2Settings({ bankHolidays: [bh] });
      const result = findSwaps(p, s, settings, stage2Request('req', [bh]));
      expect(result.plans.some(plan => plan.chains.some(c => c.links[1].staffId === 'in-post'))).toBe(true);
      expect(result.plans.some(plan => plan.chains.some(c => c.links[1].staffId === 'out-post'))).toBe(false);
    });

    it('rules out leave, blank, regular day off and excluded cover', () => {
      const ids = ['req', 'on-leave', 'blank-day', 'regular-off', 'excluded'];
      const p = stage2Profile(ids, ['Long List']);
      const s = blankSnapshot(ids);
      work(s, 'req', STAGE2_MONDAY, 'longDay', 'Long List');
      setDay(s, 'on-leave', STAGE2_MONDAY, 'leave', 'Leave');
      setDay(s, 'blank-day', STAGE2_MONDAY, 'blank');
      off(s, 'regular-off', STAGE2_MONDAY);
      off(s, 'excluded', STAGE2_MONDAY);
      for (const [id, ret] of [['on-leave', '2026-11-10'], ['blank-day', '2026-11-11'], ['regular-off', '2026-11-12'], ['excluded', '2026-11-13']] as const) {
        work(s, id, ret, 'longDay', 'Long List');
        off(s, 'req', ret);
      }
      const settings = stage2Settings({
        regularDaysOff: { 'regular-off': [weekday(STAGE2_MONDAY)] },
        excluded: [{ staffId: 'excluded' }],
      });
      const result = findSwaps(p, s, settings, stage2Request('req', [STAGE2_MONDAY]));
      expect(result.plans).toEqual([]);
      expect(result.ruledOut.find(r => r.staffId === 'blank-day')).toMatchObject({
        group: 'notOnRota',
        reason: 'Not on the rota on these dates',
      });
      expect(result.ruledOut.find(r => r.staffId === 'regular-off')?.reason).toMatch(/regular day off/i);
      expect(result.ruledOut.find(r => r.staffId === 'excluded')?.reason).toMatch(/excluded/i);
    });

    it('blocks a return shift on the requester cant-work list', () => {
      const p = stage2Profile(['req', 'would-cover'], ['Long List']);
      const s = blankSnapshot(['req', 'would-cover']);
      const cantWork = '2026-11-10';
      work(s, 'req', STAGE2_MONDAY, 'longDay', 'Long List');
      off(s, 'would-cover', STAGE2_MONDAY);
      work(s, 'would-cover', cantWork, 'longDay', 'Long List');
      off(s, 'req', cantWork);
      const without = findSwaps(p, s, stage2Settings({ maxChain: 2 }), stage2Request('req', [STAGE2_MONDAY]));
      expect(without.plans.some(plan => plan.chains[0].links[1].staffId === 'would-cover')).toBe(true);
      const blocked = findSwaps(p, s, stage2Settings({ maxChain: 2 }), stage2Request('req', [STAGE2_MONDAY], { cantWorkDates: [cantWork] }));
      expect(blocked.plans).toEqual([]);
      expect(blocked.ruledOut.find(r => r.staffId === 'would-cover')?.reason).toMatch(/leave or can’t-work/i);
    });
  });

  describe('6. Pay labels', () => {
    it('labels weekday returns, not weekend-to-bank-holiday, including 3- and 4-person chains', () => {
      const sat = '2026-11-07';
      const bh = '2026-11-11';
      const p2 = stage2Profile(['req', 'wk', 'wd'], ['Weekend List', 'Clinic List']);
      const s2 = blankSnapshot(['req', 'wk', 'wd']);
      work(s2, 'req', sat, 'dayJob', 'Weekend List');
      off(s2, 'wk', sat); off(s2, 'wd', sat);
      work(s2, 'wk', addDays(sat, 7), 'dayJob', 'Weekend List'); off(s2, 'req', addDays(sat, 7));
      work(s2, 'wd', '2026-11-10', 'dayJob', 'Clinic List'); off(s2, 'req', '2026-11-10');
      const direct = findSwaps(p2, s2, stage2Settings({ weekendDayActivities: ['Weekend List'], bankHolidays: [bh], maxChain: 2 }), stage2Request('req', [sat], { includeNormalDays: true }));
      expect(direct.plans.find(plan => plan.chains[0].links[1].staffId === 'wk')?.chains[0].payDifferent).toBe(false);
      expect(direct.plans.find(plan => plan.chains[0].links[1].staffId === 'wd')?.chains[0].payDifferent).toBe(true);

      const p3 = stage2Profile(['req', 'b', 'c'], ['Long List']);
      const s3 = blankSnapshot(['req', 'b', 'c']);
      work(s3, 'req', sat, 'longDay', 'Long List');
      off(s3, 'b', sat); off(s3, 'c', sat);
      work(s3, 'b', '2026-11-10', 'longDay', 'Long List'); off(s3, 'c', '2026-11-10');
      work(s3, 'c', addDays(sat, 7), 'longDay', 'Long List'); off(s3, 'req', addDays(sat, 7));
      const three = findSwaps(p3, s3, stage2Settings({ maxChain: 3 }), stage2Request('req', [sat]));
      const chain3 = three.plans.flatMap(plan => plan.chains).find(c => c.links.length === 3);
      expect(chain3?.payDifferent).toBe(true);

      const p4 = stage2Profile(['req', 'b', 'c', 'd'], ['Long List']);
      const s4 = blankSnapshot(['req', 'b', 'c', 'd']);
      work(s4, 'req', sat, 'longDay', 'Long List');
      const rets = ['2026-11-10', '2026-11-18', '2026-11-26'];
      off(s4, 'b', sat);
      work(s4, 'b', rets[0], 'longDay', 'Long List'); off(s4, 'c', rets[0]);
      work(s4, 'c', rets[1], 'longDay', 'Long List'); off(s4, 'd', rets[1]);
      work(s4, 'd', rets[2], 'longDay', 'Long List'); off(s4, 'req', rets[2]);
      const four = findSwaps(p4, s4, stage2Settings({ maxChain: 4 }), stage2Request('req', [sat]));
      const chain4 = four.plans.flatMap(plan => plan.chains).find(c => c.links.length === 4);
      expect(chain4?.payDifferent).toBe(true);

      const p4wk = stage2Profile(['req', 'b', 'c', 'd'], ['Long List']);
      const s4wk = blankSnapshot(['req', 'b', 'c', 'd']);
      const sun = addDays(sat, 1);
      work(s4wk, 'req', sat, 'longDay', 'Long List');
      off(s4wk, 'b', sat);
      work(s4wk, 'b', sun, 'longDay', 'Long List'); off(s4wk, 'c', sun);
      work(s4wk, 'c', addDays(sun, 7), 'longDay', 'Long List'); off(s4wk, 'd', addDays(sun, 7));
      work(s4wk, 'd', addDays(sun, 14), 'longDay', 'Long List'); off(s4wk, 'req', addDays(sun, 14));
      const fourWk = findSwaps(p4wk, s4wk, stage2Settings({ maxChain: 4 }), stage2Request('req', [sat]));
      const chain4wk = fourWk.plans.flatMap(plan => plan.chains).find(c => c.links.length === 4);
      expect(chain4wk?.payDifferent).toBe(false);

      const pBh = stage2Profile(['req', 'wk-cover', 'bh-cover'], ['Weekend List']);
      const sBh = blankSnapshot(['req', 'wk-cover', 'bh-cover']);
      work(sBh, 'req', sat, 'dayJob', 'Weekend List');
      off(sBh, 'wk-cover', sat); off(sBh, 'bh-cover', sat);
      work(sBh, 'wk-cover', addDays(sat, 7), 'dayJob', 'Weekend List'); off(sBh, 'req', addDays(sat, 7));
      work(sBh, 'bh-cover', bh, 'dayJob', 'Weekend List'); off(sBh, 'req', bh);
      const bhSwap = findSwaps(pBh, sBh, stage2Settings({ weekendDayActivities: ['Weekend List'], bankHolidays: [bh], maxChain: 2 }), stage2Request('req', [sat]));
      expect(bhSwap.plans.find(plan => plan.chains[0].links[1].staffId === 'bh-cover')?.chains[0].payDifferent).toBe(false);
    });
  });

  describe('7. Ranking and limits', () => {
    it('ranks full cover above partial, prefers fewer people, and merges identical people-and-shift plans', () => {
      const sat = '2026-11-07';
      const sun = '2026-11-08';
      const p = stage2Profile(['req', 'solo', 'split-a', 'split-b'], ['Weekend List']);
      const s = blankSnapshot(['req', 'solo', 'split-a', 'split-b']);
      work(s, 'req', sat, 'dayJob', 'Weekend List');
      work(s, 'req', sun, 'dayJob', 'Weekend List');
      off(s, 'solo', sat); off(s, 'solo', sun);
      off(s, 'split-a', sat); work(s, 'split-a', sun, 'dayJob', 'Weekend List');
      work(s, 'split-b', sat, 'dayJob', 'Weekend List'); off(s, 'split-b', sun);
      work(s, 'solo', '2026-11-14', 'dayJob', 'Weekend List'); off(s, 'req', '2026-11-14');
      work(s, 'split-a', '2026-11-15', 'dayJob', 'Weekend List'); off(s, 'req', '2026-11-15');
      work(s, 'split-b', '2026-11-16', 'dayJob', 'Weekend List'); off(s, 'req', '2026-11-16');
      const settings = stage2Settings({ weekendDayActivities: ['Weekend List'], maxChain: 2 });
      const result = findSwaps(p, s, settings, stage2Request('req', [sat, sun]));
      const fullIdx = result.plans.findIndex(plan => plan.cleared.length === 2);
      const partialIdx = result.plans.findIndex(plan => plan.cleared.length === 1);
      expect(fullIdx).toBeLessThan(partialIdx);
      expect(result.plans.some(plan => plan.people === 2)).toBe(true);
      const exchangeKeys = result.plans.map(plan => {
        const people = [...new Set(plan.chains.flatMap(chain => chain.links.map(link => link.staffId)))].sort().join(',');
        const shifts = [...new Set(plan.chains.flatMap(chain => chain.links.map(link => `${link.staffId}:${link.gives.dates.join('+')}`)))].sort().join(',');
        return `${people}:${shifts}`;
      });
      expect(new Set(exchangeKeys).size).toBe(exchangeKeys.length);

      const mirrorSat = '2026-11-07';
      const mirrorSun = '2026-11-08';
      const pm = stage2Profile(['req', 'solo-mirror'], ['Weekend List']);
      const sm = blankSnapshot(['req', 'solo-mirror']);
      work(sm, 'req', mirrorSat, 'dayJob', 'Weekend List');
      work(sm, 'req', mirrorSun, 'dayJob', 'Weekend List');
      off(sm, 'solo-mirror', mirrorSat);
      off(sm, 'solo-mirror', mirrorSun);
      work(sm, 'solo-mirror', '2026-11-14', 'dayJob', 'Weekend List');
      work(sm, 'solo-mirror', '2026-11-15', 'dayJob', 'Weekend List');
      off(sm, 'req', '2026-11-14');
      off(sm, 'req', '2026-11-15');
      const mirrorResult = findSwaps(pm, sm, stage2Settings({ weekendDayActivities: ['Weekend List'], maxChain: 2 }), stage2Request('req', [mirrorSat, mirrorSun]));
      const wholeWeekendPlans = mirrorResult.plans.filter(plan => plan.wholeWeekend);
      expect(wholeWeekendPlans).toHaveLength(1);

      const pAlert = stage2Profile(['req', 'cover-a', 'cover-b'], ['Long List', 'Night List']);
      applyDefaultLimitRules(pAlert);
      const sAlert = blankSnapshot(['req', 'cover-a', 'cover-b']);
      work(sAlert, 'req', STAGE2_MONDAY, 'longDay', 'Long List');
      off(sAlert, 'cover-a', STAGE2_MONDAY);
      off(sAlert, 'cover-b', STAGE2_MONDAY);
      work(sAlert, 'cover-a', '2026-11-10', 'longDay', 'Long List');
      off(sAlert, 'req', '2026-11-10');
      for (let i = 1; i <= 4; i++) work(sAlert, 'cover-b', addDays(STAGE2_MONDAY, i), 'night', 'Night List');
      work(sAlert, 'cover-b', '2026-11-07', 'longDay', 'Long List');
      work(sAlert, 'cover-b', '2026-11-14', 'longDay', 'Long List');
      off(sAlert, 'req', '2026-11-07');
      off(sAlert, 'req', '2026-11-14');
      const alertResult = findSwaps(pAlert, sAlert, stage2Settings({ maxChain: 2 }), stage2Request('req'));
      const cleanIdx = alertResult.plans.findIndex(plan => plan.chains[0].links[1].staffId === 'cover-a');
      const heavyIdx = alertResult.plans.findIndex(plan =>
        plan.chains[0].links[1].staffId === 'cover-b' && (plan.alerts?.length ?? 0) > 0,
      );
      expect(cleanIdx).toBeGreaterThanOrEqual(0);
      expect(heavyIdx).toBeGreaterThanOrEqual(0);
      expect(alertResult.plans[cleanIdx].alerts ?? []).toHaveLength(0);
      expect(cleanIdx).toBeLessThan(heavyIdx);

      const small = findSwaps(p, s, settings, stage2Request('req', [sat]));
      expect(small.truncated).toBe(false);
    });

    it('pages direct plans separately and sets truncated when more exist', () => {
      const coverCount = 105;
      const ids = ['req', ...Array.from({ length: coverCount }, (_, i) => `cover-${i}`)];
      const p = stage2Profile(ids, ['Long List']);
      const s = blankSnapshot(ids, 20);
      work(s, 'req', STAGE2_MONDAY, 'longDay', 'Long List');
      for (let i = 0; i < coverCount; i++) {
        off(s, `cover-${i}`, STAGE2_MONDAY);
        const ret = addDays(STAGE2_MONDAY, 7 + i);
        work(s, `cover-${i}`, ret, 'longDay', 'Long List');
        off(s, 'req', ret);
      }
      const base = stage2Request('req');
      const firstPage = findSwaps(p, s, stage2Settings({ maxChain: 2 }), base);
      expect(firstPage.truncated).toBe(true);
      expect(firstPage.plans).toHaveLength(50);
      expect(firstPage.morePlanSizes).toContain(2);
      const secondPage = findSwaps(p, s, stage2Settings({ maxChain: 2 }), { ...base, planLimits: { 2: 100 } });
      expect(secondPage.plans.slice(0, 50).map(plan => plan.chains)).toEqual(firstPage.plans.map(plan => plan.chains));
      expect(secondPage.plans.length).toBeGreaterThan(50);
    });
  });

  describe('8. Longer chains', () => {
    const fourPersonFixture = () => {
      const ids = ['req', ...Array.from({ length: 9 }, (_, index) => [`cover-${index}`, `mid-${index}`, `ret-${index}`]).flat()];
      const p = stage2Profile(ids, ['Long List']);
      p.rules.push({
        id: 'block-first-eight', name: 'Block first eight covers', type: 'forbid', hard: true,
        who: { staffIds: Array.from({ length: 8 }, (_, i) => `cover-${i}`) },
        work: { roleIds: ['role-Long List'] }, days: { dates: [STAGE2_MONDAY] },
      });
      const s = blankSnapshot(ids, 20);
      work(s, 'req', STAGE2_MONDAY, 'longDay', 'Long List');
      for (let index = 0; index < 9; index++) {
        const first = addDays(STAGE2_MONDAY, 7 + index * 3);
        const second = addDays(first, 1);
        const third = addDays(first, 2);
        off(s, `cover-${index}`, STAGE2_MONDAY);
        work(s, `cover-${index}`, first, 'longDay', 'Long List');
        off(s, `mid-${index}`, first);
        work(s, `mid-${index}`, second, 'longDay', 'Long List');
        off(s, `ret-${index}`, second);
        work(s, `ret-${index}`, third, 'longDay', 'Long List');
        off(s, 'req', third);
      }
      return { p, s };
    };

    it('exhausts the 3-person search without a 4-person chain, then finds cover-8 at maxChain 4', () => {
      const { p, s } = fourPersonFixture();
      const req = stage2Request('req');
      const three = findSwaps(p, s, stage2Settings({ maxChain: 3 }), req);
      const four = findSwaps(p, s, stage2Settings({ maxChain: 4 }), req);
      expect(three.plans.some(plan => plan.chains.some(c => c.links.length === 4))).toBe(false);
      expect(three.plans.some(plan => plan.chains.some(c => c.links[1]?.staffId === 'cover-8'))).toBe(false);
      expect(three.truncated || three.plans.length === 0).toBe(true);
      expect(four.plans.some(plan => plan.chains.some(chain => chain.links.length === 4 && chain.links[1].staffId === 'cover-8'))).toBe(true);
    });

    it('reaches a farther valid return before a nearer rule-breaking one under search order', () => {
      const validReturn = '2026-11-10';
      const invalidReturn = '2026-11-06';
      const farReturn = addDays(STAGE2_MONDAY, 21);
      const build = (order: string[]) => {
        const p = stage2Profile(order, ['Long List'], [{
          id: 'near-no-monday', name: '', type: 'forbid', hard: true,
          who: { staffIds: ['near-bad'] }, work: { roleIds: ['role-Long List'] }, days: { dates: [STAGE2_MONDAY] },
        }]);
        const s = blankSnapshot(order, 10);
        work(s, 'req', STAGE2_MONDAY, 'longDay', 'Long List');
        off(s, 'near-valid', STAGE2_MONDAY);
        off(s, 'near-bad', STAGE2_MONDAY);
        off(s, 'far-good', STAGE2_MONDAY);
        work(s, 'near-valid', validReturn, 'longDay', 'Long List');
        off(s, 'req', validReturn);
        work(s, 'near-bad', invalidReturn, 'longDay', 'Long List');
        off(s, 'req', invalidReturn);
        work(s, 'far-good', farReturn, 'longDay', 'Long List');
        off(s, 'req', farReturn);
        return { p, s, request: stage2Request('req') };
      };
      const { a, b } = runWithStaffOrder(['req', 'near-valid', 'near-bad', 'far-good'], build);
      for (const result of [a, b]) {
        expect(result.plans.some(plan => plan.chains[0].links[1].staffId === 'far-good')).toBe(true);
        expect(returnDatesInPlans(result.plans, 'near-valid')).toContain(validReturn);
        expect(returnDatesInPlans(result.plans, 'near-bad')).not.toContain(invalidReturn);
      }
      expect(directKeysFromResult(a.plans)).toEqual(directKeysFromResult(b.plans));
    });
  });

  describe('9. Ruled-out reasons under plan cap', () => {
    it('does not claim no chain exists when valid chains were cut by the 100-plan limit', () => {
      const coverCount = 105;
      const ids = ['req', ...Array.from({ length: coverCount }, (_, i) => `cover-${i}`)];
      const p = stage2Profile(ids, ['Long List']);
      const s = blankSnapshot(ids, 20);
      work(s, 'req', STAGE2_MONDAY, 'longDay', 'Long List');
      for (let i = 0; i < coverCount; i++) {
        off(s, `cover-${i}`, STAGE2_MONDAY);
        const ret = addDays(STAGE2_MONDAY, 7 + i);
        work(s, `cover-${i}`, ret, 'longDay', 'Long List');
        off(s, 'req', ret);
      }
      const settings = stage2Settings({ maxChain: 2 });
      const req = stage2Request('req');
      const result = findSwaps(p, s, settings, req);
      const brute = enumerateDirectSwaps(p, s, settings, req, result.clashes);
      expect([...brute.signatures.keys()].some(key => key.startsWith('cover-104:'))).toBe(true);
      expect(result.truncated).toBe(true);
      const last = result.ruledOut.find(r => r.staffId === 'cover-104');
      expect(last).toBeDefined();
      expect(last!.reason).not.toBe('No compatible return shifts complete a valid chain.');
    });
  });

  describe('10. No side effects', () => {
    it('does not mutate profile, snapshot or settings', () => {
      const p = stage2Profile(['req', 'cover-a'], ['Long List']);
      const s = blankSnapshot(['req', 'cover-a']);
      work(s, 'req', STAGE2_MONDAY, 'longDay', 'Long List');
      off(s, 'cover-a', STAGE2_MONDAY);
      work(s, 'cover-a', '2026-11-10', 'longDay', 'Long List');
      off(s, 'req', '2026-11-10');
      const settings = stage2Settings();
      const before = structuredClone({ p, s, settings });
      findSwaps(p, s, settings, stage2Request('req'));
      expect({ p, s, settings }).toEqual(before);
    });
  });
});

describe.skipIf(!ROTA_PAGES_DIR || !ROTA_REQUESTER_NAME || !ROTA_LEAVE_DATES)('Stage 2 real-data checks (ROTA_PAGES_DIR)', () => {
  it('prints counts only: plans, alerts, rejecting breaches, alert mismatches, receivers off, duplicate shifts', () => {
    const weeks = readdirSync(ROTA_PAGES_DIR!).filter(n => /\.html?$/i.test(n)).sort().flatMap(name => {
      const html = readFileSync(join(ROTA_PAGES_DIR!, name), 'utf8');
      if (isActivityWeek(html) || !isPersonWeek(html)) return [];
      return [parsePersonWeek(html)];
    }).sort((a, b) => a.start.localeCompare(b.start));
    expect(weeks.length).toBeGreaterThan(0);

    const ws = emptyWorkspace();
    applyImport(ws, planImport(ws, weeks, []));
    const profile = ws.profile;
    applyDefaultLimitRules(profile);
    const snapshot = ws.swapFinder!.snapshot;
    const settings = ws.swapFinder!.settings;
    const requester = profile.staff.find(s => s.name === ROTA_REQUESTER_NAME)?.id;
    expect(requester, 'requester name from ROTA_REQUESTER_NAME').toBeTruthy();
    const leaveDates = ROTA_LEAVE_DATES!.split(',').map(d => d.trim()).filter(Boolean);
    expect(leaveDates.length, 'ROTA_LEAVE_DATES').toBeGreaterThan(0);

    const request = { staffId: requester!, leaveDates, leaveType: 'annual' as const, today: '2026-08-01' };
    const result = findSwaps(profile, snapshot, settings, request);
    const context = buildTestContext(profile, snapshot, settings, request)!;

    let receiversOff = 0;
    let receiversNotOff = 0;
    let plansWithAlerts = 0;
    let rejectingBreaches = 0;
    let missingAlerts = 0;
    let extraAlerts = 0;
    let duplicateShiftPlans = 0;

    for (const plan of result.plans) {
      if (!shiftsUsedOnce(plan.chains)) duplicateShiftPlans++;
      if (newRejectingBreaches(context, plan.chains).length) rejectingBreaches++;
      const expected = expectedAlertStaff(context, plan.chains);
      const actual = alertStaffOnPlan(plan);
      if (expected.length && !actual.length) missingAlerts++;
      if (!expected.length && actual.length) extraAlerts++;
      if (expected.length && actual.length && expected.join(',') !== actual.join(',')) missingAlerts++;
      if (actual.length) plansWithAlerts++;
      for (const chain of plan.chains) {
        if (receiverOffOnTaken(snapshot, chain, settings, request)) receiversOff++;
        else receiversNotOff++;
      }
    }

    console.log(JSON.stringify({
      personWeekFiles: weeks.length,
      plansReturned: result.plans.length,
      plansWithAlerts,
      rejectingBreaches,
      missingAlerts,
      extraAlerts,
      receiversOff,
      receiversNotOff,
      duplicateShiftPlans,
      truncated: result.truncated,
    }));

    expect(result.plans.length).toBeGreaterThan(0);
    expect(receiversNotOff).toBe(0);
    expect(duplicateShiftPlans).toBe(0);
    expect(rejectingBreaches).toBe(0);
    expect(missingAlerts).toBe(0);
    expect(extraAlerts).toBe(0);
  });
});
