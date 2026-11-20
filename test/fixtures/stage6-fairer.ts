import { fairerFixture } from './fairer-made-up';
import { prepareFairerModel } from '../../src/app/fairer';

/** Entirely invented people and places for Stage 6 browser checks. */
export function stage6FairerFixture() {
  const ws = fairerFixture(3, 7);
  const names = ['Dr Rowan', 'Dr Ellis', 'Dr Hart', 'Dr Moss', 'Dr Vale', 'Dr Quinn', 'Dr Hayes'];
  ws.profile.staff.forEach((person, index) => { person.name = names[index]!; person.groupIds = [['fy2', 'gpvts', 'st1', 'st2'][index % 4]!]; });
  ws.profile.groups = ['FY2', 'GPVTS', 'ST1', 'ST2'].map(name => ({ id: name.toLowerCase(), name }));
  ws.sessions!.groups = ws.profile.groups.map(group => ({ id: group.id, name: group.name, grades: [group.name] }));
  const places = ['Cedar Theatre', 'Willow Ward', 'Moss Clinic', 'River Assessment'];
  const renames = new Map(ws.profile.roles.map((role, index) => [role.name, places[index]!]));
  ws.profile.roles.forEach((role, index) => { role.name = places[index]!; });
  for (const days of Object.values(ws.swapFinder!.snapshot.days)) for (const day of Object.values(days)) if (day.activity && renames.has(day.activity)) day.activity = renames.get(day.activity);
  ws.profile.roles.push({ id: 'made-up-night', name: 'Nights' });
  ws.sessions!.types.push({ id: 'made-up-oncall', name: 'On-call', kind: 'on-call', colour: 5, placeIds: ['made-up-night'] });
  for (const type of ws.sessions!.types) ws.sessions!.ratios[type.id] = { fy2: 1, gpvts: 1, st1: type.name === 'Theatre' ? 2 : 1, st2: type.name === 'Theatre' ? 2 : 1 };
  ws.swapFinder!.snapshot.days['fairer-doctor-2']!['2026-11-05'] = { status: 'training', activity: 'Mandatory teaching at the invented Riverside education centre' };
  ws.swapFinder!.snapshot.days['fairer-doctor-5']!['2026-11-03'] = { status: 'night', activity: 'Nights', extra: true };
  ws.fairerSettings = { start: ws.period.start, end: ws.period.end, changeLimit: 'none', maxDays: 2, keepSameConsultants: false };
  return ws;
}

export function stage6DisplayFixture() {
  const ws = stage6FairerFixture();
  const model = prepareFairerModel(ws, ws.period.start, ws.period.end, 'none', 'none');
  const suggestion = structuredClone(model.baseline);
  // A pair of invented swaps on separate weeks makes filtering and wrap tests exact.
  for (const date of ['2026-11-02', '2026-11-16']) {
    const a = suggestion.find(item => item.staffId === 'fairer-doctor-0' && item.date === date && !item.fixed)!;
    const b = suggestion.find(item => item.staffId === 'fairer-doctor-1' && item.date === date && !item.fixed)!;
    [a.roleId, b.roleId] = [b.roleId, a.roleId];
  }
  return { ws, model, suggestion };
}
