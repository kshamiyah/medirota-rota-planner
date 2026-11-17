import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { Profile, Rule } from '../../engine/types';
import { update } from '../store';
import { describeRule } from '../rules/sentence';
import { continuityOf, gridRows, limitDefs, readAccess, readTarget, writeAccess, writeTarget, type Access, type Row, type Target } from '../rules/grid';

const rowName = (p: Profile, row: Row) =>
  row.kind === 'group' ? p.groups.find(g => g.id === row.id)?.name ?? '?' : p.staff.find(s => s.id === row.id)?.name ?? '?';
const shiftName = (p: Profile, id: string) => p.shiftTypes.find(s => s.id === id)?.name ?? id;
/** Shifts a place is staffed on (falls back to every shift). */
const shiftsAt = (p: Profile, placeId: string) => {
  const ids = [...new Set(p.demands.filter(d => d.roleId === placeId && d.max > 0).map(d => d.shiftTypeId))];
  return ids.length ? ids : p.shiftTypes.map(s => s.id);
};
const syncNames = (w: { profile: Profile }) => { w.profile.rules.forEach(r => { r.name = describeRule(w.profile, r); }); };

/**
 * A table cell that opens a small editing panel beside it. The panel floats
 * above the page (rendered at the end of <body>) so the table's scrolling box
 * can't cut it off; it opens upwards when there isn't room below.
 */
export function Cell({ label, tone, children, ariaLabel, header }: { label: ReactNode; tone: string; children: (close: () => void) => ReactNode; ariaLabel: string; header?: boolean }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<CSSProperties>({});
  const cellRef = useRef<HTMLTableCellElement>(null);
  const Tag = header ? 'th' : 'td';
  const popRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const cell = cellRef.current?.getBoundingClientRect();
      const pop = popRef.current?.getBoundingClientRect();
      if (!cell) return;
      const width = pop?.width ?? 270, height = pop?.height ?? 220, gap = 6, margin = 8;
      const left = Math.min(Math.max(margin, cell.left + cell.width / 2 - width / 2), window.innerWidth - width - margin);
      const below = window.innerHeight - cell.bottom - gap >= height + margin || cell.top < height + gap + margin;
      setPos(below ? { left, top: cell.bottom + gap } : { left, top: cell.top - gap - height });
    };
    place();
    const raf = requestAnimationFrame(place); // again once the panel has its real size
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => { cancelAnimationFrame(raf); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!cellRef.current?.contains(t) && !popRef.current?.contains(t)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key); };
  }, [open]);

  return (
    <Tag ref={cellRef} className="grid-cell">
      <button className={`grid-cell-btn ${tone} ${open ? 'open' : ''}`} onClick={() => setOpen(o => !o)} aria-label={ariaLabel} aria-expanded={open}>{label}</button>
      {open && createPortal(
        <div ref={popRef} className="cell-pop" role="dialog" aria-label={ariaLabel} style={pos}>{children(() => setOpen(false))}</div>,
        document.body,
      )}
    </Tag>
  );
}

