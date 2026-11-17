/**
 * One-off helper: run from a git checkout (e.g. 9237d57) to emit normalised planner
 * output after applyImport. The tester commits the JSON; tests compare current imports to it.
 *
 *   npx tsx test/scripts/generate-planner-baseline.ts > test/fixtures/swaps-planner-baseline.json
 */
import { applyImport, planImport } from '../../src/app/mediImport';
import type { PersonRow, PersonWeek } from '../../src/app/medirota';
import { emptyWorkspace, type Workspace } from '../../src/app/store';
import type { FixedAssignment, Unavailability } from '../../src/engine/types';

const row = (id: string, label: string, days: PersonRow['days'], role = 'CT'): PersonRow => ({ id, rowName: label, label, role, days });
const weekOf = (acts: Record<number, Partial<Record<'am' | 'pm' | 'eve' | 'night', string[]>>>) =>
  Object.fromEntries(Object.entries(acts).map(([d, s]) => [`2026-11-0${+d + 2}`, s]));
const sampleWeek = (): PersonWeek[] => [({
  start: '2026-11-02',
  people: [
    row('1', 'Piper Example (ST1)', weekOf({ 0: { night: ['Nights CT'] }, 1: { night: ['Nights CT'] }, 2: { am: ['Zero Day CT'] }, 3: { am: ['Elective C-Sections'], pm: ['Elective C-Sections'] }, 4: { am: ['[Away]'] } })),
    row('2', 'Quinn Sample (GPVTS)', weekOf({ 0: { am: ['Delivery Suite'], eve: ['Delivery Suite'] }, 1: { am: ['PROMPT Training'] }, 2: { am: ['Elective C-Sections'] }, 3: { am: ['Elective C-Sections'] }, 4: { am: ['Elective C-Sections'] } })),
    row('3', 'Riley Locum', weekOf({ 0: { am: ['MAU CT [Extra]'] } }), 'Locum'),
    row('4', 'Empty Roster (FY2)', {}),
  ],
})];

export function normalisePlanner(ws: Workspace) {
  const staffById = new Map(ws.profile.staff.map(s => [s.id, s]));
  const shiftName = (id: string) => ws.profile.shiftTypes.find(s => s.id === id)?.name ?? id;
  const roleName = (id?: string) => (id ? ws.profile.roles.find(r => r.id === id)?.name : undefined) ?? id;
  const mediId = (staffId: string) => staffById.get(staffId)?.mediRotaId ?? staffById.get(staffId)?.name ?? staffId;

  const fixed = ws.fixed.map((f: FixedAssignment) => ({
    mediRotaId: mediId(f.staffId),
    date: f.date,
    shift: shiftName(f.shiftTypeId),
    place: roleName(f.roleId),
    reason: f.reason,
    source: f.source,
  })).sort((a, b) => a.date.localeCompare(b.date) || a.mediRotaId.localeCompare(b.mediRotaId));

  const unavailability = ws.unavailability.map((u: Unavailability) => ({
    mediRotaId: mediId(u.staffId),
    date: u.date,
    kind: u.kind,
    reason: u.reason,
    source: u.source,
  })).sort((a, b) => a.date.localeCompare(b.date) || a.mediRotaId.localeCompare(b.mediRotaId));

  const profile = {
    name: ws.profile.name,
    groups: ws.profile.groups.map(g => g.name).sort(),
    roles: ws.profile.roles.filter(r => !r.parentId).map(r => r.name).sort(),
    shiftTypes: ws.profile.shiftTypes.map(s => ({ name: s.name, start: s.start, end: s.end })).sort((a, b) => a.name.localeCompare(b.name)),
    staff: ws.profile.staff.map(s => ({
      mediRotaId: s.mediRotaId,
      name: s.name,
      grade: ws.profile.groups.find(g => s.groupIds.includes(g.id))?.name,
      locum: s.locum ?? false,
      startDate: s.startDate,
      endDate: s.endDate,
    })).sort((a, b) => (a.mediRotaId ?? a.name).localeCompare(b.mediRotaId ?? b.name)),
    demandCount: ws.profile.demands.length,
    ruleCount: ws.profile.rules.length,
  };

  return { fixed, unavailability, profile };
}

function runScenario(name: string, fn: (ws: Workspace) => void) {
  const ws = emptyWorkspace();
  fn(ws);
  return { name, planner: normalisePlanner(ws) };
}

const scenarios = [
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

console.log(JSON.stringify({ generatedFrom: 'run generate-planner-baseline.ts at commit 9237d57', scenarios }, null, 2));
