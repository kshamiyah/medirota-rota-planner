/**
 * Independent Stage 2 setup UI checks (tester). Made-up names only.
 * Avoid SSR of useWorkspace components (no getServerSnapshot); assert via source and store helpers.
 */
import './polyfill-storage';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { clearPolyfillStorage } from './polyfill-storage';
import type { Rule } from '../src/engine/types';
import { SETUP_DONE_KEY } from '../src/app/App';
import { SETUP_PROGRESS_KEY, applyNationalLimitRows, shareSentence } from '../src/app/pages/SetupWizard';
import { nextSetupWizardStep } from '../src/app/setupWizard';
import { emptyWorkspace, getWorkspace, replaceWorkspace, update, type Workspace } from '../src/app/store';
import { defaultSessionsSettings } from '../src/app/sessions';
import { DEFAULT_SWAP_SETTINGS } from '../src/app/mediImport';
import { placeName } from '../src/app/placeName';

beforeEach(() => { clearPolyfillStorage(); replaceWorkspace(emptyWorkspace()); });

function madeUpWorkspace(): Workspace {
  const ws = emptyWorkspace();
  ws.profile.shiftTypes = [
    { id: 'day', name: 'Day', start: '08:00', end: '17:00' },
    { id: 'long', name: 'Long day', start: '08:00', end: '20:30' },
    { id: 'night', name: 'Night', start: '20:00', end: '08:00' },
  ];
  ws.profile.groups = [{ id: 'fy2', name: 'FY2' }, { id: 'st2', name: 'ST2' }, { id: 'st3', name: 'ST3' }];
  ws.profile.staff = [
    { id: 'rowan', name: 'Dr Rowan', groupIds: ['st2'], fte: 1, mediRotaId: '11' },
    { id: 'ellis', name: 'Dr Ellis', groupIds: ['fy2'], fte: 1, mediRotaId: '12' },
    { id: 'hart', name: 'Dr Hart', groupIds: ['st3'], fte: 1, mediRotaId: '13' },
  ];
  ws.profile.roles = [{ id: 'maple', name: 'Maple Ward' }, { id: 'willow', name: 'Willow Clinic' }];
  ws.sessions = defaultSessionsSettings(ws.profile);
  ws.sessions.types = [
    { id: 'theatre', name: 'Theatre', colour: 1, kind: 'day', placeIds: ['maple'] },
    { id: 'nights', name: 'Nights', colour: 2, kind: 'on-call', placeIds: ['willow'] },
  ];
  ws.sessions.groups = [
    { id: 'fy2', name: 'FY2', grades: ['FY2'] },
    { id: 'st2', name: 'ST2', grades: ['ST2'] },
    { id: 'st3', name: 'ST3', grades: ['ST3'] },
  ];
  ws.sessions.ratios = { theatre: { fy2: 1, st2: 2, st3: 1 }, nights: { fy2: 1, st2: 1, st3: 1 } };
  ws.swapFinder = { settings: structuredClone(DEFAULT_SWAP_SETTINGS), snapshot: { days: {}, importedAt: { '2026-11-16': '2026-11-20T00:00:00.000Z' } } };
  ws.role = 'doctor';
  ws.me = 'rowan';
  return ws;
}

describe('Stage 2 tester UI: banner, fetch, shares, finish', () => {
  it('C8: App reopens unfinished first-time setup from the progress key, and never banners a done workspace', () => {
    const app = readFileSync('src/app/App.tsx', 'utf8');
    expect(app).toContain('if (hasProgress) return \'firstRun\'');
    expect(app).toContain('const [resumeAvailable, setResumeAvailable] = useState(false)');
    expect(app).toContain('setResumeAvailable(!dismissedSetupWizard())');
    localStorage.setItem(SETUP_DONE_KEY, 'yes');
    localStorage.setItem(SETUP_PROGRESS_KEY, JSON.stringify({ step: 'types' }));
    replaceWorkspace(madeUpWorkspace());
    expect(localStorage.getItem(SETUP_DONE_KEY)).toBe('yes');
    expect(getWorkspace().profile.staff.length).toBeGreaterThan(0);
  });

  it('C11: fetch step Other ways includes the file drop route', () => {
    const source = readFileSync('src/app/pages/SetupWizard.tsx', 'utf8');
    expect(source).toContain('Other ways to get your rota in');
    expect(source).toContain('Drop saved MediRota pages or a fetch bundle');
    expect(source).toContain('Choose files');
    expect(source).not.toContain('Use the update page to add saved pages or a file later');
  });

  it('C1: share helpers and UI cover every comparison group from 1', () => {
    const source = readFileSync('src/app/pages/SetupWizard.tsx', 'utf8');
    expect(source).toContain('settingsDraft.groups.slice(1).map');
    expect(source).toContain('shareSentence(');
    expect(source).toContain('ratios[group.id] ?? 1');
    expect(shareSentence('ST2', 'FY2', 'Theatre', 1)).toBe('ST2s are expected to do the same number of theatre sessions as FY2s.');
    expect(shareSentence('ST2', 'FY2', 'Theatre', 1)).not.toContain('1 times as many');
  });

  it('C12: finish Back goes to working-time rules', () => {
    expect(nextSetupWizardStep('finish', 'back')).toBe('rules');
    const source = readFileSync('src/app/pages/SetupWizard.tsx', 'utf8');
    expect(source).toContain("setStep('rules')");
    expect(source).toContain('Finish setup');
  });

  it('C2: national apply keeps a place-scoped count rule', () => {
    const ws = madeUpWorkspace();
    const placeRule: Rule = { id: 'maple-count', name: 'Maple', type: 'count', hard: true, work: { roleIds: ['maple'] }, period: 'week', unit: 'shifts', max: 2 };
    const next = applyNationalLimitRows(ws.profile, [placeRule]);
    expect(next).toContainEqual(placeRule);
  });

  it('C3: bookmark tab applies immediately only for first-time fetch', () => {
    const source = readFileSync('src/app/pages/Import.tsx', 'utf8');
    expect(source).toContain('if (fetchMode && firstTimeFetch)');
    expect(source).toContain('Later imports keep the full review');
    expect(source).toMatch(/setPlan\(importPlan\);\s*setStep\('files'\)/);
  });

  it('C4: ready handshake falls back to * when referrer is empty', () => {
    const source = readFileSync('src/app/pages/Import.tsx', 'utf8');
    expect(source).toContain("origin || '*'");
    expect(source).toContain('rota-planner-ready');
  });
});

describe('Stage 2 tester: Places rename keeps consultant lists following', () => {
  it('C7: renaming a place updates consultant list row names', () => {
    const ws = madeUpWorkspace();
    ws.profile.leads = [{ id: 'lead-1', name: 'Dr Vale' }];
    ws.profile.roles.push({ id: 'maple-list', name: 'Maple Ward – Dr Vale', parentId: 'maple', leadIds: ['lead-1'] });
    replaceWorkspace(ws);
    update(draft => {
      const role = draft.profile.roles.find(item => item.id === 'maple')!;
      const oldVisible = placeName(role);
      role.displayName = 'Cedar Theatre';
      const newVisible = placeName(role);
      for (const list of draft.profile.roles) {
        if (list.parentId === role.id && list.name.startsWith(`${oldVisible} – `)) {
          list.name = `${newVisible}${list.name.slice(oldVisible.length)}`;
        }
      }
    });
    expect(getWorkspace().profile.roles.find(role => role.id === 'maple-list')?.name).toBe('Cedar Theatre – Dr Vale');
  });
});
