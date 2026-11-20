import { describe, expect, it } from 'vitest';
import type { Workspace } from '../src/app/store';
import { buildSwapRequest } from '../src/app/swapRequest';
import { annualLeaveInputs, type SwapFormInputs } from '../src/app/swapsView';
import type { SwapRequest } from '../src/engine/swaps';
import fixture from './fixtures/stage3-workspace.json';

const workspace = fixture as Workspace;
const inputs: SwapFormInputs = {
  staffId: 'anise', leaveDates: ['2026-11-30'], leaveType: 'annual', cantWorkDates: [],
  excludedStaffIds: [], includeNormalDays: false, askMode: 'everyone', askStaffIds: [],
  returnPattern: 'consecutive', returnDayType: 'noPreference', returnWindow: { kind: 'any' },
  noAlertsOnly: false, maxChain: 4,
};

// The worker payload from runSearch before extraction. Keep this independent of the helper.
function previousPagePayload(ws: Workspace, requestInputs: SwapFormInputs, today: string, planLimits: SwapRequest['planLimits'], deadlineMs: number) {
  const data = ws.swapFinder!;
  const request: SwapRequest = { staffId: requestInputs.staffId, leaveDates: requestInputs.leaveDates, leaveType: 'annual', cantWorkDates: requestInputs.cantWorkDates, excludeStaffIds: requestInputs.excludedStaffIds, includeNormalDays: requestInputs.includeNormalDays, today, planLimits, returnPattern: requestInputs.returnPattern, returnDayType: requestInputs.returnDayType, returnWindow: requestInputs.returnWindow, noAlertsOnly: requestInputs.noAlertsOnly, askMode: requestInputs.askMode, askStaffIds: requestInputs.askStaffIds, deadlineMs };
  return { profile: ws.profile, snapshot: data.snapshot, settings: { ...data.settings, maxChain: requestInputs.maxChain ?? data.settings.maxChain }, request };
}

interface PageCase {
  name: string;
  choices: Partial<SwapFormInputs>;
  keepLooking?: boolean;
  append?: boolean;
  planLimits?: SwapRequest['planLimits'];
}
const cases: PageCase[] = [
  { name: 'first search with current form defaults', choices: {} },
  { name: 'chosen people, weeks and separate weekday returns', choices: {
    leaveDates: ['2026-12-24', '2026-12-25'], cantWorkDates: ['2026-12-10'],
    askMode: 'only', askStaffIds: ['bramble'], excludedStaffIds: ['cedar'], maxChain: 2,
    returnWindow: { kind: 'weeks', weeks: 6 }, returnPattern: 'separate', returnDayType: 'weekdays',
    includeNormalDays: true, noAlertsOnly: true,
  } },
  { name: 'keep looking with preferred people and return dates', keepLooking: true, choices: {
    askMode: 'prefer', askStaffIds: ['bramble', 'cedar'], maxChain: 3,
    returnWindow: { kind: 'dates', from: '2026-12-01', to: '2027-01-01' }, returnDayType: 'weekends',
  } },
  { name: 'find more with explicit plan limits', append: true, planLimits: { 2: 100, 3: 60, 4: 10 }, choices: {
    returnPattern: 'noPreference',
  } },
  { name: 'legacy inputs with missing choices use saved maxChain', choices: {
    leaveType: 'study', maxChain: undefined, returnPattern: undefined, returnDayType: undefined,
    returnWindow: undefined, noAlertsOnly: undefined, askMode: undefined, askStaffIds: undefined,
  } },
];

describe('shared swap request preserves the page worker payload', () => {
  it.each(cases)('$name', ({ choices, keepLooking, append, planLimits = {} }) => {
    const ws = structuredClone(workspace);
    ws.swapFinder!.settings.maxChain = 3;
    const before = structuredClone(ws);
    // runSearch still normalises historical study searches to annual leave.
    const requestInputs = annualLeaveInputs(structuredClone({ ...inputs, ...choices }));
    const beforeInputs = structuredClone(requestInputs);
    const deadlineMs = append ? 180_000 : keepLooking ? 180_000 : 60_000;
    const actual = buildSwapRequest(ws, requestInputs, '2026-11-20', deadlineMs, planLimits);
    expect(actual).toStrictEqual(previousPagePayload(ws, requestInputs, '2026-11-20', planLimits, deadlineMs));
    expect(actual.request.leaveType).toBe('annual');
    expect(actual.settings.maxChain).toBe(requestInputs.maxChain ?? 3);
    expect(ws).toStrictEqual(before);
    expect(requestInputs).toStrictEqual(beforeInputs);
  });
});