function RowAdder({ profile: p, rows, onAdd }: { profile: Profile; rows: Row[]; onAdd: (id: string) => void }) {
  const others = p.staff.filter(s => !rows.some(r => r.kind === 'person' && r.id === s.id));
  if (others.length === 0) return null;
  return (
    <div className="row" style={{ padding: '10px 12px' }}>
      <span className="small muted">Need a rule for one doctor?</span>
      <select value="" onChange={e => e.target.value && onAdd(e.target.value)} aria-label="Add a row for one doctor">
        <option value="">+ Add a row for…</option>
        {others.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select>
    </div>
  );
}

// ---------------- Who can work where ----------------

function accessLabel(p: Profile, a: Access): { text: string; tone: string } {
  if (a.never) return { text: '✗ Never', tone: 'tone-bad' };
  const parts: string[] = [];
  if (a.blockedShifts.length) parts.push(`No ${a.blockedShifts.map(id => shiftName(p, id)).join('/')}`);
  if (a.limit) parts.push(`Max ${a.limit.max}/${a.limit.period === 'week' ? 'wk' : 'mth'}`);
  if (a.avoid) parts.push('Avoid');
  if (!parts.length) return { text: '✓', tone: 'tone-ok' };
  return { text: parts.join(' · '), tone: a.avoid && parts.length === 1 ? 'tone-warn' : 'tone-mid' };
}

export function AccessGrid({ profile: p }: { profile: Profile }) {
  const [extra, setExtra] = useState<string[]>([]);
  const rows = gridRows(p, 'access', extra);
  if (p.roles.length === 0 || rows.length === 0) return <div className="empty">Add places and groups first.</div>;
  const save = (row: Row, placeId: string, a: Access) => update(w => { writeAccess(w.profile, row, placeId, a); syncNames(w); });
  return (
    <>
      <div className="table-wrap">
        <table className="rule-grid">
          <thead><tr><th className="sticky-col" />{p.roles.map(r => <PlaceHeader key={r.id} profile={p} roleId={r.id} />)}</tr></thead>
          <tbody>
            {rows.map(row => (
              <tr key={`${row.kind}-${row.id}`}>
                <th className="sticky-col row-head">{rowName(p, row)}{row.kind === 'person' && <span className="pill" style={{ marginLeft: 6 }}>doctor</span>}</th>
                {p.roles.map(place => {
                  const a = readAccess(p, row, place.id);
                  const { text, tone } = accessLabel(p, a);
                  return (
                    <Cell key={place.id} label={text} tone={tone} ariaLabel={`${rowName(p, row)} at ${place.name}`}>
                      {close => <AccessEditor profile={p} title={`${rowName(p, row)} at ${place.name}`} shifts={shiftsAt(p, place.id)} value={a} onChange={v => save(row, place.id, v)} close={close} />}
                    </Cell>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <RowAdder profile={p} rows={rows} onAdd={id => setExtra(e => [...e, id])} />
    </>
  );
}

/** Place heading: click it to keep the same doctor there for several days running. */
function PlaceHeader({ profile: p, roleId }: { profile: Profile; roleId: string }) {
  const place = p.roles.find(r => r.id === roleId)!;
  const rule = continuityOf(p, roleId);
  const set = (runDays: number | undefined) => update(w => {
    const existing = continuityOf(w.profile, roleId);
    if (runDays === undefined) w.profile.rules = w.profile.rules.filter(r => r !== existing);
    else if (existing) existing.runDays = runDays;
    else w.profile.rules.push({ id: `rule-cont-${roleId}`, name: '', type: 'continuity', hard: false, roleId, runDays });
    syncNames(w);
  });
  return (
    <Cell header tone="grid-head" ariaLabel={`${place.name}: same doctor several days running`}
      label={<span>{place.name}{rule && <span className="head-note">↻ same doctor {rule.runDays} days</span>}</span>}>
      {close => (
        <div className="stack" style={{ gap: 10 }}>
          <b>{place.name}</b>
          <label className="pop-opt">
            <input type="checkbox" checked={!!rule} onChange={e => set(e.target.checked ? 3 : undefined)} />
            Keep the same doctor for up to
            <input type="number" min={2} value={rule?.runDays ?? 3} style={{ width: 52 }} aria-label="Days running" onChange={e => set(Math.max(2, Number(e.target.value)))} />
            days running
          </label>
          <p className="small muted" style={{ margin: 0 }}>Where possible: it gives way to cover, training needs and fairness.</p>
          <div style={{ textAlign: 'right' }}><button className="primary" onClick={close}>Done</button></div>
        </div>
      )}
    </Cell>
  );
}

function AccessEditor({ profile: p, title, shifts, value: a, onChange, close }: {
  profile: Profile; title: string; shifts: string[]; value: Access; onChange: (a: Access) => void; close: () => void;
}) {
  const mode = a.never ? 'never' : a.avoid ? 'avoid' : 'yes';
  return (
    <div className="stack" style={{ gap: 10 }}>
      <b>{title}</b>
      <div className="stack" style={{ gap: 4 }}>
        <label className="pop-opt"><input type="radio" checked={mode === 'yes'} onChange={() => onChange({ ...a, never: false, avoid: false })} /> Can work here</label>
        <label className="pop-opt"><input type="radio" checked={mode === 'avoid'} onChange={() => onChange({ ...a, never: false, avoid: true })} /> Avoid if possible</label>
        <label className="pop-opt"><input type="radio" checked={mode === 'never'} onChange={() => onChange({ never: true, avoid: false, blockedShifts: [] })} /> Never</label>
      </div>
      {!a.never && shifts.length > 1 && (
        <div>
          <div className="small muted">Not on these shifts:</div>
          <div className="chips" style={{ marginTop: 4 }}>
            {shifts.map(id => {
              const on = a.blockedShifts.includes(id);
              return <button key={id} type="button" className={`chip ${on ? 'on' : ''}`} onClick={() => onChange({ ...a, blockedShifts: on ? a.blockedShifts.filter(x => x !== id) : [...a.blockedShifts, id] })}>{shiftName(p, id)}</button>;
            })}
          </div>
        </div>
      )}
      {!a.never && (
        <label className="pop-opt">
          <input type="checkbox" checked={!!a.limit} onChange={e => onChange({ ...a, limit: e.target.checked ? { max: 1, period: 'week' } : undefined })} />
          At most
          <input type="number" min={0} value={a.limit?.max ?? 1} style={{ width: 52 }} aria-label="At most"
            onChange={e => onChange({ ...a, limit: { max: Math.max(0, Number(e.target.value)), period: a.limit?.period ?? 'week' } })} />
          <select value={a.limit?.period ?? 'week'} aria-label="Per"
            onChange={e => onChange({ ...a, limit: { max: a.limit?.max ?? 1, period: e.target.value as 'week' | 'month' } })}>
            <option value="week">a week</option><option value="month">a month</option>
          </select>
        </label>
      )}
      <div style={{ textAlign: 'right' }}><button className="primary" onClick={close}>Done</button></div>
    </div>
  );
}

// ---------------- Training needs ----------------

export function TrainingGrid({ profile: p }: { profile: Profile }) {
  const [extra, setExtra] = useState<string[]>([]);
  const rows = gridRows(p, 'training', extra);
  if (p.roles.length === 0 || rows.length === 0) return <div className="empty">Add places and groups first.</div>;
  const save = (row: Row, placeId: string, t: Target | undefined) => update(w => { writeTarget(w.profile, row, placeId, t); syncNames(w); });
  return (
    <>
      <div className="table-wrap">
        <table className="rule-grid">
          <thead><tr><th className="sticky-col" />{p.roles.map(r => <th key={r.id}>{r.name}</th>)}</tr></thead>
          <tbody>
            {rows.map(row => (
              <tr key={`${row.kind}-${row.id}`}>
                <th className="sticky-col row-head">{rowName(p, row)}{row.kind === 'person' && <span className="pill" style={{ marginLeft: 6 }}>doctor</span>}</th>
                {p.roles.map(place => {
                  const t = readTarget(p, row, place.id);
                  const label = t ? `≥ ${t.min}/${t.period === 'week' ? 'wk' : 'mth'}` : '+';
                  return (
                    <Cell key={place.id} label={label} tone={t ? 'tone-mid' : 'tone-empty'} ariaLabel={`Training target: ${rowName(p, row)} at ${place.name}`}>
                      {close => (
                        <div className="stack" style={{ gap: 10 }}>
                          <b>{rowName(p, row)} at {place.name}</b>
                          <label className="pop-opt">
                            <input type="checkbox" checked={!!t} onChange={e => save(row, place.id, e.target.checked ? { min: 1, period: 'week', partTimeLess: true } : undefined)} />
                            At least
                            <input type="number" min={1} value={t?.min ?? 1} style={{ width: 52 }} aria-label="At least"
                              onChange={e => save(row, place.id, { period: 'week', partTimeLess: true, ...t, min: Math.max(1, Number(e.target.value)) })} />
                            <select value={t?.period ?? 'week'} aria-label="Per"
                              onChange={e => save(row, place.id, { min: 1, partTimeLess: true, ...t, period: e.target.value as 'week' | 'month' })}>
                              <option value="week">a week</option><option value="month">a month</option>
                            </select>
                          </label>
                          {t && (
                            <label className="pop-opt small">
                              <input type="checkbox" checked={t.partTimeLess} onChange={e => save(row, place.id, { ...t, partTimeLess: e.target.checked })} />
                              Less for part-timers
                            </label>
                          )}
                          <p className="small muted" style={{ margin: 0 }}>Training targets are met before work is shared out fairly.</p>
                          <div style={{ textAlign: 'right' }}><button className="primary" onClick={close}>Done</button></div>
                        </div>
                      )}
                    </Cell>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <RowAdder profile={p} rows={rows} onAdd={id => setExtra(e => [...e, id])} />
    </>
  );
}

// ---------------- Working-time limits ----------------

const NOT_A_LIMIT: Rule = { id: '', name: '', type: 'forbid', hard: true, work: {} };

export function LimitsList({ profile: p }: { profile: Profile }) {
  const defs = limitDefs(p);
  const find = (match: (r: Rule) => boolean) => p.rules.find(match);
  return (
    <div>
      {defs.map(d => {
        const rule = find(d.matches);
        const on = !!rule && rule.enabled !== false;
        // A rule of another kind makes `values` fall back to the standard contract figure.
        const vals = d.values(rule ?? NOT_A_LIMIT);
        const setVals = (next: number[]) => update(w => {
          const r = w.profile.rules.find(d.matches);
          if (r) d.apply(r, next); else w.profile.rules.push(d.make(next));
          syncNames(w);
        });
        const toggle = (v: boolean) => update(w => {
          const r = w.profile.rules.find(d.matches);
          if (r) r.enabled = v ? undefined : false;
          else if (v) w.profile.rules.push(d.make(vals));
          syncNames(w);
        });
        return (
          <div key={d.id} className={`limit-row ${on ? '' : 'off'}`}>
            <label className="switch" title={on ? 'On' : 'Off'}>
              <input type="checkbox" checked={on} onChange={e => toggle(e.target.checked)} aria-label={`${d.label} ${on ? 'on' : 'off'}`} />
              <span />
            </label>
            <span className="limit-label">{d.label}{d.offByDefault && <div className="small muted" style={{ fontWeight: 400 }}>optional</div>}</span>
            <span className="limit-text">
              {d.parts.map((part, i) => (
                <span key={i}>
                  {part}{' '}
                  {i < vals.length && (
                    <input type="number" className="limit-num" min={0} value={vals[i]} disabled={!on} aria-label={`${d.label} value ${i + 1}`}
                      onChange={e => setVals(vals.map((v, j) => (j === i ? Math.max(0, Number(e.target.value)) : v)))} />
                  )}{' '}
                </span>
              ))}
            </span>
          </div>
        );
      })}
    </div>
  );
}
