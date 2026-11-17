import { useEffect, useRef, useState } from 'react';

export interface MultiSection {
  title: string;
  options: { value: string; label: string }[];
  value: string[] | undefined;
  onChange: (v: string[]) => void;
}

/**
 * A button showing a summary ("FY2 and GP trainees"); clicking it opens a
 * tick-list in sections. `clearLabel` is the "nothing picked" choice
 * (e.g. "Everyone"), which `onClear` selects.
 */
export function MultiSelect({ summary, sections, clearLabel, onClear, label, inline, muted, unset, onClose }: {
  summary: string; sections: MultiSection[]; clearLabel: string; onClear: () => void; label: string;
  /** Show as underlined words inside a sentence instead of a button. */
  inline?: boolean;
  /** Inline only: de-emphasise (e.g. an optional "on any day"). */
  muted?: boolean;
  /** Highlight as an example value still to be set. */
  unset?: boolean;
  /** Called when the tick-list closes (picking the same value still counts as setting it). */
  onClose?: () => void;
}) {
  const [open, setOpenState] = useState(false);
  const setOpen = (v: boolean | ((o: boolean) => boolean)) => setOpenState(prev => {
    const next = typeof v === 'function' ? v(prev) : v;
    if (prev && !next) queueMicrotask(() => onClose?.());
    return next;
  });
  const ref = useRef<HTMLDivElement>(null);
  const nothing = sections.every(s => !(s.value?.length));

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  return (
    <div className={`ms ${inline ? 'ms-inline' : ''}`} ref={ref}>
      <button type="button" className={inline ? `slot ${muted ? 'slot-muted' : ''} ${unset ? 'slot-unset' : ''}` : 'ms-button'} aria-haspopup="listbox" aria-expanded={open} aria-label={label} onClick={() => setOpen(o => !o)}>
        <span className="ms-summary">{summary}</span>{!inline && <span aria-hidden="true">▾</span>}
      </button>
      {open && (
        <div className="ms-pop" role="listbox" aria-multiselectable="true">
          <label className="ms-opt">
            <input type="checkbox" checked={nothing} onChange={() => onClear()} /> <b>{clearLabel}</b>
          </label>
          {sections.filter(s => s.options.length > 0).map(s => (
            <div key={s.title}>
              <div className="ms-title">{s.title}</div>
              {s.options.map(o => {
                const checked = !!s.value?.includes(o.value);
                return (
                  <label key={o.value} className="ms-opt">
                    <input type="checkbox" checked={checked}
                      onChange={() => s.onChange(checked ? (s.value ?? []).filter(v => v !== o.value) : [...(s.value ?? []), o.value])} />
                    {' '}{o.label}
                  </label>
                );
              })}
            </div>
          ))}
          <div style={{ textAlign: 'right', paddingTop: 6 }}><button type="button" onClick={() => setOpen(false)}>Done</button></div>
        </div>
      )}
    </div>
  );
}
