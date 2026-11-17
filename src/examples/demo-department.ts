/**
 * Synthetic stress-test department: 25 doctors, 4 weeks, day sessions plus long
 * days and nights, UK junior doctor contract rules, department rules and
 * training targets. Names are invented. Deterministic for a given seed.
 */
import { addDays, dateRange, weekday } from '../engine/calendar';
import type { FixedAssignment, Profile, RotaProblem, Rule, Staff, Unavailability, Weekday } from '../engine/types';

const WEEKDAYS: Weekday[] = [0, 1, 2, 3, 4];
const WEEKEND: Weekday[] = [5, 6];

export function stressProfile(): Profile {
  const staff: Staff[] = [];
  for (let i = 1; i <= 9; i++) staff.push({ id: `st${i}`, name: `ST Doctor ${i}`, groupIds: ['st'], fte: i === 1 ? 0.6 : i <= 3 ? 0.8 : 1 });
  for (let i = 1; i <= 9; i++) staff.push({ id: `gp${i}`, name: `GP Trainee ${i}`, groupIds: ['gp'], fte: 1 });
  for (let i = 1; i <= 7; i++) staff.push({ id: `fy${i}`, name: `Junior doctor ${i}`, groupIds: ['fy'], fte: 1 });
  staff.filter(s => s.fte < 1).forEach(s => s.groupIds.push('ltft'));

  const rules: Rule[] = [
    // UK junior doctor contract style limits
    { id: 'rest11', name: '11h rest between shifts', type: 'minRest', hard: true, hours: 11 },
    { id: 'max72', name: 'Max 72h in any 7 days', type: 'maxHours', hard: true, hours: 72, windowDays: 7 },
    { id: 'avg48', name: 'Average max 48h/week', type: 'count', hard: true, work: {}, period: 'horizon', unit: 'hours', max: 48, perWeekAverage: true, scaleByFte: true },
    { id: 'nights4', name: 'Max 4 nights in a row', type: 'maxConsecutive', hard: true, work: { shiftTypeIds: ['N'] }, maxDays: 4 },
    { id: 'postNights', name: '46h rest after nights', type: 'restAfterBlock', hard: true, work: { shiftTypeIds: ['N'] }, hours: 46 },
    { id: 'days7', name: 'Max 7 days in a row', type: 'maxConsecutive', hard: true, work: {}, maxDays: 7 },
    { id: 'long4', name: 'Max 4 long days in a row', type: 'maxConsecutive', hard: true, work: { shiftTypeIds: ['LD'] }, maxDays: 4 },
    { id: 'weekends', name: 'Max 1 in 2 weekends', type: 'weekendFrequency', hard: true, maxWeekends: 1, inWeekends: 2 },
    // Department rules
    { id: 'l4full', name: 'Level 4 is a full day', type: 'linkShifts', hard: true, roleId: 'l4', shiftTypeIds: ['AM', 'PM'], days: { weekdays: WEEKDAYS } },
    { id: 'mauL4', name: 'No Assessment Unit and Ward Pod on the same day', type: 'notSameDay', hard: true, a: { roleIds: ['mau'] }, b: { roleIds: ['l4'] } },
    { id: 'oneTheatre', name: 'One theatre list per day', type: 'notSameDay', hard: true, a: { categories: ['Theatre'] }, b: { categories: ['Theatre'] } },
    { id: 'fyThuPm', name: 'Junior doctors: no Theatre List on Thursday afternoon', type: 'forbid', hard: true, who: { groupIds: ['fy'] }, work: { categories: ['Theatre'], shiftTypeIds: ['PM'] }, days: { weekdays: [3] } },
    { id: 'fyNoGynOncall', name: 'Junior doctors: no Ward on-call', type: 'forbid', hard: true, who: { groupIds: ['fy'] }, work: { roleIds: ['gynOncall'] } },
    { id: 'gpElcs', name: 'Doctors: maximum 1 Theatre List 1 shift a week', type: 'count', hard: true, who: { groupIds: ['gp'] }, work: { roleIds: ['elcs'] }, period: 'week', unit: 'shifts', max: 1 },
    { id: 'gpGth', name: 'Doctors: maximum 1 Theatre List 2 shift a week', type: 'count', hard: true, who: { groupIds: ['gp'] }, work: { roleIds: ['gth'] }, period: 'week', unit: 'shifts', max: 1 },
    { id: 'obsNightsSenior', name: 'Overnight shifts: senior doctors only', type: 'forbid', hard: true, who: { groupIds: ['fy'] }, work: { roleIds: ['obsOncall'], shiftTypeIds: ['N'] } },
    // Training needs (soft, training tier)
    { id: 'stGth', name: 'ST: 1 gynae theatre a week', type: 'count', hard: false, tier: 'training', who: { groupIds: ['st'] }, work: { roleIds: ['gth'] }, period: 'week', unit: 'shifts', min: 1, scaleByFte: true },
    { id: 'stElcs', name: 'ST: 1 ELCS a week', type: 'count', hard: false, tier: 'training', who: { groupIds: ['st'] }, work: { roleIds: ['elcs'] }, period: 'week', unit: 'shifts', min: 1, scaleByFte: true },
    { id: 'gpAnc', name: 'GP: 1 antenatal clinic a week', type: 'count', hard: false, tier: 'training', who: { groupIds: ['gp'] }, work: { roleIds: ['anc'] }, period: 'week', unit: 'shifts', min: 1 },
    { id: 'fyAnw', name: 'FY: 1 antenatal ward session a week', type: 'count', hard: false, tier: 'training', who: { groupIds: ['fy'] }, work: { roleIds: ['anw'] }, period: 'week', unit: 'shifts', min: 1 },
    { id: 'st4Elcs', name: 'ST4 needs 4 ELCS this month (OSATS)', type: 'count', hard: false, tier: 'training', weight: 2, who: { staffIds: ['st4'] }, work: { roleIds: ['elcs'] }, period: 'horizon', unit: 'shifts', min: 4 },
    { id: 'fy1Colp', name: 'FY1 needs 2 colposcopy this month', type: 'count', hard: false, tier: 'training', who: { staffIds: ['fy1'] }, work: { roleIds: ['colp'] }, period: 'horizon', unit: 'shifts', min: 2 },
    { id: 'st5Epu', name: 'ST5: more EPU', type: 'preference', hard: false, who: { staffIds: ['st5'] }, work: { roleIds: ['epu'] }, direction: 'more' },
    { id: 'gp2Mau', name: 'Doctor 2: less Assessment Unit (done plenty)', type: 'preference', hard: false, who: { staffIds: ['gp2'] }, work: { roleIds: ['mau'] }, direction: 'less' },
    // Preferences and variety (soft, preference tier)
    { id: 'fyTheatreCap', name: 'FY: at most 1 theatre a week', type: 'count', hard: false, tier: 'preference', who: { groupIds: ['fy'] }, work: { categories: ['Theatre'] }, period: 'week', unit: 'shifts', max: 1 },
    { id: 'st1NoNights', name: 'ST1 (LTFT) prefers no nights', type: 'forbid', hard: false, tier: 'preference', weight: 3, who: { staffIds: ['st1'] }, work: { shiftTypeIds: ['N'] } },
    { id: 'mauVariety', name: 'Max 3 Assessment Unit sessions a week', type: 'count', hard: false, tier: 'preference', work: { roleIds: ['mau'] }, period: 'week', unit: 'shifts', max: 3 },
    { id: 'l4Variety', name: 'Max 2 Level 4 days a week', type: 'count', hard: false, tier: 'preference', work: { roleIds: ['l4'] }, period: 'week', unit: 'shifts', max: 4 },
    { id: 'mauElcs', name: 'Pair Assessment Unit morning with Theatre List 1 afternoon', type: 'pairPreference', hard: false, a: { roleIds: ['mau'], shiftTypeIds: ['AM'] }, b: { roleIds: ['elcs'], shiftTypeIds: ['PM'] } },
    { id: 'gthEpu', name: 'Pair gynae theatre with EPU', type: 'pairPreference', hard: false, a: { roleIds: ['gth'] }, b: { roleIds: ['epu'] } },
    { id: 'gp5NoMon', name: 'GP5 prefers no Mondays', type: 'forbid', hard: false, tier: 'preference', who: { staffIds: ['gp5'] }, work: {}, days: { weekdays: [0] } },
    { id: 'fyLongDays', name: 'FY: at most 2 long days a week', type: 'count', hard: false, tier: 'preference', who: { groupIds: ['fy'] }, work: { shiftTypeIds: ['LD'] }, period: 'week', unit: 'shifts', max: 2 },
    { id: 'oncallSpread', name: 'Max 2 weekday long days a week', type: 'count', hard: false, tier: 'preference', work: { shiftTypeIds: ['LD'] }, days: { weekdays: WEEKDAYS }, period: 'week', unit: 'shifts', max: 2 },
  ];

  return {
    name: 'Example department',
    shiftTypes: [
      { id: 'AM', name: 'AM', start: '08:00', end: '13:00' },
      { id: 'PM', name: 'PM', start: '13:00', end: '17:30' },
      { id: 'LD', name: 'Long day', start: '08:00', end: '20:30' },
      { id: 'N', name: 'Night', start: '20:00', end: '08:30' },
    ],
    roles: [
      { id: 'mau', name: 'Assessment Unit', category: 'Acute' },
      { id: 'epu', name: 'Day Unit', category: 'Acute' },
      { id: 'l4', name: 'Level 4 wards', category: 'Wards' },
      { id: 'anw', name: 'Ward Unit', category: 'Wards' },
      { id: 'gth', name: 'Theatre List 2', category: 'Theatre' },
      { id: 'elcs', name: 'Theatre List 1', category: 'Theatre' },
      { id: 'anc', name: 'Clinic', category: 'Clinic' },
      { id: 'colp', name: 'Day Clinic', category: 'Clinic' },
      { id: 'obsOncall', name: 'Assessment Unit on-call', category: 'On-call' },
      { id: 'gynOncall', name: 'Ward on-call', category: 'On-call' },
    ],
    groups: [
      { id: 'st', name: 'Senior doctors' },
      { id: 'gp', name: 'Doctors' },
      { id: 'fy', name: 'Junior doctors' },
      { id: 'ltft', name: 'Less than full time' },
    ],
    staff,
    demands: [
      { id: 'mauAm', roleId: 'mau', shiftTypeId: 'AM', days: { weekdays: WEEKDAYS }, min: 1, max: 1, importance: 2 },
      { id: 'mauPm', roleId: 'mau', shiftTypeId: 'PM', days: { weekdays: WEEKDAYS }, min: 1, max: 2, importance: 2 },
      { id: 'l4Am', roleId: 'l4', shiftTypeId: 'AM', days: { weekdays: WEEKDAYS }, min: 1, max: 1, importance: 2 },
      { id: 'l4Pm', roleId: 'l4', shiftTypeId: 'PM', days: { weekdays: WEEKDAYS }, min: 1, max: 1, importance: 2 },
      { id: 'anwAm', roleId: 'anw', shiftTypeId: 'AM', days: { weekdays: WEEKDAYS }, min: 1, max: 1 },
      { id: 'anwPm', roleId: 'anw', shiftTypeId: 'PM', days: { weekdays: WEEKDAYS }, min: 1, max: 1 },
      { id: 'gthAm', roleId: 'gth', shiftTypeId: 'AM', days: { weekdays: WEEKDAYS }, min: 1, max: 1 },
      { id: 'gthPm', roleId: 'gth', shiftTypeId: 'PM', days: { weekdays: [0, 1, 2, 3] }, min: 1, max: 1 },
      { id: 'elcsAm', roleId: 'elcs', shiftTypeId: 'AM', days: { weekdays: WEEKDAYS }, min: 1, max: 1 },
      { id: 'elcsPm', roleId: 'elcs', shiftTypeId: 'PM', days: { weekdays: [0, 1, 2, 3] }, min: 1, max: 1 },
      { id: 'epuAm', roleId: 'epu', shiftTypeId: 'AM', days: { weekdays: WEEKDAYS }, min: 1, max: 2 },
      { id: 'epuPm', roleId: 'epu', shiftTypeId: 'PM', days: { weekdays: [0, 4] }, min: 1, max: 1 },
      { id: 'ancAm', roleId: 'anc', shiftTypeId: 'AM', days: { weekdays: WEEKDAYS }, min: 0, max: 1 },
      { id: 'ancPm', roleId: 'anc', shiftTypeId: 'PM', days: { weekdays: WEEKDAYS }, min: 0, max: 1 },
      { id: 'colpAm', roleId: 'colp', shiftTypeId: 'AM', days: { weekdays: [1, 3] }, min: 0, max: 1 },
      { id: 'obsLdWk', roleId: 'obsOncall', shiftTypeId: 'LD', days: { weekdays: WEEKDAYS }, min: 1, max: 1, importance: 3 },
      { id: 'obsLdWe', roleId: 'obsOncall', shiftTypeId: 'LD', days: { weekdays: WEEKEND }, min: 2, max: 2, importance: 3 },
      { id: 'gynLdWe', roleId: 'gynOncall', shiftTypeId: 'LD', days: { weekdays: WEEKEND }, min: 1, max: 1, importance: 3 },
      { id: 'obsN', roleId: 'obsOncall', shiftTypeId: 'N', days: {}, min: 1, max: 1, importance: 3 },
      { id: 'gynN', roleId: 'gynOncall', shiftTypeId: 'N', days: {}, min: 1, max: 1, importance: 3 },
    ],
    rules,
    fairness: [
      { id: 'hours', name: 'Total hours', unit: 'hours', weight: 1 },
      { id: 'nights', name: 'Nights', work: { shiftTypeIds: ['N'] }, unit: 'shifts', weight: 2 },
      { id: 'weekends', name: 'Weekend shifts', weekendsOnly: true, unit: 'shifts', weight: 2 },
    ],
    useSpareCapacity: true,
  };
}

