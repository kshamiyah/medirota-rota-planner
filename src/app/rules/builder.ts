/**
 * The rule builder's state: a rule being put together one blank at a time.
 * Pure functions, so the page only has to show the next list to pick from.
 */
import type { Profile, Rule, StaffSelector } from '../../engine/types';
import { KINDS, kindOf, type KindId } from './kinds';
import { describeRule, hasDays, type NumKey } from './sentence';

export interface Draft {
  kindId?: KindId;
  rule?: Rule;
  /** Who it's about, kept even before a kind is picked. */
  who: StaffSelector;
  /** The blanks that have been answered. */
  filled: string[];
  /** Set when changing an existing rule. */
  editingId?: string;
}

export const emptyDraft = (): Draft => ({ who: {}, filled: [] });

export function draftFromRule(r: Rule): Draft {
  const k = kindOf(r);
  const unset = r.unset ?? [];
  const rule = structuredClone(r);
  delete rule.unset;
  return { kindId: k.id, rule, who: r.who ?? {}, filled: k.ask.filter(a => !unset.includes(a)), editingId: r.id };
}

type Loose = Record<string, unknown>;

/** Pick (or change) the kind of rule, keeping whatever answers still fit. */
export function chooseKind(p: Profile, d: Draft, kindId: KindId, id: string): Draft {
  const k = KINDS.find(x => x.id === kindId)!;
  const rule = k.make(p, d.rule?.id ?? id);
  const old = d.rule as Loose | undefined;
  const next = rule as unknown as Loose;
  const keep: string[] = [];
  if (k.hasWho) { rule.who = d.who; if (d.filled.includes('who')) keep.push('who'); }
  if (old) {
    for (const key of ['work', 'a', 'b'] as const) {
      if (k.ask.includes(key) && d.filled.includes(key) && old[key]) { next[key] = structuredClone(old[key]); keep.push(key); }
    }
    if (k.ask.includes('place') && d.filled.includes('place') && typeof old.roleId === 'string') { next.roleId = old.roleId; keep.push('place'); }
    if (old.days && hasDays(rule)) next.days = structuredClone(old.days);
    // Between "at most" and "at least", the number, unit and period still make sense.
    if (rule.type === 'count' && old.type === 'count') {
      const n = (old.min ?? old.max) as number;
      if (rule.min !== undefined) rule.min = n; else rule.max = n;
      rule.unit = old.unit as 'shifts' | 'hours';
      rule.period = old.period as 'week' | 'month' | 'horizon';
      if (old.perWeekAverage) rule.perWeekAverage = true;
      for (const key of ['amount', 'period']) if (d.filled.includes(key)) keep.push(key);
    }
  }
  return { ...d, kindId, rule, filled: [...new Set(keep)] };
}

export function setWho(d: Draft, who: StaffSelector): Draft {
  const filled = [...new Set([...d.filled, 'who'])];
  const k = d.kindId && KINDS.find(x => x.id === d.kindId);
  // A rule about a place has no "who"; picking someone means starting a different kind of rule.
  if (k && !k.hasWho) return { ...d, kindId: undefined, rule: undefined, who, filled: ['who'] };
  if (!d.rule) return { ...d, who, filled };
  return { ...d, who, rule: { ...d.rule, who }, filled };
}

/** Change the rule and mark a blank as answered. */
export function answer(d: Draft, key: string, fn: (r: Rule) => void): Draft {
  if (!d.rule) return d;
  const rule = structuredClone(d.rule);
  fn(rule);
  return { ...d, rule, filled: [...new Set([...d.filled, key])] };
}

export function setNumber(r: Rule, key: NumKey, n: number): void {
  if (key === 'amount') { if (r.type === 'count') { if (r.min !== undefined) r.min = n; else r.max = n; } return; }
  (r as unknown as Record<string, number>)[key] = n;
}

export function setPeriod(r: Rule, value: string): void {
  if (r.type !== 'count') return;
  if (value === 'avg') { r.period = 'horizon'; r.perWeekAverage = true; } else { r.period = value as 'week' | 'month' | 'horizon'; delete r.perWeekAverage; }
}

/** The blank to ask about next: 'who', 'kind', one of the kind's blanks, or 'done'. */
export function nextBlank(d: Draft): string {
  if (!d.kindId) return d.filled.includes('who') ? 'kind' : 'who';
  const k = KINDS.find(x => x.id === d.kindId)!;
  return k.ask.find(a => !d.filled.includes(a)) ?? 'done';
}

export function finish(p: Profile, d: Draft): Rule | undefined {
  if (!d.rule || nextBlank(d) !== 'done') return undefined;
  const r = structuredClone(d.rule);
  delete r.unset;
  r.name = describeRule(p, r);
  return r;
}
