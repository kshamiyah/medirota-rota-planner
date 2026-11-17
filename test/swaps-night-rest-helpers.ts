/**
 * Tester-side night rest package rules (from docs/swaps-brief.md + owner addendum).
 * Written independently of src/engine/swaps.ts wording and structure.
 */
import { addDays, weekday } from '../src/engine/calendar';
import type { MovedShift, RotaSnapshot, SnapshotDay, SwapChain, SwapRequest, SwapSettings, SwapUnit } from '../src/engine/swaps';
import type { ISODate } from '../src/engine/types';
import { doctorOffForUnit } from './swaps-stage2-helpers';

export interface RestDayCheck {
  date: ISODate;
  tier: 'mandatory' | 'recommended';
}

export interface RestOutcome {
  moved: MovedShift[];
  reject?: string;
  alerts: { staffId: string; date: ISODate; message: string }[];
}

const PASS_THROUGH: SnapshotDay['status'][] = ['zero', 'blank', 'leave'];
const BLOCKING_IF_MANDATORY: SnapshotDay['status'][] = ['training', 'partShift', 'available', 'notAvailable'];

export function restDaysAroundBlock(
  blockFirst: ISODate,
  blockLast: ISODate,
  nightCount: number,
  settings: SwapSettings,
): RestDayCheck[] {
  const beforeCount = Math.max(1, Math.floor(settings.nightRestDaysBefore ?? 2));
  const afterDefault = nightCount >= 4 ? 3 : 2;
  const afterCount = Math.max(1, Math.floor(settings.nightRestDaysAfter ?? afterDefault));
  const out: RestDayCheck[] = [];
  for (let i = 0; i < beforeCount; i++) {
    out.push({ date: addDays(blockFirst, -(i + 1)), tier: i === 0 ? 'mandatory' : 'recommended' });
  }
  for (let i = 0; i < afterCount; i++) {
    out.push({ date: addDays(blockLast, i + 1), tier: i === 0 ? 'mandatory' : 'recommended' });
  }
  return out;
}

function ownerCanReceiveShift(
  date: ISODate,
  ownerGives: Set<ISODate>,
  ownerReceives: Set<ISODate>,
  ownerOffOnDate: boolean,
): boolean {
  if (ownerReceives.has(date)) return false;
  if (ownerGives.has(date)) return true;
  return ownerOffOnDate;
}

/** Independent rest-package expectation for one night-block link in a cycle. */
export function testerRestPackageForLink(
  blockOwnerId: string,
  receiverId: string,
  block: SwapUnit,
  ownerIncomingDates: ISODate[],
  snapshot: RotaSnapshot,
  settings: SwapSettings,
  ownerOffOnDate: (staffId: string, date: ISODate) => boolean,
  receiverGivesDates: Set<ISODate> = new Set(),
): RestOutcome {
  const outcome: RestOutcome = { moved: [], alerts: [] };
  const ownerGives = new Set(block.dates);
  const ownerReceives = new Set(ownerIncomingDates);
  const checks = restDaysAroundBlock(block.dates[0], block.dates[block.dates.length - 1], block.dates.length, settings);

  for (const check of checks) {
    const day = snapshot.days[receiverId]?.[check.date];
    const status = day?.status ?? 'blank';
    if (PASS_THROUGH.includes(status)) continue;

    if (status === 'night') {
      if (receiverGivesDates.has(check.date)) continue;
      outcome.alerts.push({
        staffId: receiverId,
        date: check.date,
        message: 'The night block runs into existing nights',
      });
      continue;
    }

    if (status === 'dayJob' || status === 'longDay') {
      const kind = status === 'longDay' ? 'longDay' : 'dayJob';
      const canPass = ownerCanReceiveShift(check.date, ownerGives, ownerReceives, ownerOffOnDate(blockOwnerId, check.date));
      if (canPass) {
        outcome.moved.push({
          fromStaffId: receiverId,
          toStaffId: blockOwnerId,
          date: check.date,
          activity: day?.activity ?? '',
          kind,
        });
      } else if (check.tier === 'mandatory') {
        outcome.reject ??= `Mandatory rest day ${check.date} cannot be passed on`;
      } else {
        outcome.alerts.push({
          staffId: receiverId,
          date: check.date,
          message: 'A recommended rest-day shift cannot be passed on',
        });
      }
      continue;
    }

    if (BLOCKING_IF_MANDATORY.includes(status)) {
      if (check.tier === 'mandatory') {
        outcome.reject ??= `Mandatory rest day ${check.date} contains ${status}`;
      } else {
        outcome.alerts.push({
          staffId: receiverId,
          date: check.date,
          message: `The recommended rest day contains ${status}`,
        });
      }
    }
  }
  return outcome;
}

