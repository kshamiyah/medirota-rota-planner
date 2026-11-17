import './polyfill-storage';
import { beforeEach, describe, expect, it } from 'vitest';
import { clearPolyfillStorage } from './polyfill-storage';
import { SETTINGS_GROUPS } from '../src/app/pages/Settings';
import { defaultSessionsSettings } from '../src/app/sessions';
import { DEFAULT_SWAP_SETTINGS } from '../src/app/mediImport';
import {
  emptyWorkspace, getWorkspace, replaceWorkspace, update, writeWorkspaceAsOtherTab, adoptWorkspaceFromStorage,
  WORKSPACE_STORAGE_KEY,
} from '../src/app/store';
import { canAdvanceSetupWizard, fetchFromMediRotaWizardStep, nextSetupWizardStep, setWizardDoctor, setWorkspaceRole, shouldShowSetupWizard } from '../src/app/setupWizard';

beforeEach(() => { clearPolyfillStorage(); replaceWorkspace(emptyWorkspace()); });

describe('open-source setup wizard', () => {
  it('opens only for a genuinely fresh workspace', () => {
    const empty = emptyWorkspace();
    expect(shouldShowSetupWizard(empty, false)).toBe(true);
    expect(shouldShowSetupWizard(empty, true)).toBe(false);
    empty.profile.staff.push({ id: 'rowan', name: 'Dr Rowan', groupIds: [], fte: 1 });
    expect(shouldShowSetupWizard(empty, false)).toBe(false);
  });
  it('has neutral, empty department session defaults', () => {
    const settings = defaultSessionsSettings(emptyWorkspace().profile);
    expect(settings.types).toEqual([]);
    expect(settings.groups).toEqual([]);
    expect(settings.ratios).toEqual({});
  });
  it('walks the doctor steps and applies skip and back', () => {
    expect(nextSetupWizardStep('role', 'next')).toBe('rota');
    expect(nextSetupWizardStep('rota', 'skip')).toBe('doctor');
    expect(nextSetupWizardStep('doctor', 'back')).toBe('rota');
    expect(nextSetupWizardStep('types', 'next')).toBe('groups');
    expect(nextSetupWizardStep('minimums', 'next')).toBe('finish');
    expect(nextSetupWizardStep('finish', 'back')).toBe('minimums');
  });
  it('requires a role and a doctor only on the doctor step', () => {
    expect(canAdvanceSetupWizard('role', false, false, undefined)).toBe(false);
    expect(canAdvanceSetupWizard('role', false, false, 'doctor')).toBe(true);
    expect(canAdvanceSetupWizard('rota', false, false, 'coordinator')).toBe(true);
    expect(canAdvanceSetupWizard('doctor', true, false, 'doctor')).toBe(false);
    expect(canAdvanceSetupWizard('doctor', true, true, 'doctor')).toBe(true);
  });
  it('sets the doctor role when a doctor is chosen', () => {
    const workspace = emptyWorkspace();
    workspace.profile.staff.push({ id: 'rowan', name: 'Dr Rowan', groupIds: [], fte: 1 });
    setWizardDoctor(workspace, 'rowan');
    expect(workspace.me).toBe('rowan');
    expect(workspace.role).toBe('doctor');
  });
  it('clears me when switching to coordinator', () => {
    const workspace = emptyWorkspace(); workspace.me = 'rowan';
    setWorkspaceRole(workspace, 'coordinator');
    expect(workspace.role).toBe('coordinator');
    expect(workspace.me).toBeUndefined();
  });
  it('keeps the role choice in Settings', () => {
    expect(SETTINGS_GROUPS[0].sections.some(([, label]) => label === 'You')).toBe(true);
  });
  it('continues the MediRota fetch tab at doctor for doctors and types for coordinators', () => {
    expect(fetchFromMediRotaWizardStep(undefined)).toBe('doctor');
    expect(fetchFromMediRotaWizardStep('doctor')).toBe('doctor');
    expect(fetchFromMediRotaWizardStep('coordinator')).toBe('types');
  });
});

describe('Stage 5 two-tab MediRota import inside the wizard', () => {
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
    expect(getWorkspace().profile.staff.map(person => person.name)).toEqual(['Dr Rowan', 'Dr Ellis']);
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

  it('keeps the other tab on its step and does not lose the import when the fetch tab continues by role', () => {
    replaceWorkspace(emptyWorkspace());
    update(workspace => { workspace.role = 'coordinator'; });
    const originalStep = 'rota';
    const imported = emptyWorkspace();
    imported.role = 'coordinator';
    imported.profile.staff = [{ id: 'moss', name: 'Dr Moss', groupIds: [], fte: 1 }];
    imported.swapFinder = {
      settings: structuredClone(DEFAULT_SWAP_SETTINGS),
      snapshot: { days: {}, importedAt: { '2026-12-21': '2026-11-14T12:00:00Z' } },
    };
    writeWorkspaceAsOtherTab(imported);
    window.dispatchEvent(new StorageEvent('storage', { key: WORKSPACE_STORAGE_KEY }));
    expect(fetchFromMediRotaWizardStep(getWorkspace().role)).toBe('types');
    expect(originalStep).toBe('rota');
    expect(Object.keys(getWorkspace().swapFinder?.snapshot.importedAt ?? {})).toEqual(['2026-12-21']);
    expect(getWorkspace().role).toBe('coordinator');
    expect(getWorkspace().profile.staff.map(person => person.name)).toEqual(['Dr Moss']);
  });

  it('still adopts a newer revision from another tab before update()', () => {
    replaceWorkspace(emptyWorkspace());
    const imported = emptyWorkspace();
    imported.profile.staff = [{ id: 'moss', name: 'Dr Moss', groupIds: [], fte: 1 }];
    imported.swapFinder = {
      settings: structuredClone(DEFAULT_SWAP_SETTINGS),
      snapshot: { days: {}, importedAt: { '2026-12-28': '2026-11-14T12:00:00Z' } },
    };
    writeWorkspaceAsOtherTab(imported);
    update(workspace => { workspace.me = 'moss'; });
    expect(getWorkspace().me).toBe('moss');
    expect(Object.keys(getWorkspace().swapFinder?.snapshot.importedAt ?? {})).toEqual(['2026-12-28']);
  });

  it('does not adopt an older stored copy just because the JSON differs', () => {
    replaceWorkspace(emptyWorkspace());
    update(workspace => { workspace.me = 'vale'; workspace.profile.staff = [{ id: 'vale', name: 'Dr Vale', groupIds: [], fte: 1 }]; });
    const older = emptyWorkspace();
    older.profile.staff = [{ id: 'hart', name: 'Dr Hart', groupIds: [], fte: 1 }];
    const staleRev = Math.max(0, Number(localStorage.getItem('rota-planner.workspace.rev.v1') ?? '0') - 1);
    localStorage.setItem('rota-planner.workspace.v1', JSON.stringify(older));
    localStorage.setItem('rota-planner.workspace.rev.v1', String(Math.max(0, staleRev)));
    expect(adoptWorkspaceFromStorage()).toBe(false);
    expect(getWorkspace().me).toBe('vale');
    expect(getWorkspace().profile.staff[0].name).toBe('Dr Vale');
  });
});
