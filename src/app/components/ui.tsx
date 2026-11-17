import type { ReactNode } from 'react';
import type { Weekday } from '../../engine/types';

export const WEEKDAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export const ALL_WEEKDAYS: Weekday[] = [0, 1, 2, 3, 4, 5, 6];

/** Toggle buttons for picking several options. Empty selection usually means "all". */
export function Chips<T extends string | number>({ options, value, onChange, allLabel }: {
  options: { value: T; label: string }[];
  value: T[] | undefined;
  onChange: (v: T[]) => void;
  /** If set, shows an "all" chip that clears the selection. */
  allLabel?: string;
}) {
  const sel = value ?? [];
  const toggle = (v: T) => onChange(sel.includes(v) ? sel.filter(x => x !== v) : [...sel, v]);
  return (
    <div className="chips">
      {allLabel !== undefined && (
        <button type="button" className={`chip ${sel.length === 0 ? 'on' : ''}`} onClick={() => onChange([])}>{allLabel}</button>
      )}
      {options.map(o => (
        <button type="button" key={String(o.value)} className={`chip ${sel.includes(o.value) ? 'on' : ''}`} onClick={() => toggle(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function WeekdayChips({ value, onChange, allLabel }: { value: Weekday[] | undefined; onChange: (v: Weekday[]) => void; allLabel?: string }) {
  return <Chips options={ALL_WEEKDAYS.map(d => ({ value: d, label: WEEKDAY_NAMES[d] }))} value={value} onChange={onChange} allLabel={allLabel} />;
}

export function PageHead({ title, children, actions }: { title: string; children?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-head">
      <div className="grow">
        <h1>{title}</h1>
        {children && <p className="muted">{children}</p>}
      </div>
      {actions && <div className="row">{actions}</div>}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

/** Stable colour index for a role category, so the same category always looks the same. */
export function categoryClass(categories: string[], category: string | undefined): string {
  const i = category ? categories.indexOf(category) : -1;
  return `cat-${i < 0 ? 7 : i % 8}`;
}

export function formatDay(iso: string): { dow: string; day: string; month: string } {
  const d = new Date(iso + 'T00:00:00Z');
  return {
    dow: WEEKDAY_NAMES[(d.getUTCDay() + 6) % 7],
    day: String(d.getUTCDate()),
    month: d.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' }),
  };
}

export function formatDateLong(iso: string): string {
  const date = new Date(iso + 'T00:00:00Z');
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${weekdays[date.getUTCDay()]} ${date.getUTCDate()} ${months[date.getUTCMonth()]}`;
}
