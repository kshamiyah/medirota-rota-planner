import type { RemovalSummary } from '../references';

/** "X is in use" panel listing exactly what removing it everywhere will do. */
export function RemoveWarning({ what, name, summary: s, onConfirm, onCancel }: {
  what: 'place' | 'shift' | 'group' | 'consultant'; name: string; summary: RemovalSummary; onConfirm: () => void; onCancel: () => void;
}) {
  const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
  return (
    <div className="notice warn" role="alertdialog" aria-label={`Remove ${name}`}>
      <b>The {what} "{name}" is in use. Removing it everywhere will:</b>
      <ul style={{ margin: '6px 0' }}>
        {(s.people ?? 0) > 0 && <li>take it off {n(s.people!, 'person', 'people')} (they stay, just without this group)</li>}
        {s.needs > 0 && <li>remove {n(s.needs, 'staffing need', 'staffing needs')} (including one-off changes)</li>}
        {s.booked > 0 && <li>remove {n(s.booked, 'booked shift', 'booked shifts')}</li>}
        {(s.leave ?? 0) > 0 && <li>remove {n(s.leave!, 'part-day leave entry', 'part-day leave entries')} for this shift</li>}
        {s.rotaShifts > 0 && <li>take {n(s.rotaShifts, 'shift', 'shifts')} out of the current rota</li>}
        {s.rulesDeleted.length > 0 && <li>delete {n(s.rulesDeleted.length, 'rule that only makes sense with it', 'rules that only make sense with it')}: {s.rulesDeleted.map(r => `"${r}"`).join(', ')}</li>}
        {s.rulesChanged.length > 0 && <li>take it out of {n(s.rulesChanged.length, 'rule', 'rules')}: {s.rulesChanged.map(r => `"${r}"`).join(', ')}</li>}
      </ul>
      <div className="row">
        <button className="primary" style={{ background: 'var(--bad)', borderColor: 'var(--bad)' }} onClick={onConfirm}>Remove everywhere</button>
        <button onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
