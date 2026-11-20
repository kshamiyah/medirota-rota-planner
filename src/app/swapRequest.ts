import type { Workspace } from './store';
import type { SwapFormInputs } from './swapsView';
import type { SwapRequest } from '../engine/swaps';

/** Build the worker payload shared by Find swaps and the chat add-on, without changing the workspace or choices.
 * Callers choose the leave type, date, search budget and page limits explicitly.
 */
export function buildSwapRequest(workspace: Workspace, inputs: SwapFormInputs, today: string, deadlineMs: number, planLimits: SwapRequest['planLimits'] = {}) {
  const data = workspace.swapFinder!;
  const requestInputs = structuredClone(inputs);
  const request: SwapRequest = {
    staffId: requestInputs.staffId, leaveDates: requestInputs.leaveDates, leaveType: requestInputs.leaveType,
    cantWorkDates: requestInputs.cantWorkDates, excludeStaffIds: requestInputs.excludedStaffIds,
    includeNormalDays: requestInputs.includeNormalDays, today, planLimits,
    returnPattern: requestInputs.returnPattern, returnDayType: requestInputs.returnDayType,
    returnWindow: requestInputs.returnWindow, noAlertsOnly: requestInputs.noAlertsOnly,
    askMode: requestInputs.askMode, askStaffIds: requestInputs.askStaffIds, deadlineMs,
  };
  return { profile: workspace.profile, snapshot: data.snapshot,
    settings: { ...data.settings, maxChain: requestInputs.maxChain ?? data.settings.maxChain }, request };
}
