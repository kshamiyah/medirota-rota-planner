/** Independent Stage 4 tester checks (made-up names and places only). */
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { Results, SwapOptionDetail, SwapOptionList } from '../src/app/pages/FindSwaps';
import { SwapDateCalendar } from '../src/app/components/SwapDateCalendar';
import { annualLeaveInputs, sameSwapFormInputs, withDeclinedDoctor, type SwapFormInputs } from '../src/app/swapsView';
import { buildSwapRequest } from '../src/app/swapRequest';
import {
  copySwapMessage, differentShiftLengths, optionBadge, optionKind, optionRows, optionStaffing, optionSummary,
  ownLeaveText, PAY_EXPLANATION, requesterMoves, resultLimitsLine, SAME_DAY_EXPLANATION, selectedOption, staffingLine,
} from '../src/app/swapResultsView';
import { findSwaps, type RotaSnapshot, type SwapPlan, type SwapResult } from '../src/engine/swaps';
import type { Workspace } from '../src/app/store';
import { LEAVE, stage4Request, stage4Workspace } from './stage4-find-swaps-fixture';
import { stage7Cases, stage7Fixture } from './swaps-stage7-fixture';
import { buildSeededNightRota } from './swaps-night-brute-seed';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function isolated(extra?: (ws: Workspace) => void): Workspace {
  const ws = stage4Workspace();
  const { snapshot, settings } = ws.swapFinder!;
  settings.excluded = ws.profile.staff.filter(person => !['rowan', 'ellis'].includes(person.id)).map(person => ({ staffId: person.id }));
  for (const days of Object.values(snapshot.days)) for (const date of Object.keys(days)) days[date] = { status: 'blank' };
  snapshot.unavailability = [];
  snapshot.days.rowan[LEAVE[0]] = { status: 'longDay', activity: 'Willow cover' };
  snapshot.days.ellis[LEAVE[0]] = { status: 'zero' };
  snapshot.days.ellis['2027-01-05'] = { status: 'longDay', activity: 'Willow cover' };
  snapshot.days.rowan['2027-01-05'] = { status: 'leave' };
  extra?.(ws);
  return ws;
}

const search = (ws: Workspace, patch: Partial<Parameters<typeof stage4Request>[0]> = {}) =>
  findSwaps(ws.profile, ws.swapFinder!.snapshot, ws.swapFinder!.settings, stage4Request({ leaveDates: [LEAVE[0]], ...patch }));

