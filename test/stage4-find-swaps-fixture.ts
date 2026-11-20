/** Stage 4 sample: made-up people and places only. */
import { addDays, dateRange } from '../src/engine/calendar';
import type { Workspace } from '../src/app/store';
import type { SnapshotDay, SwapRequest } from '../src/engine/swaps';
export const LEAVE = ['2026-12-18', '2026-12-19'];
export function stage4Workspace(noRules = false): Workspace {
  const ids = ['rowan', 'ellis', 'hart', 'moss', 'vale', 'quinn', 'hayes'];
  const ws: Workspace = {
    version: 1, role: 'doctor', me: 'rowan', staffExtras: {}, fixed: [], unavailability: [], period: { start: '2026-12-14', end: '2027-02-07' },
    profile: { name: 'Made-up department', staff: ids.map(id => ({ id, name: `Dr ${id[0].toUpperCase()}${id.slice(1)}`, groupIds: [], fte: 1 })), groups: [], roles: [{ id: 'long', name: 'Willow cover' }, { id: 'day', name: 'Cedar clinic' }, { id: 'night', name: 'Willow nights' }], shiftTypes: [{ id: 'long', name: 'Long day', start: '08:00', end: '20:30' }, { id: 'day', name: 'Day job', start: '08:00', end: '17:30' }, { id: 'night', name: 'Night', start: '20:00', end: '08:30' }], demands: [], fairness: [], rules: noRules ? [] : [{ id: 'rest', name: 'Minimum rest', type: 'minRest', hard: true, hours: 11 }] },
    swapFinder: { settings: { weekendDayActivities: [], hoursTolerance: 4, maxChain: 4, minDoctors: [1, 1, 1, 1, 1, 1, 1], minDoctorsBankHoliday: 1, bankHolidays: [], regularDaysOff: {}, excluded: [], returnPattern: 'consecutive' }, snapshot: { days: {}, importedAt: {}, extrasTagged: true } },
  };
  const snapshot = ws.swapFinder!.snapshot;
  for (let offset = 0; offset < 56; offset += 7) snapshot.importedAt[addDays(ws.period.start, offset)] = '2026-11-20T12:00:00Z';
  for (const id of ids) snapshot.days[id] = Object.fromEntries(dateRange(ws.period.start, ws.period.end).map(date => [date, { status: 'blank' }]));
  const put = (id: string, date: string, status: SnapshotDay['status']) => { snapshot.days[id][date] = { status, activity: status === 'longDay' ? 'Willow cover' : status === 'dayJob' ? 'Cedar clinic' : status === 'night' ? 'Willow nights' : status === 'leave' ? 'Annual leave' : '', sessions: status === 'longDay' ? ['am', 'pm', 'eve'] : status === 'dayJob' ? ['am', 'pm'] : status === 'night' ? ['night'] : [] }; };
  for (const date of LEAVE) {
    put('rowan', date, 'longDay'); put('ellis', date, 'zero'); put('moss', date, 'zero'); put('hayes', date, 'zero'); put('vale', date, 'leave');
  }
  put('hart', LEAVE[0], 'dayJob'); put('hart', LEAVE[1], 'zero');
  put('quinn', LEAVE[0], 'zero'); put('quinn', LEAVE[1], 'leave');
  for (const date of ['2027-01-05', '2027-01-06']) { put('ellis', date, 'longDay'); put('rowan', date, 'zero'); }
  for (const date of ['2026-12-29', '2026-12-30']) { put('moss', date, 'longDay'); put('vale', date, 'zero'); }
  for (const date of ['2027-01-19', '2027-01-20']) { put('vale', date, 'longDay'); put('rowan', date, 'zero'); }
  put('quinn', '2027-01-07', 'longDay'); put('rowan', '2027-01-07', 'zero');
  for (const date of ['2027-01-14', '2027-01-15']) { put('hayes', date, 'longDay'); put('rowan', date, 'leave'); }
  snapshot.unavailability = ['2027-01-14', '2027-01-15'].map(date => ({ staffId: 'rowan', date, kind: 'leave', reason: 'Annual leave' }));
  return ws;
}
export function stage4Request(patch: Partial<SwapRequest> = {}): SwapRequest { return { staffId: 'rowan', leaveDates: [...LEAVE], leaveType: 'annual', today: '2026-11-20', ...patch }; }
