import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { addDays, dateRange, weekday } from '../../engine/calendar';
import type { ISODate } from '../../engine/types';
import type { RotaSnapshot } from '../../engine/swaps';
import { formatDateLong, WEEKDAY_NAMES } from './ui';

type Mode = 'leave' | 'cantWork';

export function shortRotaLabel(status: string): string {
  return ({ longDay: 'Long day', night: 'Night', dayJob: 'Day job', zero: 'Zero Day', leave: 'Leave', training: 'Training', partShift: 'Part shift', available: 'Available', notAvailable: 'Not available', blank: '' } as Record<string, string>)[status] ?? status;
}

export function rotaShortCode(status: string): string {
  return ({ longDay: 'LD', night: 'N', dayJob: 'NWD', zero: 'Z', leave: 'AL', training: 'T', partShift: 'Part', available: 'Avail', notAvailable: 'N/A', blank: '' } as Record<string, string>)[status] ?? status;
}

export function initialCalendarMonth(importedWeeks: ISODate[], today: ISODate, selected?: ISODate): string {
  if (selected) return selected.slice(0, 7);
  const dates = [...new Set(importedWeeks.flatMap(start => dateRange(start, addDays(start, 6))))].sort();
  const current = today.slice(0, 7);
  const first = dates[0];
  return first && today < first ? first.slice(0, 7) : current;
}

