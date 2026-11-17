/**
 * Made-up rota for Stage 3 browser checks. No real colleague names.
 */
import { addDays, formatDate, parseDate, weekday } from '../src/engine/calendar';
import { findSwaps } from '../src/engine/swaps';
import type { ISODate } from '../src/engine/types';
import type { Workspace } from '../src/app/store';
import { localISODate } from '../src/app/swapsView';
import { movedShiftSentenceForUi } from './swaps-ui-copy';
import {
  STAGE2_MONDAY, applyDefaultLimitRules, blankSnapshot, off, setDay, stage2Profile, stage2Request, stage2Settings, work,
} from './swaps-stage2-helpers';

export const STAGE3_MONDAY = STAGE2_MONDAY;
export const STAGE3_SAT = '2026-11-07';

const STAFF = [
  { id: 'anise', name: 'Dr Anise' },
  { id: 'bramble', name: 'Dr Bramble' },
  { id: 'cedar', name: 'Dr Cedar' },
  { id: 'dale', name: 'Dr Dale' },
  { id: 'elder', name: 'Dr Elder' },
] as const;

export function buildStage3Workspace(options: { withWorkingTimeRules?: boolean } = {}): Workspace {
  const withRules = options.withWorkingTimeRules !== false;
  const profile = stage2Profile(
    STAFF.map(s => s.id),
    ['Ward Alpha', 'Clinic Beta', 'Weekend List'],
  );
  for (const person of STAFF) {
    const row = profile.staff.find(s => s.id === person.id)!;
    row.name = person.name;
  }
  if (withRules) applyDefaultLimitRules(profile);

  const snapshot = blankSnapshot(STAFF.map(s => s.id), 8);
  // Direct swap: Anise long Mon; Bramble off Mon with return; Cedar/Dale alternates for ruled-out variety.
  work(snapshot, 'anise', STAGE3_MONDAY, 'longDay', 'Ward Alpha');
  work(snapshot, 'anise', '2026-11-26', 'longDay', 'Ward Alpha');
  off(snapshot, 'bramble', STAGE3_MONDAY);
  off(snapshot, 'bramble', '2026-11-26');
  off(snapshot, 'cedar', STAGE3_MONDAY);
  off(snapshot, 'dale', STAGE3_MONDAY);
  work(snapshot, 'bramble', '2026-11-10', 'longDay', 'Ward Alpha');
  off(snapshot, 'anise', '2026-11-10');
  work(snapshot, 'cedar', '2026-11-12', 'longDay', 'Ward Alpha');
  off(snapshot, 'anise', '2026-11-12');
  work(snapshot, 'dale', '2026-11-14', 'longDay', 'Ward Alpha');
  off(snapshot, 'anise', '2026-11-14');

  // 3-way chain Mon: Anise clash; Bramble → Cedar → Anise returns.
  work(snapshot, 'bramble', '2026-11-11', 'longDay', 'Ward Alpha');
  off(snapshot, 'anise', '2026-11-11');
  work(snapshot, 'cedar', '2026-11-13', 'longDay', 'Ward Alpha');
  off(snapshot, 'anise', '2026-11-13');
  off(snapshot, 'bramble', '2026-11-13');
  off(snapshot, 'cedar', '2026-11-11');

  // 4-way chain Mon: Anise → Bramble → Cedar → Dale → Anise.
  work(snapshot, 'dale', '2026-11-09', 'longDay', 'Ward Alpha');
  off(snapshot, 'anise', '2026-11-09');
  off(snapshot, 'dale', STAGE3_MONDAY);
  off(snapshot, 'dale', '2026-11-11');
  off(snapshot, 'dale', '2026-11-13');

  // Direct night swap with rest-day pass-back (browser item 7; Cedar avoids Bramble pattern noise).
  const nightStart = addDays(STAGE3_MONDAY, 3);
  for (let i = 0; i < 2; i++) work(snapshot, 'anise', addDays(nightStart, i), 'night', 'Ward Alpha');
  const elderNights = addDays(nightStart, 7);
  for (let i = 0; i < 2; i++) {
    work(snapshot, 'elder', addDays(elderNights, i), 'night', 'Ward Alpha');
    off(snapshot, 'anise', addDays(elderNights, i));
    off(snapshot, 'elder', addDays(nightStart, i));
  }
  work(snapshot, 'elder', addDays(nightStart, -1), 'dayJob', 'Clinic Beta');
  off(snapshot, 'anise', addDays(nightStart, -1));
  work(snapshot, 'anise', addDays(elderNights, 2), 'dayJob', 'Clinic Beta');
  off(snapshot, 'elder', addDays(elderNights, 2));

  // Weekend day shift (settings tick list).
  work(snapshot, 'anise', STAGE3_SAT, 'dayJob', 'Weekend List');
  off(snapshot, 'bramble', STAGE3_SAT);
  work(snapshot, 'bramble', addDays(STAGE3_SAT, 7), 'dayJob', 'Weekend List');
  off(snapshot, 'anise', addDays(STAGE3_SAT, 7));

  // Sort-by-hand: part shift on a leave date.
  setDay(snapshot, 'anise', '2026-11-17', 'partShift', 'Clinic Beta', ['am', 'eve']);

  // Request-as-leave: weekday day job without includeNormalDays.
  work(snapshot, 'anise', '2026-11-18', 'dayJob', 'Clinic Beta');

  // Pattern: Bramble usually Wed off (Mon–Fri only in detectPatterns).
  for (let w = 0; w < 6; w++) {
    const weekStart = addDays(STAGE3_MONDAY, w * 7);
    off(snapshot, 'bramble', addDays(weekStart, 2));
    work(snapshot, 'bramble', addDays(weekStart, 1), 'longDay', 'Ward Alpha');
  }

  // Alert path: Dale nights then heavy return.
  for (let i = 1; i <= 4; i++) work(snapshot, 'dale', addDays(STAGE3_MONDAY, i), 'night', 'Ward Alpha');
  work(snapshot, 'dale', '2026-11-07', 'longDay', 'Ward Alpha');
  off(snapshot, 'anise', '2026-11-07');

  const settings = stage2Settings({
    weekendDayActivities: ['Weekend List'],
    maxChain: 4,
    bankHolidays: ['2026-11-09'],
  });

  const fixed = [
    { staffId: 'cedar', date: '2026-11-20', roleId: 'role-Ward Alpha', shiftTypeId: 'long' },
  ];
  const unavailability = [
    { staffId: 'dale', date: '2026-11-21', kind: 'leave' as const, reason: 'Fixture study day' },
  ];
  const rota = {
    assignments: [{ staffId: 'bramble', date: '2026-11-22', shiftTypeId: 'day', roleId: 'role-Clinic Beta' }],
    stages: [],
    seconds: 1,
    createdAt: '2026-11-04T12:00:00.000Z',
  };

  return {
    version: 1,
    profile,
    staffExtras: {},
    period: { start: STAGE3_MONDAY, end: addDays(STAGE3_MONDAY, 6) },
    unavailability,
    fixed,
    rota,
    swapFinder: { settings, snapshot },
  };
}

