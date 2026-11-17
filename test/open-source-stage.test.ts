import './polyfill-storage';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { clearPolyfillStorage } from './polyfill-storage';
import { emptyWorkspace, getWorkspace, replaceWorkspace, update, writeWorkspaceAsOtherTab, adoptWorkspaceFromStorage, WORKSPACE_STORAGE_KEY } from '../src/app/store';
import { defaultSessionsSettings } from '../src/app/sessions';
import { DEFAULT_SWAP_SETTINGS } from '../src/app/mediImport';
import { commitWizardSessionsStep, suggestSessionKind, suggestSessionType, wizardSettingsDraft } from '../src/app/pages/SetupWizard';
import { workingMinimumLabel, shortDays, workingCount } from '../src/app/overview';
import { applyPresetToWorkspace, isSetupPreset, makePresetFromWorkspace } from '../src/app/presets';
import { applyWizardDoctorChoice, setWizardDoctor, setWorkspaceRole } from '../src/app/setupWizard';

function sourceFiles(path: string): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? sourceFiles(join(path, entry.name)) : /\.(ts|tsx)$/.test(entry.name) ? [join(path, entry.name)] : []);
}

function madeUpWorkspace() {
  const workspace = emptyWorkspace();
  workspace.role = 'doctor';
  workspace.me = 'rowan';
  workspace.profile.name = 'Example department';
  workspace.profile.groups = [
    { id: 'junior', name: 'Junior doctors' },
    { id: 'general', name: 'Doctors' },
    { id: 'senior', name: 'Senior doctors' },
  ];
  workspace.profile.roles = [
    { id: 'labour', name: 'Labour Ward' },
    { id: 'theatre', name: 'Theatre List 1' },
    { id: 'day', name: 'Day Unit' },
    { id: 'assessment', name: 'Assessment Unit' },
    { id: 'nights', name: 'Nights' },
  ];
  workspace.profile.staff = [
    { id: 'rowan', name: 'Dr Rowan', groupIds: ['junior'], fte: 1 },
    { id: 'ellis', name: 'Dr Ellis', groupIds: ['general'], fte: 1 },
    { id: 'hart', name: 'Dr Hart', groupIds: ['senior'], fte: 1 },
    { id: 'moss', name: 'Dr Moss', groupIds: ['junior'], fte: 1 },
    { id: 'vale', name: 'Dr Vale', groupIds: ['general'], fte: 1 },
  ];
  workspace.swapFinder = {
    settings: { ...structuredClone(DEFAULT_SWAP_SETTINGS), minDoctors: [0, 0, 0, 0, 0, 0, 0], minDoctorsBankHoliday: 0 },
    snapshot: {
      days: {
        rowan: { '2026-11-16': { status: 'dayJob', activity: 'Labour Ward' } },
        ellis: { '2026-11-16': { status: 'dayJob', activity: 'Theatre List 1' } },
        hart: { '2026-11-16': { status: 'dayJob', activity: 'Day Unit' } },
        moss: { '2026-11-16': { status: 'dayJob', activity: 'Assessment Unit' } },
      },
      importedAt: { '2026-11-16': '2026-11-15T12:00:00Z' },
    },
  };
  workspace.sessions = {
    types: [
      { id: 'type-theatre', name: 'Theatre', colour: 4, kind: 'day', placeIds: ['theatre'] },
      { id: 'type-wards', name: 'Wards', colour: 2, kind: 'day', placeIds: ['labour'] },
      { id: 'type-assessment', name: 'Assessment', colour: 3, kind: 'day', placeIds: ['assessment'] },
      { id: 'type-nights', name: 'Nights', colour: 8, kind: 'on-call', placeIds: ['nights'] },
    ],
    groups: [
      { id: 'comparison-junior', name: 'Junior doctors', grades: ['Junior doctors'] },
      { id: 'comparison-general', name: 'Doctors', grades: ['Doctors'] },
      { id: 'comparison-senior', name: 'Senior doctors', grades: ['Senior doctors'] },
    ],
    ratios: {},
    sameConsultants: { groupIds: [], typeIds: [] },
  };
  for (const type of workspace.sessions.types) {
    workspace.sessions.ratios[type.id] = Object.fromEntries(workspace.sessions.groups.map(group => [group.id, 1]));
  }
  return workspace;
}

