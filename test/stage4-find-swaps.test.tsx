import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Results, SwapOptionDetail, SwapOptionList } from '../src/app/pages/FindSwaps';
import { SwapDateCalendar } from '../src/app/components/SwapDateCalendar';
import { annualLeaveInputs, sameSwapFormInputs, withDeclinedDoctor, type SwapFormInputs } from '../src/app/swapsView';
import { buildSwapRequest } from '../src/app/swapRequest';
import { copySwapMessage, differentShiftLengths, moreOptionSizes, optionBadge, optionChainSentences, optionContacts, optionKind, optionRows, optionStaffing, optionSummary, ownLeaveText, PAY_EXPLANATION, requesterCalendar, requesterMoves, resultDateLabel, resultLimitsLine, resultWithAppendedPlans, SAME_DAY_EXPLANATION, selectedOption, staffingLine } from '../src/app/swapResultsView';
import { findSwaps, type SwapPlan } from '../src/engine/swaps';
import { stage7Cases, stage7Fixture } from './swaps-stage7-fixture';
import { LEAVE, stage4Request, stage4Workspace } from './stage4-find-swaps-fixture';

const fixture = () => { const ws = stage4Workspace(); const result = findSwaps(ws.profile, ws.swapFinder!.snapshot, ws.swapFinder!.settings, stage4Request({ payBackOnOwnLeave: true })); return { ws, result }; };
const oldInputs: SwapFormInputs = { staffId: 'rowan', leaveDates: LEAVE, leaveType: 'annual', cantWorkDates: [], excludedStaffIds: [], includeNormalDays: false };
function detail(plan: SwapPlan, index = 0, noRulesWarning = false) {
  const ws = stage4Workspace();
  return renderToStaticMarkup(<SwapOptionDetail plan={plan} index={index} staff={ws.profile.staff} requesterId="rowan" snapshot={ws.swapFinder!.snapshot} settings={ws.swapFinder!.settings} profile={ws.profile} leaveDates={LEAVE} decline={() => undefined} findLongDay={() => undefined} noRulesWarning={noRulesWarning} />);
}
function isolated() {
  const ws = stage4Workspace(true), { snapshot, settings } = ws.swapFinder!;
  settings.excluded = ws.profile.staff.filter(person => !['rowan', 'ellis'].includes(person.id)).map(person => ({ staffId: person.id }));
  for (const days of Object.values(snapshot.days)) for (const date of Object.keys(days)) days[date] = { status: 'blank' };
  snapshot.unavailability = [];
  snapshot.days.rowan[LEAVE[0]] = { status: 'longDay', activity: 'Willow cover' };
  snapshot.days.ellis[LEAVE[0]] = { status: 'zero' };
  snapshot.days.ellis['2027-01-05'] = { status: 'longDay', activity: 'Willow cover' };
  snapshot.days.rowan['2027-01-05'] = { status: 'leave' };
  return ws;
}
const search = (ws: ReturnType<typeof stage4Workspace>, patch: Parameters<typeof stage4Request>[0] = {}) => findSwaps(ws.profile, ws.swapFinder!.snapshot, ws.swapFinder!.settings, stage4Request({ leaveDates: [LEAVE[0]], ...patch }));