export function stage3DirectSearch(ws: Workspace) {
  return findSwaps(
    ws.profile,
    ws.swapFinder!.snapshot,
    ws.swapFinder!.settings,
    stage2Request('anise', [STAGE3_MONDAY], { today: '2026-10-01' }),
  );
}

export function stage3ThreeWaySearch(ws: Workspace) {
  return findSwaps(
    ws.profile,
    ws.swapFinder!.snapshot,
    ws.swapFinder!.settings,
    stage2Request('anise', [STAGE3_MONDAY], { today: '2026-10-01' }),
  );
}

/** Sanity check used by tests before browser load. */
export function assertStage3FixtureHasPlans(ws: Workspace): void {
  const direct = stage3DirectSearch(ws);
  if (!direct.plans.some(p => p.chains.length === 1 && p.chains[0].links.length === 2)) {
    throw new Error('Stage 3 fixture: expected a direct swap plan');
  }
  const three = direct.plans.find(p => p.chains[0].links.length === 3);
  if (!three) throw new Error('Stage 3 fixture: expected a 3-way chain plan');
  const four = direct.plans.find(p => p.chains[0].links.length === 4);
  if (!four) throw new Error('Stage 3 fixture: expected a 4-way chain plan');
}

export interface Stage3BrowserMeta {
  today: ISODate;
  clashMonday: ISODate;
  directLongDate: ISODate;
  alertWeekendDate: ISODate;
  nightBlockStart: ISODate;
  pastLeaveSample: ISODate;
  fourWayStaffOrder: string[];
}

function shiftDate(date: ISODate, deltaMs: number): ISODate {
  return formatDate(parseDate(date) + deltaMs);
}

