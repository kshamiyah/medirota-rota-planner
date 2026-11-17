import type { Profile } from '../engine/types';
import type { SwapSettings } from '../engine/swaps';
import type { Workspace } from './store';
import { defaultSessionsSettings, type SessionsSettings } from './sessions';

export type PresetPersonField = 'excludeFromSwaps' | 'regularDaysOff' | 'fte' | 'locum' | 'regularLocum' | 'sessionSubGroup' | 'consultants';
export interface PresetPerson {
  name: string;
  excludeFromSwaps?: boolean;
  regularDaysOff?: number[];
  fte?: number;
  locum?: boolean;
  regularLocum?: boolean;
  sessionSubGroup?: string;
  consultants?: string[];
}
export type PresetProfile = Pick<Profile, 'shiftTypes' | 'roles' | 'groups' | 'demands' | 'rules' | 'fairness'>;
export type PresetSwapSettings = Omit<SwapSettings, 'regularDaysOff' | 'excluded'>;
export interface SetupPreset {
  version: 1;
  id: string;
  name: string;
  description: string;
  setup: { profile: PresetProfile; swapSettings: PresetSwapSettings };
  sessions?: SessionsSettings;
  people?: PresetPerson[];
  consultants?: string[];
  /** Local presets only: doctor treated as the owner's default view. */
  me?: string;
}

export function isSetupPreset(value: unknown): value is SetupPreset {
  if (!value || typeof value !== 'object') return false;
  const preset = value as Partial<SetupPreset>;
  return preset.version === 1 && typeof preset.id === 'string' && typeof preset.name === 'string'
    && typeof preset.description === 'string' && !!preset.setup?.profile && !!preset.setup?.swapSettings;
}

export function getPresets(_legacyFiles?: unknown[]): SetupPreset[] { return []; }

export function normalisePresetName(name: string): string {
  return name.trim().toLocaleLowerCase('en-GB').replace(/^dr\s*/i, '').replace(/\s+/g, ' ');
}

export function resolvePresetPeople(people: PresetPerson[] = [], staff: Profile['staff']): { unmatched: string[]; ambiguous: string[] } {
  const unmatched: string[] = [];
  const ambiguous: string[] = [];
  for (const person of people) {
    const matches = staff.filter(item => normalisePresetName(item.name) === normalisePresetName(person.name));
    if (matches.length === 0) unmatched.push(person.name);
    else if (matches.length > 1) ambiguous.push(person.name);
  }
  return { unmatched, ambiguous };
}

const defaultSwapSettings = (): SwapSettings => ({
  weekendDayActivities: [], hoursTolerance: 1, maxChain: 4, returnPattern: 'consecutive',
  returnDayType: 'noPreference', returnWindow: { kind: 'any' }, noAlertsOnly: false,
  includeNormalDays: false, minDoctors: [0, 0, 0, 0, 0, 0, 0], minDoctorsBankHoliday: 0,
  bankHolidays: [], regularDaysOff: {}, excluded: [],
});

export function markPresetPersonOverride(workspace: Workspace, name: string, field: PresetPersonField, value: boolean | number | number[] | string | string[]): void {
  if (!workspace.presetPeople) return;
  workspace.presetPeople.manualOverrides ??= {};
  const key = normalisePresetName(name);
  workspace.presetPeople.manualOverrides[key] ??= {};
    (workspace.presetPeople.manualOverrides[key] as Record<PresetPersonField, boolean | number | number[] | string | string[]>)[field] = value;
}

