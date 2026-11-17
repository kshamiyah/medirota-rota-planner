import { useState } from 'react';
import { shiftHours } from '../../engine/calendar';
import { newId, update, useWorkspace } from '../store';
import { isUsed, previewRemoveShift, removeShift, type RemovalSummary } from '../references';
import { RemoveWarning } from '../components/RemoveWarning';
import { Empty, PageHead } from '../components/ui';

const PRESETS = [
  { name: 'AM', start: '08:00', end: '13:00' },
  { name: 'PM', start: '13:00', end: '17:00' },
  { name: 'Long day', start: '08:00', end: '20:30' },
  { name: 'Night', start: '20:00', end: '08:30' },
];

export function Shifts() {
  const ws = useWorkspace();
  const shifts = ws.profile.shiftTypes;
  const [pending, setPending] = useState<{ id: string; name: string; summary: RemovalSummary } | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const remove = (id: string, name: string) => {
    setDone(null);
    const summary = previewRemoveShift(ws, id);
    if (isUsed(summary)) { setPending({ id, name, summary }); return; }
    update(w => { removeShift(w, id); });
  };
  const confirmRemove = () => {
    if (!pending) return;
    update(w => { removeShift(w, pending.id); });
    setDone(`Removed "${pending.name}" everywhere.`);
    setPending(null);
  };

  const add = (p = { name: 'New shift', start: '09:00', end: '17:00' }) =>
    update(w => { w.profile.shiftTypes.push({ id: newId('shift'), ...p }); });

  return (
    <>
      <PageHead title="Shifts" actions={<button className="primary" onClick={() => add()}>Add shift</button>}>
        The working periods in your department. A shift that ends at or before it starts runs overnight.
      </PageHead>
      {pending && <RemoveWarning what="shift" name={pending.name} summary={pending.summary} onConfirm={confirmRemove} onCancel={() => setPending(null)} />}
      {done && <div className="notice ok">{done}</div>}
      <div className="card flush">
        {shifts.length === 0 ? (
          <Empty>
            <p>No shifts yet. Start from common ones:</p>
            <div className="row" style={{ justifyContent: 'center' }}>
              {PRESETS.map(p => <button key={p.name} onClick={() => add(p)}>+ {p.name} ({p.start}–{p.end})</button>)}
            </div>
          </Empty>
        ) : (
          <div className="table-wrap">
          <table>
            <thead><tr><th>Name</th><th>Starts</th><th>Ends</th><th>Hours</th><th /></tr></thead>
            <tbody>
              {shifts.map((s, i) => (
                <tr key={s.id}>
                  <td><input value={s.name} onChange={e => update(w => { w.profile.shiftTypes[i].name = e.target.value; })} /></td>
                  <td><input type="time" value={s.start} onChange={e => update(w => { w.profile.shiftTypes[i].start = e.target.value; })} /></td>
                  <td>
                    <input type="time" value={s.end} onChange={e => update(w => { w.profile.shiftTypes[i].end = e.target.value; })} />
                    {s.end <= s.start && <span className="pill" style={{ marginLeft: 6 }}>overnight</span>}
                  </td>
                  <td>{shiftHours(s).toFixed(1)}h</td>
                  <td style={{ textAlign: 'right' }}>
                    <button className="ghost danger" onClick={() => remove(s.id, s.name)}>Remove</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </div>
      {shifts.length > 0 && (
        <div className="row">
          <span className="muted small">Quick add:</span>
          {PRESETS.filter(p => !shifts.some(s => s.name === p.name)).map(p => <button key={p.name} onClick={() => add(p)}>+ {p.name}</button>)}
        </div>
      )}
    </>
  );
}
