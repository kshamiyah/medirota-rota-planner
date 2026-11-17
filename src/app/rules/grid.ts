/**
 * Grid views of rules. "Who can work where" and "Training needs" cells, and
 * the working-time limits checklist, are read from and written back to
 * ordinary rules, so the grids are just an easier way to edit the same data.
 * Anything that doesn't fit a grid stays in "Other rules".
 */
import { shiftHours } from '../../engine/calendar';
import type { CountRule, ForbidRule, Profile, Rule } from '../../engine/types';

/** A grid row: a whole group or one named person. */
export type Row = { kind: 'group' | 'person'; id: string };

export interface Access {
  /** Never works here (a "must" rule). */
  never: boolean;
  /** Should avoid working here (a "try to" rule). */
  avoid: boolean;
  /** Shifts at this place they must not do (e.g. nights). */
  blockedShifts: string[];
  /** At most this many shifts here per period. */
  limit?: { max: number; period: 'week' | 'month' };
}

export interface Target {
  min: number;
  period: 'week' | 'month';
  partTimeLess: boolean;
}

const onePlace = (w: { roleIds?: string[]; categories?: string[] } | undefined) => (w?.roleIds?.length === 1 && !(w.categories?.length) ? w.roleIds[0] : undefined);
const noDays = (r: { days?: { weekdays?: number[]; dates?: string[] } }) => !(r.days?.weekdays?.length) && !(r.days?.dates?.length);

/** Which grid cell (if any) a rule belongs to. */
export function gridCellOf(r: Rule): { grid: 'access' | 'training'; row: Row; placeId: string } | undefined {
  const g = r.who?.groupIds ?? [], s = r.who?.staffIds ?? [];
  const row: Row | undefined = g.length === 1 && s.length === 0 ? { kind: 'group', id: g[0] } : s.length === 1 && g.length === 0 ? { kind: 'person', id: s[0] } : undefined;
  if (!row || r.unset?.length) return undefined;
  if (r.type === 'forbid' && noDays(r)) {
    const place = onePlace(r.work);
    if (!place) return undefined;
    if (r.hard || !(r.work.shiftTypeIds?.length)) return { grid: 'access', row, placeId: place };
    return undefined;
  }
  if (r.type === 'count' && noDays(r) && r.unit === 'shifts' && !(r.work.shiftTypeIds?.length) && !r.perWeekAverage && (r.period === 'week' || r.period === 'month')) {
    const place = onePlace(r.work);
    if (!place) return undefined;
    if (r.max !== undefined && r.hard) return { grid: 'access', row, placeId: place };
    if (r.min !== undefined && !r.hard && (r.tier ?? 'training') === 'training') return { grid: 'training', row, placeId: place };
  }
  return undefined;
}

const cellRules = (p: Profile, grid: 'access' | 'training', row: Row, placeId: string) =>
  p.rules.filter(r => { const c = gridCellOf(r); return c && c.grid === grid && c.placeId === placeId && c.row.kind === row.kind && c.row.id === row.id; });

export function readAccess(p: Profile, row: Row, placeId: string): Access {
  const a: Access = { never: false, avoid: false, blockedShifts: [] };
  for (const r of cellRules(p, 'access', row, placeId)) {
    if (r.enabled === false) continue;
    if (r.type === 'forbid') {
      if (r.work.shiftTypeIds?.length) a.blockedShifts.push(...r.work.shiftTypeIds);
      else if (r.hard) a.never = true;
      else a.avoid = true;
    }
    if (r.type === 'count' && r.max !== undefined) a.limit = { max: r.max, period: r.period as 'week' | 'month' };
  }
  return a;
}

let seq = 0;
const ruleId = () => `rule-${Date.now().toString(36)}${(seq++).toString(36)}`;