/** Mirror SetupWizard Next with the on-screen draft (suggestions when nothing is saved). */
function finishSetupWithoutEdits(workspace: ReturnType<typeof madeUpWorkspace>, role: 'doctor' | 'coordinator') {
  const settingsDraft = wizardSettingsDraft(workspace);
  const minimumDraft = {
    weekdays: [...(workspace.swapFinder?.settings.minDoctors ?? [0, 0, 0, 0, 0, 0, 0])],
    bankHoliday: workspace.swapFinder?.settings.minDoctorsBankHoliday ?? 0,
  };
  setWorkspaceRole(workspace, role);
  if (role === 'doctor' && workspace.me) setWizardDoctor(workspace, workspace.me);
  commitWizardSessionsStep(workspace, 'types', settingsDraft);
  commitWizardSessionsStep(workspace, 'groups', settingsDraft);
  commitWizardSessionsStep(workspace, 'ratios', settingsDraft);
  if (workspace.swapFinder) {
    if (JSON.stringify(workspace.swapFinder.settings.minDoctors) !== JSON.stringify(minimumDraft.weekdays)) {
      workspace.swapFinder.settings.minDoctors = [...minimumDraft.weekdays];
    }
    if (workspace.swapFinder.settings.minDoctorsBankHoliday !== minimumDraft.bankHoliday) {
      workspace.swapFinder.settings.minDoctorsBankHoliday = minimumDraft.bankHoliday;
    }
  }
}

function importedWithoutSessions(role: 'doctor' | 'coordinator') {
  const workspace = madeUpWorkspace();
  workspace.role = role;
  if (role === 'coordinator') delete workspace.me;
  else workspace.me = undefined;
  delete workspace.sessions;
  return workspace;
}

function expectSuggestedSessionsSaved(workspace: ReturnType<typeof madeUpWorkspace>) {
  const draft = wizardSettingsDraft({ ...workspace, sessions: undefined });
  expect(workspace.sessions?.types.map(type => type.name).sort()).toEqual(draft.types.map(type => type.name).sort());
  expect(workspace.sessions?.types.some(type => type.name === 'Wards' && type.placeIds.includes('labour'))).toBe(true);
  expect(workspace.sessions?.types.some(type => type.placeIds.includes('day'))).toBe(false);
  expect(workspace.sessions?.groups.map(group => group.name).sort()).toEqual(['Doctors', 'Junior doctors', 'Senior doctors']);
  for (const type of workspace.sessions!.types) {
    for (const group of workspace.sessions!.groups) expect(workspace.sessions!.ratios[type.id][group.id]).toBe(1);
  }
  expect(workspace.swapFinder?.settings.minDoctors).toEqual([0, 0, 0, 0, 0, 0, 0]);
  expect(workspace.swapFinder?.settings.minDoctorsBankHoliday).toBe(0);
}

beforeEach(() => { clearPolyfillStorage(); replaceWorkspace(emptyWorkspace()); });

