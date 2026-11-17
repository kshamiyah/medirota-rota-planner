import { legacySessions } from "./fixtures/legacy-sessions";

import { describe, expect, it } from 'vitest';
import { makePresetFromWorkspace, applyPresetToWorkspace } from '../src/app/presets';
import {
  analyseSessions, formatSessions, offTarget, sessionComparisonFor,
  sessionDateRange, sessionEntries, sessionValue,
} from '../src/app/sessions';
import { overviewFixture } from './fixtures/overview-made-up';

function gradeWorkspace() {
  const ws = structuredClone(overviewFixture());
  ws.profile.groups = [
    { id: 'fy2', name: 'FY2' }, { id: 'gpreg', name: 'GP Reg' }, { id: 'gpvts', name: 'GPVTS' },
    { id: 'st1', name: 'ST1' }, { id: 'st12a', name: 'ST1/2' }, { id: 'st2', name: 'ST2' },
  ];
  ws.profile.staff = ws.profile.staff.map((person, index) => ({
    ...person,
    groupIds: [index < 4 ? 'fy2' : index < 6 ? 'gpreg' : index < 8 ? 'gpvts' : index === 9 ? 'st12a' : index < 14 ? 'st1' : 'st2'],
  }));
  return ws;
}

describe('Sessions Stage 2 calculations', () => {
  it('counts full, half, long, night and part shifts; training, leave, zero, blanks and [Removed] are not counted', () => {
    expect(sessionValue('dayJob', ['am', 'pm'])).toBe(1);
    expect(sessionValue('dayJob', ['am'])).toBe(0.5);
    expect(sessionValue('longDay', ['am', 'pm', 'eve'])).toBe(1);
    expect(sessionValue('night', ['night'])).toBe(1);
    expect(sessionValue('partShift', ['pm'])).toBe(0.5);
    expect(sessionValue('partShift', ['eve'])).toBe(0.5);
    expect(sessionValue('training', ['am', 'pm'])).toBe(0);
    expect(sessionValue('leave')).toBe(0);
    expect(sessionValue('zero')).toBe(0);
    expect(sessionValue('blank')).toBe(0);

    const ws = gradeWorkspace();
    const snapshot = ws.swapFinder!.snapshot;
    for (const person of ws.profile.staff) snapshot.days[person.id] = {};
    snapshot.days['doctor-0']['2026-11-10'] = { status: 'dayJob', activity: 'Elective C-Sections', sessions: ['am', 'pm'] };
    snapshot.days['doctor-0']['2026-11-11'] = { status: 'dayJob', activity: 'Elective C-Sections', sessions: ['am'] };
    snapshot.days['doctor-0']['2026-11-12'] = { status: 'longDay', activity: 'Gynae Onc Long Day CT', sessions: ['am', 'pm', 'eve'] };
    snapshot.days['doctor-0']['2026-11-13'] = { status: 'night', activity: 'Nights CT', sessions: ['night'] };
    snapshot.days['doctor-0']['2026-11-14'] = { status: 'partShift', activity: 'MAU CT', sessions: ['am'] };
    snapshot.days['doctor-0']['2026-11-15'] = { status: 'training', activity: 'Teaching', sessions: ['am', 'pm'] };
    snapshot.days['doctor-0']['2026-11-16'] = { status: 'leave', activity: 'Annual leave' };
    snapshot.days['doctor-0']['2026-11-17'] = { status: 'zero', activity: 'Zero Day', sessions: ['am'] };
    snapshot.days['doctor-0']['2026-11-18'] = { status: 'blank' };
    snapshot.days['doctor-0']['2026-11-19'] = { status: 'dayJob', activity: 'Elective C-Sections [Removed]', sessions: ['am', 'pm'] };
    snapshot.days['doctor-0']['2026-11-20'] = { status: 'longDay', activity: 'Gynae Onc Long Day CT…', sessions: ['am', 'pm', 'eve'] };

    const settings = legacySessions(ws.profile);
    const theatre = settings.types.find(type => type.name === 'Theatre')!;
    const mau = settings.types.find(type => type.name === 'MAU')!;
    const gynaeOnc = settings.types.find(type => type.name === 'Gynae onc')!;
    const nights = settings.types.find(type => type.name === 'Nights')!;
    const result = analyseSessions(ws.profile, snapshot, settings, {}, '2026-11-10', '2026-11-20');
    const row = result.people.find(person => person.staff.id === 'doctor-0')!;
    expect(row.counts[theatre.id]).toBe(1.5);
    expect(row.counts[gynaeOnc.id]).toBe(1);
    expect(row.counts[nights.id]).toBe(1);
    expect(row.counts[mau.id]).toBe(0.5);
    expect(result.ignored).toEqual(expect.arrayContaining([
      { activity: 'Elective C-Sections [Removed]', count: 1 },
      { activity: 'Gynae Onc Long Day CT…', count: 1 },
    ]));
    expect(result.ignored.some(item => item.activity.includes('[Removed]'))).toBe(true);
  });

  it('puts extra nights, long days and day jobs only in Extras; rostered nights stay in Nights', () => {
    const ws = gradeWorkspace();
    const snapshot = ws.swapFinder!.snapshot;
    for (const person of ws.profile.staff) snapshot.days[person.id] = {};
    snapshot.days['doctor-0']['2026-11-10'] = { status: 'night', activity: 'Nights CT', sessions: ['night'] };
    snapshot.days['doctor-0']['2026-11-11'] = { status: 'night', activity: 'Nights CT', sessions: ['night'], extra: true };
    snapshot.days['doctor-0']['2026-11-12'] = { status: 'longDay', activity: 'Delivery Suite', sessions: ['am', 'pm', 'eve'], extra: true };
    snapshot.days['doctor-0']['2026-11-13'] = { status: 'dayJob', activity: 'Elective C-Sections', sessions: ['am', 'pm'], extra: true };
    snapshot.days['doctor-1']['2026-11-10'] = { status: 'night', activity: 'Nights CT', sessions: ['night'] };
    const settings = legacySessions(ws.profile);
    const nights = settings.types.find(type => type.name === 'Nights')!;
    const theatre = settings.types.find(type => type.name === 'Theatre')!;
    const delivery = settings.types.find(type => type.name === 'Delivery Suite')!;
    const result = analyseSessions(ws.profile, snapshot, settings, {}, '2026-11-10', '2026-11-13');
    const row = result.people.find(person => person.staff.id === 'doctor-0')!;
    expect(row.counts[nights.id]).toBe(1);
    expect(row.counts[theatre.id] ?? 0).toBe(0);
    expect(row.counts[delivery.id] ?? 0).toBe(0);
    expect(row.extras).toBe(3);
    expect(sessionEntries(ws.profile, snapshot, settings, 'doctor-0', '2026-11-10', '2026-11-13', nights.id)).toEqual([
      expect.objectContaining({ date: '2026-11-10', amount: 1, extra: false }),
    ]);
    expect(sessionEntries(ws.profile, snapshot, settings, 'doctor-0', '2026-11-10', '2026-11-13').filter(entry => entry.extra).map(entry => entry.amount)).toEqual([1, 1, 1]);
  });

  it('works a two-group target by hand with ratios, a 60% doctor and leave, and checks off-target edges', () => {
    // Range 10 days. Theatre ratios: FY2 1, GPs 2.
    // Rowan (FY2, 100%): availability 10, Theatre 4.
    // Ellis (FY2, 60%, 2 leave days): availability 10*0.6-2 = 4, Theatre 2.
    // Hart (GP Reg, 100%): availability 10, Theatre 6.
    // Total = 12. Denominator = 1*10 + 1*4 + 2*10 = 34.
    // Targets: Rowan 12*10/34 = 60/17, Ellis 12*4/34 = 24/17, Hart 12*20/34 = 120/17.
    const ws = gradeWorkspace();
    const snapshot = ws.swapFinder!.snapshot;
    for (const person of ws.profile.staff) {
      snapshot.days[person.id] = {};
      person.groupIds = [];
    }
    ws.profile.staff[0].groupIds = ['fy2'];
    ws.profile.staff[1].groupIds = ['fy2'];
    ws.profile.staff[4].groupIds = ['gpreg'];
    ws.profile.staff[0].fte = 1;
    ws.profile.staff[1].fte = 0.6;
    ws.profile.staff[4].fte = 1;
    for (const date of ['2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13'] as const) {
      snapshot.days['doctor-0'][date] = { status: 'dayJob', activity: 'Elective C-Sections', sessions: ['am', 'pm'] };
    }
    snapshot.days['doctor-1']['2026-11-10'] = { status: 'leave', activity: 'Annual leave' };
    snapshot.days['doctor-1']['2026-11-11'] = { status: 'leave', activity: 'Annual leave' };
    snapshot.days['doctor-1']['2026-11-12'] = { status: 'dayJob', activity: 'Elective C-Sections', sessions: ['am', 'pm'] };
    snapshot.days['doctor-1']['2026-11-13'] = { status: 'dayJob', activity: 'Elective C-Sections', sessions: ['am', 'pm'] };
    for (const date of ['2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14', '2026-11-15'] as const) {
      snapshot.days['doctor-4'][date] = { status: 'dayJob', activity: 'Elective C-Sections', sessions: ['am', 'pm'] };
    }
    const settings = legacySessions(ws.profile);
    const theatre = settings.types.find(type => type.name === 'Theatre')!;
    settings.ratios[theatre.id] = { 'session-group-fy2': 1, 'session-group-gps': 2, 'session-group-st12': 1 };
    const result = analyseSessions(ws.profile, snapshot, settings, {}, '2026-11-10', '2026-11-19');
    const rowan = result.people.find(person => person.staff.id === 'doctor-0')!;
    const ellis = result.people.find(person => person.staff.id === 'doctor-1')!;
    const hart = result.people.find(person => person.staff.id === 'doctor-4')!;
    expect([rowan.availability, ellis.availability, hart.availability]).toEqual([10, 4, 10]);
    expect([rowan.counts[theatre.id], ellis.counts[theatre.id], hart.counts[theatre.id]]).toEqual([4, 2, 6]);
    expect(rowan.targets[theatre.id]).toBeCloseTo(60 / 17);
    expect(ellis.targets[theatre.id]).toBeCloseTo(24 / 17);
    expect(hart.targets[theatre.id]).toBeCloseTo(120 / 17);
    expect(formatSessions(ellis.targets[theatre.id])).toBe('1.4');

    // Exactly 2 sessions away and exactly 20%: not off target. Just beyond either edge: off target.
    expect(offTarget(8, 10)).toBeUndefined();
    expect(offTarget(12, 10)).toBeUndefined();
    expect(offTarget(7, 10)).toBe('under');
    expect(offTarget(13, 10)).toBe('over');
    // More than 2 away but within 20%: still on target.
    expect(offTarget(17, 20)).toBeUndefined();
    // More than 20% away but only 1 or 2 sessions: still on target until both edges trip.
    expect(offTarget(4, 5)).toBeUndefined();
    expect(offTarget(3, 5)).toBeUndefined();
    expect(offTarget(2, 5)).toBe('under');
  });

  it('lists regular locums with the Locum tag path (counts, no target), leaves them out of averages, and ignores occasional locums', () => {
    const ws = gradeWorkspace();
    const snapshot = ws.swapFinder!.snapshot;
    for (const person of ws.profile.staff) {
      snapshot.days[person.id] = {};
      person.groupIds = [];
    }
    ws.profile.staff[0].groupIds = ['fy2'];
    ws.profile.staff[1].groupIds = ['fy2'];
    ws.profile.staff[18].groupIds = ['fy2'];
    ws.profile.staff[19].groupIds = ['fy2'];
    snapshot.days['doctor-0']['2026-11-10'] = { status: 'dayJob', activity: 'Elective C-Sections', sessions: ['am', 'pm'] };
    snapshot.days['doctor-0']['2026-11-11'] = { status: 'dayJob', activity: 'Elective C-Sections', sessions: ['am', 'pm'], extra: true };
    snapshot.days['doctor-1']['2026-11-10'] = { status: 'dayJob', activity: 'Elective C-Sections', sessions: ['am', 'pm'] };
    snapshot.days['doctor-18']['2026-11-10'] = { status: 'longDay', activity: 'Elective C-Sections', sessions: ['am', 'pm', 'eve'] };
    snapshot.days['doctor-19']['2026-11-10'] = { status: 'longDay', activity: 'Elective C-Sections', sessions: ['am', 'pm', 'eve'] };
    snapshot.days['doctor-19']['2026-11-11'] = { status: 'dayJob', activity: 'WC Theatres', sessions: ['am', 'pm'] };
    const settings = legacySessions(ws.profile);
    const theatre = settings.types.find(type => type.name === 'Theatre')!;
    const result = analyseSessions(ws.profile, snapshot, settings, {}, '2026-11-10', '2026-11-11');
    const regular = result.people.find(row => row.staff.id === 'doctor-18')!;
    expect(regular.staff.locum).toBe(true);
    expect(regular.staff.regularLocum).toBe(true);
    expect(regular.counts[theatre.id]).toBe(1);
    expect(regular.targets[theatre.id]).toBeUndefined();
    expect(result.people.some(row => row.staff.id === 'doctor-19')).toBe(false);
    const counted = result.people.filter(person => !person.staff.locum && person.targets[theatre.id] !== undefined);
    const total = counted.reduce((sum, person) => sum + (person.counts[theatre.id] ?? 0), 0);
    expect(total).toBe(2);
    expect(result.people.find(row => row.staff.id === 'doctor-0')?.targets[theatre.id]).toBeCloseTo(1);
    expect(result.people.find(row => row.staff.id === 'doctor-0')?.extras).toBe(1);
  });

  it('defaults FY2, GPs and ST1-2; split places an ST1/2 doctor and leaves an unplaced one without a target', () => {
    const ws = gradeWorkspace();
    const settings = legacySessions(ws.profile);
    expect(settings.groups.map(group => ({ name: group.name, grades: group.grades }))).toEqual([
      { name: 'FY2', grades: ['FY2'] },
      { name: 'GPs', grades: ['GP Reg', 'GPVTS'] },
      { name: 'ST1-2', grades: ['ST1', 'ST1/2', 'ST2'] },
    ]);
    const group = settings.groups.find(item => item.name === 'ST1-2')!;
    group.subGroups = [
      { id: 'st1-sub', name: 'ST1', grades: ['ST1'] },
      { id: 'st2-sub', name: 'ST2', grades: ['ST2'] },
    ];
    const snapshot = ws.swapFinder!.snapshot;
    for (const person of ws.profile.staff) snapshot.days[person.id] = {};
    snapshot.days['doctor-9']['2026-11-10'] = { status: 'dayJob', activity: 'Elective C-Sections', sessions: ['am', 'pm'] };
    snapshot.days['doctor-10']['2026-11-10'] = { status: 'dayJob', activity: 'Elective C-Sections', sessions: ['am', 'pm'] };
    snapshot.days['doctor-14']['2026-11-10'] = { status: 'dayJob', activity: 'Elective C-Sections', sessions: ['am', 'pm'] };

    const unplaced = analyseSessions(ws.profile, snapshot, settings, {}, '2026-11-10', '2026-11-10');
    const ambiguous = unplaced.people.find(person => person.staff.id === 'doctor-9')!;
    expect(sessionComparisonFor(ambiguous.staff, ws.profile, settings, {})).toEqual({ groupId: group.id });
    expect(ambiguous.comparisonId).toBeUndefined();
    expect(Object.keys(ambiguous.targets)).toEqual([]);

    const placed = analyseSessions(ws.profile, snapshot, settings, { 'doctor-9': 'st2-sub' }, '2026-11-10', '2026-11-10');
    const moved = placed.people.find(person => person.staff.id === 'doctor-9')!;
    expect(moved.comparisonId).toBe('st2-sub');
    expect(Object.keys(moved.targets).length).toBeGreaterThan(0);
    expect(placed.people.find(person => person.staff.id === 'doctor-10')?.comparisonId).toBe('st1-sub');
    expect(placed.people.find(person => person.staff.id === 'doctor-14')?.comparisonId).toBe('st2-sub');
  });

  it('round-trips session types, groups and ratios in a preset, and keeps placements in people', () => {
    const ws = gradeWorkspace();
    const settings = legacySessions(ws.profile);
    const group = settings.groups.find(item => item.name === 'ST1-2')!;
    group.subGroups = [
      { id: 'st1-sub', name: 'ST1', grades: ['ST1'] },
      { id: 'st2-sub', name: 'ST2', grades: ['ST2'] },
    ];
    settings.ratios[settings.types[0].id]![group.id] = 2;
    settings.types[0].name = 'Custom theatre';
    ws.sessions = settings;
    ws.sessionSubGroups = { 'doctor-9': 'st2-sub' };
    const preset = makePresetFromWorkspace(ws, 'made-up-sessions');
    expect(JSON.stringify(preset.sessions)).not.toMatch(/Dr\s/);
    expect(preset.people?.some(person => person.name === 'Dr Reed' && person.sessionSubGroup === 'st2-sub')).toBe(true);

    const next = gradeWorkspace();
    applyPresetToWorkspace(next, preset);
    expect(next.sessions).toEqual(settings);
    expect(next.sessionSubGroups?.['doctor-9']).toBe('st2-sub');
    expect(sessionDateRange(ws.swapFinder!.snapshot)).toMatchObject({ start: '2026-11-09', end: '2027-01-03' });
  });

  it('keeps doctors without a target out of the target pool used by charts', () => {
    const ws = gradeWorkspace();
    const settings = legacySessions(ws.profile);
    const group = settings.groups.find(item => item.name === 'ST1-2')!;
    group.subGroups = [
      { id: 'st1-sub', name: 'ST1', grades: ['ST1'] },
      { id: 'st2-sub', name: 'ST2', grades: ['ST2'] },
    ];
    const snapshot = ws.swapFinder!.snapshot;
    for (const person of ws.profile.staff) snapshot.days[person.id] = {};
    snapshot.days['doctor-10']['2026-11-10'] = { status: 'dayJob', activity: 'Elective C-Sections', sessions: ['am', 'pm'] };
    const result = analyseSessions(ws.profile, snapshot, settings, {}, '2026-11-10', '2026-11-10');
    const chartPeople = result.people.filter(person => !person.staff.locum && Object.keys(person.targets).length > 0);
    expect(chartPeople.some(person => person.staff.id === 'doctor-9')).toBe(false);
    expect(chartPeople.some(person => person.staff.id === 'doctor-10')).toBe(true);
  });
});