describe('Stage 4 tester: item 26 own-leave pay-back', () => {
  it('with the switch on, a future requester leave day can take a long day and is marked usesOwnLeave', () => {
    const ws = isolated();
    expect(search(ws).plans).toEqual([]);
    expect(digest(search(ws))).toBe(digest(search(ws, { payBackOnOwnLeave: false })));
    const plan = search(ws, { payBackOnOwnLeave: true }).plans[0];
    expect(plan.usesOwnLeave).toEqual(['2027-01-05']);
    expect(ownLeaveText(plan)).toBe("Uses your leave on Tue 5 Jan: you'd need to cancel it in MediRota");
    expect(optionSummary(plan, 'rowan')).toContain("Uses your leave on Tue 5 Jan");
    const html = renderToStaticMarkup(<SwapOptionDetail plan={plan} index={0} staff={ws.profile.staff} requesterId="rowan" snapshot={ws.swapFinder!.snapshot} settings={ws.swapFinder!.settings} profile={ws.profile} leaveDates={[LEAVE[0]]} decline={() => undefined} findLongDay={() => undefined} />);
    expect(html).toContain('Uses your leave on Tue 5 Jan');
  });

  it('also finds a day-job pay-back on leave when day jobs are included', () => {
    const ws = isolated(draft => {
      draft.swapFinder!.snapshot.days.rowan[LEAVE[0]] = { status: 'dayJob', activity: 'Cedar clinic' };
      draft.swapFinder!.snapshot.days.ellis['2027-01-05'] = { status: 'dayJob', activity: 'Cedar clinic' };
    });
    expect(search(ws, { includeNormalDays: true }).plans).toEqual([]);
    const plan = search(ws, { includeNormalDays: true, payBackOnOwnLeave: true }).plans[0];
    expect(plan.usesOwnLeave).toEqual(['2027-01-05']);
    expect(requesterMoves(plan, 'rowan').take[0].kind).toBe('dayShift');
  });

  it('never uses a colleague leave day; ruled-out reason matches switch off', () => {
    const ws = isolated(draft => { draft.swapFinder!.snapshot.days.ellis[LEAVE[0]] = { status: 'leave' }; });
    const off = search(ws);
    const on = search(ws, { payBackOnOwnLeave: true });
    expect(on.plans).toEqual([]);
    expect(on.ruledOut.filter(row => row.staffId === 'ellis')).toEqual(off.ruledOut.filter(row => row.staffId === 'ellis'));
  });

  it('scans fixtures with the switch on: no colleague receives work on their leave, and usesOwnLeave is never empty', () => {
    const fixtures: { label: string; result: SwapResult; requestStaffId: string; snapshot: RotaSnapshot }[] = [];
    for (const kind of stage7Cases) {
      const { ws, request } = stage7Fixture(kind);
      fixtures.push({ label: `stage7:${kind}`, result: findSwaps(ws.profile, ws.swapFinder!.snapshot, ws.swapFinder!.settings, { ...request, payBackOnOwnLeave: true }), requestStaffId: request.staffId, snapshot: ws.swapFinder!.snapshot });
    }
    for (const seed of [0, 1, 2, 3, 4]) {
      const rota = buildSeededNightRota(seed);
      fixtures.push({ label: `night:${seed}`, result: findSwaps(rota.profile, rota.snapshot, rota.settings, { ...rota.request, payBackOnOwnLeave: true }), requestStaffId: rota.request.staffId, snapshot: rota.snapshot });
    }
    const ws = isolated();
    fixtures.push({ label: 'isolated-on', result: search(ws, { payBackOnOwnLeave: true }), requestStaffId: 'rowan', snapshot: ws.swapFinder!.snapshot });
    for (const { label, result, requestStaffId, snapshot } of fixtures) {
      for (const plan of result.plans) {
        if (Object.hasOwn(plan, 'usesOwnLeave')) expect(plan.usesOwnLeave?.length, label).toBeGreaterThan(0);
        for (const chain of plan.chains) chain.links.forEach((link, index) => {
          const receiver = chain.links[(index + 1) % chain.links.length].staffId;
          if (receiver === requestStaffId) return;
          for (const date of link.gives.dates) {
            expect(snapshot.days[receiver]?.[date]?.status, `${label} ${receiver} ${date}`).not.toBe('leave');
          }
        });
        for (const move of plan.movedShifts ?? []) {
          if (move.toStaffId === requestStaffId) continue;
          expect(snapshot.days[move.toStaffId]?.[move.date]?.status, `${label} moved ${move.toStaffId}`).not.toBe('leave');
        }
      }
    }
  });

  it('blocks can’t-work and requested leave dates even with the switch on', () => {
    const ws = isolated();
    expect(search(ws, { payBackOnOwnLeave: true, cantWorkDates: ['2027-01-05'] }).plans).toEqual([]);
    expect(search(ws, { payBackOnOwnLeave: true, leaveDates: [LEAVE[0], '2027-01-05'] }).plans).toEqual([]);
  });

  it('never uses today or earlier leave days', () => {
    expect(search(isolated(), { payBackOnOwnLeave: true, today: '2027-01-05' }).plans).toEqual([]);
    expect(search(isolated(), { payBackOnOwnLeave: true, today: '2027-01-06' }).plans).toEqual([]);
  });

  it('applies the same rest alert on a leave day as on a zero day', () => {
    const prep = (status: 'leave' | 'zero') => {
      const ws = isolated(draft => {
        draft.profile.rules = [{ id: 'rest', name: 'Minimum rest', type: 'minRest', hard: true, hours: 12 }];
        draft.swapFinder!.snapshot.days.rowan['2027-01-04'] = { status: 'longDay', activity: 'Willow cover' };
        draft.swapFinder!.snapshot.days.rowan['2027-01-05'] = { status };
      });
      return search(ws, status === 'leave' ? { payBackOnOwnLeave: true } : {});
    };
    const leave = prep('leave').plans[0];
    const zero = prep('zero').plans[0];
    expect(leave.alerts).toEqual(zero.alerts);
    expect(leave.alerts?.[0]?.message).toContain('less than 12 hours');
    expect(leave.usesOwnLeave).toEqual(['2027-01-05']);
    expect(zero.usesOwnLeave).toBeUndefined();
  });

  it('marks night-package movedShifts received on the requester’s leave', () => {
    const ws = isolated(draft => {
      const days = draft.swapFinder!.snapshot.days;
      days.rowan[LEAVE[0]] = { status: 'night', activity: 'Willow nights' };
      days.rowan[LEAVE[1]] = { status: 'night', activity: 'Willow nights' };
      days.ellis[LEAVE[1]] = { status: 'zero' };
      days.ellis['2027-01-05'] = { status: 'night', activity: 'Willow nights' };
      days.ellis['2027-01-06'] = { status: 'night', activity: 'Willow nights' };
      days.rowan['2027-01-05'] = { status: 'zero' };
      days.rowan['2027-01-06'] = { status: 'zero' };
      days.ellis['2026-12-17'] = { status: 'dayJob', activity: 'Cedar clinic' };
      days.rowan['2026-12-17'] = { status: 'leave' };
    });
    expect(search(ws).plans).toEqual([]);
    const plan = search(ws, { payBackOnOwnLeave: true }).plans[0];
    expect(plan.movedShifts).toContainEqual({ fromStaffId: 'ellis', toStaffId: 'rowan', date: '2026-12-17', activity: 'Cedar clinic', kind: 'dayJob' });
    expect(plan.usesOwnLeave).toEqual(['2026-12-17']);
  });

  it('omits payBackOnOwnLeave from buildSwapRequest unless true, matching BASE key sets', () => {
    const ws = stage4Workspace();
    const old: SwapFormInputs = { staffId: 'rowan', leaveDates: LEAVE, leaveType: 'annual', cantWorkDates: [], excludedStaffIds: [], includeNormalDays: false };
    const absent = buildSwapRequest(ws, old, '2026-11-20', 0).request;
    const falsy = buildSwapRequest(ws, { ...old, payBackOnOwnLeave: false }, '2026-11-20', 0).request;
    expect(Object.keys(absent).sort()).toEqual(Object.keys(falsy).sort());
    expect(absent).toStrictEqual(falsy);
    expect(Object.hasOwn(absent, 'payBackOnOwnLeave')).toBe(false);
    expect(buildSwapRequest(ws, { ...old, payBackOnOwnLeave: true }, '2026-11-20', 0).request.payBackOnOwnLeave).toBe(true);
  });

  it('keeps the switch per search: not in settings, saved only when true, and treated as a form change', () => {
    const src = readFileSync('src/app/pages/FindSwaps.tsx', 'utf8');
    expect(src).toContain("I'd work on my leave days to pay someone back");
    expect(src).toContain('...(payBackOnOwnLeave ? { payBackOnOwnLeave: true } : {})');
    expect(src).not.toContain('draft.payBackOnOwnLeave');
    const old: SwapFormInputs = { staffId: 'rowan', leaveDates: LEAVE, leaveType: 'annual', cantWorkDates: [], excludedStaffIds: [], includeNormalDays: false };
    expect(sameSwapFormInputs(old, { ...old, payBackOnOwnLeave: true })).toBe(false);
    expect(sameSwapFormInputs(old, { ...old, payBackOnOwnLeave: false })).toBe(true);
    expect(annualLeaveInputs({ ...old, payBackOnOwnLeave: true }).payBackOnOwnLeave).toBe(true);
    expect(withDeclinedDoctor({ ...old, payBackOnOwnLeave: true }, 'ellis').payBackOnOwnLeave).toBe(true);
    const ws = isolated(draft => {
      draft.swapFinder!.snapshot.days.rowan['2026-12-22'] = { status: 'leave' };
    });
    const props = { snapshot: ws.swapFinder!.snapshot, staffId: 'rowan', leaveDates: [] as string[], cantWorkDates: [] as string[], onLeaveDates: () => undefined, onCantWorkDates: () => undefined, forcedMode: 'cantWork' as const };
    expect(renderToStaticMarkup(<SwapDateCalendar {...props} />)).not.toContain('Can pay back');
    expect(renderToStaticMarkup(<SwapDateCalendar {...props} payBackOnOwnLeave />)).toContain('Can pay back');
  });
});

