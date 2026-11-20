import type { Workspace } from './store';
import type { SessionsSettings } from './sessions';

export const SETUP_WIZARD_STEPS = ['welcome', 'role', 'bookmark', 'fetch', 'summary', 'doctor', 'types', 'groups', 'shares', 'minimums', 'rules'] as const;
export type SetupWizardStep = typeof SETUP_WIZARD_STEPS[number] | 'finish';
export type WizardAction = 'back' | 'skip' | 'next';

export function shouldShowSetupWizard(workspace: Workspace, hasSavedWorkspace: boolean): boolean {
  return !hasSavedWorkspace && workspace.profile.staff.length === 0 && Object.keys(workspace.swapFinder?.snapshot.importedAt ?? {}).length === 0;
}

function workspaceHasNoRotaYet(workspace: Workspace): boolean {
  return workspace.profile.staff.length === 0 && Object.keys(workspace.swapFinder?.snapshot.importedAt ?? {}).length === 0;
}

/**
 * Decide on fetch-tab load, before any import lands: continue setup when it isn't
 * done or dismissed and this workspace still has no rota (no staff, no imported
 * weeks). A saved role alone must not count as finished setup.
 */
export function shouldOpenFetchTabSetup(workspace: Workspace, dismissed: boolean, setupInProgress = false): boolean {
  return !dismissed && setupInProgress && workspaceHasNoRotaYet(workspace);
}

export function setWorkspaceRole(workspace: Workspace, role: 'doctor' | 'coordinator'): void {
  workspace.role = role;
  if (role === 'coordinator') delete workspace.me;
}

/**
 * Role step Next. First-time setup always saves the chosen role.
 * On a rerun, pre-selecting doctor on screen must not write role when it was
 * undefined; only write when role was already set, or they chose coordinator.
 */
export function applyWizardRoleChoice(workspace: Workspace, role: 'doctor' | 'coordinator', mode: 'firstRun' | 'rerun'): void {
  if (mode === 'firstRun') { setWorkspaceRole(workspace, role); return; }
  if (role === 'coordinator' || workspace.role === 'coordinator') setWorkspaceRole(workspace, role);
  else if (workspace.role !== undefined) setWorkspaceRole(workspace, role);
}

export function nextSetupWizardStep(step: SetupWizardStep, action: WizardAction): SetupWizardStep {
  if (step === 'welcome' && action === 'skip') return 'finish';
  if (step === 'fetch' && action === 'skip') return 'rules';
  if (step === 'bookmark' && action === 'skip') return 'fetch';
  if (step === 'minimums' && action === 'next') return 'rules';
  if (action === 'back') {
    if (step === 'finish') return 'rules';
    const index = SETUP_WIZARD_STEPS.indexOf(step);
    return SETUP_WIZARD_STEPS[Math.max(0, index - 1)];
  }
  if (step === 'finish') return 'finish';
  const index = SETUP_WIZARD_STEPS.indexOf(step);
  return SETUP_WIZARD_STEPS[index + 1] ?? 'finish';
}

export function canAdvanceSetupWizard(step: SetupWizardStep, hasRota: boolean, hasDoctor: boolean, role?: 'doctor' | 'coordinator'): boolean {
  return step !== 'finish' && (step !== 'role' || !!role) && (step !== 'doctor' || hasDoctor) && (['welcome', 'role', 'bookmark', 'fetch', 'summary', 'rules', 'minimums'].includes(step) || hasRota);
}

export function setupGroupForGrade(grade: string | undefined, settings: SessionsSettings): string | undefined {
  if (!grade) return undefined;
  const key = grade.trim().toLocaleLowerCase('en-GB');
  return settings.groups.find(group => group.grades.some(item => item.trim().toLocaleLowerCase('en-GB') === key))?.name;
}

export function commitWizardRatios(workspace: Workspace, settings: SessionsSettings): void {
  workspace.sessions = structuredClone(settings);
}

export function setWizardDoctor(workspace: Workspace, staffId: string): void {
  applyWizardDoctorChoice(workspace, staffId, 'firstRun');
}

/** Doctor step Next: always keep me in sync; only force role 'doctor' on first-time setup (or when role is already set to something else on a rerun). */
export function applyWizardDoctorChoice(workspace: Workspace, staffId: string, mode: 'firstRun' | 'rerun'): void {
  if (!workspace.profile.staff.some(person => person.id === staffId)) return;
  if (workspace.me !== staffId) workspace.me = staffId;
  if (mode === 'firstRun') { if (workspace.role !== 'doctor') workspace.role = 'doctor'; }
  else if (workspace.role !== 'doctor' && workspace.role !== undefined) workspace.role = 'doctor';
}

/** After ?fetchFromMediRota=1 imports, continue setup: doctors pick themselves; coordinators skip that step. */
export function fetchFromMediRotaWizardStep(role?: 'doctor' | 'coordinator'): SetupWizardStep {
  return role === 'coordinator' ? 'types' : 'doctor';
}
