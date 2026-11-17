import { legacySessions } from "./fixtures/legacy-sessions";

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { applyImport, type ImportPlan } from '../src/app/mediImport';
import { emptyWorkspace, type Workspace } from '../src/app/store';
import {
  applyPresetToWorkspace, getPresets, makePresetFromWorkspace,
  markPresetPersonOverride, normalisePresetName, resolvePresetPeople, type SetupPreset,
} from '../src/app/presets';

const settings = {
  weekendDayActivities: ['Long day'],
  hoursTolerance: 1.5,
  maxChain: 4,
  minDoctors: [7, 7, 7, 7, 7, 3, 3],
  minDoctorsBankHoliday: 4,
  bankHolidays: ['2027-01-01'],
  returnPattern: 'consecutive' as const,
  returnDayType: 'noPreference' as const,
  returnWindow: { kind: 'any' as const },
  noAlertsOnly: false,
  includeNormalDays: false,
};

function localPreset(people: SetupPreset['people'] = []): SetupPreset {
  return {
    version: 1,
    id: 'made-up-local',
    name: 'Made-up test setup',
    description: 'A local preset used only by this test.',
    setup: {
      profile: {
        shiftTypes: [{ id: 'test-long', name: 'Long day', start: '08:00', end: '20:30' }],
        roles: [{ id: 'test-place', name: 'Ward' }],
        groups: [{ id: 'test-grade', name: 'Test grade' }],
        demands: [],
        rules: [],
        fairness: [{ id: 'test-fairness', name: 'Hours', unit: 'hours', weight: 1 }],
      },
      swapSettings: settings,
    },
    people,
    consultants: ['Dr Quinn'],
  };
}

function addStaff(workspace: Workspace, id: string, name: string) {
  workspace.profile.staff.push({ id, name, groupIds: [], fte: 1 });
}