function shiftSnapshotDates(snapshot: NonNullable<Workspace['swapFinder']>['snapshot'], deltaMs: number) {
  const importedAt: typeof snapshot.importedAt = {};
  for (const [week, stamp] of Object.entries(snapshot.importedAt)) importedAt[shiftDate(week as ISODate, deltaMs)] = stamp;
  const days: typeof snapshot.days = {};
  for (const [staffId, byDate] of Object.entries(snapshot.days)) {
    days[staffId] = {};
    for (const [date, day] of Object.entries(byDate)) days[staffId][shiftDate(date as ISODate, deltaMs)] = day;
  }
  return { ...snapshot, importedAt, days };
}

export function shiftWorkspaceDates(ws: Workspace, fromMonday: ISODate, toMonday: ISODate): Workspace {
  const deltaMs = parseDate(toMonday) - parseDate(fromMonday);
  const snapshot = shiftSnapshotDates(ws.swapFinder!.snapshot, deltaMs);
  const settings = {
    ...ws.swapFinder!.settings,
    bankHolidays: ws.swapFinder!.settings.bankHolidays.map(d => shiftDate(d, deltaMs)),
  };
  return {
    ...ws,
    period: { start: shiftDate(ws.period.start, deltaMs), end: shiftDate(ws.period.end, deltaMs) },
    unavailability: ws.unavailability.map(item => ({ ...item, date: shiftDate(item.date, deltaMs) })),
    fixed: ws.fixed.map(item => ({ ...item, date: shiftDate(item.date, deltaMs) })),
    rota: ws.rota ? {
      ...ws.rota,
      stages: ws.rota.stages ?? [],
      seconds: ws.rota.seconds ?? 0,
      createdAt: ws.rota.createdAt ?? '2026-11-04T12:00:00.000Z',
      assignments: ws.rota.assignments.map(item => ({ ...item, date: shiftDate(item.date, deltaMs) })),
    } : undefined,
    swapFinder: { settings, snapshot },
  };
}

export function futureMonday(today: ISODate, minDaysAhead = 21): ISODate {
  let d = addDays(today, minDaysAhead);
  while (weekday(d) !== 0) d = addDays(d, 1);
  return d;
}

export function buildStage3BrowserWorkspace(today: ISODate = localISODate()): Workspace {
  const mon = futureMonday(today);
  return shiftWorkspaceDates(buildStage3Workspace(), STAGE3_MONDAY, mon);
}

export function buildStage3PastLeaveWorkspace(): Workspace {
  return buildStage3Workspace();
}

export function getStage3BrowserMeta(ws: Workspace, today: ISODate = localISODate()): Stage3BrowserMeta {
  const mon = ws.swapFinder!.snapshot.importedAt
    ? (Object.keys(ws.swapFinder!.snapshot.importedAt).sort()[0] as ISODate)
    : futureMonday(today);
  const deltaMs = parseDate(mon) - parseDate(STAGE3_MONDAY);
  const shift = (d: ISODate) => shiftDate(d, deltaMs);
  const four = findSwaps(
    ws.profile,
    ws.swapFinder!.snapshot,
    ws.swapFinder!.settings,
    stage2Request('anise', [mon], { today }),
  );
  const fourWay = four.plans.find(p => p.chains[0]?.links.length === 4);
  let alertWeekendDate = shift(STAGE3_SAT);
  const weeks = Object.keys(ws.swapFinder!.snapshot.importedAt).sort();
  outer: for (const week of weeks) {
    for (let d = 0; d < 56; d++) {
      const candidate = addDays(week as ISODate, d);
      if (candidate < today) continue;
      const probe = findSwaps(
        ws.profile,
        ws.swapFinder!.snapshot,
        ws.swapFinder!.settings,
        stage2Request('anise', [candidate], { today }),
      );
      if (probe.plans.some(plan => plan.alerts?.length)) {
        alertWeekendDate = candidate;
        break outer;
      }
    }
  }
  return {
    today,
    clashMonday: mon,
    directLongDate: shift('2026-11-26'),
    alertWeekendDate,
    nightBlockStart: shift(addDays(STAGE3_MONDAY, 3)),
    pastLeaveSample: STAGE3_MONDAY,
    fourWayStaffOrder: fourWay?.chains[0].links.map(link => link.staffId) ?? [],
  };
}