/** Replace a cell's rules with ones expressing `a`. */
export function writeAccess(p: Profile, row: Row, placeId: string, a: Access): void {
  const old = new Set(cellRules(p, 'access', row, placeId).map(r => r.id));
  const at = p.rules.findIndex(r => old.has(r.id));
  p.rules = p.rules.filter(r => !old.has(r.id));
  const who = row.kind === 'group' ? { groupIds: [row.id] } : { staffIds: [row.id] };
  const made: Rule[] = [];
  if (a.never) made.push({ id: ruleId(), name: '', type: 'forbid', hard: true, who, work: { roleIds: [placeId] } } as ForbidRule);
  else {
    if (a.avoid) made.push({ id: ruleId(), name: '', type: 'forbid', hard: false, tier: 'preference', who, work: { roleIds: [placeId] } } as ForbidRule);
    if (a.blockedShifts.length) made.push({ id: ruleId(), name: '', type: 'forbid', hard: true, who, work: { roleIds: [placeId], shiftTypeIds: [...new Set(a.blockedShifts)] } } as ForbidRule);
    if (a.limit) made.push({ id: ruleId(), name: '', type: 'count', hard: true, who, work: { roleIds: [placeId] }, period: a.limit.period, unit: 'shifts', max: a.limit.max } as CountRule);
  }
  p.rules.splice(at >= 0 ? at : p.rules.length, 0, ...made);
}

export function readTarget(p: Profile, row: Row, placeId: string): Target | undefined {
  const r = cellRules(p, 'training', row, placeId).find(x => x.enabled !== false);
  return r && r.type === 'count' && r.min !== undefined ? { min: r.min, period: r.period as 'week' | 'month', partTimeLess: !!r.scaleByFte } : undefined;
}

export function writeTarget(p: Profile, row: Row, placeId: string, t: Target | undefined): void {
  const old = new Set(cellRules(p, 'training', row, placeId).map(r => r.id));
  const at = p.rules.findIndex(r => old.has(r.id));
  p.rules = p.rules.filter(r => !old.has(r.id));
  if (!t) return;
  const who = row.kind === 'group' ? { groupIds: [row.id] } : { staffIds: [row.id] };
  const rule: CountRule = { id: ruleId(), name: '', type: 'count', hard: false, tier: 'training', who, work: { roleIds: [placeId] }, period: t.period, unit: 'shifts', min: t.min, ...(t.partTimeLess ? { scaleByFte: true } : {}) };
  p.rules.splice(at >= 0 ? at : p.rules.length, 0, rule);
}

/** Rows to show: every group, plus any person who already has grid rules. */
export function gridRows(p: Profile, grid: 'access' | 'training', extraPeople: string[] = []): Row[] {
  const people = new Set(extraPeople);
  for (const r of p.rules) { const c = gridCellOf(r); if (c?.grid === grid && c.row.kind === 'person') people.add(c.row.id); }
  return [
    ...p.groups.map(g => ({ kind: 'group' as const, id: g.id })),
    ...p.staff.filter(s => people.has(s.id)).map(s => ({ kind: 'person' as const, id: s.id })),
  ];
}

// ---------------- Working-time limits ----------------

export interface LimitDef {
  id: string;
  label: string;
  /** Text around the numbers, e.g. ['At least', 'hours off between shifts']. */
  parts: string[];
  values: (r: Rule) => number[];
  make: (vals: number[]) => Rule;
  apply: (r: Rule, vals: number[]) => void;
  matches: (r: Rule) => boolean;
  /** Not part of the standard contract set: shown, but off until switched on. */
  offByDefault?: boolean;
}

const everyone = (r: Rule) => !(r.who?.groupIds?.length) && !(r.who?.staffIds?.length);

