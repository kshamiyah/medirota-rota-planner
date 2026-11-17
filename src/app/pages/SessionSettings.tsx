import { useMemo } from 'react';
import { useWorkspace, update } from '../store';
import { defaultSessionsSettings, gradeForStaff, SESSION_COLOURS, analyseSessions, sessionDateRange, type SessionComparisonGroup, type SessionTypeSetting, type SessionsSettings } from '../sessions';
import { markPresetPersonOverride } from '../presets';

function gradeLabel(personGrade?: string): string { return personGrade?.trim() || 'No grade'; }
function gradeKey(grade: string): string { return grade.trim().toLocaleLowerCase('en-GB'); }
function slug(value: string): string { return value.toLocaleLowerCase('en-GB').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }

export function SessionRatioTable({ settings, onChange }: { settings: SessionsSettings; onChange: (typeId: string, groupId: string, value: number) => void }) {
  return <div className="table-wrap"><table className="session-ratio-table"><thead><tr><th>Session type</th>{settings.groups.map(group => <th key={group.id}>{group.name}</th>)}</tr></thead><tbody>{settings.types.map(type => <tr key={type.id}><th scope="row">{type.name}</th>{settings.groups.map(group => <td key={group.id}><input id={`ratio-${type.id}-${group.id}`} aria-label={`${type.name}, ${group.name}, parts`} type="number" min="0" step="0.25" value={settings.ratios[type.id]?.[group.id] ?? 1} onChange={event => onChange(type.id, group.id, Math.max(0, Number(event.target.value)))} /></td>)}</tr>)}</tbody></table></div>;
}

