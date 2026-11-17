import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { HoursAlertNotice, shouldDismissHoursAlert } from '../src/app/components/HoursAlert';
import type { SwapAlert } from '../src/engine/swaps';

describe('hours alert pop-up', () => {
  it('shows the engine breakdown, swap markers and suggested leave total', () => {
    const alert: SwapAlert = {
      staffId: 'rowan', date: '2026-01-11', message: 'Would exceed 72 hours in 7 days',
      suggestion: { date: '2026-01-13', activity: 'Clinic' },
      hours: {
        startDate: '2026-01-11', endDate: '2026-01-17', totalHours: 72.5, limitHours: 72, suggestionTotalHours: 63,
        shifts: [
          { date: '2026-01-11', activity: 'Long day', hours: 12.5, fromSwap: true },
          { date: '2026-01-13', activity: 'Clinic', hours: 9.5, fromSwap: false },
        ],
      },
    };
    const html = renderToStaticMarkup(<HoursAlertNotice alert={alert} doctorName="Dr Rowan" initialOpen />);
    expect(html).toContain('role="dialog"');
    expect(html).toContain('Dr Rowan');
    expect(html).toContain('Sun 11 Jan to Sat 17 Jan');
    expect(html).toContain('Long day');
    expect(html).toContain('12.5 h');
    expect(html).toContain('From this swap');
    expect(html).toContain('72.5 h, limit 72 h');
    expect(html).toContain('63 h if Tue 13 Jan is taken as annual leave');
  });

  it('dismisses for Escape and an outside press, but not an inside press', () => {
    expect(shouldDismissHoursAlert({ key: 'Escape' })).toBe(true);
    expect(shouldDismissHoursAlert({ key: 'Enter' })).toBe(false);
    expect(shouldDismissHoursAlert({ inside: false })).toBe(true);
    expect(shouldDismissHoursAlert({ inside: true })).toBe(false);
  });
});
