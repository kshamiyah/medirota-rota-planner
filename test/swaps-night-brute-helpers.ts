/**
 * Brute enumeration of night-block swap cycles (up to 4 people), independent of findSwaps' search order.
 */
import { weekStart } from '../src/engine/calendar';
import type { ISODate, Profile } from '../src/engine/types';
import type { MovedShift, RotaSnapshot, SwapChain, SwapRequest, SwapSettings, SwapUnit } from '../src/engine/swaps';
import {
  buildTestContext, newRejectingBreachesWithRestMoves, unitKey, unitsCompatible, workingTimeAlerts,
} from './swaps-stage2-helpers';
import { planNightSignature, testerNightPackageForChains } from './swaps-night-rest-helpers';

export interface NightBrutePlan {
  signature: string;
  chain: SwapChain;
  movedShifts: MovedShift[];
  alerts: { staffId: string; date: ISODate; message: string }[];
  leaveRequests: { date: ISODate; activity: string }[];
  toArrange: { date: ISODate; activity: string }[];
}

function futureNightRecords(snapshot: RotaSnapshot, context: NonNullable<ReturnType<typeof buildTestContext>>, request: SwapRequest) {
  const today = request.today;
  const importedWeeks = new Set(Object.keys(snapshot.importedAt));
  const isImported = (date: ISODate) => importedWeeks.has(weekStart(date));
  return [...context.unitRecords.values()].filter(record =>
    record.unit.kind === 'nightBlock' &&
    record.unit.staffId !== request.staffId &&
    record.unit.dates.every(date => date >= today && isImported(date)),
  );
}

/** A doctor never takes a block that shares a date with a block they give in the same chain. */
function chainSharesBlockDate(chain: SwapChain): boolean {
  return chain.links.some((link, index) => {
    const taken = chain.links[(index + chain.links.length - 1) % chain.links.length].gives.dates;
    const gives = new Set(link.gives.dates);
    return taken.some(date => gives.has(date));
  });
}

function bruteValidateChain(
  snapshot: RotaSnapshot,
  context: NonNullable<ReturnType<typeof buildTestContext>>,
  settings: SwapSettings,
  request: SwapRequest,
  chain: SwapChain,
): NightBrutePlan | null {
  if (!chain.links.every(link => link.gives.kind === 'nightBlock')) return null;
  if (chainSharesBlockDate(chain)) return null;
  const pkg = testerNightPackageForChains([chain], snapshot, settings, request);
  if (pkg.rejectReason) return null;
  if (newRejectingBreachesWithRestMoves(context, [chain], pkg.moved).length) return null;
  const alerts = [...pkg.alerts, ...workingTimeAlerts(context, [chain], pkg.moved)];
  const deduped = alerts.filter((alert, index, list) =>
    list.findIndex(item => item.staffId === alert.staffId && item.date === alert.date && item.message === alert.message) === index,
  );
  const pseudo = {
    chains: [chain], movedShifts: pkg.moved, alerts: deduped,
    leaveRequests: pkg.leaveRequests, toArrange: pkg.toArrange,
  };
  return {
    signature: planNightSignature(pseudo), chain, movedShifts: pkg.moved, alerts: deduped,
    leaveRequests: pkg.leaveRequests, toArrange: pkg.toArrange,
  };
}

export function enumerateNightBlockPlans(
  profile: Profile,
  snapshot: RotaSnapshot,
  settings: SwapSettings,
  request: SwapRequest,
  clashes: SwapUnit[],
): NightBrutePlan[] {
  const context = buildTestContext(profile, snapshot, settings, request);
  if (!context) return [];
  const candidates = futureNightRecords(snapshot, context, request).sort((a, b) =>
    a.unit.dates[0].localeCompare(b.unit.dates[0]) || a.unit.staffId.localeCompare(b.unit.staffId),
  );
  const maxPeople = Math.min(4, Math.max(2, settings.maxChain));
  const out = new Map<string, NightBrutePlan>();

  for (const clash of clashes.filter(c => c.kind === 'nightBlock')) {
    const root = context.unitRecords.get(unitKey(clash));
    if (!root) continue;

    for (let people = 2; people <= maxPeople; people++) {
      const keys = new Set<string>();
      const walk = (links: SwapChain['links']) => {
        const lastRecord = context.unitRecords.get(unitKey(links[links.length - 1].gives));
        if (!lastRecord) return;
        if (links.length === people) {
          if (!unitsCompatible(lastRecord, root, settings, request)) return;
          const chain: SwapChain = { links: [...links], payDifferent: false };
          const key = chain.links.map(link => `${link.staffId}:${unitKey(link.gives)}`).join('>');
          if (keys.has(key)) return;
          keys.add(key);
          const validated = bruteValidateChain(snapshot, context, settings, request, chain);
          if (validated) out.set(validated.signature, validated);
          return;
        }
        for (const candidate of candidates) {
          if (candidate.unit.staffId === request.staffId || links.some(link => link.staffId === candidate.unit.staffId)) continue;
          if (!unitsCompatible(lastRecord, candidate, settings, request)) continue;
          walk([...links, { staffId: candidate.unit.staffId, gives: candidate.unit }]);
        }
      };
      walk([{ staffId: request.staffId, gives: root.unit }]);
    }
  }
  return [...out.values()].sort((a, b) => a.signature.localeCompare(b.signature));
}

export function nightEngineSignatures(
  plans: { chains: SwapChain[]; movedShifts?: MovedShift[]; alerts?: { staffId: string; date: ISODate; message: string }[] }[],
): string[] {
  return plans
    .filter(plan => plan.chains.every(chain => chain.links.every(link => link.gives.kind === 'nightBlock')))
    .map(plan => planNightSignature(plan))
    .sort();
}
