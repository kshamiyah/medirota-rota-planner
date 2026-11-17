/**
 * Lexicographic solve: optimise each tier in priority order, then lock in what
 * was achieved before moving on, so a lower tier can never trade away a higher
 * one (e.g. fairness can never cost a covered shift).
 */
import highsLoader from 'highs';
import { buildModel, type BuildOptions, type BuiltModel, type RowTag } from './build';
import { tierOrder, withEmploymentDates } from './semantics';
import type { Assignment, RotaProblem, Tier } from './types';

type Highs = Awaited<ReturnType<typeof highsLoader>>;
let highsPromise: Promise<Highs> | null = null;
let loaderOptions: Parameters<typeof highsLoader>[0];

/** In a browser, tell the loader where highs.wasm is served (e.g. a Vite `?url` import). */
export function configureSolver(opts: { wasmUrl: string }): void {
  loaderOptions = { locateFile: (file: string) => (file.endsWith('.wasm') ? opts.wasmUrl : file) };
  highsPromise = null;
}

export function loadSolver(): Promise<Highs> {
  highsPromise ??= highsLoader(loaderOptions);
  return highsPromise;
}

export interface StageReport {
  tier: Tier;
  /** 'optimal' / 'timeLimit' for a full solve; 'search' for neighbourhood search. */
  status: string;
  objective: number;
  /**
   * Relative gap to the best possible, as proven by the solver (0 = proven best).
   * NaN for neighbourhood-search tiers, where no useful bound is available.
   */
  gap: number;
  seconds: number;
  /** Neighbourhood search only: rounds tried and rounds that improved the rota. */
  rounds?: number;
  improvements?: number;
}

export interface SolveOptions {
  /** Total time budget in seconds. Default 60. */
  timeLimit?: number;
  /** Stop a proven tier once within this relative gap of the best possible. Default 0.01. */
  gap?: number;
  /** Seed for neighbourhood choice, so a run can be reproduced. Default 1. */
  seed?: number;
  /** Called as each tier starts and finishes, e.g. to show progress. */
  onProgress?: (p: { tier: Tier; index: number; total: number; done: boolean; elapsed: number }) => void;
  /** Optional generic model extensions. Existing callers omit this and keep their current model. */
  buildOptions?: BuildOptions;
  /** Optional incumbent assignment for a constrained follow-up solve. */
  initialAssignments?: Assignment[];
  /** Values for specialised columns associated with initialAssignments. */
  initialVariableValues?: Record<string, number>;
  /** Hard upper bounds on objective tiers, used when a continuation must preserve an earlier result. */
  objectiveCeilings?: Partial<Record<Tier, number>>;
  /** Cap the exact consultants tier to this share of its remaining solve budget. */
  smallConsultantProofShare?: number;
  /** Add a specialised, feasibility-checked allocation after a higher tier is locked. */
  /** Reserve this fraction of the remaining wall-time for an afterTier hook. */
  afterTierReserve?: { tier: Tier; fraction: number };
  afterTier?: (tier: Tier, assignments: Assignment[], context: { remainingSeconds: number; tierObjective?: number; reportProgress: NonNullable<SolveOptions['onProgress']> }) => Promise<{
    assignments?: Assignment[];
    rows?: NonNullable<BuildOptions['additionalRows']>;
    variableValues?: Record<string, number>;
    skipTiers?: Tier[];
    completeAssignments?: Assignment[];
    stages?: StageReport[];
    note?: string;
    debug?: SolveDebug;
  } | undefined>;
}

/** Internal diagnostics for specialised solve hooks; never rendered by the UI. */
export interface SolveDebug {
  consultantRepeatDays?: number;
  consultantFallbackCheck?: string;
  consultantFallbackDetail?: string;
  fairnessObjectiveBefore?: number;
  fairnessObjectiveAfter?: number;
}

