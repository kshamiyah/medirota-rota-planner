import { useRef, useState, type ReactNode } from 'react';
import type { Staff } from '../../engine/types';
import { newId, update, useWorkspace } from '../store';
import { isUsed, previewRemoveGroup, removeGroup, removePerson, ruleUses, type RemovalSummary } from '../references';
import { addPeople, peopleTableSections, removeEveryone } from '../people';
import { Chips, Empty, PageHead, WeekdayChips } from '../components/ui';
import { RemoveWarning } from '../components/RemoveWarning';
import { ConfirmPanel } from '../components/ConfirmPanel';
import { markPresetPersonOverride } from '../presets';

const FTE_OPTIONS = [1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4];

export function People() {
  const ws = useWorkspace();
  const { staff, groups } = ws.profile;
  const [text, setText] = useState('');
  const [groupId, setGroupId] = useState<string>(groups[0]?.id ?? '');
  const [fte, setFte] = useState(1);
  const [notice, setNotice] = useState<string | null>(null);
  const [newGroup, setNewGroup] = useState('');
  const [pendingGroup, setPendingGroup] = useState<{ id: string; name: string; summary: RemovalSummary } | null>(null);
  const [pendingPerson, setPendingPerson] = useState<Staff | null>(null);
  const [pendingAll, setPendingAll] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);

  const add = () => {
    if (!text.trim()) return;
    let r = { added: 0, skipped: [] as string[], newGroups: [] as string[] };
    update(w => { r = addPeople(w, text, { groupId: groupId || undefined, fte }); });
    setText('');
    setNotice([
      `Added ${r.added} ${r.added === 1 ? 'person' : 'people'}.`,
      r.newGroups.length ? `New groups: ${r.newGroups.join(', ')}.` : '',
      r.skipped.length ? `Already listed, skipped: ${r.skipped.join(', ')}.` : '',
    ].filter(Boolean).join(' '));
    box.current?.focus();
  };

  const addGroup = () => {
    const name = newGroup.trim();
    if (!name) return;
    const id = newId('grp');
    update(w => { w.profile.groups.push({ id, name }); });
    setGroupId(id);
    setNewGroup('');
  };

  const askRemoveGroup = (id: string, name: string) => {
    setNotice(null);
    const summary = previewRemoveGroup(ws, id);
    if (isUsed(summary)) { setPendingGroup({ id, name, summary }); return; }
    update(w => { removeGroup(w, id); });
  };

  const personRules = (id: string) => {
    const only = ws.profile.rules.filter(r => ruleUses(r, 'person', id) && !(r.who?.groupIds?.length) && r.who?.staffIds?.length === 1);
    const also = ws.profile.rules.filter(r => ruleUses(r, 'person', id) && !only.includes(r));
    return { only, also };
  };

  // Regular locums are in the main table; occasional locums stay collapsed below it.
  const { sections, occasionalLocums } = peopleTableSections(staff, groups);

  // Shown right under the person's row, so it's on screen where Remove was clicked.
  const confirmRemove = (person: typeof staff[number]) => {
    const { only, also } = personRules(person.id);
    return (
      <ConfirmPanel title={`Remove ${person.name}?`} confirmLabel="Remove" onCancel={() => setPendingPerson(null)}
        onConfirm={() => {
          update(w => { removePerson(w, person.id); });
          setNotice(`Removed ${person.name}.`);
          setPendingPerson(null);
        }}>
        Their leave, booked shifts and shifts in the current rota are removed too. If they're still in MediRota, the next import will offer to add them again.
        {only.length > 0 && <> Rules only about them will be deleted: {only.map(r => `"${r.name}"`).join(', ')}.</>}
        {also.length > 0 && <> They'll be taken out of: {also.map(r => `"${r.name}"`).join(', ')}.</>}
      </ConfirmPanel>
    );
  };

  return (
    <>
      <PageHead title="People" actions={staff.length > 0 ? <button className="danger" onClick={() => setPendingAll(true)}>Remove everyone</button> : undefined}>
        The doctors you're rostering. Groups let you write rules for several people at once.
      </PageHead>

      {pendingAll && (
        <ConfirmPanel title={`Remove all ${staff.length} people?`} confirmLabel="Remove everyone"
          onCancel={() => setPendingAll(false)}
          onConfirm={() => {
            let r = { removed: 0, rulesDeleted: [] as string[] };
            update(w => { r = removeEveryone(w); });
            setPendingAll(false);
            setNotice(`Removed ${r.removed} people with their leave and booked shifts${r.rulesDeleted.length ? `, and ${r.rulesDeleted.length} rules that were about individuals (${r.rulesDeleted.map(n => `"${n}"`).join(', ')})` : ''}. Groups and rules for whole groups are kept.`);
          }}>
          Useful for a new intake. Their leave, booked shifts and the current rota go too, and rules about individual people are deleted. Groups and rules for whole groups stay.
        </ConfirmPanel>
      )}
      {pendingGroup && <RemoveWarning what="group" name={pendingGroup.name} summary={pendingGroup.summary}
        onConfirm={() => { update(w => { removeGroup(w, pendingGroup.id); }); setNotice(`Removed the "${pendingGroup.name}" group everywhere.`); setPendingGroup(null); }}
        onCancel={() => setPendingGroup(null)} />}
      {notice && <div className="notice">{notice}</div>}

      <div className="card">
        <h2>Add people</h2>
        <div className="row" style={{ alignItems: 'flex-start' }}>
          <textarea
            ref={box}
            rows={Math.min(8, Math.max(1, text.split('\n').length))}
            style={{ flex: 1, minWidth: 240, resize: 'vertical' }}
            placeholder="Type a name and press Enter. Paste a list to add many at once."
            value={text}
            onChange={e => setText(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); add(); } }}
            aria-label="Names to add"
          />
          <select value={groupId} onChange={e => setGroupId(e.target.value)} aria-label="Group for new people">
            <option value="">No group</option>
            {groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
          <select value={fte} onChange={e => setFte(Number(e.target.value))} aria-label="% time for new people">
            {FTE_OPTIONS.map(f => <option key={f} value={f}>{Math.round(f * 100)}%</option>)}
          </select>
          <button className="primary" onClick={add} disabled={!text.trim()}>Add</button>
        </div>
        <p className="small muted" style={{ marginTop: 6 }}>
          From a spreadsheet you can paste columns straight in: <b>name</b>, <b>group</b>, <b>% time</b>. Missing groups are created for you.
        </p>
      </div>

      <div className="card">
        <h2>Groups</h2>
        <div className="row">
          {groups.map((g, i) => (
            <span key={g.id} className="row" style={{ gap: 4, border: '1px solid var(--line)', borderRadius: 999, padding: '2px 4px 2px 10px' }}>
              <input value={g.name} onChange={e => update(w => { w.profile.groups[i].name = e.target.value; })} size={Math.max(6, g.name.length + 1)} style={{ border: 0, padding: 2 }} aria-label="Group name" />
              <span className="small muted">{staff.filter(s => s.groupIds.includes(g.id)).length}</span>
              <button className="ghost" title="Remove group" onClick={() => askRemoveGroup(g.id, g.name)}>×</button>
            </span>
          ))}
          <input placeholder="New group name" value={newGroup} onChange={e => setNewGroup(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') addGroup(); }} />
          <button disabled={!newGroup.trim()} onClick={addGroup}>Add group</button>
        </div>
      </div>

      <div className="card flush">
        {staff.length === 0 ? <Empty>No people yet. Type names in the box above.</Empty> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Name</th><th>Group</th><th>% time</th><th>Regular days off</th><th title="Locum or bank doctor: only works shifts already booked for them">Locum</th><th /></tr></thead>
              <tbody>
                {sections.map(sec => (
                  <Section key={sec.id || 'none'} title={`${sec.name} (${sec.people.length})`}>
                    {sec.people.map(s => {
                      const i = staff.findIndex(x => x.id === s.id);
                      const open = expanded === s.id;
                      const days = ws.staffExtras[s.id]?.nonWorkingWeekdays ?? [];
                      return (
                        <Rows key={s.id}>
                          <tr>
                            <td><input value={s.name} onChange={e => update(w => { w.profile.staff[i].name = e.target.value; })} style={{ width: 200 }} aria-label="Name" /></td>
                            <td>
                              <select value={s.groupIds[0] ?? ''} aria-label="Group" onChange={e => update(w => {
                                const rest = w.profile.staff[i].groupIds.slice(1).filter(g => g !== e.target.value);
                                w.profile.staff[i].groupIds = e.target.value ? [e.target.value, ...rest] : rest;
                              })}>
                                <option value="">No group</option>
                                {groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
                              </select>
                              {s.groupIds.length > 1 && <span className="small muted"> +{s.groupIds.length - 1}</span>}{s.locum && s.regularLocum && <span className="pill" style={{ marginLeft: 6 }}>Locum</span>}
                            </td>
                            <td>
                              <select value={FTE_OPTIONS.includes(s.fte) ? s.fte : 'other'} aria-label="% time" onChange={e => update(w => { const value = Number(e.target.value); w.profile.staff[i].fte = value; markPresetPersonOverride(w, s.name, 'fte', value); })}>
                                {FTE_OPTIONS.map(f => <option key={f} value={f}>{Math.round(f * 100)}%</option>)}
                                {!FTE_OPTIONS.includes(s.fte) && <option value="other">{Math.round(s.fte * 100)}%</option>}
                              </select>
                            </td>
                            <td style={{ minWidth: 300 }}>
                              {s.fte < 1 || days.length > 0
                                ? <WeekdayChips value={days} onChange={v => update(w => { w.staffExtras[s.id] = { ...w.staffExtras[s.id], nonWorkingWeekdays: v }; })} />
                                : <span className="muted small">full time</span>}
                            </td>
                            <td>
                              <label className="switch" title={s.locum ? 'Locum: only works shifts already booked for them' : 'Not a locum'}>
                                <input type="checkbox" checked={!!s.locum} aria-label={`${s.name} is a locum`}
                                  onChange={e => update(w => { const value = e.target.checked; if (value) w.profile.staff[i].locum = true; else delete w.profile.staff[i].locum; markPresetPersonOverride(w, s.name, 'locum', value); })} />
                                <span />
                              </label>
                              {s.locum && <label className="row small" style={{ gap: 6, marginTop: 4 }}><input type="checkbox" aria-label={`${s.name} is a regular locum`} checked={!!s.regularLocum} onChange={e => update(w => { const value = e.target.checked; w.profile.staff[i].regularLocum = value; markPresetPersonOverride(w, s.name, 'regularLocum', value); })} />Regular</label>}
                            </td>
                            <td style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
                              <button className="link small" onClick={() => setExpanded(open ? null : s.id)}>{open ? 'Less' : 'More'}</button>{' '}
                              <button className="ghost danger" onClick={() => { setNotice(null); setPendingPerson(s); }}>Remove</button>
                            </td>
                          </tr>
                          {pendingPerson?.id === s.id && (
                            <tr><td colSpan={6} style={{ padding: '4px 0 10px' }}>{confirmRemove(pendingPerson)}</td></tr>
                          )}
                          {open && (
                            <tr>
                              <td colSpan={6} style={{ background: 'var(--panel-2)' }}>
                                <div className="row">
                                  <label className="field">In post from<input type="date" value={s.startDate ?? ''} onChange={e => update(w => { w.profile.staff[i].startDate = e.target.value || undefined; })} /></label>
                                  <label className="field">until<input type="date" value={s.endDate ?? ''} onChange={e => update(w => { w.profile.staff[i].endDate = e.target.value || undefined; })} /></label>
                                  <div className="field">Also in groups
                                    <Chips options={groups.filter(g => g.id !== s.groupIds[0]).map(g => ({ value: g.id, label: g.name }))} value={s.groupIds.slice(1)}
                                      onChange={v => update(w => { w.profile.staff[i].groupIds = [...w.profile.staff[i].groupIds.slice(0, 1), ...v]; })} />
                                  </div>
                                </div>
                              </td>
                            </tr>
                          )}
                        </Rows>
                      );
                    })}
                  </Section>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {occasionalLocums.length > 0 && <details className="occasional-locums"><summary>Occasional locums ({occasionalLocums.length})</summary><div className="table-wrap"><table><thead><tr><th>Name</th><th>Group</th><th>% time</th><th>Regular days off</th><th>Locum</th><th /></tr></thead><tbody>{occasionalLocums.map(s => { const i = staff.findIndex(person => person.id === s.id); return <tr key={s.id}><td>{s.name}</td><td>{s.groupIds[0] ? groups.find(group => group.id === s.groupIds[0])?.name : 'No group'}</td><td>{Math.round(s.fte * 100)}%</td><td className="muted">—</td><td><label className="row small"><input type="checkbox" checked={!!s.regularLocum} aria-label={`${s.name} is a regular locum`} onChange={e => update(w => { const value = e.target.checked; w.profile.staff[i].regularLocum = value; markPresetPersonOverride(w, s.name, 'regularLocum', value); })} />Regular</label></td><td /></tr>; })}</tbody></table></div></details>}
      </div>
    </>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <>
      <tr><td colSpan={6} style={{ background: 'var(--panel-2)', fontWeight: 600, fontSize: 12, color: 'var(--muted)' }}>{title}</td></tr>
      {children}
    </>
  );
}

function Rows({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