export function SessionSettingsPanel() {
  const ws = useWorkspace();
  const settings = ws.sessions ?? defaultSessionsSettings(ws.profile);
  const importedRange = sessionDateRange(ws.swapFinder?.snapshot);
  const analysis = useMemo(() => importedRange && ws.swapFinder
    ? analyseSessions(ws.profile, ws.swapFinder.snapshot, settings, ws.sessionSubGroups ?? {}, importedRange.start, importedRange.end)
    : undefined, [ws.profile, ws.swapFinder, ws.sessionSubGroups, settings, importedRange?.start, importedRange?.end]);
  const grades = [...new Set(ws.profile.staff.map(person => gradeForStaff(person, ws.profile)).filter((grade): grade is string => !!grade))].sort((a, b) => a.localeCompare(b));
  const save = (mutate: (value: SessionsSettings, workspace: typeof ws) => void) => update(workspace => {
    workspace.sessions ??= defaultSessionsSettings(workspace.profile);
    mutate(workspace.sessions, workspace);
  });
  const addType = () => save(value => {
    const id = `session-custom-${Date.now()}`;
    value.types.push({ id, name: 'New session type', colour: 1, kind: 'day', placeIds: [] });
    value.ratios[id] = Object.fromEntries(value.groups.map(group => [group.id, 1]));
  });
  const removeType = (id: string) => save(value => { value.types = value.types.filter(type => type.id !== id); delete value.ratios[id]; });
  const addGroup = () => save(value => {
    const id = `session-group-custom-${Date.now()}`;
    value.groups.push({ id, name: 'New group', grades: [] });
    for (const row of Object.values(value.ratios)) row[id] = 1;
  });
  const removeGroup = (id: string) => save((value, workspace) => {
    value.groups = value.groups.filter(group => group.id !== id);
    for (const row of Object.values(value.ratios)) delete row[id];
    if (workspace.sessionSubGroups) {
      for (const [staffId, subgroupId] of Object.entries(workspace.sessionSubGroups)) {
        if (subgroupId.startsWith(`${id}-sub-`)) delete workspace.sessionSubGroups[staffId];
      }
    }
  });
  const setGrade = (group: SessionComparisonGroup, grade: string, checked: boolean) => save(value => {
    value.groups = value.groups.map(candidate => ({ ...candidate, grades: candidate.grades.filter(item => gradeKey(item) !== gradeKey(grade)) }));
    if (checked) value.groups.find(candidate => candidate.id === group.id)!.grades.push(grade);
  });
  const splitGroup = (group: SessionComparisonGroup) => save(value => {
    const current = value.groups.find(item => item.id === group.id)!;
    if (current.subGroups?.length) { delete current.subGroups; return; }
    current.subGroups = [...new Set(current.grades.filter(grade => !grade.includes('/')))].map(grade => ({ id: `${current.id}-sub-${slug(grade)}`, name: grade, grades: [grade] }));
  });
  const setSubGrade = (groupId: string, subGroupId: string, grade: string, checked: boolean) => save(value => {
    const group = value.groups.find(item => item.id === groupId)!;
    for (const subgroup of group.subGroups ?? []) subgroup.grades = subgroup.grades.filter(item => gradeKey(item) !== gradeKey(grade));
    if (checked) group.subGroups?.find(subgroup => subgroup.id === subGroupId)?.grades.push(grade);
  });
  const types = settings.types;
  const rootPlaces = ws.profile.roles.filter(role => !role.parentId);
  const mapPlace = (type: SessionTypeSetting, placeId: string, checked: boolean) => save(value => {
    if (checked) for (const item of value.types) item.placeIds = item.placeIds.filter(id => id !== placeId);
    const target = value.types.find(item => item.id === type.id)!;
    target.placeIds = checked ? [...target.placeIds, placeId] : target.placeIds.filter(id => id !== placeId);
  });
  const ambiguousDoctors = ws.profile.staff.filter(person => gradeForStaff(person, ws.profile)?.includes('/') && settings.groups.some(group => group.subGroups?.length && group.grades.some(grade => gradeKey(grade) === gradeKey(gradeForStaff(person, ws.profile)!))));
  const consistency = settings.sameConsultants ?? { groupIds: [], typeIds: [] };
  const consistencyPeople = ws.profile.staff.filter(person => !person.locum && settings.groups.some(group => consistency.groupIds.includes(group.id) && group.grades.some(grade => gradeKey(grade) === gradeKey(gradeForStaff(person, ws.profile) ?? ''))));
  const consistencyTypes = settings.types.filter(type => type.kind === 'day');
  const setPair = (staffId: string, index: number, name: string) => update(workspace => {
    const pair = [...(workspace.consultantPairs?.[staffId] ?? [])];
    pair[index] = name;
    const next = pair.filter(Boolean).slice(0, 2);
    workspace.consultantPairs ??= {};
    if (next.length) workspace.consultantPairs[staffId] = next;
    else delete workspace.consultantPairs[staffId];
    const person = workspace.profile.staff.find(item => item.id === staffId);
    if (person) markPresetPersonOverride(workspace, person.name, 'consultants', next);
  });
  return <div className="sessions-settings stack">
    <header className="sessions-section-head"><p className="eyebrow">Comparison setup</p><h2>Sessions</h2><p className="muted">Choose what counts as each session, how grades are compared and how work is shared out.</p></header>

    <section className="session-settings-block">
      <div className="session-settings-title"><h3>Same consultants</h3><p className="small muted">Keep selected groups on familiar consultant lists in Fairer rota. Consultant pairs are optional and are tried first.</p></div>
      <div className="session-grade-options"><span className="field-label">Groups</span>{settings.groups.map(group => <label key={group.id}><input type="checkbox" checked={consistency.groupIds.includes(group.id)} onChange={event => save(value => { value.sameConsultants ??= { groupIds: [], typeIds: [] }; value.sameConsultants.groupIds = event.target.checked ? [...new Set([...value.sameConsultants.groupIds, group.id])] : value.sameConsultants.groupIds.filter(id => id !== group.id); })} />{group.name}</label>)}</div>
      <div className="session-grade-options"><span className="field-label">Types</span>{consistencyTypes.map(type => <label key={type.id}><input type="checkbox" checked={consistency.typeIds.includes(type.id)} onChange={event => save(value => { value.sameConsultants ??= { groupIds: [], typeIds: [] }; value.sameConsultants.typeIds = event.target.checked ? [...new Set([...value.sameConsultants.typeIds, type.id])] : value.sameConsultants.typeIds.filter(id => id !== type.id); })} />{type.name}</label>)}</div>
      {consistencyPeople.length > 0 && <div className="session-person-placements"><h4>Consultant pairs</h4>{consistencyPeople.map(person => <div className="session-placement-row" key={person.id}><span>{person.name}</span><div className="row">{[0, 1].map(index => <label className="field small" key={index}>Pair {index + 1}<select aria-label={`${person.name}, consultant ${index + 1}`} value={ws.consultantPairs?.[person.id]?.[index] ?? ''} onChange={event => setPair(person.id, index, event.target.value)}><option value="">No preference</option>{(ws.profile.leads ?? []).map(lead => <option key={lead.id} value={lead.name}>{lead.name}</option>)}</select></label>)}</div></div>)}</div>}
      {(ws.profile.leads ?? []).length === 0 && <p className="small muted">Consultant lists will appear here after By activity weeks are imported.</p>}
    </section>

    <section className="session-settings-block">
      <div className="row session-settings-title"><div><h3>Session types</h3><p className="small muted">Each place maps to one session type. A consultant list follows its parent place.</p></div><button type="button" onClick={addType}>Add type</button></div>
      <div className="session-type-list">{types.map(type => <article className="session-type-row" key={type.id}>
        <div className="session-type-fields"><label className="field">Name<input value={type.name} onChange={event => save(value => { value.types.find(item => item.id === type.id)!.name = event.target.value; })} /></label>
          <label className="field">Colour<select value={type.colour} onChange={event => save(value => { value.types.find(item => item.id === type.id)!.colour = Number(event.target.value); })}>{SESSION_COLOURS.map(colour => <option key={colour.number} value={colour.number}>{colour.label}</option>)}</select></label>
          <label className="field">Kind<select value={type.kind} onChange={event => save(value => { value.types.find(item => item.id === type.id)!.kind = event.target.value as SessionTypeSetting['kind']; })}><option value="day">Day</option><option value="on-call">On-call</option></select></label>
          <button type="button" className="link-button danger" onClick={() => removeType(type.id)}>Remove</button>
        </div>
      <div className="session-place-mapping"><span className="field-label">Mapped places</span><div className="session-place-options">{rootPlaces.map(place => <label key={place.id}><input type="checkbox" checked={type.placeIds.includes(place.id)} onChange={event => mapPlace(type, place.id, event.target.checked)} />{place.name}</label>)}</div></div>
      <p className="small muted">{type.kind === 'on-call' ? 'On-call' : 'Day session'}</p>
      </article>)}</div>
      <h4>Not counted yet</h4>{analysis?.unmapped.length ? <ul className="session-unmapped">{analysis.unmapped.map(item => <li key={item.activity}><span>{item.activity}</span><span>{item.count} {item.count === 1 ? 'booking' : 'bookings'}</span></li>)}</ul> : <p className="small muted">No unmapped activities in the imported range.</p>}
      {analysis?.ignored.length ? <p className="session-ignored small muted">Not counted: {analysis.ignored.map(item => `${item.activity} (${item.count})`).join(', ')}.</p> : null}
    </section>

    <section className="session-settings-block">
      <div className="row session-settings-title"><div><h3>Comparison groups</h3><p className="small muted">Assign each grade to one group. Split a group to compare its grades separately.</p></div><button type="button" onClick={addGroup}>Add group</button></div>
      <div className="session-groups-list">{settings.groups.map(group => <article className="session-group-row" key={group.id}>
        <div className="session-group-heading"><label className="field">Group name<input value={group.name} onChange={event => save(value => { value.groups.find(item => item.id === group.id)!.name = event.target.value; })} /></label><button type="button" onClick={() => splitGroup(group)}>{group.subGroups?.length ? 'Merge sub-groups' : 'Split into sub-groups'}</button><button type="button" className="link-button danger" onClick={() => removeGroup(group.id)}>Remove group</button></div>
        <div className="session-grade-options"><span className="field-label">Grades</span>{grades.map(grade => <label key={grade}><input type="checkbox" checked={group.grades.some(item => gradeKey(item) === gradeKey(grade))} onChange={event => setGrade(group, grade, event.target.checked)} />{grade}</label>)}</div>
        {group.subGroups?.length ? <div className="session-subgroups"><span className="field-label">Sub-groups</span>{group.subGroups.map(subgroup => <div className="session-subgroup-row" key={subgroup.id}><label className="field">Name<input value={subgroup.name} onChange={event => save(value => { value.groups.find(item => item.id === group.id)!.subGroups!.find(item => item.id === subgroup.id)!.name = event.target.value; })} /></label><div className="session-grade-options">{group.grades.filter(grade => !grade.includes('/')).map(grade => <label key={grade}><input type="checkbox" checked={subgroup.grades.some(item => gradeKey(item) === gradeKey(grade))} onChange={event => setSubGrade(group.id, subgroup.id, grade, event.target.checked)} />{grade}</label>)}</div></div>)}</div> : null}
      </article>)}</div>
      {ambiguousDoctors.length > 0 && <div className="session-person-placements"><h4>Place ambiguous-grade doctors</h4><p className="small muted">Doctors with a combined grade need a manual sub-group when their group is split.</p>{ambiguousDoctors.map(person => {
        const grade = gradeForStaff(person, ws.profile)!;
        const group = settings.groups.find(item => item.subGroups?.length && item.grades.some(itemGrade => gradeKey(itemGrade) === gradeKey(grade)))!;
        return <label className="session-placement-row" key={person.id}><span>{person.name} <small className="muted">{gradeLabel(grade)}</small></span><select value={ws.sessionSubGroups?.[person.id] ?? ''} onChange={event => update(workspace => {
          workspace.sessionSubGroups ??= {};
          if (event.target.value) workspace.sessionSubGroups[person.id] = event.target.value;
          else delete workspace.sessionSubGroups[person.id];
          markPresetPersonOverride(workspace, person.name, 'sessionSubGroup', event.target.value);
        })}><option value="">Choose sub-group</option>{group.subGroups!.map(subgroup => <option key={subgroup.id} value={subgroup.id}>{subgroup.name}</option>)}</select></label>;
      })}</div>}
    </section>

    <section className="session-settings-block">
      <div className="session-settings-title"><h3>Ratios</h3><p className="small muted">Parts set how each group shares its session-type target. Every new group starts at 1.</p></div>
      <SessionRatioTable settings={settings} onChange={(typeId, groupId, ratio) => save(value => { value.ratios[typeId] ??= {}; value.ratios[typeId][groupId] = ratio; })} />
    </section>
  </div>;
}
