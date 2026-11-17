import { useState } from 'react';
import type { Demand, Weekday } from '../../engine/types';
import { newId, update, useWorkspace } from '../store';
import { ALL_WEEKDAYS, Empty, PageHead, WEEKDAY_NAMES, formatDateLong } from '../components/ui';
import { MustIncludeCell } from '../components/MustInclude';

type Cell = { min: number; max: number };

/** Weekday pattern for a place+shift, ignoring one-off (date-specific) changes. */
function cellsFor(demands: Demand[], roleId: string, shiftTypeId: string): Cell[] {
  return ALL_WEEKDAYS.map(wd => {
    const ds = demands.filter(d => d.roleId === roleId && d.shiftTypeId === shiftTypeId && !(d.days.dates?.length)
      && (!d.days.weekdays?.length || d.days.weekdays.includes(wd)));
    return { min: ds.reduce((t, d) => t + d.min, 0), max: ds.reduce((t, d) => t + d.max, 0) };
  });
}

/** Rewrite a row's weekday demands, grouping days that share the same numbers. */
function writeCells(demands: Demand[], roleId: string, shiftTypeId: string, cells: Cell[], importance?: number): Demand[] {
  const keep = demands.filter(d => !(d.roleId === roleId && d.shiftTypeId === shiftTypeId && !(d.days.dates?.length)));
  const groups = new Map<string, Weekday[]>();
  cells.forEach((c, wd) => {
    if (c.max <= 0 && c.min <= 0) return;
    const k = `${c.min}|${c.max}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(wd as Weekday);
  });
  for (const [k, weekdays] of groups) {
    const [min, max] = k.split('|').map(Number);
    keep.push({ id: newId('need'), roleId, shiftTypeId, days: { weekdays }, min, max, ...(importance ? { importance } : {}) });
  }
  // Keep the row visible while every day is zero.
  if (groups.size === 0) keep.push({ id: newId('need'), roleId, shiftTypeId, days: { weekdays: [...ALL_WEEKDAYS] }, min: 0, max: 0 });
  return keep;
}

export function Staffing() {
  const ws = useWorkspace();
  const { roles, shiftTypes, demands } = ws.profile;
  const [addRole, setAddRole] = useState('');
  const [addShift, setAddShift] = useState('');
  const roleName = (id: string) => roles.find(r => r.id === id)?.name ?? id;
  const shiftName = (id: string) => shiftTypes.find(s => s.id === id)?.name ?? id;

  const rows = [...new Map(demands.filter(d => !(d.days.dates?.length)).map(d => [`${d.roleId}|${d.shiftTypeId}`, d])).values()]
    .sort((a, b) => roles.findIndex(r => r.id === a.roleId) - roles.findIndex(r => r.id === b.roleId)
      || shiftTypes.findIndex(s => s.id === a.shiftTypeId) - shiftTypes.findIndex(s => s.id === b.shiftTypeId));
  const oneOffs = demands.filter(d => d.days.dates?.length && d.source !== 'medirota');
  const imported = demands.filter(d => d.source === 'medirota' && d.max > 0);

  if (roles.length === 0 || shiftTypes.length === 0) {
    return (<><PageHead title="Staffing needs" /><div className="card"><Empty>Add some shifts and places first.</Empty></div></>);
  }

  const setCell = (roleId: string, shiftTypeId: string, wd: number, field: 'min' | 'max', value: number) => update(w => {
    const cells = cellsFor(w.profile.demands, roleId, shiftTypeId);
    const imp = w.profile.demands.find(d => d.roleId === roleId && d.shiftTypeId === shiftTypeId)?.importance;
    const v = Math.max(0, Math.floor(value || 0));
    cells[wd][field] = v;
    if (field === 'min' && cells[wd].max < v) cells[wd].max = v;
    if (field === 'max' && cells[wd].min > v) cells[wd].min = v;
    w.profile.demands = writeCells(w.profile.demands, roleId, shiftTypeId, cells, imp);
  });

  const setImportance = (roleId: string, shiftTypeId: string, importance: number) => update(w => {
    w.profile.demands.forEach(d => { if (d.roleId === roleId && d.shiftTypeId === shiftTypeId) d.importance = importance === 1 ? undefined : importance; });
  });

  const addRow = () => {
    if (!addRole || !addShift) return;
    update(w => {
      if (w.profile.demands.some(d => d.roleId === addRole && d.shiftTypeId === addShift)) return;
      w.profile.demands.push({ id: newId('need'), roleId: addRole, shiftTypeId: addShift, days: { weekdays: [0, 1, 2, 3, 4] }, min: 1, max: 1 });
    });
  };

  return (
    <>
      <PageHead title="Staffing needs">
        How many doctors each place needs on each shift. <b>Min</b> must be filled; up to <b>max</b> can be used if there are spare doctors.
      </PageHead>
      <div className="card flush">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Place</th><th>Shift</th><th title="Grades or people who must be among the doctors here">Must include</th>
                {WEEKDAY_NAMES.map(d => <th key={d} style={{ textAlign: 'center' }}>{d}<div className="small muted">min · max</div></th>)}
                <th title="How much it matters to fill this when not everything can be filled">Priority</th><th />
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={12}><Empty>No staffing needs yet. Add a place and shift below.</Empty></td></tr>}
              {rows.map(r => {
                const cells = cellsFor(demands, r.roleId, r.shiftTypeId);
                return (
                  <tr key={`${r.roleId}|${r.shiftTypeId}`}>
                    <td><b>{roleName(r.roleId)}</b></td>
                    <td>{shiftName(r.shiftTypeId)}</td>
                    <MustIncludeCell roleId={r.roleId} shiftTypeId={r.shiftTypeId} />
                    {cells.map((c, wd) => (
                      <td key={wd} style={{ textAlign: 'center', whiteSpace: 'nowrap', opacity: c.max === 0 ? 0.45 : 1 }}>
                        <input type="number" min={0} value={c.min} style={{ width: 42 }} aria-label={`${roleName(r.roleId)} ${shiftName(r.shiftTypeId)} ${WEEKDAY_NAMES[wd]} minimum`}
                          onChange={e => setCell(r.roleId, r.shiftTypeId, wd, 'min', Number(e.target.value))} />
                        {' '}
                        <input type="number" min={0} value={c.max} style={{ width: 42 }} aria-label={`${roleName(r.roleId)} ${shiftName(r.shiftTypeId)} ${WEEKDAY_NAMES[wd]} maximum`}
                          onChange={e => setCell(r.roleId, r.shiftTypeId, wd, 'max', Number(e.target.value))} />
                      </td>
                    ))}
                    <td>
                      <select value={r.importance ?? 1} onChange={e => setImportance(r.roleId, r.shiftTypeId, Number(e.target.value))}>
                        <option value={1}>Normal</option><option value={2}>High</option><option value={3}>Essential</option>
                      </select>
                    </td>
                    <td><button className="ghost danger" onClick={() => update(w => { w.profile.demands = w.profile.demands.filter(d => !(d.roleId === r.roleId && d.shiftTypeId === r.shiftTypeId)); })}>Remove</button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      <div className="card row">
        <span>Add a need:</span>
        <select value={addRole} onChange={e => setAddRole(e.target.value)}><option value="">Place…</option>{roles.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}</select>
        <select value={addShift} onChange={e => setAddShift(e.target.value)}><option value="">Shift…</option>{shiftTypes.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
        <button onClick={addRow} disabled={!addRole || !addShift}>Add row</button>
      </div>

      {imported.length > 0 && (
        <div className="notice">
          {imported.length} consultant {imported.length === 1 ? 'list' : 'lists'} on particular days came from MediRota. On those days they replace the usual need for their place. See Places to change consultants or import again.
        </div>
      )}
      <OneOffs oneOffs={oneOffs} roleName={roleName} shiftName={shiftName} />
    </>
  );
}

function OneOffs({ oneOffs, roleName, shiftName }: { oneOffs: Demand[]; roleName: (id: string) => string; shiftName: (id: string) => string }) {
  const ws = useWorkspace();
  const [date, setDate] = useState(ws.period.start);
  const [role, setRole] = useState('');
  const [shift, setShift] = useState('');
  const [min, setMin] = useState(0);
  const [max, setMax] = useState(0);
  return (
    <div className="card">
      <h2>One-off changes</h2>
      <p className="muted">A cancelled list, an extra clinic or a bank holiday. On that date this replaces the usual number.</p>
      {oneOffs.length > 0 && (
        <table style={{ marginBottom: 12 }}>
          <thead><tr><th>Date</th><th>Place</th><th>Shift</th><th>Min</th><th>Max</th><th /></tr></thead>
          <tbody>
            {oneOffs.map(d => (
              <tr key={d.id}>
                <td>{d.days.dates!.map(formatDateLong).join(', ')}</td><td>{roleName(d.roleId)}</td><td>{shiftName(d.shiftTypeId)}</td>
                <td>{d.min}</td><td>{d.max}{d.max === 0 && <span className="pill" style={{ marginLeft: 6 }}>cancelled</span>}</td>
                <td><button className="ghost danger" onClick={() => update(w => { w.profile.demands = w.profile.demands.filter(x => x.id !== d.id); })}>Remove</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="row">
        <input type="date" value={date} onChange={e => setDate(e.target.value)} />
        <select value={role} onChange={e => setRole(e.target.value)}><option value="">Place…</option>{ws.profile.roles.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}</select>
        <select value={shift} onChange={e => setShift(e.target.value)}><option value="">Shift…</option>{ws.profile.shiftTypes.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
        <label className="row small muted">min <input type="number" min={0} value={min} onChange={e => setMin(Math.max(0, Number(e.target.value)))} /></label>
        <label className="row small muted">max <input type="number" min={0} value={max} onChange={e => setMax(Math.max(0, Number(e.target.value)))} /></label>
        <button disabled={!role || !shift || !date} onClick={() => update(w => {
          w.profile.demands.push({ id: newId('oneoff'), roleId: role, shiftTypeId: shift, days: { dates: [date] }, min: Math.min(min, Math.max(min, max)), max: Math.max(min, max) });
        })}>Add change</button>
      </div>
    </div>
  );
}