describe('open-source stage defaults', () => {
  it('starts with no department session types or groups and no swap minimums', () => {
    expect(defaultSessionsSettings(emptyWorkspace().profile)).toMatchObject({ types: [], groups: [], ratios: {} });
    expect(DEFAULT_SWAP_SETTINGS.minDoctors).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(DEFAULT_SWAP_SETTINGS.minDoctorsBankHoliday).toBe(0);
  });

  it.each([
    ['Theatre List 1', 'Theatre'],
    ['Elective surgery', 'Theatre'],
    ['Sections', 'Theatre'],
    ['section list', 'Theatre'],
    ['Labour Ward', 'Wards'],
    ['Ward round', 'Wards'],
    ['Antenatal clinic', 'Wards'],
    ['Postnatal unit', 'Wards'],
    ['Night cover', 'Nights'],
    ['Nights', 'Nights'],
    ['Clinic 2', 'Clinic'],
    ['Assessment Unit', 'Assessment'],
    ['Triage', 'Assessment'],
    ['MAU', 'Assessment'],
    ['EAU', 'Assessment'],
    ['SAU', 'Assessment'],
    ['Day Unit', 'Not counted'],
    ['THEATRE LIST 1', 'Theatre'],
    ['labour ward', 'Wards'],
    ['WC Theatres', 'Theatre'],
    ['Main Wards', 'Wards'],
    ['Outpatient Clinics', 'Clinic'],
    ['Theatre Lists', 'Theatre'],
    ['forward', 'Not counted'],
    ['Checklist', 'Not counted'],
    ['mausoleum', 'Not counted'],
    ['wardrobe', 'Not counted'],
    ['award night', 'Nights'],
  ])('suggests %s as %s', (place, expected) => expect(suggestSessionType(place)).toBe(expected));

  it('guesses on-call kind from the majority of imported nights and long days', () => {
    const workspace = emptyWorkspace();
    workspace.swapFinder = { settings: structuredClone(DEFAULT_SWAP_SETTINGS), snapshot: { days: {
      rowan: { '2026-11-02': { status: 'night', activity: 'Theatre List 1' }, '2026-11-03': { status: 'longDay', activity: 'Theatre List 1' }, '2026-11-04': { status: 'dayJob', activity: 'Theatre List 1' } },
    }, importedAt: {} } };
    expect(suggestSessionKind('Theatre List 1', workspace)).toBe('on-call');
    expect(suggestSessionKind('No shifts found', workspace)).toBe('day');
  });

  it('keeps removed specialty preset strings out of source code outside comments', () => {
    const combined = sourceFiles('src').map(file => readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\/|(^|[^:])\/\/.*$/gm, '$1')).join('\n');
    for (const term of ['Elective C-Sections', 'WC Theatres', 'OUH', 'O&G']) expect(combined).not.toContain(term);
  });
});

describe('open-source overview minimums', () => {
  it('shows only the working count when the minimum is 0 and never marks the day under', () => {
    const workspace = madeUpWorkspace();
    const snapshot = workspace.swapFinder!.snapshot;
    const date = '2026-11-16';
    expect(workingCount(snapshot, date)).toBe(4);
    expect(workingMinimumLabel(4, 0)).toBe('4');
    expect(workingMinimumLabel(4, 7)).toBe('4/7');
    expect(shortDays(snapshot, workspace.swapFinder!.settings, [date]).get(date)).toBe(0);
    workspace.swapFinder!.settings.minDoctors = [7, 7, 7, 7, 7, 3, 3];
    expect(shortDays(snapshot, workspace.swapFinder!.settings, [date]).get(date)).toBe(3);
  });
});