export function applyPresetPeopleSettings(workspace: Workspace): void {
  const memory = workspace.presetPeople;
  const settings = workspace.swapFinder?.settings;
  if (!memory || !settings) return;
  memory.manualOverrides ??= {};
  for (const presetPerson of memory.people) {
    const matches = workspace.profile.staff.filter(person => normalisePresetName(person.name) === normalisePresetName(presetPerson.name));
    if (matches.length !== 1) continue;
    const staff = matches[0];
    const overrides = memory.manualOverrides[normalisePresetName(presetPerson.name)] ?? {};
    const excludeFromSwaps = overrides.excludeFromSwaps ?? presetPerson.excludeFromSwaps;
    const regularDaysOff = overrides.regularDaysOff ?? presetPerson.regularDaysOff;
    const fte = overrides.fte ?? presetPerson.fte;
    const locum = overrides.locum ?? presetPerson.locum;
    const regularLocum = overrides.regularLocum ?? presetPerson.regularLocum;
    const sessionSubGroup = overrides.sessionSubGroup ?? presetPerson.sessionSubGroup;
    const consultants = overrides.consultants ?? presetPerson.consultants;
    if (excludeFromSwaps !== undefined) {
      settings.excluded = settings.excluded.filter(item => item.staffId !== staff.id);
      if (excludeFromSwaps) settings.excluded.push({ staffId: staff.id });
    }
    if (regularDaysOff !== undefined) {
      if (regularDaysOff.length) settings.regularDaysOff[staff.id] = [...regularDaysOff] as SwapSettings['regularDaysOff'][string];
      else delete settings.regularDaysOff[staff.id];
    }
    if (fte !== undefined) staff.fte = fte;
    if (locum !== undefined) {
      if (locum) staff.locum = true;
      else delete staff.locum;
    }
    if (regularLocum !== undefined) staff.regularLocum = regularLocum;
    if (sessionSubGroup !== undefined) {
      workspace.sessionSubGroups ??= {};
      workspace.sessionSubGroups[staff.id] = sessionSubGroup;
    }
    if (consultants !== undefined) {
      workspace.consultantPairs ??= {};
      if (consultants.length) workspace.consultantPairs[staff.id] = [...consultants].slice(0, 2);
      else delete workspace.consultantPairs[staff.id];
    }
  }
}

function consultantId(name: string): string {
  return `consultant-${normalisePresetName(name).replace(/[^a-z0-9]+/g, '-')}`;
}

export function applyPresetToWorkspace(workspace: Workspace, preset: SetupPreset): void {
  const previous = workspace.profile;
  const currentSettings = workspace.swapFinder?.settings ?? defaultSwapSettings();
  const profile = structuredClone(preset.setup.profile);
  const oldGroupNames = new Map(previous.groups.map(group => [group.id, group.name]));
  const presetGroupsByName = new Map(profile.groups.map(group => [group.name.trim().toLocaleLowerCase('en-GB'), group.id]));
  const staff = previous.staff.map(person => ({
    ...person,
    groupIds: [...new Set(person.groupIds.flatMap(id => {
      const name = oldGroupNames.get(id);
      const nextId = name ? presetGroupsByName.get(name.trim().toLocaleLowerCase('en-GB')) : undefined;
      return nextId ? [nextId] : [];
    }))],
  }));
  const leads = (preset.consultants ?? []).map(name => ({ id: consultantId(name), name }));
  workspace.profile = {
    ...previous,
    name: preset.name,
    ...profile,
    groups: profile.groups,
    staff,
    leads,
  };
  workspace.sessions = structuredClone(preset.sessions ?? defaultSessionsSettings(workspace.profile));
  workspace.consultantPairs = {};
  workspace.consultantLists = workspace.consultantLists ?? [];
  workspace.sessions.sameConsultants ??= { groupIds: [], typeIds: [] };
  workspace.sessionSubGroups = {};
  const bankHolidays = [...new Set([...currentSettings.bankHolidays, ...preset.setup.swapSettings.bankHolidays])];
  const settings: SwapSettings = {
    ...structuredClone(preset.setup.swapSettings),
    bankHolidays,
    regularDaysOff: {},
    excluded: [],
  };
  workspace.swapFinder = {
    settings,
    snapshot: workspace.swapFinder?.snapshot ?? { days: {}, importedAt: {} },
    ...(workspace.swapFinder?.recentSearches ? { recentSearches: workspace.swapFinder.recentSearches } : {}),
  };
  if (preset.people?.length) {
    workspace.presetPeople = { people: structuredClone(preset.people), manualOverrides: {}, ...(preset.me ? { me: preset.me } : {}) };
    applyPresetPeopleSettings(workspace);
  } else delete workspace.presetPeople;
  if (!preset.people?.length && preset.me) {
    workspace.presetPeople = { people: [], manualOverrides: {}, me: preset.me };
  }
  if (preset.me) {
    const match = workspace.profile.staff.filter(person => normalisePresetName(person.name) === normalisePresetName(preset.me!));
    if (workspace.role === 'coordinator') delete workspace.me;
    else if (match.length === 1) workspace.me = match[0].id;
  }
}

