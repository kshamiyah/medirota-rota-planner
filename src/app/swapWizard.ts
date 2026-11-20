import type { LeaveCheck } from './leaveCheck';

export type SwapSearchType = 'leave' | 'dayJob';

export function initialSwapRequesterId(role: string | undefined, me: string | undefined, visibleStaffIds: string[]): string {
  return role !== 'coordinator' && me && visibleStaffIds.includes(me) ? me : '';
}

export function isColleagueSwapRequester(role: string | undefined, me: string | undefined, staffId: string): boolean {
  return role !== 'coordinator' && !!staffId && staffId !== me;
}
export type SwapWizardAction = 'back' | 'next' | 'skip' | 'done';

const LEAVE_TITLES = ['What do you need?', 'Which days?', 'Any days you can’t work in return?', 'Who would you ask?', 'How would you like to pay it back?', 'Results'];
const DAY_JOB_TITLES = ['What do you need?', 'Which day?', 'Results'];

export function swapWizardTitles(type: SwapSearchType): string[] {
  return type === 'dayJob' ? DAY_JOB_TITLES : LEAVE_TITLES;
}

export function leaveNeedsNoSwap(check: LeaveCheck | undefined): boolean {
  return !!check?.days.length && check.days.every(row => ['Zero day, nothing to do', 'Nothing to do', 'Book as leave'].includes(row.outcome));
}

export function advanceSwapWizard(type: SwapSearchType, step: number, action: SwapWizardAction, noSwapNeeded = false): number {
  if (action === 'back') return Math.max(1, step - 1);
  if (action === 'done' || (action === 'next' && type === 'leave' && step === 2 && noSwapNeeded)) return 1;
  if (action === 'skip' && step === 3) return 4;
  if (action === 'skip' && step === 5) return 6;
  if (action === 'next' && type === 'dayJob' && step === 2) return 3;
  return Math.min(swapWizardTitles(type).length, step + 1);
}

/** Step 5 Skip must start a search with the current answers, like Find swaps, without changing saved settings. */
export function leaveStep5SkipStartsSearch(type: SwapSearchType, step: number): boolean {
  return type === 'leave' && step === 5;
}

/** Step 6 (leave) / step 3 (day job) should not keep an empty search-form card once results are showing. */
export function showSwapSearchFormCard(type: SwapSearchType, step: number, running: boolean, error?: string | null): boolean {
  if (type === 'dayJob') return step < 3;
  return step < 6 || running || !!error;
}
