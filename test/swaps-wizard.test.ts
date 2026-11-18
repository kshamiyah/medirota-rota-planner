import { describe, expect, it } from 'vitest';
import { advanceSwapWizard, leaveNeedsNoSwap, showSwapSearchFormCard, swapWizardTitles } from '../src/app/swapWizard';

describe('Find swaps wizard flow', () => {
  it('shows six leave steps and a three-step day-job path', () => {
    expect(swapWizardTitles('leave')).toHaveLength(6);
    expect(swapWizardTitles('dayJob')).toEqual(['What do you need?', 'Which day?', 'Results']);
  });

  it('supports Back, Next and Skip without changing answers', () => {
    expect(advanceSwapWizard('leave', 4, 'back')).toBe(3);
    expect(advanceSwapWizard('leave', 2, 'next')).toBe(3);
    expect(advanceSwapWizard('leave', 3, 'skip')).toBe(4);
    expect(advanceSwapWizard('leave', 5, 'skip')).toBe(6);
    expect(advanceSwapWizard('dayJob', 2, 'next')).toBe(3);
    expect(advanceSwapWizard('dayJob', 2, 'back')).toBe(1);
    expect(advanceSwapWizard('leave', 6, 'back')).toBe(5);
  });

  it('offers Done only when all selected dates need no swap', () => {
    const leaveCheck = { cost: '', outsideCount: 0, days: [{ dates: ['2027-01-13'], activity: 'Zero Day', outcome: 'Zero day, nothing to do' }], othersOff: [], minimum: [] };
    expect(leaveNeedsNoSwap(leaveCheck)).toBe(true);
    expect(advanceSwapWizard('leave', 2, 'done', true)).toBe(1);
    expect(advanceSwapWizard('leave', 2, 'next', true)).toBe(1);
    expect(leaveNeedsNoSwap({ ...leaveCheck, days: [{ ...leaveCheck.days[0], outcome: 'Nothing on the rota' }] })).toBe(false);
    expect(leaveNeedsNoSwap({ ...leaveCheck, days: [{ ...leaveCheck.days[0], outcome: 'Needs a swap' }] })).toBe(false);
  });

  it('hides the empty Results search-form card once the search has finished', () => {
    expect(showSwapSearchFormCard('leave', 6, false)).toBe(false);
    expect(showSwapSearchFormCard('leave', 6, false, null)).toBe(false);
    expect(showSwapSearchFormCard('leave', 6, true)).toBe(true);
    expect(showSwapSearchFormCard('leave', 6, false, 'worker failed')).toBe(true);
    expect(showSwapSearchFormCard('leave', 5, false)).toBe(true);
    expect(showSwapSearchFormCard('dayJob', 3, false)).toBe(false);
    expect(showSwapSearchFormCard('dayJob', 2, false)).toBe(true);
  });

  it('Change my answers returns to step 2 while keeping the leave path length', () => {
    expect(advanceSwapWizard('leave', 2, 'back')).toBe(1);
    expect(swapWizardTitles('leave')[1]).toBe('Which days?');
  });
});