/** Isolated 72-hour alert plan for browser checks (future dates via shift). */
export function buildStage3AlertWorkspace(today: ISODate = localISODate()): Workspace {
  const mon = futureMonday(today);
  const ids = ['anise', 'bramble'];
  const profile = stage2Profile(ids, ['Ward Alpha']);
  applyDefaultLimitRules(profile);
  profile.staff.find(s => s.id === 'anise')!.name = 'Dr Anise';
  profile.staff.find(s => s.id === 'bramble')!.name = 'Dr Bramble';
  const snapshot = blankSnapshot(ids, 12);
  work(snapshot, 'anise', STAGE3_MONDAY, 'longDay', 'Ward Alpha');
  off(snapshot, 'bramble', STAGE3_MONDAY);
  off(snapshot, 'bramble', '2026-11-26');
  work(snapshot, 'bramble', '2026-11-26', 'longDay', 'Ward Alpha');
  for (let i = 1; i <= 4; i++) work(snapshot, 'bramble', addDays(STAGE3_MONDAY, i), 'night', 'Ward Alpha');
  work(snapshot, 'bramble', '2026-11-07', 'longDay', 'Ward Alpha');
  for (let offset = 0; offset < 6; offset++) work(snapshot, 'bramble', addDays('2026-11-14', offset), 'longDay', 'Ward Alpha');
  work(snapshot, 'bramble', '2026-11-25', 'longDay', 'Ward Alpha');
  off(snapshot, 'anise', '2026-11-07');
  off(snapshot, 'anise', '2026-11-25');
  const ws: Workspace = {
    version: 1,
    profile,
    staffExtras: {},
    period: { start: STAGE3_MONDAY, end: addDays(STAGE3_MONDAY, 6) },
    unavailability: [],
    fixed: [],
    rota: { assignments: [], stages: [], seconds: 1, createdAt: '2026-11-04T12:00:00.000Z' },
    swapFinder: { settings: stage2Settings({ maxChain: 2 }), snapshot },
  };
  const shifted = shiftWorkspaceDates(ws, STAGE3_MONDAY, mon);
  const leave = mon;
  const probe = findSwaps(
    shifted.profile,
    shifted.swapFinder!.snapshot,
    shifted.swapFinder!.settings,
    stage2Request('anise', [leave], { today }),
  );
  if (!probe.plans.some(plan => plan.alerts?.length)) {
    throw new Error('Stage 3 alert fixture: expected a plan with working-time alerts');
  }
  return shifted;
}

export function stage3AlertLeaveDate(ws: Workspace): ISODate {
  return Object.keys(ws.swapFinder!.snapshot.importedAt).sort()[0] as ISODate;
}

export function buildStage3NoRulesWorkspace(today: ISODate = localISODate()): Workspace {
  return shiftWorkspaceDates(buildStage3Workspace({ withWorkingTimeRules: false }), STAGE3_MONDAY, futureMonday(today));
}

export function buildStage3TruncatedWorkspace(today: ISODate = localISODate()): Workspace {
  const mon = futureMonday(today);
  const coverCount = 105;
  const ids = ['anise', ...Array.from({ length: coverCount }, (_, i) => `cover-${i}`)];
  const profile = stage2Profile(ids, ['Ward Alpha']);
  applyDefaultLimitRules(profile);
  profile.staff.find(s => s.id === 'anise')!.name = 'Dr Anise';
  for (let i = 0; i < coverCount; i++) profile.staff.find(s => s.id === `cover-${i}`)!.name = `Dr Cover ${i + 1}`;
  const snapshot = blankSnapshot(ids, 20);
  work(snapshot, 'anise', STAGE3_MONDAY, 'longDay', 'Ward Alpha');
  for (let i = 0; i < coverCount; i++) {
    off(snapshot, `cover-${i}`, STAGE3_MONDAY);
    const ret = addDays(STAGE3_MONDAY, 7 + i);
    work(snapshot, `cover-${i}`, ret, 'longDay', 'Ward Alpha');
    off(snapshot, 'anise', ret);
  }
  const ws: Workspace = {
    version: 1,
    profile,
    staffExtras: {},
    period: { start: STAGE3_MONDAY, end: addDays(STAGE3_MONDAY, 6) },
    unavailability: [],
    fixed: [],
    rota: { assignments: [], stages: [], seconds: 1, createdAt: '2026-11-04T12:00:00.000Z' },
    swapFinder: { settings: stage2Settings({ maxChain: 2 }), snapshot },
  };
  return shiftWorkspaceDates(ws, STAGE3_MONDAY, mon);
}

export function buildStage3SlowWorkspace(today: ISODate = localISODate()): Workspace {
  return buildStage3TruncatedWorkspace(today);
}

export interface Stage3NightFourWayMeta {
  leaveDate: ISODate;
  requesterId: string;
  alsoTakeSentences: string[];
  chainStaff: string[];
  optionIndex: number;
}

