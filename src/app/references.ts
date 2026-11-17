/**
 * What refers to a shift, place, group or person. Used to stop things being
 * removed while something still depends on them, and to say what.
 */
import type { Rule, StaffSelector, WorkSelector } from '../engine/types';
import type { Workspace } from './store';

export type RefKind = 'shift' | 'place' | 'group' | 'person';

function workUses(w: WorkSelector | undefined, kind: RefKind, id: string): boolean {
  if (!w) return false;
  if (kind === 'shift') return !!w.shiftTypeIds?.includes(id);
  if (kind === 'place') return !!w.roleIds?.includes(id);
  return false;
}

function whoUses(w: StaffSelector | undefined, kind: RefKind, id: string): boolean {
  if (!w) return false;
  if (kind === 'group') return !!w.groupIds?.includes(id);
  if (kind === 'person') return !!w.staffIds?.includes(id);
  return false;
}

export function ruleUses(rule: Rule, kind: RefKind, id: string): boolean {
  if (whoUses(rule.who, kind, id)) return true;
  switch (rule.type) {
    case 'linkShifts':
      return (kind === 'place' && rule.roleId === id) || (kind === 'shift' && rule.shiftTypeIds.includes(id));
    case 'notSameDay':
    case 'pairPreference':
      return workUses(rule.a, kind, id) || workUses(rule.b, kind, id);
    case 'forbid':
    case 'count':
    case 'preference':
    case 'share':
    case 'workWith':
    case 'fewLeads':
    case 'maxConsecutive':
    case 'restAfterBlock':
    case 'skillMix':
    case 'minBlock':
    case 'restAfterRun':
      return workUses(rule.work, kind, id);
    case 'continuity':
      return kind === 'place' && rule.roleId === id;
    default:
      return false;
  }
}

/** Plain-English list of everything that uses this item. Empty means it's safe to remove. */
export function usesOf(ws: Workspace, kind: RefKind, id: string): string[] {
  const out: string[] = [];
  const p = ws.profile;
  const rules = p.rules.filter(r => ruleUses(r, kind, id));
  if (rules.length) out.push(`rule${rules.length > 1 ? 's' : ''}: ${rules.map(r => `"${r.name}"`).join(', ')}`);
  if (kind === 'shift' || kind === 'place') {
    const needs = p.demands.filter(d => (kind === 'shift' ? d.shiftTypeId : d.roleId) === id);
    if (needs.length) out.push('staffing needs');
    if (ws.fixed.some(f => (kind === 'shift' ? f.shiftTypeId : f.roleId) === id)) out.push('booked shifts');
    if (p.fairness.some(f => workUses(f.work, kind, id))) out.push('fairness settings');
  }
  if (kind === 'shift' && ws.unavailability.some(u => u.shiftTypeIds?.includes(id))) out.push('part-day leave');
  if (kind === 'group') {
    const n = p.staff.filter(s => s.groupIds.includes(id)).length;
    if (n) out.push(`${n} ${n === 1 ? 'person' : 'people'}`);
  }
  return out;
}

export interface RemovalSummary {
  needs: number;
  booked: number;
  rotaShifts: number;
  rulesDeleted: string[];
  rulesChanged: string[];
  /** Part-day leave entries removed (shifts only). */
  leave?: number;
  /** People who lose the group (groups only). */
  people?: number;
}

export function isUsed(s: RemovalSummary): boolean {
  return s.needs + s.booked + s.rotaShifts + (s.leave ?? 0) + (s.people ?? 0) + s.rulesDeleted.length + s.rulesChanged.length > 0;
}

/** Remove `id` from a list. 'emptied' means the list named something and now names nothing. */
function dropFrom(list: string[] | undefined, id: string, set: (v: string[]) => void): 'unchanged' | 'changed' | 'emptied' {
  if (!list?.includes(id)) return 'unchanged';
  const rest = list.filter(x => x !== id);
  set(rest);
  return rest.length === 0 ? 'emptied' : 'changed';
}

/** Keep, change or delete each rule according to what `edit` reports for it. */
function sweepRules(rules: Rule[], summary: RemovalSummary, edit: (r: Rule) => ('unchanged' | 'changed' | 'emptied')[]): Rule[] {
  return rules.filter(r => {
    const results = edit(r);
    if (results.includes('emptied')) { summary.rulesDeleted.push(r.name); return false; }
    if (results.includes('changed')) summary.rulesChanged.push(r.name);
    return true;
  });
}

function emptySummary(): RemovalSummary {
  return { needs: 0, booked: 0, rotaShifts: 0, rulesDeleted: [], rulesChanged: [] };
}

