import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import { applyImport, planImport } from '../src/app/mediImport';
import type { PersonRow, PersonWeek } from '../src/app/medirota';
import { emptyWorkspace, getWorkspace, replaceWorkspace, type Workspace } from '../src/app/store';
import { normalisePlanner } from './scripts/generate-planner-baseline';

const here = dirname(fileURLToPath(import.meta.url));
const baseline = JSON.parse(readFileSync(join(here, 'fixtures/swaps-planner-baseline.json'), 'utf8')) as {
  generatedFrom: string;
  scenarios: { name: string; planner: ReturnType<typeof normalisePlanner> }[];
};

const row = (id: string, label: string, days: PersonRow['days'], role = 'CT'): PersonRow => ({ id, rowName: label, label, role, days });
const weekOf = (acts: Record<number, Partial<Record<'am' | 'pm' | 'eve' | 'night', string[]>>>) =>
  Object.fromEntries(Object.entries(acts).map(([d, s]) => [`2026-11-0${+d + 2}`, s]));
const sampleWeek = (): PersonWeek[] => [{
  start: '2026-11-02',
  people: [
    row('1', 'Piper Example (ST1)', weekOf({ 0: { night: ['Nights CT'] }, 1: { night: ['Nights CT'] }, 2: { am: ['Zero Day CT'] }, 3: { am: ['Elective C-Sections'], pm: ['Elective C-Sections'] }, 4: { am: ['[Away]'] } })),
    row('2', 'Quinn Sample (GPVTS)', weekOf({ 0: { am: ['Delivery Suite'], eve: ['Delivery Suite'] }, 1: { am: ['PROMPT Training'] }, 2: { am: ['Elective C-Sections'] }, 3: { am: ['Elective C-Sections'] }, 4: { am: ['Elective C-Sections'] } })),
    row('3', 'Riley Locum', weekOf({ 0: { am: ['MAU CT [Extra]'] } }), 'Locum'),
    row('4', 'Empty Roster (FY2)', {}),
  ],
}];

function runScenario(name: string, fn: (ws: Workspace) => void) {
  const ws = emptyWorkspace();
  fn(ws);
  return { name, planner: normalisePlanner(ws), hasSwapFinder: Boolean(ws.swapFinder) };
}

describe('swap finder Stage 1: planner data unchanged by snapshot', () => {
  it('matches normalised fixed, unavailability and profile from commit 9237d57 (before snapshot)', () => {
    /**
     * Expected values live in test/fixtures/swaps-planner-baseline.json.
     * Regenerate from the pre-snapshot commit with:
     *   git worktree add /tmp/rota-planner-baseline-9237d57 9237d57
     *   cd /tmp/rota-planner-baseline-9237d57 && npm install --legacy-peer-deps
     *   npx tsx test/scripts/generate-planner-baseline.ts > test/fixtures/swaps-planner-baseline.json
     * (copy generate-planner-baseline.ts into that worktree first.)
     *
     * IDs from newId() are stripped; comparison uses MediRota ids and role/shift names.
     */
    expect(baseline.generatedFrom).toContain('9237d57');

    const current = [
      runScenario('sample-first-import', ws => {
        applyImport(ws, planImport(ws, sampleWeek(), []));
      }),
      runScenario('sample-reimport', ws => {
        applyImport(ws, planImport(ws, sampleWeek(), []));
        const piper = ws.profile.staff.find(s => s.name === 'Piper Example')!;
        ws.unavailability.push({ staffId: piper.id, date: '2026-11-07', kind: 'leave', reason: 'Wedding' });
        applyImport(ws, planImport(ws, sampleWeek(), []));
      }),
      runScenario('keepDayJobs-true', ws => {
        const plan = planImport(ws, sampleWeek(), []);
        applyImport(ws, { ...plan, keepDayJobs: true });
      }),
    ];

    for (const expected of baseline.scenarios) {
      const got = current.find(s => s.name === expected.name);
      expect(got, `missing scenario ${expected.name}`).toBeDefined();
      expect(got!.planner).toEqual(expected.planner);
      expect(got!.hasSwapFinder, `${expected.name} should attach swapFinder`).toBe(true);
    }
  });

  it('opens an old workspace file with no swapFinder field', () => {
    const legacy = {
      version: 1 as const,
      profile: emptyWorkspace().profile,
      staffExtras: {},
      period: { start: '2026-11-02', end: '2026-11-08' },
      unavailability: [],
      fixed: [],
    };
    replaceWorkspace(legacy);
    expect(getWorkspace().swapFinder).toBeUndefined();
    const ws = getWorkspace();
    applyImport(ws, planImport(ws, sampleWeek(), []));
    expect(ws.swapFinder?.snapshot.days).toBeDefined();
  });
});