describe('setup presets', () => {
  it('does not discover bundled or local presets', () => {
    expect(getPresets()).toEqual([]);
    expect(getPresets([localPreset([{ name: 'Dr Moss' }])])).toEqual([]);
  });

  it('replaces setup while keeping existing doctors, grades by name, rota weeks and bank holidays', () => {
    const workspace = emptyWorkspace();
    workspace.profile.groups = [{ id: 'old-grade', name: 'Test grade' }];
    addStaff(workspace, 'rowan', 'Dr Rowan');
    workspace.profile.staff[0].groupIds = ['old-grade'];
    workspace.unavailability.push({ staffId: 'rowan', date: '2027-03-03', kind: 'leave' });
    workspace.rota = { assignments: [], stages: [], seconds: 5, createdAt: '2026-11-07T12:00:00Z' };
    workspace.swapFinder = {
      settings: { ...structuredClone(settings), bankHolidays: ['2026-12-25'], regularDaysOff: {}, excluded: [] },
      snapshot: { days: { rowan: { '2027-03-03': { status: 'leave' } } }, importedAt: { '2027-03-01': '2027-03-01T00:00:00Z' } },
    };
    const beforeStaff = structuredClone(workspace.profile.staff);
    const beforeRota = structuredClone(workspace.rota);
    const beforeSnapshot = structuredClone(workspace.swapFinder.snapshot);
    // Cancel path: leaving the workspace untouched.
    expect(workspace.profile.staff).toEqual(beforeStaff);
    expect(workspace.rota).toEqual(beforeRota);
    applyPresetToWorkspace(workspace, localPreset());
    expect(workspace.profile.staff.map(person => person.name)).toEqual(['Dr Rowan']);
    expect(workspace.profile.staff[0].groupIds).toEqual(['test-grade']);
    expect(workspace.rota?.createdAt).toBe('2026-11-07T12:00:00Z');
    expect(workspace.unavailability[0].date).toBe('2027-03-03');
    expect(workspace.swapFinder?.snapshot).toEqual(beforeSnapshot);
    expect(workspace.swapFinder?.settings.bankHolidays).toEqual(['2026-12-25', '2027-01-01']);
  });

  it('applies person settings by normalised name now and to a doctor arriving in a later import', () => {
    const preset = localPreset([
      { name: 'Dr Rowan', excludeFromSwaps: true, regularDaysOff: [0, 3], fte: 0.8, locum: true },
      { name: 'Dr Quinn', excludeFromSwaps: true, regularDaysOff: [2], fte: 0.6 },
    ]);
    const workspace = emptyWorkspace();
    addStaff(workspace, 'rowan', '  rowan   ');
    applyPresetToWorkspace(workspace, preset);
    expect(workspace.profile.staff[0]).toMatchObject({ fte: 0.8, locum: true });
    expect(workspace.swapFinder?.settings.regularDaysOff.rowan).toEqual([0, 3]);
    expect(workspace.swapFinder?.settings.excluded).toEqual([{ staffId: 'rowan' }]);
    expect(resolvePresetPeople(workspace.presetPeople?.people, workspace.profile.staff)).toEqual({ unmatched: ['Dr Quinn'], ambiguous: [] });

    const plan: ImportPlan = {
      dates: [], firstTime: false,
      people: [{ mediRotaId: 'quinn-import', name: 'Dr Quinn', grade: 'Test grade', action: 'add', locum: false, days: 0 }],
      leavers: [], activities: [], needs: [], keepDayJobs: false, skip: [], activityWeeks: [], personWeeks: [],
    };
    applyImport(workspace, plan);
    const quinn = workspace.profile.staff.find(person => person.name === 'Dr Quinn')!;
    expect(quinn).toMatchObject({ fte: 0.6 });
    expect(workspace.swapFinder?.settings.excluded).toContainEqual({ staffId: quinn.id });
    expect(workspace.swapFinder?.settings.regularDaysOff[quinn.id]).toEqual([2]);
    expect(resolvePresetPeople(workspace.presetPeople?.people, workspace.profile.staff).unmatched).toEqual([]);
  });

  it('matches case, extra spaces and a Dr prefix, but leaves ambiguous names untouched', () => {
    expect(normalisePresetName(' Dr   Rowan ')).toBe('rowan');
    const workspace = emptyWorkspace();
    addStaff(workspace, 'ellis-one', 'Ellis');
    addStaff(workspace, 'ellis-two', 'DR  ELLIS');
    const preset = localPreset([{ name: 'Dr Ellis', fte: 0.5 }, { name: 'Dr Hart', fte: 0.6 }]);
    applyPresetToWorkspace(workspace, preset);
    expect(workspace.profile.staff.map(person => person.fte)).toEqual([1, 1]);
    expect(resolvePresetPeople(workspace.presetPeople?.people, workspace.profile.staff)).toEqual({ unmatched: ['Dr Hart'], ambiguous: ['Dr Ellis'] });
  });

  it('keeps manual changes over later preset applications', () => {
    const workspace = emptyWorkspace();
    addStaff(workspace, 'rowan', 'Dr Rowan');
    applyPresetToWorkspace(workspace, localPreset([{ name: 'Dr Rowan', excludeFromSwaps: true, regularDaysOff: [1], fte: 0.8, locum: true, regularLocum: true }]));
    workspace.profile.staff[0].fte = 0.9;
    delete workspace.profile.staff[0].locum;
    workspace.profile.staff[0].regularLocum = false;
    workspace.swapFinder!.settings.excluded = [];
    workspace.swapFinder!.settings.regularDaysOff.rowan = [4];
    markPresetPersonOverride(workspace, 'Dr Rowan', 'fte', 0.9);
    markPresetPersonOverride(workspace, 'Dr Rowan', 'locum', false);
    markPresetPersonOverride(workspace, 'Dr Rowan', 'regularLocum', false);
    markPresetPersonOverride(workspace, 'Dr Rowan', 'excludeFromSwaps', false);
    markPresetPersonOverride(workspace, 'Dr Rowan', 'regularDaysOff', [4]);
    const plan: ImportPlan = {
      dates: [], firstTime: false,
      people: [{ mediRotaId: 'rowan-import', name: 'Dr Rowan', staffId: 'rowan', action: 'match', locum: false, days: 0 }],
      leavers: [], activities: [], needs: [], keepDayJobs: false, skip: [], activityWeeks: [], personWeeks: [],
    };
    applyImport(workspace, plan);
    expect(workspace.profile.staff[0]).toMatchObject({ fte: 0.9 });
    expect(workspace.profile.staff[0].locum).toBeUndefined();
    expect(workspace.profile.staff[0].regularLocum).toBe(false);
    expect(workspace.swapFinder!.settings.excluded).toEqual([]);
    expect(workspace.swapFinder!.settings.regularDaysOff.rowan).toEqual([4]);
  });

  it('merges bank holidays and round-trips a saved setup as a preset', () => {
    const workspace = emptyWorkspace();
    addStaff(workspace, 'rowan', 'Dr Rowan');
    addStaff(workspace, 'ellis', 'Dr Ellis');
    workspace.profile.staff[0].fte = 0.8;
    workspace.profile.staff[0].locum = true;
    workspace.profile.staff[0].regularLocum = true;
    workspace.swapFinder = { settings: { ...structuredClone(settings), bankHolidays: ['2026-12-25'], regularDaysOff: { rowan: [0] }, excluded: [{ staffId: 'rowan' }] }, snapshot: { days: {}, importedAt: {} } };
    workspace.profile.leads = [{ id: 'quinn-lead', name: 'Dr Quinn' }];
    workspace.profile.roles = [{ id: 'test-place', name: 'Ward', leadIds: ['quinn-lead'] }];
    workspace.profile.shiftTypes = [{ id: 'test-long', name: 'Long day', start: '08:00', end: '20:30' }];
    workspace.profile.groups = [{ id: 'test-grade', name: 'Test grade' }];
    const sessions = legacySessions(workspace.profile);
    sessions.types[0].name = 'Custom theatre';
    workspace.sessions = sessions;
    const preset = makePresetFromWorkspace(workspace, 'round-trip');
    expect(preset.sessions).toEqual(sessions);
    expect(preset.people).toEqual([{ name: 'Dr Rowan', excludeFromSwaps: true, regularDaysOff: [0], fte: 0.8, locum: true, regularLocum: true }]);
    expect(preset.consultants).toEqual(['Dr Quinn']);
    const copy = emptyWorkspace();
    addStaff(copy, 'rowan-copy', 'Dr Rowan');
    addStaff(copy, 'ellis-copy', 'Dr Ellis');
    applyPresetToWorkspace(copy, preset);
    const savedAgain = makePresetFromWorkspace(copy, 'round-trip');
    expect(savedAgain.setup).toEqual(preset.setup);
    expect(savedAgain.sessions).toEqual(preset.sessions);
    expect(savedAgain.people).toEqual(preset.people);
    expect(savedAgain.consultants).toEqual(preset.consultants);
    expect(copy.swapFinder?.settings.bankHolidays).toEqual(['2026-12-25']);
    expect(copy.profile.leads?.map(lead => lead.name)).toEqual(['Dr Quinn']);
    expect(copy.profile.roles[0].leadIds).toEqual(preset.setup.profile.roles[0].leadIds);
    expect(copy.profile.roles[0].leadIds?.[0]).toBe(copy.profile.leads?.[0].id);

    const withExtra = emptyWorkspace();
    addStaff(withExtra, 'rowan-extra', 'Dr Rowan');
    withExtra.swapFinder = { settings: { ...structuredClone(settings), bankHolidays: ['2028-05-01'], regularDaysOff: {}, excluded: [] }, snapshot: { days: {}, importedAt: {} } };
    applyPresetToWorkspace(withExtra, preset);
    expect(withExtra.swapFinder?.settings.bankHolidays).toEqual(['2028-05-01', '2026-12-25']);
  });

  it('saves only people with a non-default setting, and only the fields that differ', () => {
    const workspace = emptyWorkspace();
    addStaff(workspace, 'rowan', 'Dr Rowan');
    addStaff(workspace, 'ellis', 'Dr Ellis');
    addStaff(workspace, 'hart', 'Dr Hart');
    addStaff(workspace, 'moss', 'Dr Moss');
    workspace.profile.staff[1].fte = 0.6;
    workspace.profile.staff[2].locum = true;
    workspace.swapFinder = {
      settings: {
        ...structuredClone(settings),
        bankHolidays: [],
        regularDaysOff: { hart: [2, 3] },
        excluded: [{ staffId: 'rowan' }],
      },
      snapshot: { days: {}, importedAt: {} },
    };
    const preset = makePresetFromWorkspace(workspace, 'sparse-people');
    expect(preset.people).toEqual([
      { name: 'Dr Rowan', excludeFromSwaps: true },
      { name: 'Dr Ellis', fte: 0.6 },
      { name: 'Dr Hart', regularDaysOff: [2, 3], locum: true },
    ]);
    expect(preset.people?.some(person => person.name === 'Dr Moss')).toBe(false);
    expect(preset.people?.every(person => person.fte === undefined || person.fte !== 1)).toBe(true);
    expect(preset.people?.every(person => person.locum !== false)).toBe(true);
    expect(preset.people?.every(person => person.excludeFromSwaps !== false)).toBe(true);
    expect(preset.people?.every(person => !('regularDaysOff' in person) || (person.regularDaysOff?.length ?? 0) > 0)).toBe(true);
  });

  it('accepts a made-up local preset without writing it into the ignored folder', () => {
    const local = localPreset([{ name: 'Dr Moss', fte: 0.7 }]);
    expect(getPresets([local])).toEqual([]);
  });

  it('ignores presets/local and has no tracked file there', () => {
    const gitignore = readFileSync('.gitignore', 'utf8');
    const tracked = execFileSync('git', ['ls-files', '--', 'presets/local/'], { encoding: 'utf8' }).trim();
    expect(gitignore.split(/\r?\n/)).toContain('presets/local/');
    expect(tracked).toBe('');
  });

  it('sets the local preset me doctor by normalised name and saves that name in a new preset', () => {
    const ws = emptyWorkspace();
    addStaff(ws, 'rowan-id', 'Dr Rowan');
    const preset = { ...localPreset(), me: '  rowan  ' };
    applyPresetToWorkspace(ws, preset);
    expect(ws.me).toBe('rowan-id');
    ws.me = 'manual-choice';
    ws.profile.staff.push({ id: 'manual-choice', name: 'Dr Ellis', groupIds: [], fte: 1 });
    expect(makePresetFromWorkspace(ws).me).toBe('Dr Ellis');
    const reimport: ImportPlan = { dates: [], firstTime: false, people: [], leavers: [], activities: [], needs: [], keepDayJobs: false, skip: [], activityWeeks: [], personWeeks: [] };
    applyImport(ws, reimport);
    expect(ws.me).toBe('manual-choice');
  });
});