export type SolveResult =
  | { ok: true; assignments: Assignment[]; stages: StageReport[]; seconds: number; size: { cols: number; rows: number }; notes?: string[]; debug?: SolveDebug }
  | { ok: false; reason: 'infeasible'; conflicts: Conflict[]; seconds: number };

export interface Conflict {
  ruleId: string;
  ruleName: string;
  /** Places where the rule would have to be broken for any rota to exist. */
  instances: { staffId?: string; date?: string; detail: string; amount: number }[];
}

/**
 * Share of the remaining time each tier may use; unused time flows on to later
 * tiers because shares apply to what's left. Training gets the largest share:
 * it ranks above fairness and some months need ~25s to prove the best result.
 */
const STAGE_SHARE: Record<Tier, number> = { coverage: 0.3, training: 0.4, fairness: 0.2, paired: 0.1, consultants: 0.3, preference: 0.15, extra: 0.05 };

/**
 * Tiers solved as one whole problem, so the result is proven (they solve fast).
 * The others use neighbourhood search: whole-problem solves of fairness spend
 * ~15s on the first step before improving anything, which is too fragile.
 */
const PROVEN_TIERS = new Set<Tier>(['coverage', 'training']);

export async function solve(input: RotaProblem, opts: SolveOptions = {}): Promise<SolveResult> {
  const problem = withEmploymentDates(input);
  const t0 = performance.now();
  const budget = opts.timeLimit ?? 60;
  const gap = opts.gap ?? 0.01;
  const highs = await loadSolver();
  const built = buildModel(problem, opts.buildOptions);
  const model = highs.createModel(toModelData(highs, built));
  const C = highs.constants.modelStatus;
  const tierValue = (tier: Tier, x: Float64Array) => {
    let v = 0;
    for (const [c, w] of built.objectives.get(tier)!) v += w * x[c];
    return v;
  };
  try {
    model.options.set({ output_flag: false, mip_rel_gap: gap });
    for (const [tier, ceiling] of Object.entries(opts.objectiveCeilings ?? {}) as [Tier, number][]) {
      const entries = [...(built.objectives.get(tier) ?? [])];
      if (entries.length) model.addRow(-highs.infinity, ceiling + 1e-6 + Math.abs(ceiling) * 1e-9, {
        indices: new Int32Array(entries.map(entry => entry[0])),
        values: new Float64Array(entries.map(entry => entry[1])),
      });
    }
    const stages: StageReport[] = [];
    const tiers = tierOrder(problem.profile).filter(t => (built.objectives.get(t)?.size ?? 0) > 0);
    const zero = new Float64Array(built.numCols);
    let incumbent: Float64Array | null = null;
    let initialSolution: { indices: Int32Array; values: Float64Array } | undefined;
    if (opts.initialAssignments) {
      const indices: number[] = [], values: number[] = [];
      const byKey = new Map(built.xvars.map(variable => [`${variable.staffId}|${variable.date}|${variable.roleId}|${variable.shiftTypeId}`, variable.col]));
      for (const assignment of opts.initialAssignments) {
        const col = byKey.get(`${assignment.staffId}|${assignment.date}|${assignment.roleId}|${assignment.shiftTypeId}`);
        if (col !== undefined) { indices.push(col); values.push(1); }
      }
      for (const [id, value] of Object.entries(opts.initialVariableValues ?? {})) {
        const col = built.additionalCols.get(id);
        if (col !== undefined && value !== 0) { indices.push(col); values.push(value); }
      }
      initialSolution = { indices: Int32Array.from(indices), values: Float64Array.from(values) };
    }
    const skippedTiers = new Set<Tier>();
    const notes: string[] = [];
    let solveDebug: SolveDebug | undefined;
    let completedAssignments: Assignment[] | undefined;

    for (let k = 0; k < tiers.length; k++) {
      const tier = tiers[k];
      if (skippedTiers.has(tier)) continue;
      const elapsed = (performance.now() - t0) / 1000;
      const remainingShare = tiers.slice(k).reduce((t, x) => t + STAGE_SHARE[x], 0);
      const remaining = Math.max(1, budget - elapsed);
      const reservedForHook = opts.afterTier && opts.afterTierReserve?.tier === tier
        ? Math.min(Math.max(0, opts.afterTierReserve.fraction) * remaining, Math.max(0, remaining - 1))
        : 0;
      const tierBudget = Math.max(1, remaining - reservedForHook);
      const proveSmallConsultants = tier === 'consultants' && built.numCols <= 5000 && built.rows.length <= 10000;
      const limit = proveSmallConsultants
        ? tierBudget * Math.max(0.1, Math.min(1, opts.smallConsultantProofShare ?? 1))
        : Math.max(1, tierBudget * (STAGE_SHARE[tier] / remainingShare));
      opts.onProgress?.({ tier, index: k, total: tiers.length, done: false, elapsed });
      const cost = zero.slice();
      for (const [c, v] of built.objectives.get(tier)!) cost[c] = v;
      model.changeColsCost({ kind: 'range', from: 0, to: built.numCols - 1 }, cost);
      const ts = performance.now();

      if (PROVEN_TIERS.has(tier) || proveSmallConsultants || !incumbent) {
        model.options.set({ time_limit: limit, mip_rel_gap: proveSmallConsultants ? 0 : gap });
        if (incumbent) model.setSolution({ colValue: incumbent });
        else if (initialSolution) model.setSolution(initialSolution);
        model.run();
        const status = model.getModelStatus();
        if (status === C.infeasible || status === C.unboundedOrInfeasible) {
          model.dispose();
          const conflicts = await diagnose(problem, highs);
          return { ok: false, reason: 'infeasible', conflicts, seconds: (performance.now() - t0) / 1000 };
        }
        const sol = model.getSolution();
        if (!hasSolution(highs, model, built.numCols, sol.colValue)) {
          if (!incumbent) throw new Error(`Solver found no rota within ${limit.toFixed(0)}s (status ${statusName(highs, status)})`);
          stages.push({ tier, status: `${statusName(highs, status)} (kept previous)`, objective: tierValue(tier, incumbent), gap: 1, seconds: (performance.now() - ts) / 1000 });
        } else {
          incumbent = Float64Array.from(sol.colValue);
          const g = Number(model.info.get('mip_gap') ?? 0);
          stages.push({ tier, status: statusName(highs, status), objective: tierValue(tier, incumbent), gap: Number.isFinite(g) ? Math.max(0, g) : 1, seconds: (performance.now() - ts) / 1000 });
        }
      } else {
        // Small rotas often solve outright in a few seconds; try that first.
        const quick = Math.min(3, limit * 0.15);
        model.options.set({ time_limit: quick, mip_rel_gap: gap });
        model.setSolution({ colValue: incumbent });
        model.run();
        const sol = model.getSolution();
        if (hasSolution(highs, model, built.numCols, sol.colValue) && tierValue(tier, sol.colValue) <= tierValue(tier, incumbent) + 1e-9) incumbent = Float64Array.from(sol.colValue);
        if (model.getModelStatus() === C.optimal) {
          stages.push({ tier, status: 'optimal', objective: tierValue(tier, incumbent), gap: 0, seconds: (performance.now() - ts) / 1000 });
        } else {
          const r = neighbourhoodSearch(highs, model, built, problem, incumbent, tier, limit - quick, tierValue, opts.seed ?? 1);
          incumbent = r.incumbent;
          stages.push({ tier, status: 'search', objective: tierValue(tier, incumbent), gap: NaN, seconds: (performance.now() - ts) / 1000, rounds: r.rounds, improvements: r.improvements });
        }
      }
      opts.onProgress?.({ tier, index: k, total: tiers.length, done: true, elapsed: (performance.now() - t0) / 1000 });
      if (debugEnabled()) { const s = stages[stages.length - 1]; console.error(`[solve] ${tier} ${s.status} obj=${s.objective} gap=${s.gap} ${s.seconds.toFixed(1)}s rounds=${s.rounds ?? '-'} improved=${s.improvements ?? '-'}`); }

      if (k < tiers.length - 1) {
        // Lock in this tier's result so lower tiers can't trade it away.
        const obj = tierValue(tier, incumbent);
        const entries = [...built.objectives.get(tier)!];
        model.addRow(-highs.infinity, obj + 1e-6 + Math.abs(obj) * 1e-9, {
          indices: new Int32Array(entries.map(e => e[0])),
          values: new Float64Array(entries.map(e => e[1])),
        });
      }
      if (opts.afterTier && incumbent) {
        const ratioAssignments = built.xvars.filter(v => incumbent![v.col] > 0.5)
          .map(v => ({ staffId: v.staffId, date: v.date, shiftTypeId: v.shiftTypeId, roleId: v.roleId, ...(v.fixed ? { fixed: true } : {}) }));
        const continuation = await opts.afterTier(tier, ratioAssignments, {
          remainingSeconds: Math.max(0, budget - (performance.now() - t0) / 1000),
          tierObjective: stages.at(-1)?.tier === tier ? stages.at(-1)?.objective : undefined,
          reportProgress: p => opts.onProgress?.({ ...p, elapsed: (performance.now() - t0) / 1000 }),
        });
        if (continuation) {
          if (continuation.note) notes.push(continuation.note);
          if (continuation.debug) solveDebug = { ...solveDebug, ...continuation.debug };
          if (continuation.stages) stages.push(...continuation.stages);
          for (const skipped of continuation.skipTiers ?? []) skippedTiers.add(skipped);
          if (continuation.completeAssignments) { completedAssignments = continuation.completeAssignments; break; }
          for (const row of continuation.rows ?? []) {
            const terms = row.terms.flatMap(term => term.variableId
              ? (built.additionalCols.has(term.variableId) ? [[built.additionalCols.get(term.variableId)!, term.coefficient ?? 1] as [number, number]] : [])
              : built.xvars.filter(v => (term.staffId === undefined || v.staffId === term.staffId) && (term.date === undefined || v.date === term.date) && (term.roleId === undefined || v.roleId === term.roleId) && (term.shiftTypeId === undefined || v.shiftTypeId === term.shiftTypeId) && (term.fixed === undefined || v.fixed === term.fixed)).map(v => [v.col, term.coefficient ?? 1] as [number, number]));
            model.addRow(row.lower, row.upper, { indices: new Int32Array(terms.map(term => term[0])), values: new Float64Array(terms.map(term => term[1])) });
          }
          if (continuation.assignments) {
            const next: Float64Array = Float64Array.from(incumbent);
            for (const variable of built.xvars) next[variable.col] = 0;
            const xvarByKey = new Map(built.xvars.map(variable => [`${variable.staffId}|${variable.date}|${variable.roleId}|${variable.shiftTypeId}`, variable.col]));
            for (const assignment of continuation.assignments) {
              const col = xvarByKey.get(`${assignment.staffId}|${assignment.date}|${assignment.roleId}|${assignment.shiftTypeId}`);
              if (col !== undefined) next[col] = 1;
            }
            for (const [id, value] of Object.entries(continuation.variableValues ?? {})) {
              const col = built.additionalCols.get(id);
              if (col !== undefined) next[col] = value;
            }
            incumbent = next;
          }
        }
      }
    }
    const final = incumbent!;
    const assignments: Assignment[] = completedAssignments ?? built.xvars
      .filter(v => final[v.col] > 0.5)
      .map(v => ({ staffId: v.staffId, date: v.date, shiftTypeId: v.shiftTypeId, roleId: v.roleId, ...(v.fixed ? { fixed: true } : {}) }));
    return { ok: true, assignments, stages, seconds: (performance.now() - t0) / 1000, size: { cols: built.numCols, rows: built.rows.length }, ...(notes.length ? { notes } : {}), ...(solveDebug ? { debug: solveDebug } : {}) };
  } finally {
    model.dispose();
  }
}

