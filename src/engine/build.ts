/**
 * Turns a RotaProblem into a mixed-integer program.
 *
 * Decision variables: x = 1 if a person works a role on a shift on a date.
 * Hard rules become constraints. Soft rules become penalised slack variables,
 * grouped into tiers that the solver optimises one after another.
 */
import { addDays, dateRange, indexProfile, matchesDay, matchesStaff, matchesWork, periodBuckets, shiftHours, shiftInterval, weekendOf } from './calendar';
import { activeRules, breaksRest, canEverDo, capacity, countBounds, fairnessDimensions, isSoft, minimumApplies, shareFactor, softTier } from './semantics';
import type { ISODate, MinRestRule, RotaProblem, Rule, Staff, Tier, WorkSelector } from './types';
import { weekendsTouched } from './validate';

export interface XVar {
  col: number;
  staffId: string;
  roleId?: string;
  shiftTypeId: string;
  date: ISODate;
  hours: number;
  fixed: boolean;
}

export interface RowTag {
  ruleId: string;
  ruleName: string;
  staffId?: string;
  date?: ISODate;
  detail: string;
}

interface Row {
  idx: number[];
  val: number[];
  lo: number;
  hi: number;
  tag?: RowTag;
}

export interface BuiltModel {
  numCols: number;
  colLower: number[];
  colUpper: number[];
  integer: boolean[];
  rows: Row[];
  /** Objective coefficients per tier (sparse). */
  objectives: Map<Tier, Map<number, number>>;
  xvars: XVar[];
  /** In elastic mode: slack column → the row tag it relaxes. */
  elasticSlacks: Map<number, RowTag>;
  /** Fairness deviation columns per person, so the search can target whoever is furthest from fair. */
  fairnessCols: Map<string, number[]>;
  /** Named columns supplied by BuildOptions.additionalVariables. */
  additionalCols: Map<string, number>;
}

export interface BuildOptions {
  /** Relax every hard constraint with a penalised slack, to find out which rules conflict. */
  elastic?: boolean;
  /** Restrict generated (non-fixed) assignments to this allow-list. */
  allowedVariables?: { staffId: string; date: ISODate; roleId: string; shiftTypeId: string }[];
  /** Extra generic linear rows over assignment variables. */
  additionalRows?: { terms: { staffId?: string; date?: ISODate; roleId?: string; shiftTypeId?: string; fixed?: boolean; variableId?: string; coefficient?: number }[]; lower: number; upper: number; tag?: RowTag }[];
  /** Extra generic linear objective terms. */
  additionalObjectives?: { tier: Tier; terms: { staffId?: string; date?: ISODate; roleId?: string; shiftTypeId?: string; fixed?: boolean; variableId?: string; coefficient: number }[] }[];
  /** Named binary/continuous columns used by specialised allocation objectives. */
  additionalVariables?: { id: string; lower?: number; upper?: number; integer?: boolean }[];
}

function makeDemandLookup(profile: RotaProblem['profile']) {
  const demandByRoleShift = new Map<string, typeof profile.demands>();
  for (const demand of profile.demands) {
    const k = `${demand.roleId}|${demand.shiftTypeId}`;
    demandByRoleShift.set(k, [...(demandByRoleShift.get(k) ?? []), demand]);
  }
  const demandCache = new Map<string, { min: number; max: number; importance: number }>();
  return (roleId: string, shiftTypeId: string, date: ISODate) => {
    const key = `${roleId}|${shiftTypeId}|${date}`;
    const cached = demandCache.get(key); if (cached) return cached;
    const matching = (demandByRoleShift.get(`${roleId}|${shiftTypeId}`) ?? []).filter(demand => matchesDay(demand.days, date));
    const oneOff = matching.filter(demand => demand.days.dates && demand.days.dates.length > 0);
    let min = 0, max = 0, importance = 0;
    for (const demand of oneOff.length ? oneOff : matching) {
      min += demand.min; max += demand.max; importance = Math.max(importance, demand.importance ?? 1);
    }
    const value = { min, max, importance: importance || 1 };
    demandCache.set(key, value);
    return value;
  };
}

