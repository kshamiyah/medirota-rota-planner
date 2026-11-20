import { useEffect, useRef, useState } from 'react';
import { Shifts } from './Shifts';
import { Places } from './Places';
import { Staffing } from './Staffing';
import { People } from './People';
import { Rules } from './Rules';
import { Import } from './Import';
import { SwapSettingsPage } from './SwapSettings';
import { SessionSettingsPanel } from './SessionSettings';
import { useWorkspace, emptyWorkspace, exportWorkspace, importWorkspace, replaceWorkspace, update } from '../store';
import { stressProblem } from '../../examples/demo-department';
import { ConfirmPanel } from '../components/ConfirmPanel';
import { applyPresetToWorkspace, downloadPreset, isSetupPreset, type SetupPreset } from '../presets';
import type { Workspace } from '../store';
import type { Page } from './types';
import { gradeForStaff } from '../sessions';
import { ViewingAs } from './Overview';
import { setWorkspaceRole } from '../setupWizard';

export const SETTINGS_GROUPS = [
  { heading: '', sections: [['you', 'You'], ['sessions', 'Sessions and ratios'], ['swapSettings', 'Swap settings'], ['import', 'Update from MediRota'], ['files', 'Files and presets']] },
  { heading: 'Department setup', sections: [['people', 'People'], ['shifts', 'Shifts'], ['places', 'Places'], ['staffing', 'Staffing needs'], ['rules', 'Rules']] },
] as const;
export type SettingsSection = (typeof SETTINGS_GROUPS)[number]['sections'][number][0];

export function SettingsPage({ go, initialSection, initialAnchor, onSectionChange, onRunSetup, returnToSetup }: { go: (page: Page) => void; initialSection?: SettingsSection; initialAnchor?: string; onSectionChange?: (section: SettingsSection) => void; onRunSetup: () => void; returnToSetup?: () => void }) {
  const [section, setSectionState] = useState<SettingsSection>(initialSection ?? 'you');
  const setSection = (next: SettingsSection) => { setSectionState(next); onSectionChange?.(next); };
  useEffect(() => { if (!initialAnchor) return; requestAnimationFrame(() => document.getElementById(initialAnchor)?.scrollIntoView({ block: 'start' })); }, [initialAnchor, section]);
  const content = section === 'you' ? <YouSection changeGrade={() => setSection('people')} />
    : section === 'people' ? <People /> : section === 'shifts' ? <Shifts /> : section === 'places' ? <Places />
      : section === 'staffing' ? <Staffing /> : section === 'rules' ? <Rules /> : section === 'sessions' ? <SessionSettingsPanel />
        : section === 'swapSettings' ? <SwapSettingsPage go={go} /> : section === 'files' ? <FilesAndPresets onRunSetup={onRunSetup} />
          : <Import go={go} />;
  return <div className="settings-page"><header><p className="eyebrow">Workspace</p><h1>Settings</h1>{returnToSetup && <p><button className="link-button" type="button" onClick={returnToSetup}>Return to setup</button></p>}</header><div className="settings-layout">
    <nav className="settings-nav" aria-label="Settings sections">{SETTINGS_GROUPS.map(group => <div className="settings-nav-group" key={group.heading || 'top'}>{group.heading && <h2>{group.heading}</h2>}{group.sections.map(([id, label]) => <button key={id} className={section === id ? 'active' : ''} aria-current={section === id ? 'page' : undefined} onClick={() => setSection(id)}>{label}</button>)}</div>)}</nav>
    <section className="settings-content" key={section}>{content}</section>
  </div></div>;
}

function YouSection({ changeGrade }: { changeGrade: () => void }) {
  const ws = useWorkspace();
  const visibleStaff = ws.profile.staff.filter(person => !person.locum || person.regularLocum);
  const me = visibleStaff.find(person => person.id === ws.me) ?? visibleStaff[0];
  const grade = me ? gradeForStaff(me, ws.profile) : undefined;
  return <section className="settings-you"><p className="eyebrow">Your workspace</p><h2>You</h2><div className="settings-you-row"><div><h3>Who are you?</h3><p className="muted">Choose how this workspace is used.</p></div><fieldset className="settings-role-choice" aria-label="Who are you?"><label><input type="radio" name="workspace-role" checked={(ws.role ?? 'doctor') === 'doctor'} onChange={() => update(workspace => { setWorkspaceRole(workspace, 'doctor'); })} /> A doctor on this rota</label><label><input type="radio" name="workspace-role" checked={ws.role === 'coordinator'} onChange={() => update(workspace => { setWorkspaceRole(workspace, 'coordinator'); })} /> I make the rota (coordinator)</label></fieldset></div>{ws.role !== 'coordinator' && <><div className="settings-you-row"><div><h3>Viewing as</h3><p className="muted">Choose the doctor shown first on Overview.</p></div><ViewingAs /></div>
    <div className="settings-you-row"><div><h3>Your grade</h3><p>{me ? grade ?? 'No grade assigned' : 'Choose who you are in the setup wizard.'}</p></div><button type="button" onClick={changeGrade}>Change grade in People</button></div>
    <p className="small muted">Other doctors on the rota are managed in <button type="button" className="link-button" onClick={changeGrade}>People</button>.</p></>}
  </section>;
}

