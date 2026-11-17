import { describe, expect, it } from 'vitest';
import { findSwaps, type SwapPlan } from '../src/engine/swaps';
import { planNightSignature } from './swaps-night-rest-helpers';
import { enumerateNightBlockPlans } from './swaps-night-brute-helpers';
import { buildSeededNightRota } from './swaps-night-brute-seed';

function nightPlans(result: ReturnType<typeof findSwaps>): SwapPlan[] {
  return result.plans.filter(plan => plan.chains.every(chain => chain.links.every(link => link.gives.kind === 'nightBlock')));
}

function planFromChain(plan: SwapPlan) {
  return {
    chains: plan.chains, movedShifts: plan.movedShifts, alerts: plan.alerts,
    leaveRequests: plan.leaveRequests, toArrange: plan.toArrange,
  };
}

describe('night block brute force (tester)', () => {
  it('matches findSwaps on 50 fixed-seed rotas including moved shifts and all alerts', () => {
    const stats = {
      rotasChecked: 0,
      plansCompared: 0,
      byChainSize: { 2: 0, 3: 0, 4: 0 } as Record<number, number>,
      withMovedShifts: 0,
      withAlerts: 0,
    };
    const mismatches: { seed: number; side: 'engine-only' | 'brute-only'; signature: string }[] = [];

    for (let seed = 0; seed < 50; seed++) {
      const rota = buildSeededNightRota(seed);
      const result = findSwaps(rota.profile, rota.snapshot, rota.settings, rota.request);
      const nightClashes = result.clashes.filter(clash => clash.kind === 'nightBlock');
      if (!nightClashes.length) continue;
      stats.rotasChecked++;
      const enginePlans = nightPlans(result);
      const brute = enumerateNightBlockPlans(rota.profile, rota.snapshot, rota.settings, rota.request, nightClashes);
      const engineSigs = new Set(enginePlans.map(plan => planNightSignature(planFromChain(plan))));
      const bruteSigs = new Set(brute.map(row => row.signature));
      for (const sig of engineSigs) {
        if (!bruteSigs.has(sig)) mismatches.push({ seed, side: 'engine-only', signature: sig });
      }
      for (const sig of bruteSigs) {
        if (!engineSigs.has(sig)) mismatches.push({ seed, side: 'brute-only', signature: sig });
      }
      for (const plan of enginePlans) {
        stats.plansCompared++;
        const size = plan.chains[0]?.links.length ?? 0;
        if (size >= 2 && size <= 4) stats.byChainSize[size]++;
        if (plan.movedShifts?.length) stats.withMovedShifts++;
        if (plan.alerts?.length) stats.withAlerts++;
        const sig = planNightSignature(planFromChain(plan));
        const match = brute.find(row => row.signature === sig);
        if (match && JSON.stringify(match.movedShifts) !== JSON.stringify(plan.movedShifts ?? [])) {
          mismatches.push({ seed, side: 'engine-only', signature: `${sig} moved-shift mismatch` });
        }
      }
    }

    console.log(JSON.stringify({ seedSummary: stats, mismatches }, null, 2));
    expect(mismatches, 'plans present on only one side').toEqual([]);
    expect(stats.plansCompared).toBeGreaterThan(0);
    expect(stats.byChainSize[2]).toBeGreaterThan(0);
    expect(stats.byChainSize[3]).toBeGreaterThan(0);
    expect(stats.byChainSize[4]).toBeGreaterThan(0);
    expect(stats.withMovedShifts).toBeGreaterThan(0);
    expect(stats.withAlerts).toBeGreaterThan(0);
  }, 120_000);
});
