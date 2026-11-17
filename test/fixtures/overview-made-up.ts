import { addDays, dateRange, weekday } from '../../src/engine/calendar';
import type { Workspace } from '../../src/app/store';
import { emptyWorkspace } from '../../src/app/store';

const names = ['Dr Rowan','Dr Ellis','Dr Hart','Dr Moss','Dr Vale','Dr Quinn','Dr Shaw','Dr Lane','Dr Bell','Dr Reed','Dr Frost','Dr King','Dr Cole','Dr Gray','Dr Wells','Dr Brooks','Dr Hayes','Dr James','Dr Young','Dr Price'];
const activities = ['Elective C-Sections','WC Theatres','Postnatal Wards CT','Antenatal CT','MAU CT','Float CT','Delivery Suite','Gynae Ward CT','Gynae Onc Long Day CT','Nights CT'];

export function overviewFixture(today = '2026-11-10'): Workspace {
  const ws = emptyWorkspace();
  const start = addDays(today, -weekday(today));
  ws.period = { start, end: addDays(start, 55) };
  ws.profile.name = 'Made-up O&G department';
  ws.profile.groups = [{ id: 'fy2', name: 'FY2' }, { id: 'gps', name: 'GPs' }, { id: 'st12', name: 'ST1-2' }];
  ws.profile.shiftTypes = [
    { id: 'day', name: 'Day', start: '08:00', end: '17:00' },
    { id: 'long', name: 'Long day', start: '08:00', end: '20:00' },
    { id: 'night', name: 'Night', start: '20:00', end: '08:00' },
  ];
  ws.profile.roles = activities.map((name, i) => ({ id: `place-${i}`, name, category: i < 6 ? ['Theatre','Theatre','Wards','Wards','MAU','Float'][i] : ['Delivery Suite','Gynae','Gynae onc','Nights'][i - 6] }));
  ws.profile.staff = names.map((name, i) => ({
    id: `doctor-${i}`, name, groupIds: [i < 4 ? 'fy2' : i < 8 ? 'gps' : 'st12'], fte: i === 4 ? 0.6 : 1,
  }));
  ws.profile.staff = ws.profile.staff.map((person, i) => ({ ...person, ...(i === 18 || i === 19 ? { locum: true } : {}), ...(i === 18 ? { regularLocum: true } : {}) }));
  ws.profile.demands = [];
  ws.profile.rules = [];
  ws.swapFinder = { settings: { weekendDayActivities: [], hoursTolerance: 1, maxChain: 4, minDoctors: [7,7,7,7,7,3,3], minDoctorsBankHoliday: 4, bankHolidays: [], regularDaysOff: {}, excluded: [] }, snapshot: { days: {}, importedAt: {} } };
  const { snapshot } = ws.swapFinder;
  snapshot.extrasTagged = true;
  for (const d of dateRange(start, addDays(start, 55)).filter(d => weekday(d) === 0)) snapshot.importedAt[d] = `${d}T12:00:00.000Z`;
  ws.profile.staff.forEach((person, i) => {
    snapshot.days[person.id] = {};
    for (const date of dateRange(start, addDays(start, 55))) {
      const dow = weekday(date); const slot = (i * 3 + dow + Math.floor((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 604800000)) % 10;
      if (dow > 4 && slot > 5) snapshot.days[person.id][date] = { status: 'zero', activity: 'Zero Day', sessions: ['am'] };
      else if (slot === 0) snapshot.days[person.id][date] = { status: 'leave', activity: 'Annual leave' };
      else if (slot === 1) snapshot.days[person.id][date] = { status: 'training', activity: 'Teaching' };
      else { const activity = activities[slot]; snapshot.days[person.id][date] = { status: slot >= 6 ? (slot === 9 ? 'night' : 'longDay') : 'dayJob', activity, sessions: slot >= 6 ? ['am','pm','eve'] : ['am','pm'], ...(i >= 18 ? { extra: true } : {}) }; }
    }
  });
  snapshot.days['doctor-2'][addDays(start, 8)] = { status: 'longDay', activity: 'Delivery Suite', sessions: ['am','pm','eve'], extra: true };
  snapshot.days['doctor-0'][addDays(start, 10)] = { status: 'night', activity: 'Nights CT', sessions: ['night'] };
  snapshot.days['doctor-0'][addDays(start, 11)] = { status: 'night', activity: 'Nights CT', sessions: ['night'], extra: true };
  snapshot.days['doctor-4'][addDays(start, 2)] = { status: 'leave', activity: 'Annual leave' };
  ws.me = 'doctor-0';
  return ws;
}