describe('open-source role and presets', () => {
  it('loads a saved workspace with no role as a doctor, keeping me, sessions, ratios and minimums', () => {
    const workspace = madeUpWorkspace();
    delete workspace.role;
    const before = structuredClone(workspace);
    replaceWorkspace(workspace);
    const loaded = getWorkspace();
    expect(loaded.role).toBeUndefined();
    expect(loaded.me).toBe(before.me);
    expect(loaded.sessions).toEqual(before.sessions);
    expect(loaded.swapFinder?.settings.minDoctors).toEqual(before.swapFinder?.settings.minDoctors);
    expect(loaded.swapFinder?.settings.minDoctorsBankHoliday).toBe(before.swapFinder?.settings.minDoctorsBankHoliday);
    expect((loaded.role ?? 'doctor')).toBe('doctor');
  });

  it('clears me when switching Settings You to coordinator and restores doctor choice afterwards', () => {
    replaceWorkspace(madeUpWorkspace());
    update(workspace => setWorkspaceRole(workspace, 'coordinator'));
    expect(getWorkspace().role).toBe('coordinator');
    expect(getWorkspace().me).toBeUndefined();
    // App and Settings hide Viewing as / You rows when role is coordinator.
    expect(getWorkspace().role !== 'coordinator').toBe(false);
    update(workspace => setWorkspaceRole(workspace, 'doctor'));
    expect(getWorkspace().role).toBe('doctor');
    expect(getWorkspace().me).toBeUndefined();
    update(workspace => setWizardDoctor(workspace, 'rowan'));
    expect(getWorkspace().me).toBe('rowan');
    expect(getWorkspace().role !== 'coordinator').toBe(true);
  });

  it('accepts a valid preset file and rejects an invalid one with one plain line', () => {
    const workspace = madeUpWorkspace();
    const preset = makePresetFromWorkspace(workspace);
    expect(isSetupPreset(preset)).toBe(true);
    const next = structuredClone(workspace);
    applyPresetToWorkspace(next, preset);
    expect(next.sessions?.types.map(type => type.name)).toEqual(preset.sessions?.types.map(type => type.name));
    expect(isSetupPreset({ version: 1, name: 'Broken' })).toBe(false);
    expect('This file is not a valid setup preset.').toMatch(/^This file is not a valid setup preset\.$/);
  });

  it('keeps workspace JSON deep-equal after Run setup again with no edits for both roles', () => {
    for (const role of ['doctor', 'coordinator'] as const) {
      const workspace = madeUpWorkspace();
      if (role === 'coordinator') { workspace.role = 'coordinator'; delete workspace.me; }
      const before = structuredClone(workspace);
      finishSetupWithoutEdits(workspace, role);
      expect(workspace).toEqual(before);
    }
  });

  it('keeps role undefined on a no-edit rerun of a pre-role workspace', () => {
    const workspace = madeUpWorkspace();
    delete workspace.role;
    expect(workspace.me).toBe('rowan');
    expect(workspace.sessions?.types.length).toBeGreaterThan(0);
    const before = structuredClone(workspace);
    const draft = wizardSettingsDraft(workspace);
    applyWizardDoctorChoice(workspace, workspace.me!, 'rerun');
    commitWizardSessionsStep(workspace, 'types', draft);
    commitWizardSessionsStep(workspace, 'groups', draft);
    commitWizardSessionsStep(workspace, 'ratios', draft);
    expect(workspace.role).toBeUndefined();
    expect(workspace).toEqual(before);
  });

  it('saves on-screen suggestions when Next has no edits and nothing was saved yet (fetch-tab style)', () => {
    for (const role of ['doctor', 'coordinator'] as const) {
      const workspace = importedWithoutSessions(role);
      const draft = wizardSettingsDraft(workspace);
      expect(workspace.sessions).toBeUndefined();
      if (role === 'doctor') applyWizardDoctorChoice(workspace, 'rowan', 'firstRun');
      else setWorkspaceRole(workspace, 'coordinator');
      commitWizardSessionsStep(workspace, 'types', draft);
      commitWizardSessionsStep(workspace, 'groups', draft);
      commitWizardSessionsStep(workspace, 'ratios', draft);
      expectSuggestedSessionsSaved(workspace);
      if (role === 'doctor') {
        expect(workspace.me).toBe('rowan');
        expect(workspace.role).toBe('doctor');
      } else {
        expect(workspace.me).toBeUndefined();
        expect(workspace.role).toBe('coordinator');
      }
    }
  });

  it('saves the same suggestions from the original-tab first-run path', () => {
    const original = importedWithoutSessions('doctor');
    const fetchTab = importedWithoutSessions('doctor');
    const originalDraft = wizardSettingsDraft(original);
    const fetchDraft = wizardSettingsDraft(fetchTab);
    applyWizardDoctorChoice(original, 'rowan', 'firstRun');
    applyWizardDoctorChoice(fetchTab, 'rowan', 'firstRun');
    for (const step of ['types', 'groups', 'ratios'] as const) {
      commitWizardSessionsStep(original, step, originalDraft);
      commitWizardSessionsStep(fetchTab, step, fetchDraft);
    }
    expect(original.sessions?.types.map(type => ({ name: type.name, placeIds: [...type.placeIds].sort() }))).toEqual(
      fetchTab.sessions?.types.map(type => ({ name: type.name, placeIds: [...type.placeIds].sort() })),
    );
    expect(original.sessions?.groups.map(group => ({ name: group.name, grades: group.grades }))).toEqual(
      fetchTab.sessions?.groups.map(group => ({ name: group.name, grades: group.grades })),
    );
    expect(original.me).toBe('rowan');
    expect(fetchTab.me).toBe('rowan');
    expect(original.role).toBe('doctor');
    expect(fetchTab.role).toBe('doctor');
  });

});