type Model = ReturnType<Highs['createModel']>;

/** Stage logging for Node scripts (ROTA_DEBUG=1); always off in the browser, where `process` doesn't exist. */
function debugEnabled(): boolean {
  const g = globalThis as { process?: { env?: Record<string, string | undefined> } };
  return !!g.process?.env?.ROTA_DEBUG;
}

function hasSolution(highs: Highs, model: Model, numCols: number, colValue: Float64Array | undefined): boolean {
  return !!colValue && colValue.length === numCols && Number(model.info.get('primal_solution_status')) === highs.constants.solutionStatus.feasible;
}

/**
 * Large neighbourhood search: repeatedly free a slice of the rota (some people,
 * or some days), fix everything else to the current rota, and re-solve that
 * slice. Small slices solve in a second or two, so improvements arrive steadily.
 * The current rota is always a valid answer to each slice, so results never get
 * worse and every lock from higher tiers keeps holding.
 */
function neighbourhoodSearch(
  highs: Highs, model: Model, built: BuiltModel, problem: RotaProblem, start: Float64Array, tier: Tier,
  budget: number, tierValue: (t: Tier, x: Float64Array) => number, seed: number,
): { incumbent: Float64Array; rounds: number; improvements: number } {
  const t0 = performance.now();
  const left = () => budget - (performance.now() - t0) / 1000;
  const xCols = Int32Array.from(built.xvars.map(v => v.col));
  const origLo = Float64Array.from(built.xvars.map(v => built.colLower[v.col]));
  const origHi = Float64Array.from(built.xvars.map(v => built.colUpper[v.col]));
  const staffIds = problem.profile.staff.map(s => s.id);
  const dates = [...new Set(built.xvars.map(v => v.date))].sort();
  let rnd = seed >>> 0 || 1;
  const random = () => { rnd = (rnd * 1664525 + 1013904223) >>> 0; return rnd / 2 ** 32; };
  const pick = <T,>(arr: T[], n: number) => {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a.slice(0, Math.max(1, Math.min(arr.length, n)));
  };

  let incumbent = start;
  let best = tierValue(tier, incumbent);
  let rounds = 0, improvements = 0;
  let size = 0.25; // share of people (or days) freed per round; adapts to how hard slices are
  const lo = new Float64Array(xCols.length);
  const hi = new Float64Array(xCols.length);

  let sinceImproved = 0;
  while (left() > 0.3 && sinceImproved < 10) {
    rounds++;
    sinceImproved++;
    // Rotate: a random group of people over the whole period; everyone over a
    // window of days; and (fairness only) the people furthest from a fair share
    // plus some others they can swap work with.
    const kind = tier === 'fairness' ? rounds % 3 : rounds % 2 === 1 ? 1 : 2; // 0 targeted, 1 people, 2 days
    const byPeople = kind !== 2;
    const n = Math.round(staffIds.length * size);
    let chosen: string[];
    if (kind === 0 && tier === 'fairness') {
      const cost = built.objectives.get('fairness')!;
      const worst = staffIds
        .map(id => ({ id, d: (built.fairnessCols.get(id) ?? []).reduce((t, c) => t + (cost.get(c) ?? 0) * incumbent[c], 0) }))
        .sort((a, b) => b.d - a.d)
        .slice(0, Math.max(2, Math.ceil(n / 2)))
        .map(w => w.id);
      chosen = [...new Set([...worst, ...pick(staffIds.filter(id => !worst.includes(id)), n - worst.length)])];
    } else chosen = pick(staffIds, n);
    const people = new Set(byPeople ? chosen : staffIds);
    let window: Set<string>;
    if (byPeople) window = new Set(dates);
    else {
      const len = Math.max(3, Math.round(dates.length * size));
      const from = Math.floor(random() * Math.max(1, dates.length - len + 1));
      window = new Set(dates.slice(from, from + len));
    }
    built.xvars.forEach((v, i) => {
      const free = people.has(v.staffId) && window.has(v.date);
      const cur = Math.round(incumbent[v.col]);
      lo[i] = free ? origLo[i] : cur;
      hi[i] = free ? origHi[i] : cur;
    });
    model.changeColsBounds({ kind: 'set', indices: xCols }, lo, hi);
    const limit = Math.min(2, left());
    model.options.set({ time_limit: limit });
    model.setSolution({ colValue: incumbent });
    const rs = performance.now();
    model.run();
    const took = (performance.now() - rs) / 1000;
    const status = model.getModelStatus();
    const sol = model.getSolution();
    if (hasSolution(highs, model, built.numCols, sol.colValue)) {
      const v = tierValue(tier, sol.colValue);
      if (v < best - 1e-7) { best = v; incumbent = Float64Array.from(sol.colValue); improvements++; sinceImproved = 0; }
    }
    // Slices that solve to optimality quickly can be bigger; slow ones smaller.
    if (status === highs.constants.modelStatus.optimal && took < limit * 0.5) size = Math.min(0.8, size * 1.15);
    else if (status === highs.constants.modelStatus.timeLimit) size = Math.max(0.12, size * 0.8);
  }
  model.changeColsBounds({ kind: 'set', indices: xCols }, origLo, origHi);
  return { incumbent, rounds, improvements };
}

