/**
 * Independent Stage 2 setup checks (tester). Made-up names only.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Rule } from '../src/engine/types';
import { findSwaps } from '../src/engine/swaps';
import { applyNationalLimitRows, nationalLimitRows, shareSentence, sharesAreEqual, suggestedMinimums } from '../src/app/pages/SetupWizard';
import { limitDefs } from '../src/app/rules/grid';
import { nextSetupWizardStep } from '../src/app/setupWizard';
import { quickLookItems } from '../src/app/setupReview';
import { fairerActivityLabel, fairerCsv, fairerRoleLabel, makeFairerDisplay } from '../src/app/fairerDisplay';
import { placeName } from '../src/app/placeName';
import { applyImport, planImport } from '../src/app/mediImport';
import { defaultSessionsSettings } from '../src/app/sessions';
import { emptyProfile, emptyWorkspace, replaceWorkspace, type Workspace } from '../src/app/store';
import { prepareFairerModel } from '../src/app/fairer';
import { sessionFor } from '../src/app/overview';
import { blankSnapshot, stage2Profile, stage2Request, stage2Settings, work, off } from './swaps-stage2-helpers';
import { fairerFixture } from './fixtures/fairer-made-up';

describe('Stage 2 tester: CTO rulings', () => {
  it('C12: back from finish goes to working-time rules, not minimum doctors', () => {
    expect(nextSetupWizardStep('finish', 'back')).toBe('rules');
    expect(nextSetupWizardStep('rules', 'next')).toBe('finish');
  });

  it('C1: share sentence never says 1 times as many, and equal shares detect as Yes', () => {
    expect(shareSentence('ST2', 'FY2', 'Theatre', 1)).toBe('ST2s are expected to do the same number of theatre sessions as FY2s.');
    expect(shareSentence('ST2', 'FY2', 'Theatre', 2)).toBe('ST2s are expected to do twice as many theatre sessions as FY2s.');
    expect(shareSentence('ST2', 'FY2', 'Theatre', 3)).toBe('ST2s are expected to do 3 times as many theatre sessions as FY2s.');
    const settings = defaultSessionsSettings(emptyProfile());
    settings.types = [{ id: 'theatre', name: 'Theatre', colour: 1, kind: 'day', placeIds: [] }];
    settings.groups = [{ id: 'fy2', name: 'FY2', grades: ['FY2'] }, { id: 'st2', name: 'ST2', grades: ['ST2'] }, { id: 'st3', name: 'ST3', grades: ['ST3'] }];
    settings.ratios = { theatre: { fy2: 1, st2: 1, st3: 1 } };
    expect(sharesAreEqual(settings)).toBe(true);
    settings.ratios.theatre!.st3 = 2;
    expect(sharesAreEqual(settings)).toBe(false);
  });

  it('C2: national limits leave place, group and soft same-type rules alone', () => {
    const profile = emptyProfile();
    profile.shiftTypes = [
      { id: 'night', name: 'Night', start: '20:00', end: '08:00' },
      { id: 'long', name: 'Long day', start: '08:00', end: '20:30' },
      { id: 'day', name: 'Day', start: '08:00', end: '17:00' },
    ];
    profile.roles = [{ id: 'maple', name: 'Maple Ward' }];
    profile.groups = [{ id: 'st2', name: 'ST2' }];
    const placeCount: Rule = { id: 'place-count', name: 'Maple cover', type: 'count', hard: true, work: { roleIds: ['maple'] }, period: 'week', unit: 'shifts', max: 3 };
    const groupNights: Rule = { id: 'group-nights', name: 'ST2 nights', type: 'maxConsecutive', hard: true, who: { groupIds: ['st2'] }, work: { shiftTypeIds: ['night'] }, maxDays: 3 };
    const softRest: Rule = { id: 'soft-rest', name: 'Soft rest', type: 'minRest', hard: false, hours: 11 };
    const kept = applyNationalLimitRows(profile, [placeCount, groupNights, softRest]);
    expect(kept.find(rule => rule.id === 'place-count')).toEqual(placeCount);
    expect(kept.find(rule => rule.id === 'group-nights')).toEqual(groupNights);
    expect(kept.find(rule => rule.id === 'soft-rest')).toEqual(softRest);
    expect(kept.filter(rule => rule.id.startsWith('national-')).length).toBe(nationalLimitRows(profile).length);
    expect(kept.some(rule => rule.id === 'national-rest' && rule.type === 'minRest' && rule.hard === true)).toBe(true);
  });

  it('C6: national button uses >10h; Settings → Rules keeps ≥10h for saved rules', () => {
    const profile = emptyProfile();
    profile.shiftTypes = [
      { id: 'ten', name: 'Ten hours', start: '08:00', end: '18:00' },
      { id: 'long', name: 'Long day', start: '08:00', end: '18:30' },
      { id: 'day', name: 'Day', start: '08:00', end: '17:00' },
      { id: 'night', name: 'Night', start: '20:00', end: '08:00' },
    ];
    const rows = nationalLimitRows(profile);
    expect(rows.find(row => row.id === 'national-long-days')?.rule).toMatchObject({ work: { shiftTypeIds: ['long'] } });
    expect(JSON.stringify(rows.find(row => row.id === 'national-long-days')?.rule)).not.toContain('ten');
    const tenOnly = emptyProfile();
    tenOnly.shiftTypes = [
      { id: 'ten', name: 'Ten hours', start: '08:00', end: '18:00' },
      { id: 'day', name: 'Day', start: '08:00', end: '17:00' },
    ];
    const saved: Rule = { id: 'saved-longdays', name: '', type: 'maxConsecutive', hard: true, work: { shiftTypeIds: ['ten'] }, maxDays: 4 };
    expect(limitDefs(tenOnly).find(row => row.id === 'longdays')?.matches(saved)).toBe(true);
    expect(nationalLimitRows(tenOnly).some(row => row.id === 'national-long-days')).toBe(false);
  });

  it('C9: minimum suggestions ignore one-off dates', () => {
    const ws = emptyWorkspace();
    ws.profile.shiftTypes = [{ id: 'day', name: 'Day', start: '08:00', end: '17:00' }];
    ws.profile.roles = [{ id: 'maple', name: 'Maple Ward' }];
    ws.profile.demands = [
      { id: 'need-week', roleId: 'maple', shiftTypeId: 'day', days: { weekdays: [0, 1, 2, 3, 4] }, min: 2, max: 2 },
      { id: 'need-once', roleId: 'maple', shiftTypeId: 'day', days: { dates: ['2026-11-20'] }, min: 9, max: 9 },
    ];
    const suggestions = suggestedMinimums(ws);
    expect(suggestions[0]).toBe(2);
    expect(suggestions[5]).toBe(0);
    expect(suggestions.every(value => value !== 9)).toBe(true);
  });

  it('C10: re-applying a review plan does not duplicate doctors or places', () => {
    const workspace = emptyWorkspace();
    const personWeek = {
      start: '2026-11-16',
      people: [{
        id: '11', rowName: 'Rowan, Dr', label: 'Dr Rowan (ST2)', role: 'CT',
        days: { '2026-11-16': { am: ['Maple Ward'], pm: ['Maple Ward'] } },
      }],
    };
    const plan = planImport(workspace, [personWeek], []);
    applyImport(workspace, plan);
    const peopleAfterFirst = workspace.profile.staff.length;
    const placesAfterFirst = workspace.profile.roles.filter(role => !role.parentId).length;
    const graded = {
      ...plan,
      people: plan.people.map(person => person.mediRotaId === '11' ? { ...person, grade: 'ST2' } : person),
    };
    applyImport(workspace, graded);
    expect(workspace.profile.staff).toHaveLength(peopleAfterFirst);
    expect(workspace.profile.roles.filter(role => !role.parentId)).toHaveLength(placesAfterFirst);
    expect(workspace.profile.staff[0]?.mediRotaId).toBe('11');
    expect(workspace.profile.groups.some(group => group.name === 'ST2')).toBe(true);
  });

  it('C7/display: renamed places keep MediRota matching and Fairer shows display names including unchanged activity cells', () => {
    const profile = stage2Profile(['rowan', 'ellis'], ['Maple Ward']);
    profile.roles[0]!.displayName = 'Cedar Theatre';
    expect(placeName(profile.roles[0])).toBe('Cedar Theatre');
    expect(profile.roles[0]!.name).toBe('Maple Ward');
    expect(fairerRoleLabel(profile.roles[0]!.id, { placeForRole: { [profile.roles[0]!.id]: profile.roles[0]!.id } } as never, new Map([[profile.roles[0]!.id, profile.roles[0]!]]))).toBe('Cedar Theatre');
    expect(fairerActivityLabel('Maple Ward', profile.roles)).toBe('Cedar Theatre');
    expect(fairerActivityLabel('maple ward', profile.roles)).toBe('Cedar Theatre');

    const beforeSnapshot = blankSnapshot(['rowan', 'ellis']);
    work(beforeSnapshot, 'rowan', '2026-11-02', 'dayJob', 'Maple Ward');
    off(beforeSnapshot, 'ellis', '2026-11-02');
    const settings = stage2Settings({ maxChain: 2 });
    const request = stage2Request('rowan', ['2026-11-02']);
    const before = findSwaps(profile, beforeSnapshot, settings, request);
    expect(findSwaps(profile, beforeSnapshot, settings, request)).toEqual(before);

    const sessions = defaultSessionsSettings(profile);
    sessions.types.push({ id: 'theatre', name: 'Theatre', colour: 1, kind: 'day', placeIds: [profile.roles[0]!.id] });
    expect(sessionFor('Maple Ward', profile, sessions)?.id).toBe('theatre');
    expect(sessionFor('Cedar Theatre', profile, sessions)).toBeUndefined();
  });

  it('C5: first-time summary does not pre-tick extra-only; later import does (BASE)', () => {
    const personWeek = {
      start: '2026-11-16',
      people: [{
        id: '22', rowName: 'Hart, Dr', label: 'Dr Hart (ST1)', role: 'CT',
        days: { '2026-11-16': { am: ['Maple Ward [Extra]'], pm: ['Maple Ward [Extra]'], eve: ['Maple Ward [Extra]'] } },
      }, {
        id: '23', rowName: 'Moss, Dr', label: 'Dr Moss (Locum)', role: 'Locum',
        days: { '2026-11-16': { am: ['Maple Ward'] } },
      }],
    };
    const summary = planImport(emptyWorkspace(), [personWeek], [], { firstTimeSummary: true });
    expect(summary.people.find(person => person.mediRotaId === '22')?.locum).toBe(false);
    expect(summary.people.find(person => person.mediRotaId === '23')?.locum).toBe(true);
    expect(quickLookItems(summary).extraOnly).toEqual(['22']);

    const later = planImport(emptyWorkspace(), [personWeek], []);
    expect(later.people.find(person => person.mediRotaId === '22')?.locum).toBe(true);
    expect(later.people.find(person => person.mediRotaId === '23')?.locum).toBe(true);
  });

  it('first-time summary lists only genuine unknown activities, not deliberate Not counted', () => {
    const weeks = [0, 1, 2, 3].map(index => {
      const start = new Date(Date.UTC(2026, 10, 16 + index * 7)).toISOString().slice(0, 10);
      const acts = index === 0
        ? ['⚑ CT 03 (New)', '⚑ CT 10 (New FY2)', 'Maple Ward [Removed]', 'Obscure Cover', 'Cedar Theatre']
        : ['Cedar Theatre'];
      return {
        start,
        people: [{ id: '11', rowName: 'Rowan, Dr', label: 'Dr Rowan (ST2)', role: 'CT', days: { [start]: { am: acts } } }],
      };
    });
    const plan = planImport(emptyWorkspace(), weeks, [], { firstTimeSummary: true });
    expect(plan.activities.find(activity => activity.name === '⚑ CT 03 (New)')?.treat).toBe('ignore');
    expect(plan.activities.find(activity => activity.name === 'Maple Ward [Removed]')?.treat).toBe('ignore');
    expect(plan.activities.find(activity => activity.name === 'Obscure Cover')?.treat).toBe('ignore');
    expect(quickLookItems(plan).unsortedActivities).toEqual(['Obscure Cover']);
  });
});

describe('Stage 2 tester: Fairer display names after Stage 6 merge', () => {
  it('shows display names in grid activity and CSV; short codes follow MediRota Role.name', () => {
    const ws = fairerFixture(4, 8);
    const place = ws.profile.roles.find(role => !role.parentId)!;
    const mediName = place.name;
    place.displayName = 'Willow Clinic';
    const model = prepareFairerModel(ws, ws.period.start, ws.period.end, 'none', 2, false);
    const display = makeFairerDisplay(ws, ws.sessions!, model, model.baseline);
    const named = [...display.cells.values()].filter(item => item.activity === 'Willow Clinic' || item.previous === 'Willow Clinic');
    expect(named.length).toBeGreaterThan(0);
    expect(fairerCsv(display)).toContain('Willow Clinic');
    expect(fairerCsv(display)).not.toContain('—');
    // codes.ts reads role.name only (MediRota), never displayName.
    expect(readFileSync('src/app/components/codes.ts', 'utf8')).toMatch(/role\.name/);
    expect(readFileSync('src/app/components/codes.ts', 'utf8')).not.toMatch(/displayName/);
    expect(mediName).toBeTruthy();
  });
});

describe('Stage 2 tester: saved workspace fixtures open', () => {
  it.each([
    'test/fixtures/overview-made-up-workspace.json',
    'test/fixtures/stage3-workspace.json',
    'test/fixtures/stage3-no-rules-workspace.json',
  ] as const)('loads %s without throwing', (path) => {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Workspace;
    expect(() => replaceWorkspace(structuredClone(raw))).not.toThrow();
  });
});
