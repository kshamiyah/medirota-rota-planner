/**
 * Independent rota checker. Evaluates a finished rota directly against the
 * profile's definitions, without reusing any solver logic, so it can be used to
 * test the solver and to check manual edits live.
 */
import { addDays, dateRange, indexProfile, matchesDay, matchesStaff, matchesWork, periodBuckets, shiftHours, shiftInterval, weekendOf } from './calendar';
import { activeRules, breaksRest, canEverDo, capacity, withEmploymentDates, countBounds, demandFor, fairnessDimensions, isSoft, minimumApplies, shareFactor } from './semantics';
import type { Assignment, ISODate, RotaProblem, Rule, Staff } from './types';

export interface Violation {
  ruleId: string;
  ruleName: string;
  staffId?: string;
  date?: ISODate;
  message: string;
  details?: MaxHoursViolationDetails;
}

export interface MaxHoursViolationDetails {
  kind: 'maxHours';
  startDate: ISODate;
  endDate: ISODate;
  totalHours: number;
  limitHours: number;
  shifts: { date: ISODate; shiftTypeId: string; roleId?: string; hours: number }[];
}

export interface CoverageGap {
  roleId: string;
  shiftTypeId: string;
  date: ISODate;
  required: number;
  assigned: number;
}

export interface SoftResult {
  ruleId: string;
  ruleName: string;
  staffId: string;
  period?: string;
  /** Amount the rule fell short (min) or was exceeded (max), in its unit. */
  shortfall: number;
  detail: string;
}

export interface FairnessRow {
  dimensionId: string;
  staffId: string;
  load: number;
  capacity: number;
  /** load / capacity */
  rate: number;
  /** Whether this person can do this kind of work at all (only eligible people are compared). */
  eligible: boolean;
}

export interface ValidationReport {
  violations: Violation[];
  gaps: CoverageGap[];
  soft: SoftResult[];
  fairness: FairnessRow[];
}

interface Placed extends Assignment {
  start: number;
  end: number;
  hours: number;
}

export interface ValidateOptions {
  /** Only check rules for these people (used to test "what if" changes quickly). */
  staffIds?: string[];
}

