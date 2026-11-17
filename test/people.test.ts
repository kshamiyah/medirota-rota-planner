import { describe, expect, it } from 'vitest';
import { addPeople, parseFte, peopleTableSections, removeEveryone } from '../src/app/people';
import { emptyWorkspace } from '../src/app/store';
import { swapOptionPeople } from '../src/app/swapsView';

describe('adding people', () => {
  it('places regular locums in their main group and occasional locums only in the collapsed section data', () => {
    const regular = { id: 'regular', name: 'Dr Rowan', groupIds: ['fy'], fte: 1, locum: true, regularLocum: true };
    const occasional = { id: 'occasional', name: 'Dr Ellis', groupIds: ['fy'], fte: 1, locum: true };
    const { sections, occasionalLocums } = peopleTableSections([regular, occasional], [{ id: 'fy', name: 'FY2' }]);
    expect(sections.flatMap(section => section.people.map(person => person.id))).toEqual(['regular']);
    expect(occasionalLocums.map(person => person.id)).toEqual(['occasional']);
  });

  it('keeps regular locums out of both candidate picker option lists', () => {
    const people = [
      { id: 'requester', name: 'Dr Rowan', groupIds: ['fy'], fte: 1 },
      { id: 'doctor', name: 'Dr Ellis', groupIds: ['fy'], fte: 1 },
      { id: 'regular', name: 'Dr Hart', groupIds: ['fy'], fte: 1, locum: true, regularLocum: true },
      { id: 'occasional', name: 'Dr Moss', groupIds: ['fy'], fte: 1, locum: true },
    ];
    expect(swapOptionPeople(people, 'requester').map(person => person.id)).toEqual(['doctor']);
  });

  it('reads % time in common forms', () => {
    expect(parseFte('60')).toBe(0.6);
    expect(parseFte('80%')).toBe(0.8);
    expect(parseFte('0.5')).toBe(0.5);
    expect(parseFte('full')).toBeUndefined();
    expect(parseFte('150')).toBeUndefined();
  });

  it('adds one per line, keeps commas in names, and skips duplicates', () => {
    const w = emptyWorkspace();
    w.profile.groups.push({ id: 'fy', name: 'FY2' });
    const r = addPeople(w, 'Smith, Jane\n  Patel, Arjun  \n\nsmith, jane', { groupId: 'fy', fte: 1 });
    expect(r.added).toBe(2);
    expect(r.skipped).toEqual(['smith, jane']);
    expect(w.profile.staff.map(s => [s.name, s.groupIds, s.fte])).toEqual([['Smith, Jane', ['fy'], 1], ['Patel, Arjun', ['fy'], 1]]);
  });

  it('reads spreadsheet columns and creates missing groups', () => {
    const w = emptyWorkspace();
    w.profile.groups.push({ id: 'fy', name: 'FY2' });
    const r = addPeople(w, 'Lee, Sam\tfy2\t80%\nMoss, Ari\tGP trainees\t60\nNg, Bo\t\t', { fte: 1 });
    expect(r.newGroups).toEqual(['GP trainees']);
    const gp = w.profile.groups.find(g => g.name === 'GP trainees')!.id;
    expect(w.profile.staff.map(s => [s.name, s.groupIds, s.fte])).toEqual([
      ['Lee, Sam', ['fy'], 0.8], ['Moss, Ari', [gp], 0.6], ['Ng, Bo', [], 1],
    ]);
  });

  it('removes everyone but keeps groups and group rules', () => {
    const w = emptyWorkspace();
    w.profile.groups.push({ id: 'fy', name: 'FY2' });
    addPeople(w, 'A\nB', { groupId: 'fy', fte: 1 });
    const a = w.profile.staff[0].id;
    w.profile.rules.push(
      { id: 'grp', name: 'FY no nights', type: 'forbid', hard: true, who: { groupIds: ['fy'] }, work: {} },
      { id: 'one', name: 'A more EPU', type: 'preference', hard: false, who: { staffIds: [a] }, work: {}, direction: 'more' },
    );
    w.unavailability.push({ staffId: a, date: w.period.start, reason: 'Annual leave' });
    const r = removeEveryone(w);
    expect(r).toEqual({ removed: 2, rulesDeleted: ['A more EPU'] });
    expect(w.profile.staff).toEqual([]);
    expect(w.profile.groups.map(g => g.name)).toEqual(['FY2']);
    expect(w.profile.rules.map(x => x.id)).toEqual(['grp']);
    expect(w.unavailability).toEqual([]);
  });
});