describe('open-source Stage 5 two-tab MediRota import', () => {
  it('keeps an import from another tab when this tab later sets Viewing as', () => {
    replaceWorkspace(emptyWorkspace());
    const imported = emptyWorkspace();
    imported.profile.staff = [
      { id: 'rowan', name: 'Dr Rowan', groupIds: ['junior'], fte: 1 },
      { id: 'ellis', name: 'Dr Ellis', groupIds: ['general'], fte: 1 },
    ];
    imported.profile.groups = [{ id: 'junior', name: 'Junior doctors' }, { id: 'general', name: 'Doctors' }];
    imported.swapFinder = {
      settings: structuredClone(DEFAULT_SWAP_SETTINGS),
      snapshot: { days: {}, importedAt: { '2026-11-30': '2026-11-14T12:00:00Z', '2026-12-07': '2026-11-14T12:00:00Z' } },
    };
    writeWorkspaceAsOtherTab(imported);
    expect(Object.keys(getWorkspace().swapFinder?.snapshot.importedAt ?? {})).toHaveLength(0);
    window.dispatchEvent(new StorageEvent('storage', { key: WORKSPACE_STORAGE_KEY }));
    expect(Object.keys(getWorkspace().swapFinder?.snapshot.importedAt ?? {})).toEqual(['2026-11-30', '2026-12-07']);
    update(workspace => setWizardDoctor(workspace, 'rowan'));
    expect(getWorkspace().me).toBe('rowan');
    expect(Object.keys(getWorkspace().swapFinder?.snapshot.importedAt ?? {})).toEqual(['2026-11-30', '2026-12-07']);
  });

  it('adopts a foreign import inside update even without a StorageEvent', () => {
    replaceWorkspace(emptyWorkspace());
    const imported = emptyWorkspace();
    imported.profile.staff = [{ id: 'hart', name: 'Dr Hart', groupIds: [], fte: 1 }];
    imported.swapFinder = {
      settings: structuredClone(DEFAULT_SWAP_SETTINGS),
      snapshot: { days: {}, importedAt: { '2026-12-14': '2026-11-14T12:00:00Z' } },
    };
    writeWorkspaceAsOtherTab(imported);
    update(workspace => setWizardDoctor(workspace, 'hart'));
    expect(getWorkspace().me).toBe('hart');
    expect(Object.keys(getWorkspace().swapFinder?.snapshot.importedAt ?? {})).toEqual(['2026-12-14']);
  });

  it('exports adoptWorkspaceFromStorage for the fetch-tab hand-off', () => {
    replaceWorkspace(emptyWorkspace());
    const imported = emptyWorkspace();
    imported.swapFinder = {
      settings: structuredClone(DEFAULT_SWAP_SETTINGS),
      snapshot: { days: {}, importedAt: { '2026-12-21': '2026-11-14T12:00:00Z' } },
    };
    writeWorkspaceAsOtherTab(imported);
    expect(adoptWorkspaceFromStorage()).toBe(true);
    expect(Object.keys(getWorkspace().swapFinder?.snapshot.importedAt ?? {})).toEqual(['2026-12-21']);
    expect(adoptWorkspaceFromStorage()).toBe(false);
  });
});
