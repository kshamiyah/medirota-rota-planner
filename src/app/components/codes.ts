/**
 * Short codes for the grids, so a cell reads at a glance ("DS", "N", "AL")
 * with the full name on hover and a legend above the grid.
 */
import { weekday } from '../../engine/calendar';
import type { ISODate, Profile, Role, Staff, Unavailability } from '../../engine/types';

const SKIP = new Set(['ct', 'the', 'and', 'of', 'on', 'call', 'day', 'long', 'list', 'lists', 'elective', 'wards']);
const KNOWN: Record<string, string> = { postnatal: 'PN', antenatal: 'AN', nights: 'N', night: 'N' };

/** "Delivery Suite" → "DS", "Gynae Onc Long Day CT" → "GO", "Postnatal Wards CT" → "PN", "Elective C-Sections" → "CS". */
export function placeCode(role: Role | undefined, roles: Role[]): string {
  if (!role) return '?';
  const parent = role.parentId ? roles.find(r => r.id === role.parentId) : undefined;
  if (parent) return placeCode(parent, roles);
  const words = role.name.replace(/[–—]/g, ' ').split(/\s+/).filter(Boolean);
  const caps = words.find(w => /^[A-Z]{2,4}$/.test(w) && w !== 'CT');
  if (caps) return caps;
  const kept = words.filter(w => !SKIP.has(w.toLowerCase()));
  if (kept.length === 1 && KNOWN[kept[0].toLowerCase()]) return KNOWN[kept[0].toLowerCase()];
  if (kept.length === 1 && kept[0].includes('-')) return kept[0].split('-').map(x => x[0].toUpperCase()).join('');
  if (kept.length === 1) return kept[0].slice(0, 2).toUpperCase();
  return (kept.map(w => KNOWN[w.toLowerCase()] ?? w[0].toUpperCase()).join('') || role.name.slice(0, 2).toUpperCase()).slice(0, 3);
}

/** A colour class per kind of work, from the place's group (category). */
export function categoryOf(role: Role | undefined, roles: Role[]): string | undefined {
  if (!role) return undefined;
  return role.category ?? (role.parentId ? roles.find(r => r.id === role.parentId)?.category : undefined);
}

export interface AwayCode { code: string; cls: string; label: string }

const TRAINING = /train|teach|prompt|fetal|mandatory|induction|study|self development/i;

/** How a day off shows in the grids. */
export function awayCode(u: Unavailability): AwayCode {
  const reason = u.reason ?? '';
  if (u.kind === 'nonWorking') return /zero/i.test(reason) ? { code: 'ZD', cls: 'code-off', label: 'Zero Day' } : { code: 'Off', cls: 'code-off', label: reason || 'Regular day off' };
  if (/not available/i.test(reason)) return { code: 'NA', cls: 'code-off', label: 'Not available' };
  if (/sick/i.test(reason)) return { code: 'Sick', cls: 'code-leave', label: 'Sick' };
  if (/study leave/i.test(reason)) return { code: 'SL', cls: 'code-train', label: 'Study leave' };
  if (TRAINING.test(reason)) return { code: 'TR', cls: 'code-train', label: reason || 'Training' };
  if (u.kind === 'leave' || /leave|away/i.test(reason)) return { code: 'AL', cls: 'code-leave', label: reason || 'Leave' };
  return { code: reason ? reason.slice(0, 3) : 'Off', cls: 'code-off', label: reason || 'Unavailable' };
}

/** "Night" → "N", "Long Day" → "LD", "Normal working day" → "D". */
export function shiftCode(name: string | undefined): string {
  if (!name) return '';
  if (/night/i.test(name)) return 'N';
  if (/long/i.test(name)) return 'LD';
  if (/normal|day/i.test(name)) return 'D';
  return name.split(/\s+/).map(w => w[0]).join('').toUpperCase().slice(0, 2);
}

/** Places that have their own colour, for the legend: one entry per group of places. */
export function legendGroups(p: Profile): { category: string; codes: string[] }[] {
  const out = new Map<string, Set<string>>();
  for (const r of p.roles.filter(x => !x.parentId)) {
    const c = r.category ?? 'Other';
    if (!out.has(c)) out.set(c, new Set());
    out.get(c)!.add(placeCode(r, p.roles));
  }
  return [...out].map(([category, codes]) => ({ category, codes: [...codes] }));
}

/** Weekend shading and a line before each Monday. */
export function dayClass(d: ISODate): string {
  const wd = weekday(d);
  return `${wd >= 5 ? 'weekend' : ''} ${wd === 0 ? 'week-start' : ''}`;
}

/** Doctors grouped by their first group, in the department's group order; locums last. Given dates, leaves out anyone not in the department then. */
export function staffSections(p: Profile, period?: { start: ISODate; end: ISODate }): { title: string; staff: Staff[] }[] {
  const out: { title: string; staff: Staff[] }[] = [];
  const all = period ? p.staff.filter(s => !(s.startDate && s.startDate > period.end) && !(s.endDate && s.endDate < period.start)) : p.staff;
  for (const g of p.groups) {
    const staff = all.filter(s => !s.locum && s.groupIds[0] === g.id);
    if (staff.length) out.push({ title: g.name, staff });
  }
  const none = all.filter(s => !s.locum && !p.groups.some(g => g.id === s.groupIds[0]));
  if (none.length) out.push({ title: 'No group', staff: none });
  const locums = all.filter(s => s.locum);
  if (locums.length) out.push({ title: 'Locums', staff: locums });
  return out;
}