export function validate(input: RotaProblem, assignments: Assignment[], opts: ValidateOptions = {}): ValidationReport {
  const problem = withEmploymentDates(input);
  const { profile } = problem;
  const idx = indexProfile(profile);
  const dates = dateRange(problem.start, problem.end);
  const inHorizon = new Set(dates);
  const violations: Violation[] = [];
  const v = (ruleId: string, ruleName: string, message: string, staffId?: string, date?: ISODate, details?: MaxHoursViolationDetails) =>
    violations.push({ ruleId, ruleName, message, staffId, date, ...(details ? { details } : {}) });

  // Place assignments in time.
  const placed: Placed[] = [];
  for (const a of assignments) {
    const st = idx.shiftTypes.get(a.shiftTypeId);
    if (!idx.staff.has(a.staffId)) { v('data', 'Unknown person', `Unknown person ${a.staffId}`, a.staffId, a.date); continue; }
    if (!st) { v('data', 'Unknown shift', `Unknown shift type ${a.shiftTypeId}`, a.staffId, a.date); continue; }
    if (a.roleId !== undefined && !idx.roles.has(a.roleId)) { v('data', 'Unknown role', `Unknown role ${a.roleId}`, a.staffId, a.date); continue; }
    if (!inHorizon.has(a.date)) { v('data', 'Outside dates', `Shift on ${a.date} is outside the rota dates`, a.staffId, a.date); continue; }
    const { start, end } = shiftInterval(a.date, st);
    placed.push({ ...a, start, end, hours: shiftHours(st) });
  }
  const byStaff = new Map<string, Placed[]>();
  for (const p of placed) {
    if (!byStaff.has(p.staffId)) byStaff.set(p.staffId, []);
    byStaff.get(p.staffId)!.push(p);
  }
  for (const list of byStaff.values()) list.sort((a, b) => a.start - b.start);

  const roleName = (id?: string) => (id ? idx.roles.get(id)?.name ?? id : 'outside commitment');
  const shiftName = (id: string) => idx.shiftTypes.get(id)?.name ?? id;
  const isFixed = (a: Assignment) => problem.fixed.some(f => f.staffId === a.staffId && f.date === a.date && f.shiftTypeId === a.shiftTypeId && f.roleId === a.roleId);

  // Fixed assignments must be present.
  for (const f of problem.fixed) {
    if (!placed.some(p => p.staffId === f.staffId && p.date === f.date && p.shiftTypeId === f.shiftTypeId && p.roleId === f.roleId)) {
      v('fixed', 'Pre-booked shift', `Pre-booked shift missing`, f.staffId, f.date);
    }
  }

  // Availability.
  for (const p of placed) {
    if (isFixed(p)) continue;
    const off = problem.unavailability.find(u => u.staffId === p.staffId && u.date === p.date && (!u.shiftTypeIds || u.shiftTypeIds.includes(p.shiftTypeId)));
    if (off) v('availability', 'Availability', `Booked while unavailable${off.reason ? ` (${off.reason})` : ''}`, p.staffId, p.date);
  }

  // One thing at a time: no overlapping shifts.
  for (const [staffId, list] of byStaff) {
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length && list[j].start < list[i].end; j++) {
      v('overlap', 'Overlapping shifts', `Two shifts at once (${shiftName(list[i].shiftTypeId)} and ${shiftName(list[j].shiftTypeId)})`, staffId, list[j].date);
    }
  }

  // Demand: never above max, never on a shift that has no demand.
  const coverCount = new Map<string, number>();
  for (const p of placed) if (p.roleId !== undefined) {
    const k = `${p.roleId}|${p.shiftTypeId}|${p.date}`;
    coverCount.set(k, (coverCount.get(k) ?? 0) + 1);
  }
  for (const [k, n] of coverCount) {
    const [roleId, shiftTypeId, date] = k.split('|');
    const { max } = demandFor(profile, roleId, shiftTypeId, date);
    const fixedHere = problem.fixed.filter(f => f.roleId === roleId && f.shiftTypeId === shiftTypeId && f.date === date).length;
    if (n > Math.max(max, fixedHere)) v('demand', 'Staffing maximum', `${n} people on ${roleName(roleId)} ${shiftName(shiftTypeId)} (max ${max})`, undefined, date);
  }
  const gaps: CoverageGap[] = [];
  for (const date of dates) for (const role of profile.roles) for (const st of profile.shiftTypes) {
    const { min } = demandFor(profile, role.id, st.id, date);
    if (min <= 0) continue;
    const n = coverCount.get(`${role.id}|${st.id}|${date}`) ?? 0;
    if (n < min) gaps.push({ roleId: role.id, shiftTypeId: st.id, date, required: min, assigned: n });
  }

  // Rules.
  const soft: SoftResult[] = [];
  const work = (p: Placed, sel: Parameters<typeof matchesWork>[0]) => matchesWork(sel, p.roleId, p.shiftTypeId, idx.roles);
  for (const rule of activeRules(profile)) {
    if (rule.type === 'skillMix') {
      // A whole-team check, so skipped when only checking particular people.
      if (!opts.staffIds) checkSkillMix(rule);
      continue;
    }
    const people = profile.staff.filter(s => matchesStaff(rule.who, s) && (!opts.staffIds || opts.staffIds.includes(s.id)));
    for (const s of people) {
      const list = byStaff.get(s.id) ?? [];
      checkRule(rule, s, list);
    }
  }

  function report(rule: Rule, staffId: string, date: ISODate | undefined, message: string, amount = 1, period?: string, details?: MaxHoursViolationDetails) {
    if (isSoft(rule)) soft.push({ ruleId: rule.id, ruleName: rule.name, staffId, period, shortfall: amount, detail: message });
    else v(rule.id, rule.name, message, staffId, date, details);
  }

  function checkSkillMix(rule: Extract<Rule, { type: 'skillMix' }>) {
    for (const d of dates) {
      if (!matchesDay(rule.days, d)) continue;
      const staffed = profile.roles.some(role => profile.shiftTypes.some(st => demandFor(profile, role.id, st.id, d).max > 0 && matchesWork(rule.work, role.id, st.id, idx.roles)));
      if (!staffed) continue;
      const n = placed.filter(p => p.date === d && work(p, rule.work) && matchesStaff(rule.who, idx.staff.get(p.staffId)!)).length;
      if (n < rule.min) {
        const msg = `Only ${n} of the required ${rule.min}`;
        if (isSoft(rule)) soft.push({ ruleId: rule.id, ruleName: rule.name, staffId: '', period: d, shortfall: rule.min - n, detail: msg });
        else v(rule.id, rule.name, msg, undefined, d);
      }
    }
  }

  function checkRule(rule: Rule, s: Staff, list: Placed[]) {
    switch (rule.type) {
      case 'skillMix':
      case 'continuity':
        return; // skill mix is checked for the whole team; continuity is a preference only
      case 'minBlock': {
        const worked = new Set(list.filter(p => work(p, rule.work)).map(p => p.date));
        let i = 0;
        while (i < dates.length) {
          if (!worked.has(dates[i])) { i++; continue; }
          let j = i;
          while (j + 1 < dates.length && worked.has(dates[j + 1])) j++;
          const len = j - i + 1;
          // Runs touching the start or end of the rota may continue outside it.
          if (i > 0 && j < dates.length - 1 && len < rule.minDays) report(rule, s.id, dates[i], `A block of ${len} (needs at least ${rule.minDays})`);
          i = j + 1;
        }
        return;
      }
      case 'restAfterRun': {
        const matching = list.filter(p => work(p, rule.work));
        const worked = new Set(matching.map(p => p.date));
        for (const m of matching) {
          const k = dates.indexOf(m.date);
          if (k < rule.runDays - 1) continue;
          if (!dates.slice(k - rule.runDays + 1, k + 1).every(d => worked.has(d))) continue;
          const tooSoon = list.find(n => n !== m && n.start > m.start && n.start < m.end + rule.hours * 60);
          if (tooSoon) report(rule, s.id, tooSoon.date, `Shift ${round((tooSoon.start - m.end) / 60)}h after ${rule.runDays} in a row (needs ${rule.hours}h)`);
        }
        return;
      }
      case 'forbid':
        for (const p of list) if (work(p, rule.work) && matchesDay(rule.days, p.date) && !isFixed(p)) report(rule, s.id, p.date, `Not allowed: ${roleName(p.roleId)} ${shiftName(p.shiftTypeId)}`);
        return;
      case 'linkShifts': {
        const [a, b] = rule.shiftTypeIds;
        for (const d of dates) {
          if (!matchesDay(rule.days, d)) continue;
          if (demandFor(profile, rule.roleId, a, d).max <= 0 || demandFor(profile, rule.roleId, b, d).max <= 0) continue;
          const hasA = list.some(p => p.date === d && p.roleId === rule.roleId && p.shiftTypeId === a);
          const hasB = list.some(p => p.date === d && p.roleId === rule.roleId && p.shiftTypeId === b);
          if (hasA !== hasB) report(rule, s.id, d, `Covers only one half of linked ${roleName(rule.roleId)} shifts`);
        }
        return;
      }
      case 'notSameDay':
        for (const d of dates) {
          if (!matchesDay(rule.days, d)) continue;
          const day = list.filter(p => p.date === d);
          const clash = day.some(u => work(u, rule.a) && day.some(w => w !== u && work(w, rule.b)));
          if (clash) report(rule, s.id, d, `Two incompatible pieces of work on the same day`);
        }
        return;
      case 'count':
        for (const bucket of periodBuckets(rule.period, dates)) {
          const bounds = countBounds(rule, s, bucket.fraction, bucket.dates.length);
          const min = minimumApplies(problem, s, bucket.dates) ? bounds.min : undefined;
          const max = bounds.max;
          const inB = list.filter(p => bucket.dates.includes(p.date) && matchesDay(rule.days, p.date) && work(p, rule.work));
          const total = inB.reduce((t, p) => t + (rule.unit === 'hours' ? p.hours : 1), 0);
          if (min !== undefined && total < min - 1e-6) report(rule, s.id, bucket.dates[0], `${total} ${rule.unit} in ${bucket.key}, needs at least ${round(min)}`, min - total, bucket.key);
          if (max !== undefined && total > max + 1e-6) report(rule, s.id, bucket.dates[0], `${total} ${rule.unit} in ${bucket.key}, max ${round(max)}`, total - max, bucket.key);
        }
        return;
      case 'pairPreference': // reported via stats only
      case 'preference':
        return;
      case 'minRest':
        for (let i = 0; i < list.length; i++) {
          for (let j = i + 1; j < list.length && list[j].start < list[i].end + rule.hours * 60; j++) {
            const gap = (list[j].start - list[i].end) / 60;
            if (breaksRest(rule, gap, (list[j].end - list[i].start) / 60)) {
              report(rule, s.id, list[j].date, `Only ${round(gap)}h rest between shifts (needs ${rule.hours}h)`);
            }
          }
        }
        return;
      case 'maxConsecutive': {
        const worked = new Set(list.filter(p => work(p, rule.work)).map(p => p.date));
        let run = 0;
        for (const d of dates) {
          run = worked.has(d) ? run + 1 : 0;
          if (run === rule.maxDays + 1) report(rule, s.id, d, `More than ${rule.maxDays} days in a row`);
        }
        return;
      }
      case 'restAfterBlock': {
        const matching = list.filter(p => work(p, rule.work));
        for (const m of matching) {
          const continues = matching.some(n => n.date === addDays(m.date, 1));
          if (continues) continue;
          const tooSoon = list.find(n => n !== m && n.start >= m.start && n.start < m.end + rule.hours * 60);
          if (tooSoon) report(rule, s.id, tooSoon.date, `Shift starts ${round((tooSoon.start - m.end) / 60)}h after a block ended (needs ${rule.hours}h)`);
        }
        return;
      }
      case 'maxHours': {
        const limit = rule.hours * (rule.scaleByFte ? s.fte : 1);
        for (let i = 0; i < dates.length; i++) {
          const d = dates[i];
          const endDate = addDays(d, rule.windowDays - 1);
          const window = new Set(dateRange(d, endDate));
          const shifts = list.filter(p => window.has(p.date));
          const total = shifts.reduce((t, p) => t + p.hours, 0);
          if (total > limit + 1e-6) {
            report(rule, s.id, d, `${round(total)}h in ${rule.windowDays} days from ${d} (max ${round(limit)}h)`, 1, undefined, {
              kind: 'maxHours', startDate: d, endDate, totalHours: total, limitHours: limit,
              shifts: shifts.map(({ date, shiftTypeId, roleId, hours }) => ({ date, shiftTypeId, ...(roleId ? { roleId } : {}), hours })),
            });
            i += rule.windowDays - 1; // one report per breach, not one per overlapping window
          }
        }
        return;
      }
      case 'weekendFrequency': {
        const sats = weekendsTouched(dates);
        const worked = new Set<string>();
        for (const p of list) {
          const w = weekendOf(p.date, idx.shiftTypes.get(p.shiftTypeId)!);
          if (w) worked.add(w);
        }
        const windows = sats.length <= rule.inWeekends
          ? [sats]
          : Array.from({ length: sats.length - rule.inWeekends + 1 }, (_, i) => sats.slice(i, i + rule.inWeekends));
        for (const win of windows) {
          const n = win.filter(w => worked.has(w)).length;
          if (n > rule.maxWeekends) report(rule, s.id, win[0], `Works ${n} of ${win.length} weekends from ${win[0]} (max ${rule.maxWeekends})`);
        }
        return;
      }
    }
  }

  // Fairness rows.
  const fairness: FairnessRow[] = [];
  for (const dim of opts.staffIds ? [] : fairnessDimensions(profile)) {
    for (const s of profile.staff.filter(x => matchesStaff(dim.who, x))) {
      const list = (byStaff.get(s.id) ?? []).filter(p => work(p, dim.work) && (!dim.weekendsOnly || weekendOf(p.date, idx.shiftTypes.get(p.shiftTypeId)!)));
      const load = list.reduce((t, p) => t + (dim.unit === 'hours' ? p.hours : 1), 0);
      const cap = capacity(problem, s) * shareFactor(dim, s);
      fairness.push({ dimensionId: dim.id, staffId: s.id, load, capacity: cap, rate: cap > 0 ? load / cap : 0, eligible: !s.locum && canEverDo(problem, s, dim.work, dim.weekendsOnly) });
    }
  }

  return { violations, gaps, soft, fairness };
}

/** Saturdays of every weekend that the horizon touches (including a Friday-night overlap). */
export function weekendsTouched(dates: ISODate[]): ISODate[] {
  const out = new Set<string>();
  for (const d of dates) {
    const wd = new Date(d + 'T00:00:00Z').getUTCDay();
    if (wd === 6) out.add(d);
    else if (wd === 0) out.add(addDays(d, -1));
    else if (wd === 5) out.add(addDays(d, 1));
  }
  return [...out].sort();
}

function round(n: number): string {
  return (Math.round(n * 10) / 10).toString();
}