export function limitDefs(p: Profile): LimitDef[] {
  const nights = p.shiftTypes.filter(s => s.end <= s.start).map(s => s.id).sort();
  const longDays = p.shiftTypes.filter(s => s.end > s.start && shiftHours(s) >= 10).map(s => s.id).sort();
  const sameShifts = (r: { work?: { shiftTypeIds?: string[]; roleIds?: string[]; categories?: string[] } }, ids: string[]) =>
    !(r.work?.roleIds?.length) && !(r.work?.categories?.length) && JSON.stringify([...(r.work?.shiftTypeIds ?? [])].sort()) === JSON.stringify(ids);
  const defs: LimitDef[] = [
    {
      id: 'rest', label: 'Rest between shifts', parts: ['At least', 'hours off between shifts'],
      matches: r => r.type === 'minRest' && everyone(r), values: r => [r.type === 'minRest' ? r.hours : 11],
      make: v => ({ id: 'contract-rest', name: '', type: 'minRest', hard: true, hours: v[0] }), apply: (r, v) => { if (r.type === 'minRest') r.hours = v[0]; },
    },
    {
      id: 'hours7', label: 'Hours in a week', parts: ['At most', 'hours in any', 'days'],
      matches: r => r.type === 'maxHours' && everyone(r), values: r => (r.type === 'maxHours' ? [r.hours, r.windowDays] : [72, 7]),
      make: v => ({ id: 'contract-72', name: '', type: 'maxHours', hard: true, hours: v[0], windowDays: v[1] }), apply: (r, v) => { if (r.type === 'maxHours') { r.hours = v[0]; r.windowDays = v[1]; } },
    },
    {
      id: 'avg', label: 'Average hours', parts: ['At most', 'hours a week on average (less for part-timers)'],
      matches: r => r.type === 'count' && r.unit === 'hours' && !!r.perWeekAverage && r.max !== undefined && everyone(r) && !(r.work.roleIds?.length) && !(r.work.shiftTypeIds?.length),
      values: r => [r.type === 'count' ? r.max ?? 48 : 48],
      make: v => ({ id: 'contract-48', name: '', type: 'count', hard: true, work: {}, period: 'horizon', unit: 'hours', max: v[0], perWeekAverage: true, scaleByFte: true }),
      apply: (r, v) => { if (r.type === 'count') r.max = v[0]; },
    },
    {
      id: 'days', label: 'Days in a row', parts: ['At most', 'working days in a row'],
      matches: r => r.type === 'maxConsecutive' && everyone(r) && sameShifts(r, []), values: r => [r.type === 'maxConsecutive' ? r.maxDays : 7],
      make: v => ({ id: 'contract-7days', name: '', type: 'maxConsecutive', hard: true, work: {}, maxDays: v[0] }), apply: (r, v) => { if (r.type === 'maxConsecutive') r.maxDays = v[0]; },
    },
    {
      id: 'weekends', label: 'Weekends', parts: ['At most', 'in every', 'weekends'],
      matches: r => r.type === 'weekendFrequency' && everyone(r), values: r => (r.type === 'weekendFrequency' ? [r.maxWeekends, r.inWeekends] : [1, 2]),
      make: v => ({ id: 'contract-weekends', name: '', type: 'weekendFrequency', hard: true, maxWeekends: v[0], inWeekends: v[1] }),
      apply: (r, v) => { if (r.type === 'weekendFrequency') { r.maxWeekends = v[0]; r.inWeekends = v[1]; } },
    },
  ];
  if (nights.length) {
    defs.push(
      {
        id: 'nights', label: 'Nights in a row', parts: ['At most', 'nights in a row'],
        matches: r => r.type === 'maxConsecutive' && everyone(r) && sameShifts(r, nights), values: r => [r.type === 'maxConsecutive' ? r.maxDays : 4],
        make: v => ({ id: 'contract-nights', name: '', type: 'maxConsecutive', hard: true, work: { shiftTypeIds: nights }, maxDays: v[0] }), apply: (r, v) => { if (r.type === 'maxConsecutive') r.maxDays = v[0]; },
      },
      {
        id: 'postnights', label: 'Rest after nights', parts: ['At least', 'hours off after a run of nights'],
        matches: r => r.type === 'restAfterBlock' && everyone(r) && sameShifts(r, nights), values: r => [r.type === 'restAfterBlock' ? r.hours : 46],
        make: v => ({ id: 'contract-postnights', name: '', type: 'restAfterBlock', hard: true, work: { shiftTypeIds: nights }, hours: v[0] }), apply: (r, v) => { if (r.type === 'restAfterBlock') r.hours = v[0]; },
      },
      {
        id: 'nightblocks', label: 'Nights in blocks', parts: ['At least', 'nights at a time (no single nights)'],
        matches: r => r.type === 'minBlock' && everyone(r) && sameShifts(r, nights), values: r => [r.type === 'minBlock' ? r.minDays : 2],
        make: v => ({ id: 'contract-nightblocks', name: '', type: 'minBlock', hard: true, work: { shiftTypeIds: nights }, minDays: v[0] }), apply: (r, v) => { if (r.type === 'minBlock') r.minDays = v[0]; },
        offByDefault: true,
      },
    );
  }
  if (longDays.length) {
    defs.push({
      id: 'longdays', label: 'Long days in a row', parts: ['At most', 'long days in a row'],
      matches: r => r.type === 'maxConsecutive' && everyone(r) && sameShifts(r, longDays), values: r => [r.type === 'maxConsecutive' ? r.maxDays : 4],
      make: v => ({ id: 'contract-longdays', name: '', type: 'maxConsecutive', hard: true, work: { shiftTypeIds: longDays }, maxDays: v[0] }), apply: (r, v) => { if (r.type === 'maxConsecutive') r.maxDays = v[0]; },
    }, {
      id: 'postlongdays', label: 'Rest after long days', parts: ['After', 'long days in a row, at least', 'hours off'],
      matches: r => r.type === 'restAfterRun' && everyone(r) && sameShifts(r, longDays), values: r => (r.type === 'restAfterRun' ? [r.runDays, r.hours] : [4, 48]),
      make: v => ({ id: 'contract-postlongdays', name: '', type: 'restAfterRun', hard: true, work: { shiftTypeIds: longDays }, runDays: v[0], hours: v[1] }),
      apply: (r, v) => { if (r.type === 'restAfterRun') { r.runDays = v[0]; r.hours = v[1]; } },
      offByDefault: true,
    });
  }
  return defs;
}