/**
 * Take a place out of a work selector. Returns 'unchanged', 'changed', or
 * 'emptied' when the selector named only places and none are left, meaning
 * it would silently widen to "any place".
 */
function dropPlace(w: WorkSelector | undefined, id: string): 'unchanged' | 'changed' | 'emptied' {
  if (!w?.roleIds?.includes(id)) return 'unchanged';
  w.roleIds = w.roleIds.filter(r => r !== id);
  if (w.roleIds.length === 0 && !(w.categories?.length)) return 'emptied';
  return 'changed';
}

/**
 * Remove a place everywhere: staffing needs (including one-off changes),
 * booked shifts, the current rota, fairness settings and rules. A rule left
 * with no place (it was only about this one) is deleted rather than widened to
 * every place. Mutates the workspace; use `previewRemovePlace` to see the
 * effect first.
 */
export function removePlace(w: Workspace, placeId: string): RemovalSummary {
  const p = w.profile;
  const summary = emptySummary();
  // A place's consultant lists go with it.
  for (const child of p.roles.filter(r => r.parentId === placeId)) {
    const s = removePlace(w, child.id);
    summary.needs += s.needs; summary.booked += s.booked; summary.rotaShifts += s.rotaShifts;
    summary.rulesChanged.push(...s.rulesChanged); summary.rulesDeleted.push(...s.rulesDeleted);
  }
  p.roles = p.roles.filter(r => r.id !== placeId);
  summary.needs = p.demands.filter(d => d.roleId === placeId).length;
  p.demands = p.demands.filter(d => d.roleId !== placeId);
  summary.booked = w.fixed.filter(f => f.roleId === placeId).length;
  w.fixed = w.fixed.filter(f => f.roleId !== placeId);
  p.fairness = p.fairness.filter(f => dropPlace(f.work, placeId) !== 'emptied');
  p.rules = sweepRules(p.rules, summary, r => {
    if (r.type === 'linkShifts' || r.type === 'continuity') return [r.roleId === placeId ? 'emptied' : 'unchanged'];
    if (r.type === 'notSameDay' || r.type === 'pairPreference') return [dropPlace(r.a, placeId), dropPlace(r.b, placeId)];
    if ('work' in r) return [dropPlace(r.work, placeId)];
    return [];
  });
  if (w.rota) {
    summary.rotaShifts = w.rota.assignments.filter(a => a.roleId === placeId).length;
    w.rota.assignments = w.rota.assignments.filter(a => a.roleId !== placeId);
    w.rota.locked = (w.rota.locked ?? []).filter(k => !k.endsWith(`|${placeId}`));
    if (summary.rotaShifts) w.rota.edited = true;
  }
  return summary;
}

/** What removing a place would do, without changing anything. */
export function previewRemovePlace(ws: Workspace, placeId: string): RemovalSummary {
  return removePlace(structuredClone(ws), placeId);
}

/** Take a shift out of a work selector; 'emptied' if it named shifts and now names none. */
function dropShift(w: WorkSelector | undefined, id: string) {
  return dropFrom(w?.shiftTypeIds, id, v => { if (w) w.shiftTypeIds = v; });
}

/**
 * Remove a shift everywhere: staffing needs, booked shifts, part-day leave for
 * that shift, the current rota, fairness settings and rules. A rule that was
 * limited to this shift and no other is deleted rather than widened to every
 * shift (e.g. "max 4 nights in a row" must not become "max 4 days in a row").
 */
export function removeShift(w: Workspace, shiftId: string): RemovalSummary {
  const p = w.profile;
  const summary = emptySummary();
  p.shiftTypes = p.shiftTypes.filter(s => s.id !== shiftId);
  summary.needs = p.demands.filter(d => d.shiftTypeId === shiftId).length;
  p.demands = p.demands.filter(d => d.shiftTypeId !== shiftId);
  summary.booked = w.fixed.filter(f => f.shiftTypeId === shiftId).length;
  w.fixed = w.fixed.filter(f => f.shiftTypeId !== shiftId);
  summary.leave = 0;
  w.unavailability = w.unavailability.filter(u => {
    if (!u.shiftTypeIds?.includes(shiftId)) return true;
    u.shiftTypeIds = u.shiftTypeIds.filter(x => x !== shiftId);
    if (u.shiftTypeIds.length === 0) { summary.leave!++; return false; }
    return true;
  });
  p.fairness = p.fairness.filter(f => dropShift(f.work, shiftId) !== 'emptied');
  p.rules = sweepRules(p.rules, summary, r => {
    if (r.type === 'linkShifts') return [r.shiftTypeIds.includes(shiftId) ? 'emptied' : 'unchanged'];
    if (r.type === 'notSameDay' || r.type === 'pairPreference') return [dropShift(r.a, shiftId), dropShift(r.b, shiftId)];
    if ('work' in r) return [dropShift(r.work, shiftId)];
    return [];
  });
  if (w.rota) {
    summary.rotaShifts = w.rota.assignments.filter(a => a.shiftTypeId === shiftId).length;
    w.rota.assignments = w.rota.assignments.filter(a => a.shiftTypeId !== shiftId);
    w.rota.locked = (w.rota.locked ?? []).filter(k => k.split('|')[2] !== shiftId);
    if (summary.rotaShifts) w.rota.edited = true;
  }
  return summary;
}

