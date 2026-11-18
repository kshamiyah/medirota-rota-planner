/**
 * Unlimited findSwaps on every Stage 7 fixture must stay deep-equal to the
 * pre-speed-up engine at b053e10 (the only engine diff is skipFairness + scopeStaffIds).
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { findSwaps } from '../src/engine/swaps';
import { planIdentity } from '../src/app/swapsView';
import { stage7Cases, stage7Fixture } from './swaps-stage7-fixture';

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

const expected = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures/swaps-b053e10-digests.json'), 'utf8')) as Record<string, string>;

describe('findSwaps unlimited output vs b053e10-era engine', () => {
  it('keeps plans, order, ruled-out list and flags identical on every Stage 7 fixture', () => {
    const digests: Record<string, string> = {};
    for (const kind of stage7Cases) {
      const { ws, request } = stage7Fixture(kind);
      const result = findSwaps(ws.profile, ws.swapFinder!.snapshot, ws.swapFinder!.settings, request);
      const again = findSwaps(ws.profile, ws.swapFinder!.snapshot, ws.swapFinder!.settings, request);
      expect(again, kind).toEqual(result);
      digests[kind] = digest({
        plans: result.plans.map(planIdentity),
        ruledOut: result.ruledOut.map(item => ({ staffId: item.staffId, group: item.group, reason: item.reason, dates: item.unit.dates })),
        truncated: result.truncated ?? false,
        stoppedEarly: result.stoppedEarly ?? null,
        morePlanSizes: result.morePlanSizes ?? [],
        limits: result.limits ?? [],
        existingShortages: result.existingShortages ?? [],
        clashes: result.clashes ?? [],
      });
    }
    expect(digests).toEqual(expected);
  });
});