interface Instance {
  staffId: string;
  shiftTypeId: string;
  date: ISODate;
  start: number;
  end: number;
  vars: XVar[];
}

const INF = Infinity;

export function buildModel(problem: RotaProblem, opts: BuildOptions = {}): BuiltModel {
  const { profile } = problem;
  const idx = indexProfile(profile);
  const dates = dateRange(problem.start, problem.end);
  const rules = activeRules(profile);
  const demandAt = makeDemandLookup(profile);

  const colLower: number[] = [];
  const colUpper: number[] = [];
  const integer: boolean[] = [];
  const rows: Row[] = [];
  const objectives = new Map<Tier, Map<number, number>>();
  const elasticSlacks = new Map<number, RowTag>();
  const fairnessCols = new Map<string, number[]>();

  const addCol = (lo: number, hi: number, int: boolean) => {
    colLower.push(lo); colUpper.push(hi); integer.push(int);
    return colLower.length - 1;
  };
  const addCost = (tier: Tier, col: number, c: number) => {
    if (c === 0) return;
    if (!objectives.has(tier)) objectives.set(tier, new Map());
    const m = objectives.get(tier)!;
    m.set(col, (m.get(col) ?? 0) + c);
  };

  /** Add a constraint lo <= sum <= hi. Soft rules get slack; elastic mode relaxes hard ones too. */
  const constrain = (terms: [number, number][], lo: number, hi: number, tag: RowTag, soft?: { tier: Tier; weight: number }) => {
    const idxs = terms.map(t => t[0]);
    const vals = terms.map(t => t[1]);
    const relax = soft ?? (opts.elastic ? { tier: 'coverage' as Tier, weight: 1 } : undefined);
    if (relax) {
      if (lo > -INF) {
        const s = addCol(0, INF, false);
        rows.push({ idx: [...idxs, s], val: [...vals, 1], lo, hi: INF, tag });
        if (soft) addCost(soft.tier, s, soft.weight); else elasticSlacks.set(s, tag);
      }
      if (hi < INF) {
        const s = addCol(0, INF, false);
        rows.push({ idx: [...idxs, s], val: [...vals, -1], lo: -INF, hi, tag });
        if (soft) addCost(soft.tier, s, soft.weight); else elasticSlacks.set(s, tag);
      }
      return;
    }
    rows.push({ idx: idxs, val: vals, lo, hi, tag });
  };

  const softOf = (rule: Rule) => (isSoft(rule) ? { tier: softTier(rule), weight: rule.weight ?? 1 } : undefined);
  const rulesFor = (s: Staff) => rules.filter(r => matchesStaff(r.who, s));

  // ---- Decision variables ----
  const xvars: XVar[] = [];
  const unavailable = (staffId: string, date: ISODate, shiftTypeId: string) =>
    problem.unavailability.some(u => u.staffId === staffId && u.date === date && (!u.shiftTypeIds || u.shiftTypeIds.includes(shiftTypeId)));
  const hardForbidden = (s: Staff, roleId: string, shiftTypeId: string, date: ISODate) =>
    rules.some(r => r.type === 'forbid' && !isSoft(r) && !opts.elastic && matchesStaff(r.who, s) && matchesDay(r.days, date) && matchesWork(r.work, roleId, shiftTypeId, idx.roles));
  const fixedKey = (staffId: string, roleId: string | undefined, shiftTypeId: string, date: ISODate) => `${staffId}|${roleId ?? '-'}|${shiftTypeId}|${date}`;
  const fixedSet = new Set(problem.fixed.map(f => fixedKey(f.staffId, f.roleId, f.shiftTypeId, f.date)));
  const allowedSet = opts.allowedVariables ? new Set(opts.allowedVariables.map(v => fixedKey(v.staffId, v.roleId, v.shiftTypeId, v.date))) : undefined;
  const xIndex = new Map<string, XVar>();

  const newX = (s: Staff, roleId: string | undefined, shiftTypeId: string, date: ISODate, fixed: boolean) => {
    const st = idx.shiftTypes.get(shiftTypeId)!;
    const col = addCol(0, 1, true);
    const xv: XVar = { col, staffId: s.id, roleId, shiftTypeId, date, hours: shiftHours(st), fixed };
    xvars.push(xv);
    xIndex.set(fixedKey(s.id, roleId, shiftTypeId, date), xv);
    return xv;
  };

  for (const date of dates) for (const role of profile.roles) for (const st of profile.shiftTypes) {
    const { max } = demandAt(role.id, st.id, date);
    if (max <= 0) continue;
    for (const s of profile.staff) {
      if (s.locum) continue; // locums only work the shifts already booked for them
      if (fixedSet.has(fixedKey(s.id, role.id, st.id, date))) continue;
      if (unavailable(s.id, date, st.id)) continue;
      if (hardForbidden(s, role.id, st.id, date)) continue;
      if (allowedSet && !allowedSet.has(fixedKey(s.id, role.id, st.id, date))) continue;
      newX(s, role.id, st.id, date, false);
    }
  }
  for (const f of problem.fixed) {
    const s = idx.staff.get(f.staffId);
    if (!s || !idx.shiftTypes.has(f.shiftTypeId) || f.date < problem.start || f.date > problem.end) continue;
    const xv = newX(s, f.roleId, f.shiftTypeId, f.date, true);
    const tag: RowTag = { ruleId: 'fixed', ruleName: 'Pre-booked shift', staffId: s.id, date: f.date, detail: `Pre-booked ${f.roleId ?? 'commitment'} ${f.shiftTypeId}` };
    if (opts.elastic) constrain([[xv.col, 1]], 1, INF, tag);
    else colLower[xv.col] = 1;
  }

  // ---- Instances: (person, shift, date) with the vars that occupy it ----
  const instancesByStaff = new Map<string, Instance[]>();
  {
    const map = new Map<string, Instance>();
    for (const xv of xvars) {
      const k = `${xv.staffId}|${xv.shiftTypeId}|${xv.date}`;
      let inst = map.get(k);
      if (!inst) {
        const { start, end } = shiftInterval(xv.date, idx.shiftTypes.get(xv.shiftTypeId)!);
        inst = { staffId: xv.staffId, shiftTypeId: xv.shiftTypeId, date: xv.date, start, end, vars: [] };
        map.set(k, inst);
        if (!instancesByStaff.has(xv.staffId)) instancesByStaff.set(xv.staffId, []);
        instancesByStaff.get(xv.staffId)!.push(inst);
      }
      inst.vars.push(xv);
    }
    for (const list of instancesByStaff.values()) list.sort((a, b) => a.start - b.start);
  }
  const occ = (inst: Instance): [number, number][] => inst.vars.map(v => [v.col, 1]);
  const varMatches = (v: XVar, sel?: WorkSelector) => matchesWork(sel, v.roleId, v.shiftTypeId, idx.roles);

  // ---- Demand: max is hard, min is the coverage objective ----
  const bySlot = new Map<string, XVar[]>();
  for (const v of xvars) if (v.roleId !== undefined) {
    const k = `${v.roleId}|${v.shiftTypeId}|${v.date}`;
    if (!bySlot.has(k)) bySlot.set(k, []);
    bySlot.get(k)!.push(v);
  }
  for (const date of dates) for (const role of profile.roles) for (const st of profile.shiftTypes) {
    const { min, max, importance } = demandAt(role.id, st.id, date);
    if (max <= 0 && min <= 0) continue;
    const vars = bySlot.get(`${role.id}|${st.id}|${date}`) ?? [];
    const terms = vars.map(v => [v.col, 1] as [number, number]);
    const fixedHere = vars.filter(v => v.fixed).length;
    const tag: RowTag = { ruleId: 'demand', ruleName: 'Staffing maximum', date, detail: `${role.name} ${st.name} max ${max}` };
    if (terms.length > 0) constrain(terms, -INF, Math.max(max, fixedHere), tag);
    if (min > 0) {
      const short = addCol(0, min, false);
      rows.push({ idx: [...terms.map(t => t[0]), short], val: [...terms.map(t => t[1]), 1], lo: min, hi: INF });
      addCost('coverage', short, importance);
    }
    if (profile.useSpareCapacity) for (const t of terms) addCost('extra', t[0], -1);
  }

  // ---- Skill mix: at least N of these people on this work each day ----
  for (const rule of rules) {
    if (rule.type !== 'skillMix') continue;
    const soft = isSoft(rule) ? { tier: softTier(rule), weight: rule.weight ?? 1 } : undefined;
    for (const d of dates) {
      if (!matchesDay(rule.days, d)) continue;
      // Only on days when this work is actually staffed.
      const staffed = profile.roles.some(role => profile.shiftTypes.some(st => demandAt(role.id, st.id, d).max > 0 && matchesWork(rule.work, role.id, st.id, idx.roles)));
      if (!staffed) continue;
      const terms = xvars
        .filter(v => v.date === d && varMatches(v, rule.work) && matchesStaff(rule.who, idx.staff.get(v.staffId)!))
        .map(v => [v.col, 1] as [number, number]);
      constrain(terms, rule.min, INF, { ruleId: rule.id, ruleName: rule.name, date: d, detail: 'skill mix' }, soft);
    }
  }

  // ---- Per person ----
  for (const s of profile.staff) {
    const insts = instancesByStaff.get(s.id) ?? [];
    const myVars = insts.flatMap(i => i.vars);
    const myRules = rulesFor(s);
    const restRules = myRules.filter((r): r is MinRestRule => r.type === 'minRest');
    const maxRest = Math.max(0, ...restRules.map(r => r.hours));

    // One role per shift.
    for (const inst of insts) if (inst.vars.length > 1) {
      constrain(occ(inst), -INF, 1, { ruleId: 'overlap', ruleName: 'One role per shift', staffId: s.id, date: inst.date, detail: inst.shiftTypeId });
    }
    // No overlaps, and minimum rest between shifts.
    for (let i = 0; i < insts.length; i++) {
      for (let j = i + 1; j < insts.length && insts[j].start < insts[i].end + maxRest * 60; j++) {
        const a = insts[i], b = insts[j];
        const gapH = (b.start - a.end) / 60;
        const terms = [...occ(a), ...occ(b)];
        if (gapH < 0) {
          constrain(terms, -INF, 1, { ruleId: 'overlap', ruleName: 'Overlapping shifts', staffId: s.id, date: b.date, detail: `${a.shiftTypeId} ${a.date} overlaps ${b.shiftTypeId} ${b.date}` });
          continue;
        }
        const broken = restRules.filter(r => breaksRest(r, gapH, (b.end - a.start) / 60));
        const hard = broken.find(r => !isSoft(r));
        const detail = `${a.shiftTypeId} ${a.date} → ${b.shiftTypeId} ${b.date}`;
        if (hard) {
          constrain(terms, -INF, 1, { ruleId: hard.id, ruleName: hard.name, staffId: s.id, date: b.date, detail });
          continue;
        }
        for (const r of broken) constrain(terms, -INF, 1, { ruleId: r.id, ruleName: r.name, staffId: s.id, date: b.date, detail }, softOf(r));
      }
    }

    for (const rule of myRules) {
      const soft = softOf(rule);
      const tag = (date?: ISODate, detail = ''): RowTag => ({ ruleId: rule.id, ruleName: rule.name, staffId: s.id, date, detail });
      switch (rule.type) {
        case 'forbid': {
          // Hard forbids were applied by not creating variables (except fixed / elastic).
          for (const v of myVars) {
            if (v.fixed || !varMatches(v, rule.work) || !matchesDay(rule.days, v.date)) continue;
            if (soft) addCost(soft.tier, v.col, soft.weight);
            else if (opts.elastic) constrain([[v.col, 1]], -INF, 0, tag(v.date, 'forbidden work'));
          }
          break;
        }
        case 'workWith':
          for (const v of myVars) {
            const leads = v.roleId ? idx.roles.get(v.roleId)?.leadIds ?? [] : [];
            if (varMatches(v, rule.work) && leads.some(l => rule.leadIds.includes(l))) addCost(softTier(rule), v.col, -(rule.weight ?? 1));
          }
          break;
        case 'fewLeads': {
          // One indicator per consultant this person could work with; each one used costs the same.
          const byLead = new Map<string, number[]>();
          for (const v of myVars) {
            if (!varMatches(v, rule.work)) continue;
            for (const l of (v.roleId ? idx.roles.get(v.roleId)?.leadIds ?? [] : [])) {
              if (!byLead.has(l)) byLead.set(l, []);
              byLead.get(l)!.push(v.col);
            }
          }
          for (const cols of byLead.values()) {
            const used = addCol(0, 1, false);
            for (const c of cols) rows.push({ idx: [used, c], val: [1, -1], lo: 0, hi: INF });
            addCost(softTier(rule), used, rule.weight ?? 1);
          }
          break;
        }
        case 'preference':
          for (const v of myVars) if (varMatches(v, rule.work) && matchesDay(rule.days, v.date)) {
            addCost(softTier(rule), v.col, (rule.direction === 'more' ? -1 : 1) * (rule.weight ?? 1));
          }
          break;
        case 'linkShifts': {
          const [a, b] = rule.shiftTypeIds;
          for (const d of dates) {
            if (!matchesDay(rule.days, d)) continue;
            if (demandAt(rule.roleId, a, d).max <= 0 || demandAt(rule.roleId, b, d).max <= 0) continue;
            const va = xIndex.get(`${s.id}|${rule.roleId}|${a}|${d}`);
            const vb = xIndex.get(`${s.id}|${rule.roleId}|${b}|${d}`);
            if (!va && !vb) continue;
            const terms: [number, number][] = [];
            if (va) terms.push([va.col, 1]);
            if (vb) terms.push([vb.col, -1]);
            constrain(terms, 0, 0, tag(d, 'linked shifts'), soft);
          }
          break;
        }
        case 'notSameDay': {
          const same = JSON.stringify(rule.a) === JSON.stringify(rule.b);
          for (const d of dates) {
            if (!matchesDay(rule.days, d)) continue;
            const day = myVars.filter(v => v.date === d);
            const A = day.filter(v => varMatches(v, rule.a));
            if (same) {
              if (A.length > 1) constrain(A.map(v => [v.col, 1]), -INF, 1, tag(d), soft);
              continue;
            }
            const B = day.filter(v => varMatches(v, rule.b));
            for (const u of A) for (const w of B) {
              if (u === w) continue;
              constrain([[u.col, 1], [w.col, 1]], -INF, 1, tag(d), soft);
            }
          }
          break;
        }
        case 'count':
          for (const bucket of periodBuckets(rule.period, dates)) {
            const bounds = countBounds(rule, s, bucket.fraction, bucket.dates.length);
            const min = minimumApplies(problem, s, bucket.dates) ? bounds.min : undefined;
            const max = bounds.max;
            const inB = new Set(bucket.dates);
            const terms = myVars
              .filter(v => inB.has(v.date) && matchesDay(rule.days, v.date) && varMatches(v, rule.work))
              .map(v => [v.col, rule.unit === 'hours' ? v.hours : 1] as [number, number]);
            const t = tag(bucket.dates[0], bucket.key);
            if (min !== undefined && min > 0) constrain(terms, min, INF, t, soft);
            if (max !== undefined && terms.length > 0) constrain(terms, -INF, max, t, soft);
          }
          break;
        case 'pairPreference':
          for (const d of dates) {
            if (!matchesDay(rule.days, d)) continue;
            const day = myVars.filter(v => v.date === d);
            const A = day.filter(v => varMatches(v, rule.a));
            const B = day.filter(v => varMatches(v, rule.b));
            if (A.length === 0 || B.length === 0) continue;
            const q = addCol(0, 1, false);
            rows.push({ idx: [q, ...A.map(v => v.col)], val: [1, ...A.map(() => -1)], lo: -INF, hi: 0 });
            rows.push({ idx: [q, ...B.map(v => v.col)], val: [1, ...B.map(() => -1)], lo: -INF, hi: 0 });
            addCost(softTier(rule), q, -(rule.weight ?? 1));
          }
          break;
        case 'minRest':
        case 'skillMix':
          break; // handled above
        case 'minBlock': {
          // Forbid a run of k < minDays days (bounded by days off inside the rota on both sides).
          const w = exactDayIndicators(insts, inst => inst.vars.filter(v => varMatches(v, rule.work)));
          for (let i = 1; i < dates.length; i++) {
            for (let k = 1; k < rule.minDays && i + k < dates.length; k++) {
              const run = dates.slice(i, i + k).map(d => w.get(d));
              if (run.some(c => c === undefined)) continue;
              const terms: [number, number][] = run.map(c => [c!, 1]);
              const before = w.get(dates[i - 1]), after = w.get(dates[i + k]);
              if (before !== undefined) terms.push([before, -1]);
              if (after !== undefined) terms.push([after, -1]);
              constrain(terms, -INF, k - 1, tag(dates[i], `block shorter than ${rule.minDays}`), soft);
            }
          }
          break;
        }
        case 'restAfterRun': {
          const w = dayIndicators(insts, dates, inst => inst.vars.some(v => varMatches(v, rule.work)), inst => inst.vars.filter(v => varMatches(v, rule.work)));
          for (const m of insts) {
            if (!m.vars.some(v => varMatches(v, rule.work))) continue;
            const i = dates.indexOf(m.date);
            if (i < rule.runDays - 1) continue;
            const run = dates.slice(i - rule.runDays + 1, i + 1).map(d => w.get(d));
            if (run.some(c => c === undefined)) continue;
            for (const n of insts) {
              if (n === m || n.start <= m.start || n.start >= m.end + rule.hours * 60) continue;
              constrain([...run.map(c => [c!, 1] as [number, number]), ...occ(n)], -INF, rule.runDays, tag(n.date, `after ${rule.runDays} in a row`), soft);
            }
          }
          break;
        }
        case 'continuity': {
          const u = exactDayIndicators(insts, inst => inst.vars.filter(v => v.roleId === rule.roleId));
          const weight = rule.weight ?? 1;
          for (let i = 0; i + 1 < dates.length; i++) {
            const a = u.get(dates[i]), b = u.get(dates[i + 1]);
            if (a === undefined || b === undefined) continue;
            const q = addCol(0, 1, false);
            rows.push({ idx: [q, a], val: [1, -1], lo: -INF, hi: 0 });
            rows.push({ idx: [q, b], val: [1, -1], lo: -INF, hi: 0 });
            addCost('preference', q, -weight);
          }
          // Not more than runDays in a row at this place (penalised more than continuity is rewarded).
          for (let i = 0; i + rule.runDays < dates.length; i++) {
            const win = dates.slice(i, i + rule.runDays + 1).map(d => u.get(d)).filter((c): c is number => c !== undefined);
            if (win.length > rule.runDays) constrain(win.map(c => [c, 1]), -INF, rule.runDays, tag(dates[i], 'continuity run'), { tier: 'preference', weight: 2 * weight });
          }
          break;
        }
        case 'maxConsecutive': {
          const w = dayIndicators(insts, dates, inst => inst.vars.some(v => varMatches(v, rule.work)), inst => inst.vars.filter(v => varMatches(v, rule.work)));
          for (let i = 0; i + rule.maxDays < dates.length; i++) {
            const win = dates.slice(i, i + rule.maxDays + 1).map(d => w.get(d)).filter((c): c is number => c !== undefined);
            if (win.length > rule.maxDays) constrain(win.map(c => [c, 1]), -INF, rule.maxDays, tag(dates[i + rule.maxDays], 'consecutive days'), soft);
          }
          break;
        }
        case 'restAfterBlock': {
          const matchingOn = (d: ISODate) => insts.filter(i => i.date === d).flatMap(i => i.vars.filter(v => varMatches(v, rule.work)));
          for (const m of insts) {
            const mv = m.vars.filter(v => varMatches(v, rule.work));
            if (mv.length === 0) continue;
            const next = matchingOn(addDays(m.date, 1));
            const nextCols = new Set(next.map(v => v.col));
            for (const n of insts) {
              if (n === m || n.start < m.start || n.start >= m.end + rule.hours * 60) continue;
              const nv = n.vars.filter(v => !nextCols.has(v.col));
              if (nv.length === 0) continue;
              const terms: [number, number][] = [...mv.map(v => [v.col, 1] as [number, number]), ...next.map(v => [v.col, -1] as [number, number]), ...nv.map(v => [v.col, 1] as [number, number])];
              constrain(terms, -INF, 1, tag(n.date, `after block ending ${m.date}`), soft);
            }
          }
          break;
        }
        case 'maxHours': {
          const limit = rule.hours * (rule.scaleByFte ? s.fte : 1);
          const lastStart = Math.max(0, dates.length - rule.windowDays);
          for (let i = 0; i <= lastStart; i++) {
            const win = new Set(dates.slice(i, i + rule.windowDays));
            const terms = myVars.filter(v => win.has(v.date)).map(v => [v.col, v.hours] as [number, number]);
            const total = terms.reduce((t, x) => t + x[1], 0);
            if (total > limit) constrain(terms, -INF, limit, tag(dates[i], `${rule.windowDays}-day window`), soft);
          }
          break;
        }
        case 'weekendFrequency': {
          const sats = weekendsTouched(dates);
          const W = new Map<string, number>();
          for (const inst of insts) {
            const wk = weekendOf(inst.date, idx.shiftTypes.get(inst.shiftTypeId)!);
            if (!wk) continue;
            if (!W.has(wk)) W.set(wk, addCol(0, 1, false));
            rows.push({ idx: [W.get(wk)!, ...inst.vars.map(v => v.col)], val: [1, ...inst.vars.map(() => -1)], lo: 0, hi: INF });
          }
          const windows = sats.length <= rule.inWeekends ? [sats] : sats.slice(0, sats.length - rule.inWeekends + 1).map((_, i) => sats.slice(i, i + rule.inWeekends));
          for (const win of windows) {
            const cols = win.map(w => W.get(w)).filter((c): c is number => c !== undefined);
            if (cols.length > rule.maxWeekends) constrain(cols.map(c => [c, 1]), -INF, rule.maxWeekends, tag(win[0], 'weekends'), soft);
          }
          break;
        }
      }
    }
  }

  /**
   * Day indicators that equal 1 exactly when some matching var is 1 that day
   * (both bounds), for rules that can't be fooled by setting an indicator high.
   */
  function exactDayIndicators(insts: Instance[], vars: (i: Instance) => XVar[]) {
    const byDay = new Map<ISODate, XVar[]>();
    for (const inst of insts) for (const v of vars(inst)) {
      if (!byDay.has(v.date)) byDay.set(v.date, []);
      byDay.get(v.date)!.push(v);
    }
    const w = new Map<ISODate, number>();
    for (const [d, vs] of byDay) {
      const c = addCol(0, 1, false);
      w.set(d, c);
      for (const v of vs) rows.push({ idx: [c, v.col], val: [1, -1], lo: 0, hi: INF });
      rows.push({ idx: [c, ...vs.map(v => v.col)], val: [1, ...vs.map(() => -1)], lo: -INF, hi: 0 });
    }
    return w;
  }

  /** Continuous day-worked indicators: w[d] >= occupancy of each matching shift on day d. */
  function dayIndicators(insts: Instance[], _dates: ISODate[], has: (i: Instance) => boolean, vars: (i: Instance) => XVar[]) {
    const w = new Map<ISODate, number>();
    for (const inst of insts) {
      if (!has(inst)) continue;
      if (!w.has(inst.date)) w.set(inst.date, addCol(0, 1, false));
      const vs = vars(inst);
      rows.push({ idx: [w.get(inst.date)!, ...vs.map(v => v.col)], val: [1, ...vs.map(() => -1)], lo: 0, hi: INF });
    }
    return w;
  }

  // ---- Fairness: share each dimension in proportion to capacity ----
  for (const dim of fairnessDimensions(profile)) {
    const people = profile.staff
      .filter(s => !s.locum && matchesStaff(dim.who, s) && canEverDo(problem, s, dim.work, dim.weekendsOnly))
      .map(s => ({ s, cap: (dim.capacityByStaff?.[s.id] ?? capacity(problem, s)) * shareFactor(dim, s) }))
      .filter(p => p.cap > 1e-6);
    if (people.length < 2) continue;
    const loads = people.map(({ s }) => (instancesByStaff.get(s.id) ?? [])
      .filter(inst => !dim.weekendsOnly || weekendOf(inst.date, idx.shiftTypes.get(inst.shiftTypeId)!))
      .flatMap(inst => inst.vars.filter(v => varMatches(v, dim.work)))
      .map(v => [v.col, dim.unit === 'hours' ? v.hours : 1] as [number, number]));
    // Normalise so dimensions measured in hours and in shifts weigh comparably.
    const expected = estimateDemand(problem, dim) / people.reduce((t, p) => t + p.cap, 0);
    const norm = Math.max(expected, 1e-3);
    const L = addCol(0, INF, false);
    people.forEach(({ s, cap }, i) => {
      const dev = addCol(0, INF, false);
      if (!fairnessCols.has(s.id)) fairnessCols.set(s.id, []);
      fairnessCols.get(s.id)!.push(dev);
      const terms = loads[i];
      // dev >= load - cap*L  and  dev >= cap*L - load
      rows.push({ idx: [dev, ...terms.map(t => t[0]), L], val: [1, ...terms.map(t => -t[1]), cap], lo: 0, hi: INF });
      rows.push({ idx: [dev, ...terms.map(t => t[0]), L], val: [1, ...terms.map(t => t[1]), -cap], lo: 0, hi: INF });
      addCost('fairness', dev, (dim.weight ?? 1) / (cap * norm * people.length));
    });
  }

  const byStaffDate = new Map<string, XVar[]>();
  for (const variable of xvars) {
    const key = `${variable.staffId}|${variable.date}`;
    byStaffDate.set(key, [...(byStaffDate.get(key) ?? []), variable]);
  }
  const extraColumns = new Map<string, number>();
  for (const variable of opts.additionalVariables ?? []) extraColumns.set(variable.id, addCol(variable.lower ?? 0, variable.upper ?? 1, variable.integer ?? true));
  const selected = (term: NonNullable<BuildOptions['additionalRows']>[number]['terms'][number]) => (byStaffDate.get(`${term.staffId}|${term.date}`) ?? []).filter(v =>
    (term.roleId === undefined || v.roleId === term.roleId) &&
    (term.shiftTypeId === undefined || v.shiftTypeId === term.shiftTypeId) &&
    (term.fixed === undefined || v.fixed === term.fixed));
  for (const row of opts.additionalRows ?? []) {
    const terms = row.terms.flatMap(term => term.variableId ? (extraColumns.has(term.variableId) ? [[extraColumns.get(term.variableId)!, term.coefficient ?? 1] as [number, number]] : []) : selected(term).map(v => [v.col, term.coefficient ?? 1] as [number, number]));
    rows.push({ idx: terms.map(t => t[0]), val: terms.map(t => t[1]), lo: row.lower, hi: row.upper, tag: row.tag });
  }
  for (const objective of opts.additionalObjectives ?? []) for (const term of objective.terms) {
    if (term.variableId) { const col = extraColumns.get(term.variableId); if (col !== undefined) addCost(objective.tier, col, term.coefficient); }
    else for (const v of selected(term)) addCost(objective.tier, v.col, term.coefficient);
  }

  return { numCols: colLower.length, colLower, colUpper, integer, rows, objectives, xvars, elasticSlacks, fairnessCols, additionalCols: extraColumns };
}

/** Total minimum demand that a fairness dimension would count, used only to normalise weights. */
function estimateDemand(problem: RotaProblem, dim: { work?: WorkSelector; weekendsOnly?: boolean; unit: 'shifts' | 'hours' }): number {
  const { profile } = problem;
  const idx = indexProfile(profile);
  const demandAt = makeDemandLookup(profile);
  let total = 0;
  for (const date of dateRange(problem.start, problem.end)) for (const role of profile.roles) for (const st of profile.shiftTypes) {
    const { min } = demandAt(role.id, st.id, date);
    if (min <= 0 || !matchesWork(dim.work, role.id, st.id, idx.roles)) continue;
    if (dim.weekendsOnly && !weekendOf(date, st)) continue;
    total += min * (dim.unit === 'hours' ? shiftHours(st) : 1);
  }
  return total;
}