/** 4-way night chain with rest pass-back (browser item 3); made-up names only. */
export function buildStage3NightFourWayWorkspace(today: ISODate = localISODate()): { workspace: Workspace; meta: Stage3NightFourWayMeta } {
  const decoys = Array.from({ length: 11 }, (_, index) => `hop-${String(index).padStart(2, '0')}`);
  const ids = ['anise', 'bramble', 'cedar', 'dale', 'elder', ...decoys];
  const profile = stage2Profile(ids, ['Ward Alpha', 'Clinic Beta']);
  applyDefaultLimitRules(profile);
  const names: Record<string, string> = {
    anise: 'Dr Anise', bramble: 'Dr Bramble', cedar: 'Dr Cedar', dale: 'Dr Dale', elder: 'Dr Elder',
  };
  for (const id of ids) profile.staff.find(s => s.id === id)!.name = names[id] ?? `Dr ${id}`;
  const snapshot = blankSnapshot(ids, 14);
  const block = (staffId: string, start: ISODate, len = 2) => {
    for (let i = 0; i < len; i++) work(snapshot, staffId, addDays(start, i), 'night', 'Ward Alpha');
  };
  block('anise', STAGE3_MONDAY);
  block('bramble', '2026-11-13');
  off(snapshot, 'bramble', STAGE3_MONDAY); off(snapshot, 'bramble', addDays(STAGE3_MONDAY, 1));
  off(snapshot, 'anise', '2026-11-13'); off(snapshot, 'anise', '2026-11-14');
  work(snapshot, 'bramble', '2026-11-08', 'night', 'Ward Alpha');
  block('cedar', '2026-11-17');
  block('dale', '2026-11-24');
  block('elder', '2026-12-01');
  off(snapshot, 'cedar', STAGE3_MONDAY); off(snapshot, 'cedar', addDays(STAGE3_MONDAY, 1));
  off(snapshot, 'dale', '2026-11-17'); off(snapshot, 'dale', '2026-11-18');
  off(snapshot, 'elder', '2026-11-24'); off(snapshot, 'elder', '2026-11-25');
  off(snapshot, 'anise', '2026-12-01'); off(snapshot, 'anise', '2026-12-02');
  work(snapshot, 'cedar', '2026-11-09', 'dayJob', 'Clinic Beta'); off(snapshot, 'anise', '2026-11-09');
  work(snapshot, 'dale', '2026-11-16', 'dayJob', 'Clinic Beta'); off(snapshot, 'cedar', '2026-11-16');
  work(snapshot, 'elder', '2026-11-23', 'dayJob', 'Clinic Beta'); off(snapshot, 'dale', '2026-11-23');
  work(snapshot, 'anise', '2026-11-30', 'dayJob', 'Clinic Beta'); off(snapshot, 'elder', '2026-11-30');
  for (const id of decoys) {
    block(id, '2026-11-12');
    off(snapshot, id, '2026-11-24'); off(snapshot, id, '2026-11-25');
    snapshot.days[id]['2026-11-23'] = { status: 'training', activity: 'Teaching' };
  }
  off(snapshot, 'anise', '2026-11-12'); off(snapshot, 'anise', '2026-11-13');
  const base: Workspace = {
    version: 1,
    profile,
    staffExtras: {},
    period: { start: STAGE3_MONDAY, end: addDays(STAGE3_MONDAY, 6) },
    unavailability: [],
    fixed: [],
    rota: { assignments: [], stages: [], seconds: 1, createdAt: '2026-11-04T12:00:00.000Z' },
    swapFinder: { settings: stage2Settings({ maxChain: 4 }), snapshot },
  };
  const mon = futureMonday(today);
  const workspace = shiftWorkspaceDates(base, STAGE3_MONDAY, mon);
  const leaveDate = mon;
  const probe = findSwaps(
    workspace.profile,
    workspace.swapFinder!.snapshot,
    workspace.swapFinder!.settings,
    stage2Request('anise', [leaveDate], { today }),
  );
  const planIndex = probe.plans.findIndex(p =>
    p.chains[0]?.links.length === 4 &&
    p.movedShifts?.some(m => m.fromStaffId === 'anise' || m.toStaffId === 'anise'),
  );
  const plan = probe.plans[planIndex];
  if (!plan?.movedShifts?.length) throw new Error('Stage 3 night 4-way fixture: expected moved shifts including the requester');
  const alsoTakeSentences = plan.movedShifts.map(move => movedShiftSentenceForUi(move, workspace.profile.staff, 'anise'));
  return {
    workspace,
    meta: {
      leaveDate,
      requesterId: 'anise',
      alsoTakeSentences,
      chainStaff: plan.chains[0].links.map(link => link.staffId),
      optionIndex: planIndex,
    },
  };
}