export interface TesterNightPackage {
  moved: MovedShift[];
  alerts: { staffId: string; date: ISODate; message: string }[];
  leaveRequests: { date: ISODate; activity: string }[];
  toArrange: { date: ISODate; activity: string }[];
  rejectReason?: string;
}

function dayTypeForDate(date: ISODate, bankHolidays: ISODate[]): SwapUnit['dayType'] {
  if (bankHolidays.includes(date)) return 'bankHoliday';
  return weekday(date) >= 5 ? 'weekend' : 'weekday';
}

/** Stage 4 night package: night dates plus mandatory/recommended rest (independent of src/engine/swaps.ts). */
function nightPackageForOneChain(
  chain: SwapChain,
  snapshot: RotaSnapshot,
  settings: SwapSettings,
  request: SwapRequest,
  allGives: Map<string, Set<ISODate>>,
  allNightReceives: Map<string, Set<ISODate>>,
): TesterNightPackage {
  const outcome: TesterNightPackage = { moved: [], alerts: [], leaveRequests: [], toArrange: [] };
  if (!chain.links.length || chain.links.some(link => link.gives.kind !== 'nightBlock')) return outcome;
  const bankHolidays = settings.bankHolidays;

  for (let index = 0; index < chain.links.length; index++) {
    const blockOwner = chain.links[index];
    const receiver = chain.links[(index + 1) % chain.links.length];
    const receiverGives = new Set(receiver.gives.dates);
    const ownerGives = allGives.get(blockOwner.staffId) ?? new Set<ISODate>();
    const ownerReceives = allNightReceives.get(blockOwner.staffId) ?? new Set<ISODate>();
    const first = blockOwner.gives.dates[0];
    const last = blockOwner.gives.dates[blockOwner.gives.dates.length - 1];
    const before = Math.max(1, Math.floor(settings.nightRestDaysBefore ?? 2));
    const afterDefault = blockOwner.gives.dates.length >= 4 ? 3 : 2;
    const after = Math.max(1, Math.floor(settings.nightRestDaysAfter ?? afterDefault));
    const daysToCheck: { date: ISODate; mandatory: boolean; nightDate: boolean }[] = [
      ...blockOwner.gives.dates.map(date => ({ date, mandatory: true, nightDate: true })),
      ...Array.from({ length: before }, (_, offset) => ({ date: addDays(first, -(offset + 1)), mandatory: offset === 0, nightDate: false })),
      ...Array.from({ length: after }, (_, offset) => ({ date: addDays(last, offset + 1), mandatory: offset === 0, nightDate: false })),
    ];

    for (const checked of daysToCheck) {
      if (receiverGives.has(checked.date)) continue;
      const day = snapshot.days[receiver.staffId]?.[checked.date];
      const status = day?.status ?? 'blank';
      if (!checked.nightDate && PASS_THROUGH.includes(status)) continue;

      if (checked.nightDate && status !== 'dayJob' && status !== 'longDay') {
        if (status === 'zero') continue;
        if (status === 'blank') {
          const singleNight: SwapUnit = { ...blockOwner.gives, dates: [checked.date] };
          if (doctorOffForUnit(snapshot, settings, receiver.staffId, singleNight, request)) continue;
        }
        outcome.rejectReason ??= `A night date on ${checked.date} contains ${status}.`;
        continue;
      }

      if (!checked.nightDate && status === 'night') {
        outcome.alerts.push({ staffId: receiver.staffId, date: checked.date, message: 'The night block runs into existing nights' });
        continue;
      }

      if (status === 'dayJob' || status === 'longDay') {
        const kind = status;
        const restUnit: SwapUnit = {
          kind: kind === 'longDay' ? 'longDay' : 'dayShift',
          staffId: receiver.staffId,
          activity: day?.activity ?? '',
          dates: [checked.date],
          dayType: dayTypeForDate(checked.date, bankHolidays),
          hours: 0,
        };
        const cantWork = blockOwner.staffId === request.staffId && request.cantWorkDates?.includes(checked.date);
        const ownerFree = !cantWork && !ownerReceives.has(checked.date) &&
          (ownerGives.has(checked.date) || doctorOffForUnit(snapshot, settings, blockOwner.staffId, restUnit, request));
        if (ownerFree) {
          outcome.moved.push({
            fromStaffId: receiver.staffId,
            toStaffId: blockOwner.staffId,
            date: checked.date,
            activity: day?.activity ?? '',
            kind,
          });
          if (blockOwner.staffId === request.staffId && request.leaveDates.includes(checked.date)) {
            const item = { date: checked.date, activity: day?.activity ?? '' };
            if (kind === 'dayJob') outcome.leaveRequests.push(item);
            else outcome.toArrange.push(item);
          }
        } else if (checked.nightDate || checked.mandatory) {
          outcome.rejectReason ??= `${checked.nightDate ? 'A shift on a night date' : 'A mandatory rest-day shift'} on ${checked.date} cannot be passed on.`;
        } else {
          outcome.alerts.push({ staffId: receiver.staffId, date: checked.date, message: 'A recommended rest-day shift cannot be passed on' });
        }
        continue;
      }

      if (BLOCKING_IF_MANDATORY.includes(status)) {
        if (checked.mandatory) outcome.rejectReason ??= `A mandatory rest day on ${checked.date} contains ${status}.`;
        else outcome.alerts.push({ staffId: receiver.staffId, date: checked.date, message: `The recommended rest day contains ${status}` });
      }
    }
  }
  return outcome;
}