function FilesAndPresets({ onRunSetup }: { onRunSetup: () => void }) {
  const ws = useWorkspace();
  const file = useRef<HTMLInputElement>(null);
  const presetFile = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState('');
  const [confirm, setConfirm] = useState<'example' | 'empty' | 'preset' | null>(null);
  const [pendingPreset, setPendingPreset] = useState<SetupPreset | null>(null);
  const loadExample = () => {
    const ex = stressProblem(1);
    const extras: Workspace['staffExtras'] = {};
    const unavailability = ex.unavailability.filter(item => {
      if (item.kind !== 'nonWorking') return true;
      const day = (new Date(`${item.date}T00:00:00Z`).getUTCDay() + 6) % 7;
      const days = new Set(extras[item.staffId]?.nonWorkingWeekdays ?? []);
      days.add(day as 0); extras[item.staffId] = { nonWorkingWeekdays: [...days].sort() }; return false;
    });
    replaceWorkspace({ ...emptyWorkspace(), profile: { ...ex.profile, name: 'Example department' }, staffExtras: extras, period: { start: ex.start, end: ex.end }, unavailability, fixed: ex.fixed });
    setConfirm(null); setMessage('Example loaded: 25 made-up doctors over 4 weeks.');
  };
  return <section className="settings-files"><h2>Files and presets</h2><p className="muted">Save a workspace file, load a setup preset, or start again. Your changes are also saved in this browser.</p><div className="row">
    <button onClick={exportWorkspace}>Save to file</button><button onClick={() => file.current?.click()}>Open file</button><button onClick={() => presetFile.current?.click()}>Load a preset</button><button onClick={() => downloadPreset(ws)}>Save setup as preset file</button><button onClick={() => setConfirm('example')}>Load example</button><button className="danger" onClick={() => setConfirm('empty')}>Start empty</button><button type="button" onClick={onRunSetup}>Run setup again</button>
    <input ref={file} type="file" accept=".json,application/json" hidden onChange={async e => { const picked = e.target.files?.[0]; if (!picked) return; try { await importWorkspace(picked); setMessage(`Opened ${picked.name}.`); } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not open that file.'); } e.target.value = ''; }} />
    <input ref={presetFile} type="file" accept=".preset.json,.json,application/json" hidden onChange={async e => { const picked = e.target.files?.[0]; if (!picked) return; try { const value = JSON.parse(await picked.text()); if (!isSetupPreset(value)) throw new Error('This file is not a valid setup preset.'); setPendingPreset(value); setConfirm(null); } catch { setMessage('This file is not a valid setup preset.'); } e.target.value = ''; }} />
  </div>
  {pendingPreset && <ConfirmPanel title={`Load ${pendingPreset.name}?`} confirmLabel="Load preset" onConfirm={() => { update(workspace => applyPresetToWorkspace(workspace, pendingPreset)); setPendingPreset(null); }} onCancel={() => setPendingPreset(null)}>This replaces shifts, places, staffing needs, rules and swap settings. People and imported rota weeks are kept.</ConfirmPanel>}
  {confirm === 'example' && <ConfirmPanel title="Replace this workspace with the example?" confirmLabel="Load example" onConfirm={loadExample} onCancel={() => setConfirm(null)}>Everything in this workspace is replaced. Save to file first if you want to keep it.</ConfirmPanel>}
  {confirm === 'empty' && <ConfirmPanel title="Start with an empty workspace?" confirmLabel="Clear everything" onConfirm={() => { replaceWorkspace(emptyWorkspace()); setConfirm(null); setMessage('Started with an empty workspace.'); }} onCancel={() => setConfirm(null)}>This clears everything in this browser. Save to file first if you want to keep it.</ConfirmPanel>}
  {message && <p className="notice">{message}</p>}</section>;
}
