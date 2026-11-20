import { useState } from 'react';
import { newId, update, useWorkspace } from '../store';
import { isUsed, previewRemoveLead, previewRemovePlace, removeLead, removePlace, type RemovalSummary } from '../references';
import { RemoveWarning } from '../components/RemoveWarning';
import { Empty, PageHead, categoryClass } from '../components/ui';
import { placeName } from '../placeName';

export function Places() {
  const ws = useWorkspace();
  const roles = ws.profile.roles;
  const leads = ws.profile.leads ?? [];
  const places = roles.filter(r => !r.parentId);
  const categories = [...new Set(roles.map(r => r.category).filter((c): c is string => !!c))];
  const [pending, setPending] = useState<{ kind: 'place' | 'consultant'; id: string; name: string; summary: RemovalSummary } | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [newLead, setNewLead] = useState('');
  const leadName = (id: string) => leads.find(l => l.id === id)?.name ?? 'a removed consultant';

  const remove = (id: string, name: string) => {
    setDone(null);
    const summary = previewRemovePlace(ws, id);
    if (isUsed(summary)) { setPending({ kind: 'place', id, name, summary }); return; }
    update(w => { removePlace(w, id); });
  };
  const removeConsultant = (id: string, name: string) => {
    setDone(null);
    const summary = previewRemoveLead(ws, id);
    if (isUsed(summary)) { setPending({ kind: 'consultant', id, name, summary }); return; }
    update(w => { removeLead(w, id); });
  };
  const confirmRemove = () => {
    if (!pending) return;
    update(w => { if (pending.kind === 'place') removePlace(w, pending.id); else removeLead(w, pending.id); });
    setDone(`Removed "${pending.name}" everywhere.`);
    setPending(null);
  };
  const addLead = () => {
    const name = newLead.trim();
    if (!name || leads.some(l => l.name.toLowerCase() === name.toLowerCase())) return;
    update(w => { (w.profile.leads ??= []).push({ id: newId('cons'), name }); });
    setNewLead('');
  };

  return (
    <>
      <PageHead title="Places" actions={<button className="primary" onClick={() => update(w => { w.profile.roles.push({ id: newId('place'), name: 'New place' }); })}>Add place</button>}>
        Wards, theatres, clinics and on-call roles that need a doctor. Give them a group (e.g. "Theatre") to write rules about a whole group at once.
      </PageHead>
      {pending && <RemoveWarning what={pending.kind} name={pending.name} summary={pending.summary} onConfirm={confirmRemove} onCancel={() => setPending(null)} />}
      {done && <div className="notice ok">{done}</div>}
      <div className="card flush">
        {places.length === 0 ? (
          <Empty>No places yet. Add the wards, theatres and clinics you staff.</Empty>
        ) : (
          <div className="table-wrap">
          <table>
            <thead><tr><th>Name</th><th>Group</th><th /></tr></thead>
            <tbody>
              {places.map(r => {
                const i = roles.findIndex(x => x.id === r.id);
                const lists = roles.filter(x => x.parentId === r.id);
                return [
                  <tr key={r.id}>
                    <td><input value={placeName(r)} aria-label="Place name" onChange={e => update(w => {
                      const role = w.profile.roles[i];
                      const oldVisible = placeName(role);
                      const next = e.target.value;
                      role.displayName = next.trim() && next.trim() !== role.name ? next.trim() : undefined;
                      const newVisible = placeName(role);
                      if (oldVisible !== newVisible) {
                        for (const list of w.profile.roles) {
                          if (list.parentId === role.id && list.name.startsWith(`${oldVisible} – `)) {
                            list.name = `${newVisible}${list.name.slice(oldVisible.length)}`;
                          }
                        }
                      }
                    })} style={{ width: '100%', minWidth: 140, maxWidth: 260 }} />{r.displayName && <small className="small muted">MediRota: {r.name}</small>}</td>
                    <td>
                      <div className="row">
                        <input list="place-groups" value={r.category ?? ''} placeholder="e.g. Theatre" aria-label="Group"
                          onChange={e => update(w => { w.profile.roles[i].category = e.target.value || undefined; })} />
                        {r.category && <span className={`tag ${categoryClass(categories, r.category)}`}>{r.category}</span>}
                      </div>
                    </td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      {leads.length > 0 && <AddList placeId={r.id} placeName={placeName(r)} />}
                      <button className="ghost danger" onClick={() => remove(r.id, r.name)}>Remove</button>
                    </td>
                  </tr>,
                  ...lists.map(l => (
                    <tr key={l.id}>
                      <td style={{ paddingLeft: 28 }}><span className="muted">↳</span> {l.name}</td>
                          <td className="small muted">{(l.leadIds ?? []).map(leadName).join(' & ')}'s list · counts as {placeName(r)}</td>
                      <td style={{ textAlign: 'right' }}><button className="ghost danger" onClick={() => remove(l.id, l.name)}>Remove</button></td>
                    </tr>
                  )),
                ];
              })}
            </tbody>
          </table>
          </div>
        )}
        <datalist id="place-groups">{categories.map(c => <option key={c} value={c} />)}</datalist>
      </div>

      <div className="card">
        <h2>Consultants</h2>
        <p className="muted">People who run lists can be paired with doctors. Each person's list counts as its place for every rule.</p>
        <div className="chips" style={{ marginBottom: 10 }}>
          {leads.length === 0 && <span className="small muted">None yet. Add them here, or import a MediRota week below.</span>}
          {leads.map(l => (
            <span key={l.id} className="pill" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {l.name}
              <button className="ghost small danger" style={{ minHeight: 0, padding: '0 4px' }} aria-label={`Remove ${l.name}`} onClick={() => removeConsultant(l.id, l.name)}>×</button>
            </span>
          ))}
        </div>
        <div className="row">
          <input placeholder="Consultant's name" value={newLead} onChange={e => setNewLead(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') addLead(); }} />
          <button disabled={!newLead.trim()} onClick={addLead}>Add consultant</button>
        </div>
      </div>

    </>
  );
}

/** "+ Consultant's list" on a place: pick a consultant, and a list for them is added under the place. */
function AddList({ placeId, placeName }: { placeId: string; placeName: string }) {
  const ws = useWorkspace();
  const leads = ws.profile.leads ?? [];
  const taken = new Set(ws.profile.roles.filter(r => r.parentId === placeId).map(r => (r.leadIds ?? []).join()));
  const free = leads.filter(l => !taken.has(l.id));
  if (free.length === 0) return null;
  return (
    <select value="" aria-label={`Add a consultant's list to ${placeName}`} style={{ marginRight: 6, width: '11.5rem', maxWidth: '100%' }}
      onChange={e => {
        const lead = leads.find(l => l.id === e.target.value);
        if (!lead) return;
        update(w => { w.profile.roles.push({ id: newId('list'), name: `${placeName} – ${lead.name}`, parentId: placeId, leadIds: [lead.id] }); });
      }}>
      <option value="">+ Consultant's list</option>
      {free.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
    </select>
  );
}
