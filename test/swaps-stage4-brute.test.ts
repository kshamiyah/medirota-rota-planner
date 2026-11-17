import { describe, expect, it } from 'vitest';
import { findSwaps } from '../src/engine/swaps';
import {
  applyDefaultLimitRules, buildSeededRandomRota, directSwapSignatures, enumerateDirectSwaps,
  stage2Settings, testerPlanIsValid, type BruteForceStats,
} from './swaps-stage2-helpers';

function bruteSignatureList(brute: BruteForceStats) {
  return [...brute.signatures.entries()]
    .map(([key, alertStaff]) => ({ key, alertStaff }))
    .sort((a, b) => a.key.localeCompare(b.key) || a.alertStaff.join(',').localeCompare(b.alertStaff.join(',')));
}

describe('Stage 4 random direct-swap audit (tester)', () => {
  it('validates every returned plan and matches direct brute force within the page limit on 200 seeds', () => {
    const settings = stage2Settings({ maxChain: 2 });
    let rotasChecked = 0;
    let plansChecked = 0;
    let invalidPlans = 0;
    let bruteMisses = 0;

    for (let seed = 0; seed < 200; seed++) {
      const random = buildSeededRandomRota(seed);
      applyDefaultLimitRules(random.profile);
      const page = findSwaps(random.profile, random.snapshot, settings, random.request);
      if (!page.clashes.length || page.clashes.some(clash => clash.kind === 'nightBlock')) continue;
      rotasChecked++;

      for (const plan of page.plans) {
        plansChecked++;
        const reason = testerPlanIsValid(random.profile, random.snapshot, settings, random.request, plan);
        if (reason) invalidPlans++;
        expect(reason, `seed ${seed} returned invalid plan`).toBeUndefined();
      }

      const brute = enumerateDirectSwaps(random.profile, random.snapshot, settings, random.request, page.clashes);
      const engineDirect = directSwapSignatures(page.plans);
      const bruteList = bruteSignatureList(brute);
      for (const entry of engineDirect) {
        if (!bruteList.some(row => row.key === entry.key)) bruteMisses++;
      }
      expect(bruteList, `seed ${seed} engine direct not in brute`).toEqual(engineDirect);
    }

    expect(rotasChecked).toBeGreaterThan(50);
    expect(plansChecked).toBeGreaterThan(0);
    console.log(JSON.stringify({ rotasChecked, plansChecked, invalidPlans, bruteMisses }, null, 2));
  }, 180_000);
});