/** Small deterministic PRNG so every run of a seed is identical. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

export function stressProblem(seed = 1): RotaProblem {
  const profile = stressProfile();
  const start = '2026-11-02';
  const end = '2026-11-29';
  const dates = dateRange(start, end);
  const r = rng(seed);
  const unavailability: Unavailability[] = [];
  const fixed: FixedAssignment[] = [];

  for (const s of profile.staff) {
    // Annual leave: ~half the doctors take a 3–7 day block.
    if (r() < 0.5) {
      const len = 3 + Math.floor(r() * 5);
      const from = Math.floor(r() * (dates.length - len));
      for (let i = 0; i < len; i++) unavailability.push({ staffId: s.id, date: dates[from + i], reason: 'Annual leave' });
    }
    // One study day for ~half.
    if (r() < 0.5) {
      const weekdaysOnly = dates.filter(d => weekday(d) < 5);
      unavailability.push({ staffId: s.id, date: weekdaysOnly[Math.floor(r() * weekdaysOnly.length)], reason: 'Study day' });
    }
    // FY teaching every Wednesday afternoon.
    if (s.groupIds.includes('fy')) for (const d of dates) if (weekday(d) === 2) unavailability.push({ staffId: s.id, date: d, shiftTypeIds: ['PM', 'LD', 'N'], reason: 'FY teaching' });
    // Part-time non-working days.
    if (s.fte === 0.6) for (const d of dates) if (weekday(d) === 0 || weekday(d) === 4) unavailability.push({ staffId: s.id, date: d, kind: 'nonWorking', reason: 'Non-working day (LTFT)' });
    if (s.fte === 0.8) for (const d of dates) if (weekday(d) === 4) unavailability.push({ staffId: s.id, date: d, kind: 'nonWorking', reason: 'Non-working day (LTFT)' });
  }

  // Pre-booked from another system: st2 on obstetric nights Mon–Thu of week 2,
  // gp3 on a course (outside commitment) on Tuesday of week 3.
  const busy = (id: string, d: string) => unavailability.some(u => u.staffId === id && u.date === d);
  for (let i = 0; i < 4; i++) {
    const d = addDays('2026-11-09', i);
    if (!busy('st2', d)) fixed.push({ staffId: 'st2', date: d, shiftTypeId: 'N', roleId: 'obsOncall', reason: 'Pre-booked' });
  }
  if (!busy('gp3', '2026-11-17')) fixed.push({ staffId: 'gp3', date: '2026-11-17', shiftTypeId: 'LD', reason: 'Course' });

  return { profile, start, end, unavailability, fixed };
}

/**
 * The same department with two hard rules that cannot both hold: st2 is
 * pre-booked on a Friday AM theatre straight after a block of nights, and
 * gp1 must do 6 ELCS this month despite GPs being capped at 1 a week.
 */
export function impossibleProblem(): RotaProblem {
  const p = stressProblem(1);
  p.unavailability = p.unavailability.filter(u => !(u.staffId === 'st2' && u.date >= '2026-11-09' && u.date <= '2026-11-13'));
  p.fixed = p.fixed.filter(f => f.staffId !== 'st2');
  for (let i = 0; i < 4; i++) p.fixed.push({ staffId: 'st2', date: addDays('2026-11-09', i), shiftTypeId: 'N', roleId: 'obsOncall' });
  p.fixed.push({ staffId: 'st2', date: '2026-11-13', shiftTypeId: 'AM', roleId: 'elcs' });
  p.profile.rules.push({ id: 'gp1SixElcs', name: 'GP1 must do 6 ELCS', type: 'count', hard: true, who: { staffIds: ['gp1'] }, work: { roleIds: ['elcs'] }, period: 'horizon', unit: 'shifts', min: 6 });
  return p;
}
