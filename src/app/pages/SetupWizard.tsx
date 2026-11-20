import { useEffect, useMemo, useRef, useState } from 'react';
import type { ISODate } from '../../engine/types';
import { defaultSessionsSettings, gradeForStaff, SESSION_COLOURS, type SessionsSettings } from '../sessions';
import { update, useWorkspace } from '../store';
import { Import } from './Import';
import { SessionRatioTable } from './SessionSettings';
import { SessionTypesEditor } from '../components/SessionTypesEditor';
import type { Page } from './types';
import { applyWizardDoctorChoice, canAdvanceSetupWizard, setWorkspaceRole, type SetupWizardStep, type WizardAction } from '../setupWizard';

function shortDate(date: ISODate) { return new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }); }
function importedWeeksSummary(importedAt: Record<ISODate, string>, doctors: number) {
  const weeks = Object.keys(importedAt).sort(); if (!weeks.length) return undefined;
  const last = new Date(`${weeks.at(-1)}T00:00:00Z`); last.setUTCDate(last.getUTCDate() + 6);
  return `${weeks.length} ${weeks.length === 1 ? 'week' : 'weeks'} imported, ${shortDate(weeks[0])} to ${shortDate(last.toISOString().slice(0, 10))}, ${doctors} ${doctors === 1 ? 'doctor' : 'doctors'}`;
}
/** Keyword rules from the open-source brief; case-insensitive, whole-word only, optional plural s. */
export function suggestSessionType(name: string): string {
  const value = name.toLocaleLowerCase('en-GB');
  if (/\b(theatres?|surgery|sections?|lists?)\b/.test(value)) return 'Theatre';
  if (/\b(wards?|antenatal|postnatal)\b/.test(value)) return 'Wards';
  if (/\bnights?\b/.test(value)) return 'Nights';
  if (/\bclinics?\b/.test(value)) return 'Clinic';
  if (/\b(assessments?|triage|mau|eau|sau)\b/.test(value)) return 'Assessment';
  return 'Not counted';
}
export function suggestSessionKind(name: string, ws?: ReturnType<typeof useWorkspace>): 'day' | 'on-call' {
  const activities = Object.values(ws?.swapFinder?.snapshot.days ?? {}).flatMap(days => Object.values(days)).filter(day => day.activity === name);
  if (activities.length) return activities.filter(day => day.status === 'night' || day.status === 'longDay').length > activities.length / 2 ? 'on-call' : 'day';
  return 'day';
}
/** Draft for the wizard screen: saved values when present, otherwise place/grade suggestions. */
export function wizardSettingsDraft(ws: ReturnType<typeof useWorkspace>): SessionsSettings {
  if (ws.sessions?.types.length || ws.sessions?.groups.length) return structuredClone(ws.sessions);
  const types: SessionsSettings['types'] = [];
  for (const place of ws.profile.roles.filter(role => !role.parentId)) {
    const name = suggestSessionType(place.name); if (name === 'Not counted') continue;
    let type = types.find(item => item.name === name);
    if (!type) { const colour = SESSION_COLOURS[types.length % SESSION_COLOURS.length].number; type = { id: `session-suggested-${types.length}`, name, colour, kind: suggestSessionKind(place.name, ws), placeIds: [] }; types.push(type); }
    type.placeIds.push(place.id);
  }
  const grades = [...new Set(ws.profile.staff.map(person => gradeForStaff(person, ws.profile)).filter((grade): grade is string => !!grade))];
  const groups = grades.map((grade, index) => ({ id: `session-group-${index}`, name: grade, grades: [grade] }));
  return { types, groups, ratios: Object.fromEntries(types.map(type => [type.id, Object.fromEntries(groups.map(group => [group.id, 1]))])), sameConsultants: { groupIds: [], typeIds: [] } };
}

/** Next on types/groups/ratios: write the on-screen draft when it differs from what is saved (or when nothing is saved yet). Skip never calls this. */
export function commitWizardSessionsStep(workspace: { sessions?: SessionsSettings; profile: Parameters<typeof defaultSessionsSettings>[0] }, step: 'types' | 'groups' | 'ratios', draft: SessionsSettings): void {
  const baseline = structuredClone(workspace.sessions ?? defaultSessionsSettings(workspace.profile));
  const saved = structuredClone(baseline);
  if (step === 'types') saved.types = structuredClone(draft.types);
  if (step === 'groups') saved.groups = structuredClone(draft.groups);
  if (step === 'ratios') saved.ratios = structuredClone(draft.ratios);
  if (JSON.stringify(saved) !== JSON.stringify(baseline)) workspace.sessions = saved;
}