export function makePresetFromWorkspace(workspace: Workspace, id = `saved-${Date.now()}`): SetupPreset {
  const leads = workspace.profile.leads ?? [];
  const leadName = new Map(leads.map(lead => [lead.id, lead.name]));
  const profile: PresetProfile = {
    shiftTypes: structuredClone(workspace.profile.shiftTypes),
    roles: structuredClone(workspace.profile.roles).map(role => ({
      ...role,
      ...(role.leadIds ? { leadIds: role.leadIds.map(leadId => leadName.has(leadId) ? consultantId(leadName.get(leadId)!) : leadId) } : {}),
    })),
    groups: structuredClone(workspace.profile.groups),
    demands: structuredClone(workspace.profile.demands),
    rules: structuredClone(workspace.profile.rules),
    fairness: structuredClone(workspace.profile.fairness),
  };
  const current = workspace.swapFinder?.settings ?? defaultSwapSettings();
  const { excluded, regularDaysOff, ...swapSettings } = structuredClone(current);
  // Only people with a non-default setting, and only the fields that differ.
  // Writing every doctor (with fte 1 / locum false) would later override MediRota
  // locum detection and fill the "not on this rota" notice as the rota rotates.
  const people: PresetPerson[] = workspace.profile.staff.flatMap(staff => {
    const entry: PresetPerson = { name: staff.name };
    let keep = false;
    if (excluded.some(item => item.staffId === staff.id)) { entry.excludeFromSwaps = true; keep = true; }
    const daysOff = regularDaysOff[staff.id] ?? [];
    if (daysOff.length) { entry.regularDaysOff = [...daysOff]; keep = true; }
    if (staff.fte !== 1) { entry.fte = staff.fte; keep = true; }
    if (staff.locum) { entry.locum = true; keep = true; }
    if (staff.regularLocum) { entry.regularLocum = true; keep = true; }
    const sessionSubGroup = workspace.sessionSubGroups?.[staff.id];
    if (sessionSubGroup) { entry.sessionSubGroup = sessionSubGroup; keep = true; }
    const consultants = workspace.consultantPairs?.[staff.id] ?? [];
    if (consultants.length) { entry.consultants = [...consultants]; keep = true; }
    return keep ? [entry] : [];
  });
  return {
    version: 1,
    id,
    name: workspace.profile.name || 'My department',
    description: `Saved setup from ${workspace.profile.name || 'My department'}.`,
    setup: { profile, swapSettings },
    sessions: structuredClone(workspace.sessions ?? defaultSessionsSettings(workspace.profile)),
    ...(people.length ? { people } : {}),
    ...(workspace.profile.staff.find(person => person.id === workspace.me)?.name ? { me: workspace.profile.staff.find(person => person.id === workspace.me)!.name } : {}),
    ...(leads.length ? { consultants: leads.map(lead => lead.name) } : {}),
  };
}

export function downloadPreset(workspace: Workspace): void {
  const preset = makePresetFromWorkspace(workspace);
  const blob = new Blob([JSON.stringify(preset, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${preset.name.replace(/[^\w-]+/g, '-').toLowerCase() || 'setup'}.preset.json`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