function localToday(): ISODate {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

export function calendarMonthDates(month: string): (ISODate | null)[] {
  const first = `${month}-01`;
  const nextMonth = month.endsWith('-12') ? `${Number(month.slice(0, 4)) + 1}-01-01` : `${month.slice(0, 5)}${String(Number(month.slice(5)) + 1).padStart(2, '0')}-01`;
  const last = addDays(nextMonth, -1);
  return [...Array(weekday(first)).fill(null), ...dateRange(first, last)];
}

function shiftedMonth(month: string, direction: -1 | 1): string {
  const year = Number(month.slice(0, 4)), value = Number(month.slice(5)) - 1 + direction;
  return `${year + Math.floor(value / 12)}-${String(((value % 12) + 12) % 12 + 1).padStart(2, '0')}`;
}

export function addCalendarRange(value: ISODate[], first: ISODate, last: ISODate): ISODate[] {
  const [start, end] = first <= last ? [first, last] : [last, first];
  return [...new Set([...value, ...dateRange(start, end)])].sort();
}

export function toggleCalendarDate(value: ISODate[], date: ISODate): ISODate[] {
  return value.includes(date) ? value.filter(item => item !== date) : [...value, date].sort();
}

export function calendarPointerAnchor(current: ISODate | undefined, date: ISODate, shiftKey: boolean): ISODate {
  return shiftKey && current ? current : date;
}

export function keyboardCalendarDate(date: ISODate, key: string): ISODate | undefined {
  const delta = key === 'ArrowLeft' ? -1 : key === 'ArrowRight' ? 1 : key === 'ArrowUp' ? -7 : key === 'ArrowDown' ? 7 : 0;
  return delta ? addDays(date, delta) : undefined;
}

export function SwapDateCalendar({ snapshot, staffId, leaveDates, cantWorkDates, onLeaveDates, onCantWorkDates, selectionMode = 'multiple', selectedDate, onSelectedDateChange, forcedMode, payBackOnOwnLeave = false }: {
  snapshot: RotaSnapshot; staffId: string; leaveDates: ISODate[]; cantWorkDates: ISODate[];
  onLeaveDates: (dates: ISODate[]) => void; onCantWorkDates: (dates: ISODate[]) => void;
  selectionMode?: 'multiple' | 'single'; selectedDate?: ISODate; onSelectedDateChange?: (date: ISODate) => void;
  forcedMode?: Mode; payBackOnOwnLeave?: boolean;
}) {
  const imported = Object.keys(snapshot.importedAt).sort();
  const today = localToday();
  const [month, setMonth] = useState(initialCalendarMonth(imported, today));
  const [mode, setMode] = useState<Mode>('leave');
  const [rangeMode, setRangeMode] = useState(false);
  const [rangeStart, setRangeStart] = useState<ISODate>();
  const anchor = useRef<ISODate | undefined>(undefined);
  const dragging = useRef(false);
  const importedDates = useMemo(() => new Set(imported.flatMap(start => dateRange(start, addDays(start, 6)))), [imported]);
  useEffect(() => { setMonth(initialCalendarMonth(imported, today)); }, [staffId, imported.join('|'), today]);
  const cells = calendarMonthDates(month);
  const activeMode = forcedMode ?? mode;
  const value = activeMode === 'leave' ? leaveDates : cantWorkDates;
  const change = activeMode === 'leave' ? onLeaveDates : onCantWorkDates;
  const choose = (date: ISODate, shift = false) => {
    if (!importedDates.has(date)) return;
    if (selectionMode === 'single') { onSelectedDateChange?.(date); anchor.current = date; return; }
    if (rangeMode) {
      if (!rangeStart) { setRangeStart(date); anchor.current = date; return; }
      change(addCalendarRange(value, rangeStart, date)); setRangeStart(undefined); setRangeMode(false); anchor.current = date; return;
    }
    if (shift && anchor.current) change(addCalendarRange(value, anchor.current, date));
    else change(toggleCalendarDate(value, date));
    anchor.current = date;
  };
  const key = (event: KeyboardEvent<HTMLButtonElement>, date: ISODate) => {
    const next = keyboardCalendarDate(date, event.key);
    if (!next) return;
    event.preventDefault();
    if (event.shiftKey && importedDates.has(next)) choose(next, true);
    document.querySelector<HTMLButtonElement>(`[data-swap-date="${next}"]`)?.focus();
  };
  const dragInto = (event: PointerEvent<HTMLButtonElement>, date: ISODate) => {
    if (dragging.current && event.buttons === 1 && anchor.current && importedDates.has(date)) change(addCalendarRange(value, anchor.current, date));
  };
  const monthName = new Date(`${month}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  return (
    <section className="swap-date-calendar" onPointerUp={() => { dragging.current = false; }}>
      {selectionMode === 'multiple' && !forcedMode && <div className="row swap-calendar-controls">
        <div className="seg" aria-label="Dates to pick"><button type="button" className={mode === 'leave' ? 'on' : ''} onClick={() => setMode('leave')}>Leave dates</button><button type="button" className={mode === 'cantWork' ? 'on' : ''} onClick={() => setMode('cantWork')}>Can’t work in return</button></div>
        <button type="button" className="swap-phone-range" onClick={() => { setRangeMode(value => !value); setRangeStart(undefined); }}>{rangeMode ? 'Cancel range' : 'Pick a range'}</button>
      </div>}
      <div className="swap-month-head"><button type="button" aria-label="Previous month" onClick={() => setMonth(value => shiftedMonth(value, -1))}>‹</button><h3>{monthName}</h3><button type="button" aria-label="Next month" onClick={() => setMonth(value => shiftedMonth(value, 1))}>›</button></div>
      <div className="swap-month-grid" role="grid" aria-label={`${monthName}, ${activeMode === 'leave' ? 'leave dates' : 'dates you cannot work in return'}`}>
        {WEEKDAY_NAMES.map(day => <div className="swap-month-weekday" role="columnheader" key={day}>{day.slice(0, 3)}</div>)}
        {cells.map((date, index) => date === null ? <span key={`blank-${index}`} /> : (() => {
          const importedDay = importedDates.has(date); const day = snapshot.days[staffId]?.[date];
          const leave = selectionMode === 'multiple' && leaveDates.includes(date), cant = selectionMode === 'multiple' && cantWorkDates.includes(date);
          const kind = shortRotaLabel(day?.status ?? 'blank'); const activity = day?.activity ?? '';
          const canPayBack = payBackOnOwnLeave && activeMode === 'cantWork' && day?.status === 'leave' && !leave && !cant;
          const onCall = day?.status === 'longDay' || day?.status === 'night';
          const picked = selectionMode === 'single' ? selectedDate === date : leave;
          return <button type="button" role="gridcell" data-swap-date={date} disabled={!importedDay} className={`${canPayBack ? 'swap-can-pay-back' : ''} ${picked ? 'picked-leave' : ''} ${cant ? 'picked-cant' : ''} ${onCall ? `on-call ${day?.status}` : ''}`} key={date}
            aria-label={`${formatDateLong(date)}${picked ? ', selected' : ''}${leave ? ', leave date' : ''}${cant ? ', cannot work in return' : ''}${canPayBack ? ', can pay back' : ''}${kind ? `, ${kind}` : ''}${activity ? `, ${activity}` : ''}`}
            onClick={event => choose(date, event.shiftKey)} onKeyDown={event => selectionMode === 'multiple' ? key(event, date) : undefined} onPointerDown={event => { if (selectionMode === 'multiple') { dragging.current = true; anchor.current = calendarPointerAnchor(anchor.current, date, event.shiftKey); } }} onPointerEnter={event => { if (selectionMode === 'multiple') dragInto(event, date); }}>
            <span className="swap-day-number">{Number(date.slice(8))}</span><span className="swap-day-kind" data-short={rotaShortCode(day?.status ?? 'blank')}>{kind}</span>{activity && <span className="swap-day-activity">{activity}</span>}
            <span className="swap-day-marks">{canPayBack && <small>Can pay back</small>}{leave && <small>Leave</small>}{cant && <small>Can’t work</small>}</span>
          </button>;
        })())}
      </div>
      {selectionMode === 'multiple' && rangeMode && <p className="small muted">{rangeStart ? 'Now pick the last day.' : 'Pick the first day of the range.'}</p>}
    </section>
  );
}