const LIMIT_TYPES = ['minRest', 'maxHours', 'maxConsecutive', 'restAfterBlock', 'weekendFrequency', 'minBlock', 'restAfterRun'];

/**
 * Which part of the Rules page a rule lives in: a grid cell, the standard
 * working-hours checklist, the group/shift-specific limits under it, or
 * "Other rules".
 */
export function ruleHome(p: Profile, r: Rule): 'access' | 'training' | 'limits' | 'customLimit' | 'staffing' | 'continuity' | 'other' {
  const cell = gridCellOf(r);
  if (cell) return cell.grid;
  if (r.type === 'continuity' && !r.unset?.length && !(r.who?.groupIds?.length) && !(r.who?.staffIds?.length)) return 'continuity';
  if (mustIncludeOf(r)) return 'staffing';
  if (limitDefs(p).some(d => d.matches(r))) return 'limits';
  if (LIMIT_TYPES.includes(r.type) || (r.type === 'count' && r.unit === 'hours' && r.max !== undefined && !(r.work.roleIds?.length) && !(r.work.categories?.length))) return 'customLimit';
  return 'other';
}

/** A skill-mix rule about one place on one shift (shown as "Must include" on Staffing needs). */
export function mustIncludeOf(r: Rule): { roleId: string; shiftTypeId: string } | undefined {
  if (r.type !== 'skillMix' || r.unset?.length || r.days?.weekdays?.length || r.days?.dates?.length) return undefined;
  const roles = r.work.roleIds ?? [], shifts = r.work.shiftTypeIds ?? [];
  if (roles.length !== 1 || shifts.length !== 1 || r.work.categories?.length) return undefined;
  return { roleId: roles[0], shiftTypeId: shifts[0] };
}

/** The continuity rule for a place, if any. */
export function continuityOf(p: Profile, roleId: string): Extract<Rule, { type: 'continuity' }> | undefined {
  return p.rules.find((r): r is Extract<Rule, { type: 'continuity' }> => r.type === 'continuity' && r.roleId === roleId && ruleHome(p, r) === 'continuity');
}
