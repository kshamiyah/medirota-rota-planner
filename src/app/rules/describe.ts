/** Plain-English names for who and which work a rule is about. */
import type { Profile, StaffSelector, WorkSelector } from '../../engine/types';

function list(items: string[], joiner = 'and'): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} ${joiner} ${items[items.length - 1]}`;
}

export function describeWho(p: Profile, who?: StaffSelector): string {
  const parts = [
    ...(who?.groupIds ?? []).map(id => p.groups.find(g => g.id === id)?.name ?? 'a removed group'),
    ...(who?.staffIds ?? []).map(id => p.staff.find(s => s.id === id)?.name ?? 'a removed person'),
  ];
  return parts.length ? list(parts) : 'Everyone';
}

export function describeWork(p: Profile, work?: WorkSelector, joiner = 'or'): string {
  const places = [
    ...(work?.categories ?? []).map(c => `any ${c}`),
    ...(work?.roleIds ?? []).map(id => p.roles.find(r => r.id === id)?.name ?? 'a removed place'),
  ];
  const shifts = (work?.shiftTypeIds ?? []).map(id => p.shiftTypes.find(s => s.id === id)?.name ?? 'a removed shift');
  if (!places.length) return shifts.length ? `${list(shifts, joiner)} shifts` : 'any work';
  return shifts.length ? `${list(places, joiner)} (${list(shifts, joiner)})` : list(places, joiner);
}

export function describeLeads(p: Profile, ids: string[] | undefined): string {
  const names = (ids ?? []).map(id => p.leads?.find(l => l.id === id)?.name ?? 'a removed consultant');
  return names.length ? list(names, 'or') : 'their consultant';
}
