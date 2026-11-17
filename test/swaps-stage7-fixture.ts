/** Synthetic Stage 7 cases. Staffing-only rows reuse an allowed made-up name. */
import type { Workspace } from '../src/app/store';
import { addDays, dateRange } from '../src/engine/calendar';
import type { SnapshotDay, SwapRequest } from '../src/engine/swaps';

export const STAGE7_DATE = '2026-12-07';
export const STAGE7_RETURN = '2026-12-14';
export const STAGE7_NAMES = ['Dr Rowan', 'Dr Ellis', 'Dr Hart', 'Dr Moss', 'Dr Vale', 'Dr Quinn'];
const ids = ['rowan', 'ellis', 'hart', 'moss', 'vale', 'quinn', 'staffing-a', 'staffing-b', 'staffing-c'];
export const stage7Cases = ['sameAt', 'sameAbove', 'sameBelow', 'weekend', 'bankHoliday', 'only', 'excluded', 'regular', 'morning', 'afternoon', 'noSessions', 'training', 'threeWay', 'requesterTraining', 'nightDate', 'mandatoryRest', 'recommendedRest', 'ranking', 'mixed', 'paging'] as const;
export type Stage7Case = typeof stage7Cases[number];
export function stage7Fixture(kind: Stage7Case = 'sameAt') {
  const ws: Workspace = {
    version: 1, staffExtras: {}, period: { start: '2026-11-30', end: addDays('2026-11-30', 167) }, fixed: [], unavailability: [],
    profile: {
      name: 'Made-up department',
      staff: ids.map((id, index) => ({ id, name: STAGE7_NAMES[index] ?? 'Dr Quinn', groupIds: [], fte: 1 })), groups: [],
      shiftTypes: [{ id: 'day', name: 'Day job', start: '08:00', end: '17:30' }, { id: 'long', name: 'Long day', start: '08:00', end: '20:30' }, { id: 'night', name: 'Night', start: '20:00', end: '08:30' }],
      roles: [{ id: 'long', name: 'Long cover' }, { id: 'day', name: 'MAU CT' }, { id: 'night', name: 'Night cover' }], demands: [], fairness: [],
      rules: [{ id: 'rest', name: 'Minimum rest', type: 'minRest', hard: true, hours: 11 }],
    },
    swapFinder: { settings: { weekendDayActivities: [], hoursTolerance: 1, maxChain: 2, bankHolidays: [], minDoctors: [7, 7, 7, 7, 7, 3, 3], minDoctorsBankHoliday: 4, regularDaysOff: {}, excluded: ids.filter(id => id !== 'rowan' && id !== 'ellis').map(staffId => ({ staffId })) }, snapshot: { days: {}, importedAt: {} } },
  };
  const { settings, snapshot } = ws.swapFinder!;
  for (let offset = 0; offset < 168; offset += 7) snapshot.importedAt[addDays(ws.period.start, offset)] = '2026-11-08T12:00:00.000Z';
  for (const id of ids) snapshot.days[id] = Object.fromEntries(dateRange(ws.period.start, ws.period.end).map(date => [date, { status: 'blank' }]));
  const put = (id: string, date: string, status: SnapshotDay['status'], sessions?: SnapshotDay['sessions']) => {
    snapshot.days[id][date] = { status, activity: status === 'longDay' ? 'Long cover' : status === 'dayJob' ? 'MAU CT' : status === 'night' ? 'Night cover' : status === 'training' ? 'Training' : status === 'zero' ? 'Zero Day' : '', sessions: sessions ?? (status === 'longDay' ? ['am', 'pm', 'eve'] : status === 'dayJob' ? ['am', 'pm'] : status === 'night' ? ['night'] : []) };
  };
  const date = kind === 'weekend' ? '2026-12-12' : kind === 'bankHoliday' ? '2026-12-25' : STAGE7_DATE;
  const request: SwapRequest = { staffId: 'rowan', leaveDates: [date], leaveType: 'annual', today: '2026-11-08' };
  const count = kind === 'sameAbove' ? 9 : kind === 'sameBelow' ? 7 : 8;
  ids.slice(0, count).forEach(id => put(id, date, id === 'rowan' ? 'longDay' : 'dayJob'));
  if (kind === 'bankHoliday') settings.bankHolidays = [date];
  if (kind === 'only') { request.askMode = 'only'; request.askStaffIds = ['ellis']; }
  if (kind === 'excluded') settings.excluded.push({ staffId: 'ellis' });
  if (kind === 'regular') settings.regularDaysOff.ellis = [0];
  if (kind === 'morning') put('ellis', date, 'dayJob', ['am']);
  if (kind === 'afternoon') put('ellis', date, 'dayJob', ['pm']);
  if (kind === 'noSessions') delete snapshot.days.ellis[date].sessions;
  if (['training', 'threeWay', 'requesterTraining', 'ranking'].includes(kind)) {
    put('ellis', date, 'training'); put('ellis', STAGE7_RETURN, 'longDay'); put('rowan', STAGE7_RETURN, 'zero');
    settings.minDoctors = settings.minDoctors.map(() => 1);
  }
  if (kind === 'threeWay') {
    settings.maxChain = 3; settings.excluded = settings.excluded.filter(item => item.staffId !== 'hart');
    put('hart', date, 'leave'); put('rowan', STAGE7_RETURN, 'blank'); put('hart', STAGE7_RETURN, 'training');
    put('hart', '2026-12-21', 'longDay'); put('rowan', '2026-12-21', 'zero');
  }
  if (kind === 'requesterTraining') put('rowan', STAGE7_RETURN, 'training');
  if (['nightDate', 'mandatoryRest', 'recommendedRest'].includes(kind)) {
    put('rowan', date, 'night'); put('ellis', date, kind === 'nightDate' ? 'training' : 'zero');
    put('ellis', '2026-12-21', 'night'); put('rowan', '2026-12-21', 'zero');
    if (kind !== 'nightDate') put('ellis', addDays(date, kind === 'mandatoryRest' ? 1 : 2), 'training');
  }
  if (kind === 'ranking') {
    settings.excluded = settings.excluded.filter(item => !['hart', 'moss'].includes(item.staffId));
    put('moss', date, 'zero'); put('moss', STAGE7_RETURN, 'longDay');
  }
  if (kind === 'mixed') {
    put('rowan', addDays(date, 1), 'longDay'); put('ellis', addDays(date, 1), 'zero');
    put('ellis', STAGE7_RETURN, 'longDay'); put('rowan', STAGE7_RETURN, 'zero');
    request.leaveDates.push(addDays(date, 1));
  }
  if (kind === 'paging') {
    settings.maxChain = 3;
    settings.minDoctors = settings.minDoctors.map(() => 5);
    settings.excluded = settings.excluded.filter(item => !['hart', 'moss'].includes(item.staffId));
    put('ellis', date, 'training'); put('moss', date, 'zero');
    // 3-way nearby (leaves Dec 14/21 free). Training directs and Zero Day returns start afterwards.
    put('hart', date, 'leave');
    put('ellis', STAGE7_RETURN, 'longDay'); put('rowan', STAGE7_RETURN, 'blank');
    put('hart', STAGE7_RETURN, 'training');
    put('hart', addDays(STAGE7_RETURN, 7), 'longDay'); put('rowan', addDays(STAGE7_RETURN, 7), 'zero');
    // More than 50 Zero Day directs so the main 50 fill without training.
    for (let i = 0; i < 60; i++) {
      const returned = addDays(STAGE7_RETURN, 14 + i * 2);
      put('moss', returned, 'longDay'); put('rowan', returned, 'zero');
    }
    for (let i = 0; i < 5; i++) {
      const returned = addDays(STAGE7_RETURN, 15 + i * 2);
      put('ellis', returned, 'longDay'); put('rowan', returned, 'zero'); put('moss', returned, 'blank');
    }
  }
  return { ws, request };
}
