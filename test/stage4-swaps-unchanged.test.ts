import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { expect, it } from 'vitest';
import { findSwaps } from '../src/engine/swaps';
import { buildSwapRequest } from '../src/app/swapRequest';
import type { Workspace } from '../src/app/store';
import baseline from './fixtures/stage4-swaps-baseline.json';

const cases = JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/stage4-swaps-inputs.json.gz', import.meta.url))).toString()) as {
  id: keyof typeof baseline.cases; source: string; test: string; args: Parameters<typeof findSwaps>;
}[];
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
it('keeps whole unlimited results identical for every captured synthetic fixture, absent, false and old-style shared requests', () => {
  for (const item of cases) {
    const [profile, snapshot, settings, request] = item.args;
    const ws = { profile, swapFinder: { snapshot, settings } } as Workspace;
    const oldInputs = { ...request, cantWorkDates: request.cantWorkDates ?? [], excludedStaffIds: request.excludeStaffIds ?? [], includeNormalDays: request.includeNormalDays ?? false };
    const built = buildSwapRequest(ws, oldInputs, request.today, 0, request.planLimits);
    delete built.request.deadlineMs;
    for (const variant of [request, { ...request, payBackOnOwnLeave: false }, built.request]) {
      expect(digest(findSwaps(profile, snapshot, settings, variant)), `${item.source}: ${item.test}, ${item.id}`).toBe(baseline.cases[item.id]);
    }
  }
}, 120_000);