export function SetupWizard({ mode, go, onFinish, initialStep = 'role' }: { mode: 'firstRun' | 'rerun'; go: (page: Page) => void; onFinish: () => void; initialStep?: SetupWizardStep }) {
  const ws = useWorkspace();
  const [step, setStep] = useState<SetupWizardStep>(initialStep);
  const [query, setQuery] = useState('');
  const [roleDraft, setRoleDraft] = useState<'doctor' | 'coordinator' | undefined>(mode === 'firstRun' ? ws.role : ws.role ?? 'doctor');
  const [doctorDraft, setDoctorDraft] = useState(ws.me ?? '');
  const [settingsDraft, setSettingsDraft] = useState<SessionsSettings>(() => wizardSettingsDraft(ws));
  const [unsortedCount, setUnsortedCount] = useState(0);
  const [minimumDraft, setMinimumDraft] = useState(() => ({ weekdays: [...(ws.swapFinder?.settings.minDoctors ?? [0,0,0,0,0,0,0])], bankHoliday: ws.swapFinder?.settings.minDoctorsBankHoliday ?? 0 }));
  const importedAt = ws.swapFinder?.snapshot.importedAt ?? {};
  const hasRota = Object.keys(importedAt).length > 0;
  const hadRota = useRef(hasRota);
  useEffect(() => {
    // After the first import lands (any tab/mode), show suggestions when nothing is saved yet.
    if (!hadRota.current && hasRota) setSettingsDraft(wizardSettingsDraft(ws));
    hadRota.current = hasRota;
  }, [hasRota, ws.profile, ws.sessions, ws.swapFinder?.snapshot]);
  const isCoordinator = roleDraft === 'coordinator';
  const doctors = useMemo(() => {
    const people = ws.profile.staff.filter(person => !query || `${person.name} ${gradeForStaff(person, ws.profile) ?? ''}`.toLocaleLowerCase('en-GB').includes(query.toLocaleLowerCase('en-GB')));
    return people;
  }, [ws.profile, query]);
  const places = ws.profile.roles.filter(role => !role.parentId);
  const isSuggestedSessionDraft = !ws.sessions?.types.length && !ws.sessions?.groups.length;
  const grades = [...new Set(ws.profile.staff.map(person => gradeForStaff(person, ws.profile)).filter((grade): grade is string => !!grade))];
  const groups = settingsDraft.groups;
  const steps = isCoordinator ? ['role','rota','types','groups','ratios','minimums'] as SetupWizardStep[] : ['role','rota','doctor','types','groups','ratios','minimums'] as SetupWizardStep[];
  const visibleSteps = steps.filter(item => item !== 'doctor' || !isCoordinator);
  const stepNumber = visibleSteps.indexOf(step) + 1;
  const titles: Record<SetupWizardStep, string> = { role: 'Who are you?', rota: 'Get your rota from MediRota', doctor: 'Which doctor are you?', types: 'Sort places into session types', groups: 'Group grades', ratios: 'Session ratios', minimums: 'Minimum doctors per day for swaps', finish: 'Setup complete' };
  const saveStep = (current: 'types' | 'groups' | 'ratios') => update(workspace => { commitWizardSessionsStep(workspace, current, settingsDraft); });
  const move = (action: WizardAction) => {
    if (step === 'role' && action === 'next' && !roleDraft) return;
    if (step === 'doctor' && action === 'next' && !doctorDraft) return;
    if (action === 'next') {
      if (step === 'role') update(workspace => { if (roleDraft === 'coordinator' || workspace.role === 'coordinator') setWorkspaceRole(workspace, roleDraft!); else if (workspace.role !== undefined) setWorkspaceRole(workspace, roleDraft!); });
      if (step === 'doctor') update(workspace => { applyWizardDoctorChoice(workspace, doctorDraft, mode); });
      if (step === 'types' || step === 'groups' || step === 'ratios') saveStep(step);
      if (step === 'minimums' && ws.swapFinder) update(workspace => { if (!workspace.swapFinder) return; if (JSON.stringify(workspace.swapFinder.settings.minDoctors) !== JSON.stringify(minimumDraft.weekdays)) workspace.swapFinder.settings.minDoctors = [...minimumDraft.weekdays]; if (workspace.swapFinder.settings.minDoctorsBankHoliday !== minimumDraft.bankHoliday) workspace.swapFinder.settings.minDoctorsBankHoliday = minimumDraft.bankHoliday; });
    }
    if (action === 'skip' && step === 'types') setSettingsDraft(wizardSettingsDraft(ws));
    const index = visibleSteps.indexOf(step);
    setStep(action === 'back' ? visibleSteps[Math.max(0, index - 1)] : visibleSteps[index + 1] ?? 'finish');
  };
  const changeRatio = (typeId: string, groupId: string, value: number) => setSettingsDraft(current => { const next = structuredClone(current); next.ratios[typeId] ??= {}; next.ratios[typeId][groupId] = value; return next; });
  if (step === 'finish') return <div className="setup-wizard-page"><section className="setup-wizard-card"><p className="eyebrow">Setup complete</p><h1>You're set up</h1><p>Your setup is saved in this browser. You can import rota weeks later.</p><button className="primary" type="button" onClick={onFinish}>Go to Overview</button></section></div>;
  return <div className="setup-wizard-page"><section className="setup-wizard-card" aria-labelledby="setup-wizard-title"><p className="eyebrow">{mode === 'firstRun' ? 'First-time setup' : 'Setup'}</p><div className="setup-wizard-progress"><span>Step {stepNumber} of {visibleSteps.length}</span><span>{titles[step]}</span></div><h1 id="setup-wizard-title">{titles[step]}</h1>
    {step === 'role' && <fieldset className="setup-wizard-step"><legend>Choose your role</legend><label className="setup-doctor-option"><input type="radio" name="role" checked={roleDraft === 'doctor'} onChange={() => setRoleDraft('doctor')} /><span>A doctor on this rota</span></label><label className="setup-doctor-option"><input type="radio" name="role" checked={roleDraft === 'coordinator'} onChange={() => setRoleDraft('coordinator')} /><span>I make the rota (coordinator)</span></label></fieldset>}
    {step === 'rota' && <div className="setup-wizard-step"><ol className="setup-rota-instructions"><li>Add the bookmark below to your bookmarks bar.</li><li>Open MediRota and sign in.</li><li>Choose a By person week and click the bookmark.</li><li>Come back here to review and import the weeks.</li></ol><p className="small muted">Optional: also fetch lists by activity to see consultants.</p>{importedWeeksSummary(importedAt, ws.profile.staff.length) && <p className="setup-import-summary" role="status">{importedWeeksSummary(importedAt, ws.profile.staff.length)}</p>}{!hasRota && <p className="small muted">You can skip this step and import your rota later.</p>}<Import go={go} embedded /></div>}
    {step === 'doctor' && <div className="setup-wizard-step">{!hasRota ? <p>Import your rota first to choose yourself.</p> : <><label className="field">Find a doctor<input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Type a name or grade" /></label><div className="setup-doctor-groups">{doctors.map(person => <label className="setup-doctor-option" key={person.id}><input type="radio" name="setup-doctor" checked={doctorDraft === person.id} onChange={() => setDoctorDraft(person.id)} /><span>{person.name}<small>{gradeForStaff(person, ws.profile) ?? 'No grade'}</small></span></label>)}</div></>}</div>}
    {step === 'types' && <div className="setup-wizard-step">{!hasRota ? <p>Import your rota first to sort places. You can do this later in Settings.</p> : <SessionTypesEditor settings={settingsDraft} places={places.map(place => ({ id: place.id, name: place.name }))} unsortedPlaceIds={isSuggestedSessionDraft ? places.filter(place => suggestSessionType(place.name) === 'Not counted').map(place => place.id) : []} showSuggestionNote onUnsortedCountChange={setUnsortedCount} onChange={setSettingsDraft} />}</div>}
    {step === 'groups' && <div className="setup-wizard-step">{!hasRota ? <p>Import your rota first to group grades. You can do this later in Settings.</p> : <>
      <p>Each grade starts in its own group. Put grades together to compare them, and name each group.</p>
      {groups.map(group => <section className="setup-group-card" key={group.id}>
        <label className="field">Group name<input aria-label={`Name for ${group.name}`} value={group.name} onChange={event => setSettingsDraft(current => ({ ...current, groups: current.groups.map(item => item.id === group.id ? { ...item, name: event.target.value } : item) }))} /></label>
        <ul className="setup-group-grades">{group.grades.map(grade => <li key={grade}><span>{grade}</span><label className="field">Compare together with<select aria-label={`Compare ${grade} with`} value={group.id} onChange={event => setSettingsDraft(current => {
          const next = structuredClone(current);
          next.groups = next.groups.map(item => ({ ...item, grades: item.grades.filter(value => value !== grade) })).filter(item => item.grades.length);
          if (event.target.value === '__new') next.groups.push({ id: `group-${Date.now()}`, name: grade, grades: [grade] });
          else { const target = next.groups.find(item => item.id === event.target.value); if (target) target.grades.push(grade); else next.groups.push({ id: event.target.value || `group-${Date.now()}`, name: grade, grades: [grade] }); }
          return next;
        })}>{groups.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}<option value="__new">New group</option></select></label></li>)}</ul>
      </section>)}
      {grades.filter(grade => !groups.some(group => group.grades.includes(grade))).map(grade => <label className="field" key={`ungrouped-${grade}`}>{grade}<select aria-label={`Compare ${grade} with`} value="" onChange={event => setSettingsDraft(current => {
        const next = structuredClone(current);
        if (event.target.value === '__new' || !event.target.value) next.groups.push({ id: `group-${Date.now()}`, name: grade, grades: [grade] });
        else { const target = next.groups.find(item => item.id === event.target.value); if (target) target.grades.push(grade); }
        return next;
      })}><option value="">Own group</option>{groups.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}<option value="__new">New group</option></select></label>)}
      {!isCoordinator && doctorDraft && <p>You're compared with: <b>{groups.find(group => group.grades.includes(gradeForStaff(ws.profile.staff.find(person => person.id === doctorDraft)!, ws.profile) ?? ''))?.name ?? 'No group'}</b></p>}
      {(() => {
        const ambiguous = ws.profile.staff.flatMap(person => {
          const grade = gradeForStaff(person, ws.profile);
          if (!grade?.includes('/')) return [];
          const group = settingsDraft.groups.find(item => item.subGroups?.length && item.grades.some(value => value.trim().toLocaleLowerCase('en-GB') === grade.trim().toLocaleLowerCase('en-GB')));
          return group ? [{ person, grade, group }] : [];
        });
        return ambiguous.length > 0 ? <section className="setup-ambiguous"><h2>Place ambiguous-grade doctors</h2>{ambiguous.map(({ person, grade, group }) => <label className="field setup-placement" key={person.id}>{person.name} · {grade}<select aria-label={`${person.name} sub-group`} value={ws.sessionSubGroups?.[person.id] ?? ''} onChange={event => update(workspace => { workspace.sessionSubGroups ??= {}; if (event.target.value) workspace.sessionSubGroups[person.id] = event.target.value; else delete workspace.sessionSubGroups[person.id]; })}><option value="">Choose a sub-group</option>{group.subGroups!.map(subgroup => <option key={subgroup.id} value={subgroup.id}>{subgroup.name}</option>)}</select></label>)}</section> : null;
      })()}
    </>}</div>}
    {step === 'ratios' && <div className="setup-wizard-step">{!hasRota ? <p>Import your rota first. You can set ratios later in Settings.</p> : <><p>Change them only if you know the values for your department.</p><SessionRatioTable settings={settingsDraft} onChange={changeRatio} /></>}</div>}
    {step === 'minimums' && <div className="setup-wizard-step"><p>Find swaps warns when a swap or leave would leave fewer doctors than this on a day.</p><div className="swap-minimums">{['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'].map((day, index) => <label className="field" key={day}>{day}<input type="number" min="0" placeholder="No minimum" value={minimumDraft.weekdays[index] || ''} onChange={event => setMinimumDraft(current => ({ ...current, weekdays: current.weekdays.map((value, i) => i === index ? Number(event.target.value) || 0 : value) }))} /></label>)}<label className="field">Bank holiday<input type="number" min="0" placeholder="No minimum" value={minimumDraft.bankHoliday || ''} onChange={event => setMinimumDraft(current => ({ ...current, bankHoliday: Number(event.target.value) || 0 }))} /></label></div></div>}
    <footer className="setup-wizard-actions">{step === 'types' && hasRota && isSuggestedSessionDraft ? <span className="small muted">{unsortedCount ? `${unsortedCount} ${unsortedCount === 1 ? 'place' : 'places'} not sorted yet` : 'All places sorted ✓'}</span> : <span /> }<button type="button" disabled={step === 'role'} onClick={() => move('back')} aria-label="Back">Back</button><button type="button" className="ghost" onClick={() => move('skip')}>Skip</button><button type="button" className="primary" disabled={!canAdvanceSetupWizard(step, hasRota, !!doctorDraft, roleDraft)} onClick={() => move('next')}>Next</button></footer>
  </section></div>;
}