describe('Stage 4 own leave pay-back', () => {
  it('only changes results when on and marks the received leave date, including explicit snapshot leave', () => {
    const ws = isolated();
    ws.swapFinder!.snapshot.unavailability = [{ staffId: 'rowan', date: '2027-01-05', kind: 'leave', reason: 'Annual leave' }];
    expect(search(ws).plans).toEqual([]);
    expect(search(ws, { payBackOnOwnLeave: false })).toStrictEqual(search(ws));
    const plan = search(ws, { payBackOnOwnLeave: true }).plans[0];
    expect(plan.usesOwnLeave).toEqual(['2027-01-05']);
    expect(ownLeaveText(plan)).toBe("Uses your leave on Tue 5 Jan: you'd need to cancel it in MediRota");
    expect(optionSummary(plan, 'rowan')).toContain(ownLeaveText(plan));
    expect(detail(plan)).toContain('Uses your leave on Tue 5 Jan');
  });
  it('also marks requester leave recorded only in explicit unavailability', () => {
    const ws = isolated(); ws.swapFinder!.snapshot.days.rowan['2027-01-05'] = { status: 'zero' };
    ws.swapFinder!.snapshot.unavailability = [{ staffId: 'rowan', date: '2027-01-05', kind: 'leave', reason: 'Annual leave' }];
    expect(search(ws).plans).toEqual([]);
    expect(search(ws, { payBackOnOwnLeave: true }).plans[0].usesOwnLeave).toEqual(['2027-01-05']);
  });
  it('never offers a colleague on leave, even when that is the only possible helper', () => {
    const ws = isolated(); ws.swapFinder!.snapshot.days.ellis[LEAVE[0]] = { status: 'leave' };
    expect(search(ws, { payBackOnOwnLeave: true }).plans).toEqual([]);
  });
  it('still blocks can’t-work dates and requested leave dates', () => {
    const ws = isolated();
    expect(search(ws, { payBackOnOwnLeave: true, cantWorkDates: ['2027-01-05'] }).plans).toEqual([]);
    expect(search(ws, { payBackOnOwnLeave: true, leaveDates: [...LEAVE, '2027-01-05'] }).plans).toEqual([]);
  });
  it('still blocks today and earlier return shifts', () => {
    expect(search(isolated(), { payBackOnOwnLeave: true, today: '2027-01-05' }).plans).toEqual([]);
  });
  it('marks a night-package rest-day shift received on the requester’s leave', () => {
    const ws = isolated(), days = ws.swapFinder!.snapshot.days;
    days.rowan[LEAVE[0]] = { status: 'night', activity: 'Willow nights' };
    days.rowan[LEAVE[1]] = { status: 'night', activity: 'Willow nights' };
    days.ellis[LEAVE[1]] = { status: 'zero' };
    days.ellis['2027-01-05'] = { status: 'night', activity: 'Willow nights' };
    days.ellis['2027-01-06'] = { status: 'night', activity: 'Willow nights' };
    days.rowan['2027-01-05'] = { status: 'zero' }; days.rowan['2027-01-06'] = { status: 'zero' };
    days.ellis['2026-12-17'] = { status: 'dayJob', activity: 'Cedar clinic' };
    days.rowan['2026-12-17'] = { status: 'leave' };
    expect(search(ws).plans).toEqual([]);
    const plan = search(ws, { payBackOnOwnLeave: true }).plans[0];
    expect(plan.movedShifts).toContainEqual({ fromStaffId: 'ellis', toStaffId: 'rowan', date: '2026-12-17', activity: 'Cedar clinic', kind: 'dayJob' });
    expect(plan.usesOwnLeave).toEqual(['2026-12-17']);
    expect(requesterMoves(plan, 'rowan', ws.profile, ws.swapFinder!.snapshot).take).toContainEqual({ dates: ['2026-12-17'], activity: 'Cedar clinic', kind: 'dayShift', hours: 9.5 });
    expect(search(ws, { payBackOnOwnLeave: true, cantWorkDates: ['2026-12-17'] }).plans).toEqual([]);
  });
  it('does not add a flag to plans that do not receive work on leave', () => {
    const { result } = fixture();
    expect(result.plans.some(plan => !Object.hasOwn(plan, 'usesOwnLeave'))).toBe(true);
    expect(result.plans.filter(plan => plan.usesOwnLeave).every(plan => plan.usesOwnLeave!.join() === [...plan.usesOwnLeave!].sort().join())).toBe(true);
  });
  it('keeps the old request payload byte-for-byte and omits the false key', () => {
    const ws = stage4Workspace();
    const expected = { profile: ws.profile, snapshot: ws.swapFinder!.snapshot, settings: ws.swapFinder!.settings, request: { staffId: oldInputs.staffId, leaveDates: oldInputs.leaveDates, leaveType: 'annual', cantWorkDates: [], excludeStaffIds: [], includeNormalDays: false, today: '2026-11-20', planLimits: {}, returnPattern: undefined, returnDayType: undefined, returnWindow: undefined, noAlertsOnly: undefined, askMode: undefined, askStaffIds: undefined, deadlineMs: 60000 } };
    expect(buildSwapRequest(ws, oldInputs, '2026-11-20', 60000)).toStrictEqual(expected);
    expect(buildSwapRequest(ws, { ...oldInputs, payBackOnOwnLeave: false }, '2026-11-20', 60000)).toStrictEqual(expected);
    expect(buildSwapRequest(ws, { ...oldInputs, payBackOnOwnLeave: true }, '2026-11-20', 60000).request.payBackOnOwnLeave).toBe(true);
  });
  it('preserves the switch with recent inputs, annual normalisation, Leave out and a long-day follow-up', () => {
    const saved = JSON.parse(JSON.stringify({ ...oldInputs, payBackOnOwnLeave: true }));
    expect(annualLeaveInputs(saved).payBackOnOwnLeave).toBe(true);
    expect(withDeclinedDoctor(saved, 'ellis').payBackOnOwnLeave).toBe(true);
    expect({ ...saved, leaveDates: [LEAVE[0]] }.payBackOnOwnLeave).toBe(true);
    expect(!!annualLeaveInputs(oldInputs).payBackOnOwnLeave).toBe(false);
    expect(sameSwapFormInputs(oldInputs, { ...oldInputs, payBackOnOwnLeave: true })).toBe(false);
    expect(sameSwapFormInputs(oldInputs, { ...oldInputs, payBackOnOwnLeave: false })).toBe(true);
    const src = readFileSync('src/app/pages/FindSwaps.tsx', 'utf8');
    expect(src).toContain('...(payBackOnOwnLeave ? { payBackOnOwnLeave: true } : {})');
    expect(src).toContain('setPayBackOnOwnLeave(!!annual.payBackOnOwnLeave)');
    expect(src).toContain('setPayBackOnOwnLeave(!!next.payBackOnOwnLeave)');
    expect(src).not.toContain('draft.payBackOnOwnLeave');
  });
  it('marks leave as possible pay-back only when on, while keeping it tappable', () => {
    const ws = isolated(); ws.swapFinder!.snapshot.days.rowan['2026-11-23'] = { status: 'leave' }; ws.swapFinder!.snapshot.importedAt['2026-11-23'] = '2026-11-20T12:00:00Z';
    const props = { snapshot: ws.swapFinder!.snapshot, staffId: 'rowan', leaveDates: [], cantWorkDates: [], onLeaveDates: () => undefined, onCantWorkDates: () => undefined, forcedMode: 'cantWork' as const };
    const off = renderToStaticMarkup(<SwapDateCalendar {...props} />);
    const on = renderToStaticMarkup(<SwapDateCalendar {...props} payBackOnOwnLeave />);
    expect(off).not.toContain('Can pay back'); expect(on).toContain('Can pay back');
    expect(on).toMatch(/data-swap-date="2026-11-23" class="swap-can-pay-back/);
    expect(renderToStaticMarkup(<SwapDateCalendar {...props} payBackOnOwnLeave cantWorkDates={['2026-11-23']} />)).not.toContain('Can pay back');
  });
});

describe('Stage 4 list and detail', () => {
  it('numbers a flat chosen-first list, complete before partial, preserving engine order within sections', () => {
    const { result } = fixture();
    const plans = result.plans.slice(0, 8).map((plan, index) => ({ ...plan, chosenPeople: index % 2 === 0, remaining: index % 3 === 0 ? [plan.cleared[0]] : [] }));
    const rows = optionRows(plans, 'all', {}, true);
    expect(rows.map(row => row.number)).toEqual(plans.map((_, index) => index + 1));
    expect(rows.map(row => row.plan)).toEqual([true, false].flatMap(chosen => [false, true].flatMap(part => plans.filter(plan => plan.chosenPeople === chosen && !!plan.remaining.length === part))));
    for (const filter of ['ask1', 'ask2', 'ask3', 'noAlerts'] as const) {
      const filtered = optionRows(plans, filter, { hideSameDay: true }, true);
      expect(filtered.map(row => row.number)).toEqual(filtered.map((_, index) => index + 1));
    }
  });
  it('labels only-chosen searches as Your chosen people even without the engine preference flag', () => {
    const { result } = fixture();
    const rows = optionRows(result.plans, 'all', {}, true, 'only');
    expect(rows.every(row => row.section === 'Your chosen people')).toBe(true);
    expect(rows.map(row => row.number)).toEqual(rows.map((_, index) => index + 1));
  });
  it('selects the first shown option, follows another identity and falls back if it is filtered away', () => {
    const { result } = fixture(), rows = optionRows(result.plans);
    expect(selectedOption(rows)).toBe(rows[0]); expect(selectedOption(rows, rows[1].identity)).toBe(rows[1]);
    expect(selectedOption(rows.slice(2), rows[1].identity)).toBe(rows[2]);
    expect(selectedOption([...rows, { ...rows[0], identity: 'appended' }], rows[1].identity)).toBe(rows[1]);
    expect(selectedOption([])).toBeUndefined();
    const partial = resultWithAppendedPlans({ ...result, plans: [rows[0].plan] }, result, 3);
    expect(selectedOption(optionRows(partial.plans), rows[1].identity)?.identity).toBe(rows[1].identity);
    const completed = resultWithAppendedPlans(result, partial, 3);
    expect(selectedOption(optionRows(completed.plans), rows[1].identity)?.identity).toBe(rows[1].identity);
  });
  it('renders continuous row numbers and changes highlighted row and detail with the selection', () => {
    const { ws, result } = fixture(), rows = optionRows(result.plans);
    const html = renderToStaticMarkup(<SwapOptionList rows={rows} selectedIdentity={rows[1].identity} staff={ws.profile.staff} requesterId="rowan" onSelect={() => undefined} />);
    expect(html.match(/aria-current="true"/g)).toHaveLength(1);
    expect(html).toMatch(/aria-current="true"><span class="swap-option-number">2/);
    expect(detail(rows[1].plan, 1)).toContain('Option 2');
    expect(detail(rows[0].plan)).not.toEqual(detail(rows[1].plan, 1));
  });
  it('badges count both alerts and warnings, give partial precedence and preserve the no-rules rule', () => {
    const { result } = fixture(), base = { ...result.plans[0], alerts: [], warnings: [], remaining: [] };
    expect(optionBadge(base)).toBe('No alerts'); expect(optionBadge(base, true)).toBe('Not checked');
    const warning = { date: LEAVE[0], doctors: 1, minimum: 2 };
    expect(optionBadge({ ...base, warnings: [warning] }, true)).toBe('1 alert');
    expect(optionBadge({ ...base, warnings: [warning], alerts: [{ staffId: 'rowan', date: LEAVE[0], message: 'Check hours' }] })).toBe('2 alerts');
    expect(optionBadge({ ...base, remaining: [base.cleared[0]] }, true)).toBe('Part');
  });
  it.each(['Straight swap', 'Same-day swap', 'Three-way'])('shows requester give/take and correct calendar dates for %s', kind => {
    const { ws, result } = fixture(), plan = result.plans.find(item => optionKind(item) === kind)!;
    const moves = requesterMoves(plan, 'rowan'), weeks = requesterCalendar(plan, ws.swapFinder!.snapshot, 'rowan', LEAVE);
    expect(moves.give).toEqual(plan.chains.map(chain => ({ ...chain.links.find(link => link.staffId === 'rowan')!.gives })));
    expect(moves.take.map(move => move.dates)).toEqual(plan.chains.map(chain => chain.links.at(-1)!.gives.dates));
    const html = detail(plan);
    expect(html).toContain('You give'); expect(html).toContain('You take'); expect(html).toContain("Show everyone&#x27;s changes");
    expect(html).toContain('Struck through: shifts you give away. Outlined: shifts you take on.');
    for (const move of moves.give) for (const date of move.dates) expect(weeks.flatMap(week => week.days).find(day => day.date === date)?.given.length).toBeGreaterThan(0);
    for (const move of moves.take) for (const date of move.dates) expect(weeks.flatMap(week => week.days).find(day => day.date === date)?.[move.asLeave ? 'leave' : 'taken']).toBeTruthy();
    for (const id of optionContacts(plan, 'rowan')) expect(html).toContain(`Leave out ${ws.profile.staff.find(person => person.id === id)!.name}`);
  });
  it('keeps same-day, length and pay tags separate', () => {
    const { result } = fixture(), same = result.plans.find(plan => optionKind(plan) === 'Same-day swap')!;
    expect(detail(same)).toContain(SAME_DAY_EXPLANATION); expect(differentShiftLengths(same, 'rowan')).toMatch(/Different shift lengths: .* h for your .* h/);
    const direct = result.plans.find(plan => optionKind(plan) === 'Straight swap' && plan.chains.some(chain => chain.payDifferent))!;
    expect(differentShiftLengths(direct, 'rowan')).toBeUndefined(); expect(detail(direct)).toContain(PAY_EXPLANATION);
    const intermediate = messagePlan(3); intermediate.chains[0].links[1].gives.hours = 9.5;
    expect(differentShiftLengths(intermediate, 'rowan')).toBe('Different shift lengths: 9.5 h and 12.5 h exchanged within a chain');
  });
  it('shows one limits line for every limit kind and pages, while keeping no-rules prominent', () => {
    for (const limit of ['chainSample', 'planSample', 'planCap'] as const) expect(resultLimitsLine({ limits: [limit] })).toContain('Showing the first page.');
    expect(resultLimitsLine({ morePlanSizes: [3] })).toBe('Showing the first page. More options may be available.');
    expect(resultLimitsLine({ limits: ['chainSample', 'planCap'], morePlanSizes: [3, 4] })).toBe("Showing the first page. Some 3- and 4-person swaps aren't shown yet.");
    expect(resultLimitsLine({})).toBeUndefined();
    expect(moreOptionSizes({ limits: ['planSample'] }, 2)).toEqual([2]);
    expect(moreOptionSizes({ limits: ['chainSample'] }, 3)).toEqual([3]);
    expect(moreOptionSizes({ morePlanSizes: [2, 4] }, 4)).toEqual([2, 4]);
    expect(moreOptionSizes({}, 4)).toEqual([]);
    const { ws, result } = fixture(); const html = renderToStaticMarkup(<Results result={{ ...result, noRulesWarning: true, limits: ['chainSample', 'planSample', 'planCap'] }} staff={ws.profile.staff} requesterId="rowan" snapshot={ws.swapFinder!.snapshot} settings={ws.swapFinder!.settings} profile={ws.profile} leaveDates={LEAVE} decline={() => undefined} findLongDay={() => undefined} loadMore={() => undefined} loading={false} go={() => undefined} hasChosenPeople={false} changeAnswers={() => undefined} />);
    expect(html).toContain('Settings → Rules'); expect(html).toContain('No working-time rules are set'); expect(html.match(/class="swap-limits-line"/g)).toHaveLength(1); expect(html).not.toContain('Your chosen people'); expect(html).toContain('Not checked: no rules set');
  });
  it('names every person and move in a mixed same-day and multi-person option', () => {
    const mixed = messagePlan(3); mixed.chains.push(messagePlan(2, true).chains[0]);
    const lines = optionChainSentences(mixed, stage4Workspace().profile.staff, 'rowan');
    expect(lines).toHaveLength(4);
    expect(lines[3]).toBe('Dr Ellis works your long day on Fri 18 Dec; you take their Cedar clinic as annual leave.');
  });
  it('uses short naturally joined clash dates for the headline', () => {
    expect(resultDateLabel(LEAVE)).toBe('Fri 18 and Sat 19 Dec');
    expect(resultDateLabel(['2026-12-31', '2027-01-01'])).toBe('Thu 31 Dec and Fri 1 Jan');
  });
  it('keeps Step 5 saved values under the new labels', () => {
    const source = readFileSync('src/app/pages/FindSwaps.tsx', 'utf8');
    for (const label of ['Work the pay-back shifts in one go?', 'Which days would you rather pay back on?', 'Pay back within how many weeks?', 'How many people can one swap pass through?', 'Also look at swapping day jobs', 'Department swap settings']) expect(source).toContain(label);
    for (const option of ['value="consecutive">Yes, in one go', 'value="separate">Separate days are fine', 'value="noPreference">No preference', 'value="noPreference">Any day', 'value="any">Any time', 'value="weeks">Within a number of weeks', 'value="dates">Between dates', 'value={2}>2', 'value={3}>3', 'value={4}>4']) expect(source).toContain(option);
  });
});

describe('Stage 4 staffing', () => {
  it('matches engine warning counts and same-day headcounts on all Stage 7 fixtures', () => {
    for (const kind of stage7Cases) {
      const { ws, request } = stage7Fixture(kind), { snapshot, settings } = ws.swapFinder!;
      const result = findSwaps(ws.profile, snapshot, settings, request);
      for (const plan of result.plans) {
        const lines = optionStaffing(plan, snapshot, settings, request.staffId, request.leaveDates);
        for (const warning of plan.warnings) expect(lines.find(line => line.date === warning.date), kind).toMatchObject(warning);
        for (const chain of plan.chains.filter(chain => chain.sameDay)) expect(lines.find(line => line.date === chain.links[0].gives.dates[0]), kind).toMatchObject(chain.sameDay!);
      }
    }
  });
  it('uses bank holiday minimums, omits unset minimums and ignores unimported work', () => {
    const { ws, result } = fixture(), { settings, snapshot } = ws.swapFinder!, plan = result.plans[0];
    const date = plan.chains[0].links[0].gives.dates[0]; settings.bankHolidays = [date]; settings.minDoctorsBankHoliday = 7;
    expect(optionStaffing(plan, snapshot, settings, 'rowan', LEAVE).find(line => line.date === date)?.minimum).toBe(7);
    settings.minDoctors.fill(0); settings.minDoctorsBankHoliday = 0; expect(optionStaffing(plan, snapshot, settings, 'rowan', LEAVE)).toEqual([]);
    const html = renderToStaticMarkup(<SwapOptionDetail plan={plan} index={0} staff={ws.profile.staff} requesterId="rowan" snapshot={snapshot} settings={settings} profile={ws.profile} leaveDates={LEAVE} decline={() => undefined} findLongDay={() => undefined} />);
    expect(html).not.toContain('<h3>Staffing</h3>');
    settings.minDoctors.fill(1); snapshot.importedAt = {}; expect(optionStaffing(plan, snapshot, settings, 'rowan', LEAVE)).toEqual([]);
  });
  it('uses the agreed above/at/below wording and amber below the minimum', () => {
    expect(staffingLine({ date: '2026-12-29', doctors: 7, minimum: 6 })).toBe('Tue 29 Dec: 7 doctors at work (minimum 6)');
    expect(staffingLine({ date: '2026-12-29', doctors: 7, minimum: 7 })).toBe('Tue 29 Dec: 7 doctors at work (minimum 7)');
    expect(staffingLine({ date: '2026-12-29', doctors: 6, minimum: 7 })).toBe('Tue 29 Dec: 6 doctors at work (minimum 7), below minimum');
    const { result } = fixture(), html = detail({ ...result.plans[0], warnings: [{ date: '2026-12-29', doctors: 6, minimum: 7 }] }); expect(html).toContain('class="swap-staffing-below">Tue 29 Dec: 6 doctors at work (minimum 7), below minimum');
  });
});

// Independent tiny plans make the complete clipboard contract easy to review.
function messagePlan(size: 2 | 3 | 4, sameDay = false): SwapPlan {
  const ids = ['rowan', 'ellis', 'hart', 'moss'].slice(0, size);
  return { people: size - 1, shiftsMoved: size, cleared: [], remaining: [], warnings: [], chains: [{ payDifferent: false, links: ids.map((staffId, index) => ({ staffId, gives: { staffId, dates: [index === 0 || sameDay ? '2026-12-18' : index === 1 ? '2027-01-05' : index === 2 ? '2027-01-12' : '2027-01-19'], activity: sameDay && index === 1 ? 'Cedar clinic' : 'Willow cover', hours: sameDay && index === 1 ? 9.5 : 12.5, kind: sameDay && index === 1 ? 'dayShift' : 'longDay', dayType: 'weekday' } })), ...(sameDay ? { sameDay: { doctors: 7, minimum: 6 } } : {}) }] };
}
describe('Stage 4 exact clipboard messages', () => {
  const staff = stage4Workspace().profile.staff;
  const footer = " (Found with Rota Planner; I'll check and book it in MediRota.)";
  it('direct', () => { expect(copySwapMessage(messagePlan(2), staff, 'rowan')).toBe("Hi Dr Ellis, would you swap with me? I'd give you Fri 18 Dec Willow cover (12.5 h), and take your Tue 5 Jan Willow cover (12.5 h)." + footer); });
  it('same day', () => { expect(copySwapMessage(messagePlan(2, true), staff, 'rowan')).toBe("Hi Dr Ellis, would you swap with me? You would work my long day on Fri 18 Dec, and I'd take your day job as annual leave." + footer); });
  it('three way', () => { expect(copySwapMessage(messagePlan(3), staff, 'rowan')).toBe('Hi Dr Ellis, Dr Hart, would you swap with me? I would give Fri 18 Dec Willow cover (12.5 h) to Dr Ellis. Dr Ellis would give Tue 5 Jan Willow cover (12.5 h) to Dr Hart. Dr Hart would give Tue 12 Jan Willow cover (12.5 h) to me.' + footer); });
  it('four way', () => { expect(copySwapMessage(messagePlan(4), staff, 'rowan')).toBe('Hi Dr Ellis, Dr Hart, Dr Moss, would you swap with me? I would give Fri 18 Dec Willow cover (12.5 h) to Dr Ellis. Dr Ellis would give Tue 5 Jan Willow cover (12.5 h) to Dr Hart. Dr Hart would give Tue 12 Jan Willow cover (12.5 h) to Dr Moss. Dr Moss would give Tue 19 Jan Willow cover (12.5 h) to me.' + footer); });
  it('adds cancellation when the option uses the requester’s leave', () => { expect(copySwapMessage({ ...messagePlan(2), usesOwnLeave: ['2027-01-05'] }, staff, 'rowan')).toBe("Hi Dr Ellis, would you swap with me? I'd give you Fri 18 Dec Willow cover (12.5 h), and take your Tue 5 Jan Willow cover (12.5 h). I'd cancel my leave on Tue 5 Jan in MediRota." + footer); });
});
