import { describe, expect, it } from 'vitest';
import { findDayJobSwapOptions, dayJobSwapText } from '../src/app/dayJobSwaps';
import { defaultSessionsSettings, type SessionsSettings } from '../src/app/sessions';
import { renderDayJobSwapPng } from '../src/app/swapShare';
import type { Profile, Staff } from '../src/engine/types';
import type { RotaSnapshot, SwapSettings } from '../src/engine/swaps';

const date = '2026-12-03';
const staff: Staff[] = [
  { id: 'rowan', name: 'Dr Rowan', groupIds: ['fy2'], fte: 1 }, { id: 'ellis', name: 'Dr Ellis', groupIds: ['gp'], fte: 1 },
  { id: 'hart', name: 'Dr Hart', groupIds: ['fy2'], fte: 1 }, { id: 'moss', name: 'Dr Moss', groupIds: ['st'], fte: 1 },
  { id: 'vale', name: 'Dr Vale', groupIds: ['gp'], fte: 1 }, { id: 'quinn', name: 'Dr Quinn', groupIds: ['gp'], fte: 1 },
  { id: 'hayes', name: 'Dr Hayes', groupIds: ['st'], fte: 1 }, { id: 'mr-hart', name: 'Mr Hart', groupIds: ['consultant'], fte: 1 },
  { id: 'mr-vale', name: 'Mr Vale', groupIds: ['consultant'], fte: 1 }, { id: 'ms-quinn', name: 'Ms Quinn', groupIds: ['consultant'], fte: 1 },
];
const profile: Profile = {
  name: 'Test', shiftTypes: [{ id: 'day', name: 'Day job', start: '08:00', end: '17:00' }],
  roles: [{ id: 'wards', name: 'Postnatal Wards CT' }, { id: 'float', name: 'Float CT' }, { id: 'theatre', name: 'Elective C-Sections' }, { id: 'unknown', name: 'Unknown place' }],
  groups: [{ id: 'fy2', name: 'FY2' }, { id: 'gp', name: 'GP' }, { id: 'st', name: 'ST1' }, { id: 'consultant', name: 'Consultant' }],
  staff, demands: [], rules: [], fairness: [],
};
const snapshot = (): RotaSnapshot => ({ importedAt: { '2026-11-30': '2026-11-01T00:00:00Z' }, days: {} });
const settings: SwapSettings = { weekendDayActivities: [], hoursTolerance: 0, maxChain: 4, minDoctors: [0, 0, 0, 0, 0, 0, 0], minDoctorsBankHoliday: 0, bankHolidays: [], regularDaysOff: {}, excluded: [] };
const sessions: SessionsSettings = { ...defaultSessionsSettings(profile), types: [
  { id: 'wards', name: 'Wards', colour: 1, kind: 'day', placeIds: ['wards'] },
  { id: 'theatre', name: 'Theatre', colour: 2, kind: 'day', placeIds: ['theatre'] },
  { id: 'float', name: 'Float', colour: 3, kind: 'day', placeIds: ['float'] },
] };
function setDay(s: RotaSnapshot, id: string, status: 'dayJob' | 'longDay' | 'night' | 'partShift' | 'leave' | 'training' | 'zero' | 'blank', activity?: string, extra = false) {
  s.days[id] ??= {};
  s.days[id][date] = { status, ...(activity ? { activity } : {}), ...(extra ? { extra: true } : {}) };
}
function search(s: RotaSnapshot, overrides: Partial<Parameters<typeof findDayJobSwapOptions>[0]> = {}) {
  return findDayJobSwapOptions({ profile, snapshot: s, sessions, settings, requesterId: 'rowan', date, ...overrides });
}