export function testerNightPackageForChains(
  chains: SwapChain[],
  snapshot: RotaSnapshot,
  settings: SwapSettings,
  request: SwapRequest,
): TesterNightPackage {
  const combined: TesterNightPackage = { moved: [], alerts: [], leaveRequests: [], toArrange: [] };
  const moved = new Set<string>();
  const alertKeys = new Set<string>();
  const leaveKeys = new Set<string>();
  const arrangeKeys = new Set<string>();
  const allGives = new Map<string, Set<ISODate>>();
  const allNightReceives = new Map<string, Set<ISODate>>();
  for (const chain of chains) {
    for (let index = 0; index < chain.links.length; index++) {
      const link = chain.links[index];
      const gives = allGives.get(link.staffId) ?? new Set<ISODate>();
      for (const date of link.gives.dates) gives.add(date);
      allGives.set(link.staffId, gives);
      if (link.gives.kind === 'nightBlock') {
        const receiver = chain.links[(index + 1) % chain.links.length].staffId;
        const receives = allNightReceives.get(receiver) ?? new Set<ISODate>();
        for (const date of link.gives.dates) receives.add(date);
        allNightReceives.set(receiver, receives);
      }
    }
  }
  for (const chain of chains) {
    const part = nightPackageForOneChain(chain, snapshot, settings, request, allGives, allNightReceives);
    combined.rejectReason ??= part.rejectReason;
    for (const shift of part.moved) {
      const key = `${shift.fromStaffId}|${shift.toStaffId}|${shift.date}|${shift.kind}`;
      if (!moved.has(key)) { moved.add(key); combined.moved.push(shift); }
    }
    for (const alert of part.alerts) {
      const key = `${alert.staffId}|${alert.date}|${alert.message}`;
      if (!alertKeys.has(key)) { alertKeys.add(key); combined.alerts.push(alert); }
    }
    for (const item of part.leaveRequests) {
      const key = `${item.date}|${item.activity}`;
      if (!leaveKeys.has(key)) { leaveKeys.add(key); combined.leaveRequests.push(item); }
    }
    for (const item of part.toArrange) {
      const key = `${item.date}|${item.activity}`;
      if (!arrangeKeys.has(key)) { arrangeKeys.add(key); combined.toArrange.push(item); }
    }
  }
  return combined;
}

export function testerRestPackageForChain(
  chain: SwapChain,
  snapshot: RotaSnapshot,
  settings: SwapSettings,
  request: SwapRequest,
): RestOutcome {
  const pkg = testerNightPackageForChains([chain], snapshot, settings, request);
  return { moved: pkg.moved, reject: pkg.rejectReason, alerts: pkg.alerts };
}

export function planNightChainSignature(plan: { chains: SwapChain[]; movedShifts?: MovedShift[] }): string {
  const chains = plan.chains.map(chain => chain.links.map(l => `${l.staffId}:${l.gives.dates.join('+')}`).join('>')).sort().join('|');
  const moves = (plan.movedShifts ?? []).map(m => `${m.fromStaffId}->${m.toStaffId}@${m.date}`).sort().join(',');
  return `${chains}#${moves}`;
}

export function planNightSignature(plan: {
  chains: SwapChain[];
  movedShifts?: MovedShift[];
  alerts?: { staffId: string; date: ISODate; message: string }[];
  leaveRequests?: { date: ISODate; activity: string }[];
  toArrange?: { date: ISODate; activity: string }[];
}): string {
  const alerts = (plan.alerts ?? []).map(a => `${a.staffId}@${a.date}|${a.message}`).sort().join(',');
  const leave = (plan.leaveRequests ?? []).map(item => `${item.date}|${item.activity}`).sort().join(',');
  const arrange = (plan.toArrange ?? []).map(item => `${item.date}|${item.activity}`).sort().join(',');
  return `${planNightChainSignature(plan)}#${alerts}#L${leave}#A${arrange}`;
}
