/**
 * Adding people quickly: typed names, pasted lists, or rows pasted straight
 * from a spreadsheet (name, group, % time in separate columns).
 */
import type { Workspace } from './store';
import { newId } from './store';
import { removePerson } from './references';
import type { Group, Staff } from '../engine/types';

export interface PeopleSection { id: string; name: string; people: Staff[] }

/** People table groups regular locums with staff and keeps occasional locums separate. */
export function peopleTableSections(staff: Staff[], groups: Group[]): { sections: PeopleSection[]; occasionalLocums: Staff[] } {
  const mainStaff = staff.filter(person => !person.locum || person.regularLocum);
  const sections = [
    ...groups.map(group => ({ id: group.id, name: group.name, people: mainStaff.filter(person => person.groupIds[0] === group.id) })),
    { id: '', name: 'No group', people: mainStaff.filter(person => !person.groupIds.length || !groups.some(group => group.id === person.groupIds[0])) },
  ].filter(section => section.people.length > 0);
  return { sections, occasionalLocums: staff.filter(person => person.locum && !person.regularLocum) };
}

export interface AddResult {
  added: number;
  skipped: string[];
  newGroups: string[];
}

/** "60", "60%", "0.6" → 0.6. Anything unreadable → undefined. */
export function parseFte(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const m = text.trim().match(/^(\d+(?:\.\d+)?)\s*%?$/);
  if (!m) return undefined;
  const n = Number(m[1]);
  const fte = n > 1 ? n / 100 : n;
  return fte > 0 && fte <= 1 ? Math.round(fte * 100) / 100 : undefined;
}

/**
 * Add people from text. One person per line. If a line has tabs (copied from a
 * spreadsheet) the columns are: name, group, % time. Commas are kept as part
 * of the name, so "Smith, Jane" works. Names already listed are skipped.
 */
export function addPeople(w: Workspace, text: string, defaults: { groupId?: string; fte: number }): AddResult {
  const result: AddResult = { added: 0, skipped: [], newGroups: [] };
  for (const raw of text.split(/\r?\n/)) {
    const cols = raw.split('\t').map(c => c.trim());
    const name = cols[0];
    if (!name) continue;
    if (w.profile.staff.some(s => s.name.toLowerCase() === name.toLowerCase())) { result.skipped.push(name); continue; }
    let groupId = defaults.groupId;
    if (cols[1]) {
      let g = w.profile.groups.find(x => x.name.toLowerCase() === cols[1].toLowerCase());
      if (!g) {
        g = { id: newId('grp'), name: cols[1] };
        w.profile.groups.push(g);
        result.newGroups.push(g.name);
      }
      groupId = g.id;
    }
    const fte = parseFte(cols[2]) ?? defaults.fte;
    w.profile.staff.push({ id: newId('dr'), name, groupIds: groupId ? [groupId] : [], fte });
    result.added++;
  }
  return result;
}

/** Remove every person (e.g. for a new intake), with the same clean-up as removing one. */
export function removeEveryone(w: Workspace): { removed: number; rulesDeleted: string[] } {
  const ids = w.profile.staff.map(s => s.id);
  const rulesDeleted: string[] = [];
  for (const id of ids) rulesDeleted.push(...removePerson(w, id));
  if (w.rota && w.rota.assignments.length === 0) delete w.rota;
  return { removed: ids.length, rulesDeleted };
}