describe('Stage 8 day-job swaps', () => {
  it('groups and orders other whole-day jobs by Sessions, then grade and name', () => {
    const s = snapshot();
    setDay(s, 'rowan', 'dayJob', 'Postnatal Wards CT'); setDay(s, 'hart', 'dayJob', 'Postnatal Wards CT');
    setDay(s, 'ellis', 'dayJob', 'Float CT'); setDay(s, 'hayes', 'dayJob', 'Float CT'); setDay(s, 'vale', 'dayJob', 'Float CT');
    setDay(s, 'moss', 'dayJob', 'Elective C-Sections');
    const result = search(s);
    expect(result.requesterPlaceName).toBe('Postnatal Wards CT');
    expect(result.groups.map(group => group.placeName)).toEqual(['Elective C-Sections', 'Float CT']);
    expect(result.groups[1].people.map(person => person.staff.name)).toEqual(['Dr Ellis', 'Dr Vale', 'Dr Hayes']);
    expect(result.count).toBe(4);
  });

  it('leaves out same job, non-day statuses, extras, locums and excluded colleagues', () => {
    const s = snapshot();
    setDay(s, 'rowan', 'dayJob', 'Postnatal Wards CT'); setDay(s, 'hart', 'dayJob', 'Postnatal Wards CT');
    setDay(s, 'ellis', 'longDay', 'Float CT'); setDay(s, 'moss', 'night', 'Float CT'); setDay(s, 'vale', 'leave');
    setDay(s, 'quinn', 'training'); setDay(s, 'hayes', 'zero'); setDay(s, 'mr-hart', 'partShift', 'Float CT');
    setDay(s, 'mr-vale', 'dayJob', 'Float CT', true); setDay(s, 'ms-quinn', 'dayJob', 'Float CT');
    const result = search(s, { settings: { ...settings, excluded: [{ staffId: 'ms-quinn' }] } });
    expect(result.count).toBe(0);
  });

  it('excludes extra and locum shifts from the colleague results', () => {
    const s = snapshot(); setDay(s, 'rowan', 'dayJob', 'Postnatal Wards CT');
    setDay(s, 'hart', 'dayJob', 'Float CT', true); setDay(s, 'ellis', 'dayJob', 'Float CT'); setDay(s, 'moss', 'dayJob', 'Float CT');
    const result = search(s, { profile: { ...profile, staff: profile.staff.map(person => person.id === 'ellis' ? { ...person, locum: true } : person) } });
    expect(result.groups.flatMap(group => group.people.map(person => person.staff.name))).toEqual(['Dr Moss']);
  });

  it('returns a plain requester message with a short date when not on a day job', () => {
    const s = snapshot(); setDay(s, 'rowan', 'longDay', 'Elective C-Sections');
    expect(search(s).message).toBe("You're on a long day on Thu 3 Dec. Use Cover my leave for long days.");
  });

  it('names the doctor when the doctor box is not Viewing as', () => {
    const s = snapshot(); setDay(s, 'hart', 'longDay', 'Elective C-Sections');
    expect(search(s, { requesterId: 'hart', viewerId: 'rowan' }).message)
      .toBe('Dr Hart is on a long day on Thu 3 Dec. Use Cover my leave for long days.');
    expect(search(s, { requesterId: 'hart', viewerId: 'hart' }).message)
      .toBe("You're on a long day on Thu 3 Dec. Use Cover my leave for long days.");
  });

  it('excludes a requester with an extra day job or locum status', () => {
    const s = snapshot(); setDay(s, 'rowan', 'dayJob', 'Postnatal Wards CT', true);
    expect(search(s).requesterPlaceName).toBeUndefined();
    s.days.rowan[date] = { status: 'dayJob', activity: 'Postnatal Wards CT' };
    expect(search(s, { profile: { ...profile, staff: profile.staff.map(person => person.id === 'rowan' ? { ...person, locum: true } : person) } }).requesterPlaceName).toBeUndefined();
  });

  it('allows weekend day jobs', () => {
    const s = snapshot(), weekend = '2026-12-05';
    s.days.rowan = { [weekend]: { status: 'dayJob', activity: 'Postnatal Wards CT' } };
    s.days.ellis = { [weekend]: { status: 'dayJob', activity: 'Float CT' } };
    expect(findDayJobSwapOptions({ profile, snapshot: s, sessions, settings, requesterId: 'rowan', date: weekend }).count).toBe(1);
  });

  it('shows the Fairer consultant match when known and none when unknown', () => {
    const s = snapshot(); setDay(s, 'rowan', 'dayJob', 'Postnatal Wards CT'); setDay(s, 'moss', 'dayJob', 'Elective C-Sections'); setDay(s, 'ellis', 'dayJob', 'Float CT');
    const lists = [{ date, placeId: 'theatre', activity: 'Elective C-Sections', session: 'am', staffIds: ['moss'], consultants: ['Mr Hart'], unmatched: 0 }];
    const result = search(s, { consultantLists: lists });
    expect(result.groups[0].people[0].consultants).toEqual(['Mr Hart']);
    expect(result.groups[1].people[0].consultants).toEqual([]);
    expect(result.count).toBe(2);
  });

  it('formats the Stage 8 WhatsApp text without a remaining-options footer', () => {
    const s = snapshot(); setDay(s, 'rowan', 'dayJob', 'Postnatal Wards CT'); setDay(s, 'hart', 'dayJob', 'Float CT'); setDay(s, 'moss', 'dayJob', 'Float CT');
    const result = search(s);
    expect(dayJobSwapText({ date, requesterPlace: result.requesterPlaceName!, groups: result.groups })).toBe("Day job swap, Thu 3 Dec. I'm on Postnatal Wards CT. Could anyone swap?\n\n*Float CT*: Dr Hart, Dr Moss");
  });

  it('renders a phone-width share image', async () => {
    const context = { font: '', fillStyle: '', textAlign: 'left', measureText: (text: string) => ({ width: text.length * 8 }), fillRect() {}, fillText() {} } as unknown as CanvasRenderingContext2D;
    const canvas = { width: 0, height: 0, getContext: () => context, toBlob: (callback: BlobCallback) => callback(new Blob(['png'])) } as unknown as HTMLCanvasElement;
    await renderDayJobSwapPng({ date, requesterName: 'Dr Rowan', requesterPlace: 'Postnatal Wards CT', groups: [] }, () => canvas);
    expect(canvas.width).toBe(720);
    expect(canvas.height).toBeGreaterThan(0);
  });
});