/** Relax every hard rule and find the fewest breaks needed for any rota to exist. */
async function diagnose(problem: RotaProblem, highs: Highs): Promise<Conflict[]> {
  const built = buildModel(problem, { elastic: true });
  const cost = new Array(built.numCols).fill(0);
  for (const c of built.elasticSlacks.keys()) cost[c] = 1;
  const data = toModelData(highs, built, cost);
  const model = highs.createModel(data);
  try {
    model.options.set({ output_flag: false, time_limit: 30, mip_rel_gap: 0 });
    model.run();
    const val = model.getSolution().colValue;
    const byRule = new Map<string, Conflict>();
    for (const [c, tag] of built.elasticSlacks) {
      if (!val || val[c] < 1e-6) continue;
      const k = tag.ruleId;
      if (!byRule.has(k)) byRule.set(k, { ruleId: tag.ruleId, ruleName: tag.ruleName, instances: [] });
      byRule.get(k)!.instances.push({ staffId: tag.staffId, date: tag.date, detail: tag.detail, amount: val[c] });
    }
    return [...byRule.values()];
  } finally {
    model.dispose();
  }
}

function toModelData(highs: Highs, b: BuiltModel, cost?: number[]) {
  const starts = new Int32Array(b.rows.length + 1);
  let nnz = 0;
  b.rows.forEach((r, i) => { nnz += r.idx.length; starts[i + 1] = nnz; });
  const indices = new Int32Array(nnz);
  const values = new Float64Array(nnz);
  let k = 0;
  for (const r of b.rows) for (let j = 0; j < r.idx.length; j++) { indices[k] = r.idx[j]; values[k] = r.val[j]; k++; }
  const inf = (x: number) => (x === Infinity ? highs.infinity : x === -Infinity ? -highs.infinity : x);
  return {
    numCols: b.numCols,
    numRows: b.rows.length,
    colCost: cost ? Float64Array.from(cost) : new Float64Array(b.numCols),
    colLower: new Float64Array(b.colLower.map(inf)),
    colUpper: new Float64Array(b.colUpper.map(inf)),
    rowLower: new Float64Array(b.rows.map(r => inf(r.lo))),
    rowUpper: new Float64Array(b.rows.map(r => inf(r.hi))),
    matrix: { format: 'csr' as const, numRows: b.rows.length, numCols: b.numCols, starts, indices, values },
    integrality: new Int32Array(b.integer.map(i => (i ? 1 : 0))),
  };
}

function statusName(highs: Highs, code: number): string {
  for (const [name, v] of Object.entries(highs.constants.modelStatus)) if (v === code) return name;
  return String(code);
}

export type { RowTag };
