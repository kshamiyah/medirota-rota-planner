/**
 * The original department (from the old Rota app's requirements, caps and hard
 * constraints) expressed purely as profile data. Doctors are anonymised.
 * Weekday AM/PM sessions only, as in the original.
 */
import { dateRange } from '../../src/engine/calendar';
import type { Demand, Profile, RotaProblem, Staff, Unavailability, Weekday } from '../../src/engine/types';

const MON: Weekday = 0, TUE: Weekday = 1, WED: Weekday = 2, THU: Weekday = 3, FRI: Weekday = 4;

function demand(id: string, roleId: string, shiftTypeId: string, weekdays: Weekday[], min: number, max: number): Demand {
  return { id, roleId, shiftTypeId, days: { weekdays }, min, max };
}

export function oldDepartmentProfile(): Profile {
  const staff: Staff[] = [
    ...[1, 2, 3, 4, 5].map(i => ({ id: `og${i}`, name: `O&G trainee ${i}`, groupIds: ['og'], fte: i >= 4 ? 0.6 : 1 })),
    ...[1, 2, 3, 4, 5, 6, 7, 8].map(i => ({ id: `gp${i}`, name: `GP trainee ${i}`, groupIds: ['gp'], fte: 1 })),
    ...[1, 2, 3].map(i => ({ id: `fy${i}`, name: `FY doctor ${i}`, groupIds: ['fy'], fte: 1 })),
  ];
  return {
    name: 'Original department',
    shiftTypes: [
      { id: 'am', name: 'AM', start: '08:00', end: '13:00' },
      { id: 'pm', name: 'PM', start: '13:00', end: '17:00' },
    ],
    roles: [
      { id: 'l4', name: 'Level 4 Wards', category: 'Level 4' },
      { id: 'elcs', name: 'Elective LSCS', category: 'Theatre' },
      { id: 'gth', name: 'Gynae Theatre', category: 'Theatre' },
      { id: 'mau', name: 'MAU (level 3)', category: 'MAU' },
      { id: 'epu', name: 'EPU', category: 'EPU' },
    ],
    groups: [{ id: 'og', name: 'O&G ST1/2' }, { id: 'gp', name: 'GP trainees' }, { id: 'fy', name: 'Foundation' }],
    staff,
    demands: [
      // From ROTA_REQUIREMENTS: AM
      demand('l4am-mon', 'l4', 'am', [MON], 1, 1), demand('l4am', 'l4', 'am', [TUE, WED, THU, FRI], 1, 2),
      demand('elcsam', 'elcs', 'am', [MON, TUE, WED, THU, FRI], 1, 1),
      demand('gtham', 'gth', 'am', [MON, TUE, WED, THU, FRI], 1, 1),
      demand('mauam', 'mau', 'am', [MON, TUE, WED, THU, FRI], 1, 1),
      demand('epuam-mon', 'epu', 'am', [MON], 1, 1), demand('epuam', 'epu', 'am', [TUE, WED, THU, FRI], 1, 2),
      // PM (no theatre Friday PM, no EPU Tue–Thu PM)
      demand('l4pm', 'l4', 'pm', [MON, TUE, WED, THU, FRI], 1, 1),
      demand('elcspm', 'elcs', 'pm', [MON, TUE, WED, THU], 1, 1),
      demand('gthpm', 'gth', 'pm', [MON, TUE, WED, THU], 1, 1),
      demand('maupm', 'mau', 'pm', [MON, TUE, WED, THU, FRI], 1, 2),
      demand('epupm', 'epu', 'pm', [MON, FRI], 1, 2),
    ],
    rules: [
      { id: 'l4full', name: 'Level 4 Wards full day', type: 'linkShifts', hard: true, roleId: 'l4', shiftTypeIds: ['am', 'pm'] },
      { id: 'mauL4', name: 'No MAU + Level 4 same day', type: 'notSameDay', hard: true, a: { roleIds: ['mau'] }, b: { roleIds: ['l4'] } },
      { id: 'oneTheatre', name: 'One theatre list per day', type: 'notSameDay', hard: true, a: { categories: ['Theatre'] }, b: { categories: ['Theatre'] } },
      { id: 'fyThuPm', name: 'Foundation: no Thursday PM theatre', type: 'forbid', hard: true, who: { groupIds: ['fy'] }, work: { categories: ['Theatre'], shiftTypeIds: ['pm'] }, days: { weekdays: [THU] } },
      // Weekly caps from caps.ts (hard limits; the old soft limits become preferences)
      { id: 'gpElcs', name: 'GP: max 1 ELCS a week', type: 'count', hard: true, who: { groupIds: ['gp'] }, work: { roleIds: ['elcs'] }, period: 'week', unit: 'shifts', max: 1 },
      { id: 'gpGth', name: 'GP: max 1 gynae theatre a week', type: 'count', hard: true, who: { groupIds: ['gp'] }, work: { roleIds: ['gth'] }, period: 'week', unit: 'shifts', max: 1 },
      { id: 'fyElcs', name: 'FY: max 1 ELCS a week', type: 'count', hard: true, who: { groupIds: ['fy'] }, work: { roleIds: ['elcs'] }, period: 'week', unit: 'shifts', max: 1 },
      { id: 'fyGth', name: 'FY: max 1 gynae theatre a week', type: 'count', hard: true, who: { groupIds: ['fy'] }, work: { roleIds: ['gth'] }, period: 'week', unit: 'shifts', max: 1 },
      { id: 'ogTheatre', name: 'O&G: max 3 of each theatre a week', type: 'count', hard: true, who: { groupIds: ['og'] }, work: { roleIds: ['elcs'] }, period: 'week', unit: 'shifts', max: 3 },
      { id: 'ogGth', name: 'O&G: max 3 gynae theatre a week', type: 'count', hard: true, who: { groupIds: ['og'] }, work: { roleIds: ['gth'] }, period: 'week', unit: 'shifts', max: 3 },
      // Old soft behaviour as preferences
      { id: 'l4Repeat', name: 'Avoid repeat Level 4 days', type: 'count', hard: false, tier: 'preference', work: { roleIds: ['l4'] }, period: 'week', unit: 'shifts', max: 2 },
      { id: 'mauElcs', name: 'Pair MAU with ELCS', type: 'pairPreference', hard: false, a: { roleIds: ['mau'] }, b: { roleIds: ['elcs'] } },
      { id: 'gthEpu', name: 'Pair gynae theatre with EPU', type: 'pairPreference', hard: false, a: { roleIds: ['gth'] }, b: { roleIds: ['epu'] } },
    ],
    fairness: [{ id: 'sessions', name: 'Sessions', unit: 'shifts' }],
  };
}

/** One week with ~60% availability, matching the harness used to audit the old app. */
export function oldDepartmentProblem(seed = 1): RotaProblem {
  const profile = oldDepartmentProfile();
  const dates = dateRange('2026-10-12', '2026-10-16');
  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  const unavailability: Unavailability[] = [];
  for (const d of profile.staff) for (const date of dates) for (const st of ['am', 'pm']) {
    if (rnd() >= 0.6) unavailability.push({ staffId: d.id, date, shiftTypeIds: [st], reason: 'Not available' });
  }
  return { profile, start: dates[0], end: dates[dates.length - 1], unavailability, fixed: [] };
}