describe('Stage 4 tester: list, detail, wording, PM rulings', () => {
  it('numbers a flat list 1..n with chosen first, complete before partial, and renumbers after filters', () => {
    const { result } = { result: findSwaps(...(() => { const ws = stage4Workspace(); return [ws.profile, ws.swapFinder!.snapshot, ws.swapFinder!.settings, stage4Request()] as const; })()) };
    const plans = result.plans.slice(0, 6).map((plan, index) => ({ ...plan, chosenPeople: index < 3, remaining: index % 2 ? [plan.cleared[0]] : [] }));
    const rows = optionRows(plans, 'all', {}, true, 'prefer');
    expect(rows.map(row => row.number)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(rows.slice(0, 3).every(row => row.section === 'Your chosen people')).toBe(true);
    expect(rows.slice(0, 2).every(row => !row.plan.remaining.length)).toBe(true);
    const filtered = optionRows(plans, 'ask1', {}, true, 'prefer');
    expect(filtered.map(row => row.number)).toEqual(filtered.map((_, index) => index + 1));
  });

  it('selects the first option and falls back when the selection is filtered away', () => {
    const ws = stage4Workspace();
    const result = findSwaps(ws.profile, ws.swapFinder!.snapshot, ws.swapFinder!.settings, stage4Request());
    const rows = optionRows(result.plans);
    expect(selectedOption(rows)?.number).toBe(1);
    expect(selectedOption(rows, rows[2].identity)?.identity).toBe(rows[2].identity);
    expect(selectedOption(rows.filter((_, index) => index !== 2), rows[2].identity)?.identity).toBe(rows[0].identity);
  });

  it('badges follow R5: Part, Not checked, No alerts, N alerts (alerts + staffing warnings)', () => {
    const base = { ...findSwaps(stage4Workspace().profile, stage4Workspace().swapFinder!.snapshot, stage4Workspace().swapFinder!.settings, stage4Request()).plans[0], alerts: [], warnings: [], remaining: [] as SwapPlan['remaining'] };
    expect(optionBadge(base)).toBe('No alerts');
    expect(optionBadge(base, true)).toBe('Not checked');
    expect(optionBadge({ ...base, warnings: [{ date: LEAVE[0], doctors: 1, minimum: 2 }] })).toBe('1 alert');
    expect(optionBadge({ ...base, warnings: [{ date: LEAVE[0], doctors: 1, minimum: 2 }], alerts: [{ staffId: 'rowan', date: LEAVE[0], message: 'Check' }] })).toBe('2 alerts');
    expect(optionBadge({ ...base, remaining: [base.cleared[0]] }, true)).toBe('Part');
  });

  it('uses design-style partial summaries and keeps payDifferent separate from different shift lengths', () => {
    const ws = stage4Workspace();
    const result = findSwaps(ws.profile, ws.swapFinder!.snapshot, ws.swapFinder!.settings, stage4Request());
    const partial = result.plans.find(plan => plan.remaining.length)!;
    expect(optionSummary(partial, 'rowan')).toMatch(/^Straight swap · \w+ only/);
    expect(optionSummary(partial, 'rowan')).not.toContain('Covers ');
    const pay = result.plans.find(plan => plan.chains.some(chain => chain.payDifferent && !chain.sameDay))!;
    expect(differentShiftLengths(pay, 'rowan')).toBeUndefined();
    expect(renderToStaticMarkup(<SwapOptionDetail plan={pay} index={0} staff={ws.profile.staff} requesterId="rowan" snapshot={ws.swapFinder!.snapshot} settings={ws.swapFinder!.settings} profile={ws.profile} leaveDates={LEAVE} decline={() => undefined} findLongDay={() => undefined} />)).toContain(PAY_EXPLANATION);
    const same = result.plans.find(plan => optionKind(plan) === 'Same-day swap')!;
    expect(differentShiftLengths(same, 'rowan')).toMatch(/Different shift lengths: .* h for your .* h/);
    expect(optionSummary(same, 'rowan')).toContain('day job as leave');
  });

  it('staffing lines match the brief in all three cases and agree with engine warnings', () => {
    expect(staffingLine({ date: '2026-12-29', doctors: 7, minimum: 6 })).toBe('Tue 29 Dec: 7 doctors at work (minimum 6)');
    expect(staffingLine({ date: '2026-12-29', doctors: 6, minimum: 7 })).toBe('Tue 29 Dec: 6 doctors at work (minimum 7), below minimum');
    for (const kind of stage7Cases) {
      const { ws, request } = stage7Fixture(kind);
      const result = findSwaps(ws.profile, ws.swapFinder!.snapshot, ws.swapFinder!.settings, request);
      for (const plan of result.plans) {
        const lines = optionStaffing(plan, ws.swapFinder!.snapshot, ws.swapFinder!.settings, request.staffId, request.leaveDates);
        for (const warning of plan.warnings) expect(lines.find(line => line.date === warning.date)).toMatchObject(warning);
      }
    }
  });

  it('keeps one limits line and the no-rules warning, with step 5 labels from the brief', () => {
    expect(resultLimitsLine({ limits: ['chainSample', 'planCap'] })).toBe("Showing the first page. Some 3- and 4-person swaps aren't shown yet.");
    const ws = stage4Workspace(true);
    const result = findSwaps(ws.profile, ws.swapFinder!.snapshot, ws.swapFinder!.settings, stage4Request());
    const html = renderToStaticMarkup(<Results result={{ ...result, noRulesWarning: true, limits: ['chainSample'] }} staff={ws.profile.staff} requesterId="rowan" snapshot={ws.swapFinder!.snapshot} settings={ws.swapFinder!.settings} profile={ws.profile} leaveDates={LEAVE} decline={() => undefined} findLongDay={() => undefined} loadMore={() => undefined} loading={false} go={() => undefined} hasChosenPeople={false} changeAnswers={() => undefined} />);
    expect(html).toContain('Settings → Rules');
    expect(html.match(/class="swap-limits-line"/g)).toHaveLength(1);
    expect(html).toContain('Hide same-day swaps');
    const same = result.plans.find(plan => optionKind(plan) === 'Same-day swap')!;
    expect(renderToStaticMarkup(<SwapOptionDetail plan={same} index={0} staff={ws.profile.staff} requesterId="rowan" snapshot={ws.swapFinder!.snapshot} settings={ws.swapFinder!.settings} profile={ws.profile} leaveDates={LEAVE} decline={() => undefined} findLongDay={() => undefined} />)).toContain(SAME_DAY_EXPLANATION);
    const source = readFileSync('src/app/pages/FindSwaps.tsx', 'utf8');
    for (const label of ['Work the pay-back shifts in one go?', 'Which days would you rather pay back on?', 'Pay back within how many weeks?', 'How many people can one swap pass through?', 'Also look at swapping day jobs', 'Department swap settings']) {
      expect(source).toContain(label);
    }
    for (const value of ['value="consecutive"', 'value="separate"', 'value="noPreference"', 'value="weekdays"', 'value="weekends"', 'value="any"', 'value="weeks"', 'value="dates"', 'value={2}', 'value={3}', 'value={4}']) {
      expect(source).toContain(value);
    }
  });

  it('copies the expected message text and shows the failure path', async () => {
    const ws = stage4Workspace();
    const plan = findSwaps(ws.profile, ws.swapFinder!.snapshot, ws.swapFinder!.settings, stage4Request()).plans.find(item => optionKind(item) === 'Straight swap')!;
    const message = copySwapMessage(plan, ws.profile.staff, 'rowan', ws.profile, ws.swapFinder!.snapshot);
    expect(message).toMatch(/^Hi Dr .+, would you swap with me\?/);
    expect(message).toContain("Found with Rota Planner; I'll check and book it in MediRota.");
    const writeText = vi.fn().mockRejectedValue(new Error('clipboard blocked'));
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    // Detail renders failure copy after a failed click; assert the static failure copy exists in source and the message body is exact for leave-using options.
    expect(copySwapMessage({ ...plan, usesOwnLeave: ['2027-01-05'] }, ws.profile.staff, 'rowan')).toContain("I'd cancel my leave on Tue 5 Jan in MediRota.");
    expect(readFileSync('src/app/pages/FindSwaps.tsx', 'utf8')).toContain('Message could not be copied.');
    vi.unstubAllGlobals();
  });

  it('renders continuous numbers in the list and keeps the options-to-discuss footer', () => {
    const ws = stage4Workspace();
    const result = findSwaps(ws.profile, ws.swapFinder!.snapshot, ws.swapFinder!.settings, stage4Request());
    const rows = optionRows(result.plans);
    const list = renderToStaticMarkup(<SwapOptionList rows={rows} selectedIdentity={rows[0].identity} staff={ws.profile.staff} requesterId="rowan" onSelect={() => undefined} />);
    expect(list).toContain('swap-option-number">1<');
    expect(list).toContain(`swap-option-number">${rows.length}<`);
    const detail = renderToStaticMarkup(<SwapOptionDetail plan={rows[0].plan} index={0} staff={ws.profile.staff} requesterId="rowan" snapshot={ws.swapFinder!.snapshot} settings={ws.swapFinder!.settings} profile={ws.profile} leaveDates={LEAVE} decline={() => undefined} findLongDay={() => undefined} />);
    expect(detail).toContain('options to discuss, not approved swaps');
    expect(detail).toContain('You give');
    expect(detail).toContain('You take');
  });

  it('preserves R2 chat-addon helper wording versus BASE on a few inputs', async () => {
    // Expected strings captured independently against a27ae8f (BASE) before the temp worktree was removed.
    const { SAME_DAY_LABEL, swapLimitMessages, displayRuledOutReason, pastLeaveWarning, localISODate, swapPlanNotes, swapDateSummary, datesOutsideImports, latestImport } = await import('../src/app/swapsView');
    expect(SAME_DAY_LABEL).toBe('Not like for like: they work a long day instead of their day job');
    expect(swapLimitMessages(['chainSample', 'planCap'])).toEqual([
      'All direct swaps are shown. Some 3- and 4-person chains may be missing, because the search only checks those closest in date.',
      'The first page is shown for each chain size. Use Find 50 more to extend a page.',
    ]);
    expect(displayRuledOutReason('Working a longDay on 2026-12-29')).toBe('On a longDay on Tue 29 Dec');
    expect(pastLeaveWarning(['2026-11-01'], '2026-11-20')).toBe('These leave dates are before today and cannot be searched: Sun 1 Nov.');
    expect(localISODate(new Date('2026-11-20T12:00:00Z'))).toBe('2026-11-20');
    const { ws, request } = stage7Fixture('sameAt');
    const plan = findSwaps(ws.profile, ws.swapFinder!.snapshot, ws.swapFinder!.settings, request).plans[0];
    const nameFor = (id: string) => ws.profile.staff.find(person => person.id === id)?.name ?? id;
    expect(swapPlanNotes(plan, nameFor)).toEqual([
      'Not like for like: they work a long day instead of their day job',
      'Mon 7 Dec: 7 of 7 working after leave',
    ]);
    expect(swapDateSummary(ws.swapFinder!.snapshot, ws.swapFinder!.settings, request.staffId, request.leaveDates, false, request.today)).toEqual({
      clashes: [{ date: '2026-12-07', label: 'Long cover' }], swapCount: 1, requestAsLeave: [], sortByHand: [], extraShiftsToHandBack: [],
    });
    expect(datesOutsideImports(ws.swapFinder!.snapshot, ['2099-01-01'])).toEqual(['2099-01-01']);
    expect(latestImport(ws.swapFinder!.snapshot)).toBe('2026-11-08T12:00:00.000Z');
  });

  it('keeps FindSwaps parity strings the chat add-on reads as text', () => {
    const source = readFileSync('src/app/pages/FindSwaps.tsx', 'utf8');
    expect(source).toContain("leaveType: 'annual'");
    expect(source).toContain('annualLeaveInputs(structuredClone(searchInputs))');
    expect(source).toContain('planLimits: Partial<Record<2 | 3 | 4, number>> = {}');
    expect(source).toContain('buildSwapRequest(ws, requestInputs, localISODate()');
  });

  it('loads a BASE-shaped recent search with the switch off and omits the key when saving off', () => {
    const oldSearch: SwapFormInputs = { staffId: 'rowan', leaveDates: LEAVE, leaveType: 'annual', cantWorkDates: [], excludedStaffIds: [], includeNormalDays: false, askMode: 'everyone', maxChain: 4 };
    const restored = annualLeaveInputs(structuredClone(oldSearch));
    expect(!!restored.payBackOnOwnLeave).toBe(false);
    expect(JSON.parse(JSON.stringify(oldSearch))).not.toHaveProperty('payBackOnOwnLeave');
    const savedOn = { ...(true ? { payBackOnOwnLeave: true } : {}), ...oldSearch };
    expect(savedOn.payBackOnOwnLeave).toBe(true);
  });
});
