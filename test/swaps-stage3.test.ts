import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import { chainSentences, pastLeaveWarning } from '../src/app/swapsView';
import { findSwaps } from '../src/engine/swaps';
import { replaceWorkspace, getWorkspace, type Workspace } from '../src/app/store';
import { normalisePlanner } from './scripts/generate-planner-baseline';
import {
  assertStage3FixtureHasPlans, buildStage3BrowserWorkspace, buildStage3NightFourWayWorkspace, buildStage3Workspace, getStage3BrowserMeta, STAGE3_MONDAY,
} from './swaps-stage3-fixture';
import { movedShiftSentenceForUi } from './swaps-ui-copy';
import { localISODate } from '../src/app/swapsView';
import { stage2Request } from './swaps-stage2-helpers';

const here = dirname(fileURLToPath(import.meta.url));

function plannerFingerprint(ws: Workspace) {
  return normalisePlanner(ws);
}

describe('Stage 3 swap page (tester)', () => {
  it('fixture produces direct and 3-way plans before browser load', () => {
    const ws = buildStage3Workspace();
    expect(() => assertStage3FixtureHasPlans(ws)).not.toThrow();
  });

  it('findSwaps does not change fixed, unavailability, rota or snapshot', () => {
    const ws = buildStage3Workspace();
    const frozen = structuredClone(ws);

    const request = stage2Request('anise', [STAGE3_MONDAY], { today: '2026-10-01' });
    for (let i = 0; i < 5; i++) {
      findSwaps(ws.profile, ws.swapFinder!.snapshot, ws.swapFinder!.settings, request);
    }
    findSwaps(ws.profile, ws.swapFinder!.snapshot, ws.swapFinder!.settings, {
      ...request,
      leaveDates: [STAGE3_MONDAY, '2026-11-07'],
      includeNormalDays: true,
      excludeStaffIds: ['dale'],
    });

    expect(plannerFingerprint(ws)).toEqual(plannerFingerprint(frozen));
    expect(ws.fixed).toEqual(frozen.fixed);
    expect(ws.unavailability).toEqual(frozen.unavailability);
    expect(ws.rota).toEqual(frozen.rota);
    expect(ws.swapFinder!.snapshot).toEqual(frozen.swapFinder!.snapshot);
    expect(ws.swapFinder!.settings).toEqual(frozen.swapFinder!.settings);
    replaceWorkspace(frozen);
    expect(getWorkspace().fixed).toEqual(frozen.fixed);
  });

  it('chainSentences match findSwaps for direct and 3-way plans in the fixture', () => {
    const ws = buildStage3Workspace();
    const result = findSwaps(
      ws.profile,
      ws.swapFinder!.snapshot,
      ws.swapFinder!.settings,
      stage2Request('anise', [STAGE3_MONDAY], { today: '2026-10-01' }),
    );
    const direct = result.plans.find(p => p.chains.length === 1 && p.chains[0].links.length === 2);
    const three = result.plans.find(p => p.chains.length === 1 && p.chains[0].links.length === 3);
    expect(direct).toBeDefined();
    expect(three).toBeDefined();
    for (const plan of [direct!, three!]) {
      for (const chain of plan.chains) {
        const sentences = chainSentences(chain, ws.profile.staff, 'anise');
        expect(sentences).toHaveLength(chain.links.length);
        for (const link of chain.links) {
          const owner = ws.profile.staff.find(s => s.id === link.staffId)!.name;
          const dateLabel = link.gives.dates[0];
          expect(sentences.some(s => s.includes(owner) || (link.staffId === 'anise' && s.includes('your')))).toBe(true);
          expect(sentences.some(s => s.includes(dateLabel.slice(8, 10)) || s.match(/\d{1,2} \w+/))).toBe(true);
        }
      }
    }
  });

  it('on-screen copy in FindSwaps has no em dashes', () => {
    const src = readFileSync(join(here, '../src/app/pages/FindSwaps.tsx'), 'utf8');
    const swapsView = readFileSync(join(here, '../src/app/swapsView.ts'), 'utf8');
    expect(src.includes('—')).toBe(false);
    expect(swapsView.includes('—')).toBe(false);
  });

  it('names past leave dates in the page warning copy', () => {
    const today = '2026-11-04';
    const warning = pastLeaveWarning([STAGE3_MONDAY, '2026-12-01'], today);
    expect(warning).toMatch(/before today/);
    expect(warning).toMatch(/Mon 2 Nov/);
    expect(warning).not.toContain('Dec');
  });

  it('drops leave dates before today in the engine search', () => {
    const ws = buildStage3Workspace();
    const result = findSwaps(
      ws.profile,
      ws.swapFinder!.snapshot,
      ws.swapFinder!.settings,
      stage2Request('anise', [STAGE3_MONDAY], { today: '2026-11-04' }),
    );
    expect(result.clashes).toHaveLength(0);
    expect(result.plans).toHaveLength(0);
  });

  it('matches chainSentences for a future direct swap shown in the UI copy', () => {
    const ws = buildStage3Workspace();
    const result = findSwaps(
      ws.profile,
      ws.swapFinder!.snapshot,
      ws.swapFinder!.settings,
      stage2Request('anise', ['2026-11-26'], { today: '2026-11-04' }),
    );
    const direct = result.plans.find(p => p.chains.length === 1 && p.chains[0].links.length === 2);
    expect(direct).toBeDefined();
    const sentences = chainSentences(direct!.chains[0], ws.profile.staff, 'anise');
    expect(sentences.some(s => s.includes('Dr Bramble'))).toBe(true);
    expect(sentences.some(s => s.includes('Thu, 26 Nov') || s.includes('26 Nov'))).toBe(true);
  });

  it('matches UI also-takes copy for night direct and 4-way night fixtures', () => {
    const today = localISODate();
    const ws = buildStage3BrowserWorkspace(today);
    const meta = getStage3BrowserMeta(ws, today);
    const nightDirect = findSwaps(
      ws.profile,
      ws.swapFinder!.snapshot,
      ws.swapFinder!.settings,
      stage2Request('anise', [meta.nightBlockStart], { today }),
    );
    const directPlan = nightDirect.plans.find(p => p.movedShifts?.length);
    const alsoTakes = directPlan?.movedShifts?.map(m => movedShiftSentenceForUi(m, ws.profile.staff, 'anise')) ?? [];
    expect(alsoTakes).toHaveLength(1);
    expect(alsoTakes[0]).toMatch(/^You also take Dr Elder's Clinic Beta on Wed, \d+ Dec\.$/);

    const { workspace: nfWs, meta: nfMeta } = buildStage3NightFourWayWorkspace(today);
    const fourWay = findSwaps(
      nfWs.profile,
      nfWs.swapFinder!.snapshot,
      nfWs.swapFinder!.settings,
      stage2Request('anise', [nfMeta.leaveDate], { today }),
    );
    const plan = fourWay.plans[nfMeta.optionIndex];
    expect(plan.movedShifts?.map(m => movedShiftSentenceForUi(m, nfWs.profile.staff, 'anise'))).toEqual(nfMeta.alsoTakeSentences);
  });

  it('ties visible results to the settings fingerprint after the builder fix', () => {
    const src = readFileSync(join(here, '../src/app/pages/FindSwaps.tsx'), 'utf8');
    const view = readFileSync(join(here, '../src/app/swapsView.ts'), 'utf8');
    expect(view.includes('swapSettingsFingerprint')).toBe(true);
    expect(view.includes('swapResultIsCurrent')).toBe(true);
    expect(src.includes('settingsFingerprint')).toBe(true);
    expect(src.includes('resultIsCurrent')).toBe(true);
    expect(src.includes('setResult(undefined)')).toBe(true);
  });

  it('shows no-rules warning when profile has no working-time rules', () => {
    const ws = buildStage3Workspace({ withWorkingTimeRules: false });
    const result = findSwaps(
      ws.profile,
      ws.swapFinder!.snapshot,
      ws.swapFinder!.settings,
      stage2Request('anise', [STAGE3_MONDAY], { today: '2026-10-01' }),
    );
    expect(result.noRulesWarning).toBe(true);
  });
});