export function previewRemoveShift(ws: Workspace, shiftId: string): RemovalSummary {
  return removeShift(structuredClone(ws), shiftId);
}

/**
 * Remove a group everywhere: people lose it, and rules lose it. A rule that
 * applied only to this group is deleted rather than widened to everyone.
 */
export function removeGroup(w: Workspace, groupId: string): RemovalSummary {
  const p = w.profile;
  const summary = emptySummary();
  p.groups = p.groups.filter(g => g.id !== groupId);
  summary.people = 0;
  for (const s of p.staff) if (s.groupIds.includes(groupId)) { s.groupIds = s.groupIds.filter(g => g !== groupId); summary.people++; }
  p.rules = sweepRules(p.rules, summary, r => {
    const who = r.who;
    if (!who?.groupIds?.includes(groupId)) return [];
    who.groupIds = who.groupIds.filter(g => g !== groupId);
    return [who.groupIds.length === 0 && !(who.staffIds?.length) ? 'emptied' : 'changed'];
  });
  return summary;
}

export function previewRemoveGroup(ws: Workspace, groupId: string): RemovalSummary {
  return removeGroup(structuredClone(ws), groupId);
}

/**
 * Remove a person everywhere: leave, booked shifts, the current rota, and any
 * rules. A rule that named only this person is deleted (otherwise it would
 * silently start applying to everyone); otherwise they're just taken out of it.
 * Returns the names of rules that were deleted.
 */
export function removePerson(w: Workspace, staffId: string): string[] {
  const deleted: string[] = [];
  w.profile.staff = w.profile.staff.filter(s => s.id !== staffId);
  w.unavailability = w.unavailability.filter(u => u.staffId !== staffId);
  w.fixed = w.fixed.filter(f => f.staffId !== staffId);
  delete w.staffExtras[staffId];
  w.profile.rules = w.profile.rules.filter(r => {
    if (!r.who?.staffIds?.includes(staffId)) return true;
    const rest = r.who.staffIds.filter(id => id !== staffId);
    if (rest.length === 0 && !(r.who.groupIds?.length)) { deleted.push(r.name); return false; }
    r.who = { ...r.who, staffIds: rest };
    return true;
  });
  if (w.rota) {
    const before = w.rota.assignments.length;
    w.rota.assignments = w.rota.assignments.filter(a => a.staffId !== staffId);
    w.rota.locked = (w.rota.locked ?? []).filter(k => !k.startsWith(`${staffId}|`));
    if (w.rota.assignments.length !== before) w.rota.edited = true;
  }
  return deleted;
}

/**
 * Remove a consultant: take them off their lists (a list left with no
 * consultant is removed, with its staffing needs) and out of pairing rules
 * (a rule that named only them is deleted).
 */
export function removeLead(w: Workspace, leadId: string): RemovalSummary {
  const p = w.profile;
  const summary = emptySummary();
  p.leads = (p.leads ?? []).filter(l => l.id !== leadId);
  for (const r of [...p.roles]) {
    if (!r.leadIds?.includes(leadId)) continue;
    r.leadIds = r.leadIds.filter(l => l !== leadId);
    if (r.leadIds.length === 0 && r.parentId) {
      const s = removePlace(w, r.id);
      summary.needs += s.needs; summary.booked += s.booked; summary.rotaShifts += s.rotaShifts;
    }
  }
  p.rules = sweepRules(p.rules, summary, r => {
    if (r.type !== 'workWith' || !r.leadIds.includes(leadId)) return [];
    r.leadIds = r.leadIds.filter(l => l !== leadId);
    return [r.leadIds.length === 0 ? 'emptied' : 'changed'];
  });
  return summary;
}

export function previewRemoveLead(ws: Workspace, leadId: string): RemovalSummary {
  return removeLead(structuredClone(ws), leadId);
}
