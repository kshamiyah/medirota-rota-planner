/// <reference lib="webworker" />
// Runs the solver off the main thread so the page stays responsive.
import wasmUrl from 'highs/runtime?url';
import { configureSolver, solve } from '../engine/solve';
import type { RotaProblem } from '../engine/types';
import type { BuildOptions } from '../engine/build';
import { allocateFairerConsultants, type FairerModel } from './fairer';

configureSolver({ wasmUrl });

export type WorkerRequest = { problem: RotaProblem; timeLimit: number; buildOptions?: BuildOptions; fairerStage?: FairerModel; afterTierReserve?: { tier: 'fairness'; fraction: number } };
export type WorkerMessage =
  | { type: 'progress'; tier: string; index: number; total: number; done: boolean; elapsed: number }
  | { type: 'done'; result: Extract<Awaited<ReturnType<typeof solve>>, { ok: true }> }
  | { type: 'infeasible'; conflicts: Extract<Awaited<ReturnType<typeof solve>>, { ok: false }>['conflicts'] }
  | { type: 'error'; message: string };

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const post = (m: WorkerMessage) => self.postMessage(m);
  try {
    const res = await solve(e.data.problem, {
      timeLimit: e.data.timeLimit,
      buildOptions: e.data.buildOptions,
      afterTierReserve: e.data.afterTierReserve,
      onProgress: p => post({ type: 'progress', ...p }),
      afterTier: e.data.fairerStage ? async (tier, assignments, context) => tier === 'fairness'
        ? await allocateFairerConsultants(e.data.fairerStage!, assignments, context.remainingSeconds, context.reportProgress, context.tierObjective)
        : undefined : undefined,
    });
    if (res.ok) post({ type: 'done', result: res });
    else post({ type: 'infeasible', conflicts: res.conflicts });
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
