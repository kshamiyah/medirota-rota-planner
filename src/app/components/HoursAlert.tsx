import { useEffect, useRef, useState } from 'react';
import type { SwapAlert } from '../../engine/swaps';
import { formatDateLong } from './ui';

export function formatHours(hours: number): string {
  return (Math.round(hours * 10) / 10).toString();
}

export function shouldDismissHoursAlert(event: { key?: string; inside?: boolean }): boolean {
  return event.key === 'Escape' || event.inside === false;
}

export function HoursBreakdown({ alert }: { alert: SwapAlert }) {
  const hours = alert.hours;
  if (!hours) return null;
  return (
    <div className="swap-hours-popover" role="dialog" aria-label="Hours alert breakdown">
      <p className="swap-hours-window"><b>{formatDateLong(hours.startDate)} to {formatDateLong(hours.endDate)}</b></p>
      <ul className="plain-list swap-hours-list">
        {hours.shifts.map((shift, index) => <li key={`${shift.date}-${shift.activity}-${index}`}>
          <span><b>{formatDateLong(shift.date)}</b>: {shift.activity}</span>
          <span>{formatHours(shift.hours)} h {shift.fromSwap && <em>From this swap</em>}</span>
        </li>)}
      </ul>
      <p className="swap-hours-total"><b>{formatHours(hours.totalHours)} h, limit {formatHours(hours.limitHours)} h</b></p>
      {alert.suggestion && hours.suggestionTotalHours !== undefined && <p>{formatHours(hours.suggestionTotalHours)} h if {formatDateLong(alert.suggestion.date)} is taken as annual leave.</p>}
    </div>
  );
}

export function HoursAlertNotice({ alert, doctorName, initialOpen = false }: { alert: SwapAlert; doctorName: string; initialOpen?: boolean }) {
  const [open, setOpen] = useState(initialOpen);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (shouldDismissHoursAlert({ inside: !!root.current?.contains(event.target as Node) })) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (shouldDismissHoursAlert({ key: event.key })) setOpen(false); };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [open]);

  return (
    <div className="notice warn swap-hours-alert" ref={root}>
      <button type="button" className="swap-hours-alert-trigger" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(value => !value)}>
        <span><b>{doctorName}, {formatDateLong(alert.date)}:</b> {alert.message}. This warning does not stop the swap.</span>
        <span className="swap-hours-open">{open ? 'Hide hours' : 'See hours'}</span>
      </button>
      {open && <HoursBreakdown alert={alert} />}
    </div>
  );
}
