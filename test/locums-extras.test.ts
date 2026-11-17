import { describe, expect, it, vi } from 'vitest';
import { addDays } from '../src/engine/calendar';
import { findSwaps, isCountedWork, type RotaSnapshot } from '../src/engine/swaps';
import type { Staff } from '../src/engine/types';
import { applyImport, planImport } from '../src/app/mediImport';
import { overviewValidation, workingCount } from '../src/app/overview';
import { peopleTableSections } from '../src/app/people';
import { applyPresetToWorkspace, makePresetFromWorkspace, markPresetPersonOverride, type SetupPreset } from '../src/app/presets';
import { emptyWorkspace } from '../src/app/store';
import { makeShareContent, renderSharePng, shareText, type ShareInput } from '../src/app/swapShare';
import { swapOptionPeople, swapRequesterPeople } from '../src/app/swapsView';
import type { PersonRow, PersonWeek, Session } from '../src/app/medirota';
import { blankSnapshot, off, stage2Profile, stage2Request, stage2Settings, work, STAGE2_MONDAY } from './swaps-stage2-helpers';

const person = (id: string, label: string, days: PersonRow['days'], role = 'CT'): PersonRow =>
  ({ id, rowName: label, label, role, days });
const sessions = (...items: [Session, string][]): PersonRow['days'][string] =>
  Object.fromEntries(items.map(([session, activity]) => [session, [activity]]));
const week = (people: PersonRow[], start = '2026-11-02'): PersonWeek => ({ start, people });

describe('locums and extras acceptance', () => {
  it('imports Extra nights, long days, day jobs and a mixed am/pm day with extrasTagged', () => {
    const ws = emptyWorkspace();
    const start = '2026-11-02';
    const plan = planImport(ws, [week([person('rowan', 'Dr Rowan (ST2)', {
      [start]: sessions(['night', 'Nights CT [Extra]']),
      [addDays(start, 1)]: sessions(['am', 'Delivery Suite [Extra]'], ['pm', 'Delivery Suite [Extra]'], ['eve', 'Delivery Suite [Extra]']),
      [addDays(start, 2)]: sessions(['am', 'MAU CT [Extra]'], ['pm', 'MAU CT [Extra]']),
      [addDays(start, 3)]: sessions(['am', 'Postnatal Wards CT'], ['pm', 'Float CT [Extra]']),
      [addDays(start, 4)]: sessions(['am', 'Elective C-Sections'], ['pm', 'Elective C-Sections']),
    })])], []);
    applyImport(ws, plan);
    const id = ws.profile.staff.find(staff => staff.name === 'Dr Rowan')!.id;
    const days = ws.swapFinder!.snapshot.days[id];
    expect(days[start]).toEqual({ status: 'night', activity: 'Nights CT', sessions: ['night'], extra: true });
    expect(days[addDays(start, 1)]).toEqual({ status: 'longDay', activity: 'Delivery Suite', sessions: ['am', 'pm', 'eve'], extra: true });
    expect(days[addDays(start, 2)]).toMatchObject({ status: 'dayJob', activity: 'MAU CT', extra: true });
    expect(days[addDays(start, 2)].activity).not.toContain('[Extra]');
    // Mixed rostered am + extra pm of another place: keep the first day-job place (rostered wards),
    // do not mark the day as extra, and do not keep the extra pm place as the activity.
    expect(days[addDays(start, 3)]).toEqual({ status: 'dayJob', activity: 'Postnatal Wards CT', sessions: ['am'] });
    expect(days[addDays(start, 3)].extra).toBeUndefined();
    expect(days[addDays(start, 4)]).toMatchObject({ status: 'dayJob', activity: 'Elective C-Sections' });
    expect(days[addDays(start, 4)].extra).toBeUndefined();
    expect(ws.swapFinder!.snapshot.extrasTagged).toBe(true);
  });

  it('hands back a requester extra long day: listed, not searched, and present in share text and image', async () => {
    const p = stage2Profile(['rowan', 'ellis'], ['Long List']);
    const s = blankSnapshot(['rowan', 'ellis']);
    const leave = '2026-11-10';
    work(s, 'rowan', leave, 'longDay', 'Long List');
    s.days.rowan[leave].extra = true;
    off(s, 'ellis', leave);
    work(s, 'ellis', '2026-11-17', 'longDay', 'Long List');
    off(s, 'rowan', '2026-11-17');
    const result = findSwaps(p, s, stage2Settings({ maxChain: 2, minDoctors: [0, 0, 0, 0, 0, 0, 0], minDoctorsBankHoliday: 0 }), stage2Request('rowan', [leave]));
    expect(result.extraShiftsToHandBack).toEqual([{ date: leave, activity: 'Long List' }]);
    expect(result.clashes).toEqual([]);
    expect(result.plans).toEqual([]);

    const shareInput: ShareInput = {
      plans: [], filter: 'all', requesterId: 'rowan', requesterName: 'Dr Rowan', nameFor: id => id === 'ellis' ? 'Dr Ellis' : 'Dr Rowan',
      covered: [], existingShortages: [], extraShiftsToHandBack: result.extraShiftsToHandBack, importedAt: '2026-11-06T12:00:00Z', limit: 5,
    };
    const content = makeShareContent(shareInput);
    expect(shareText(content)).toContain('• Extra shift on Tue 10 Nov (Long List): hand back to medical staffing');
    const labels: string[] = [];
    const context = {
      fillStyle: '', font: '', textAlign: '', strokeStyle: '', fillRect: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(), roundRect: vi.fn(), fill: vi.fn(),
      fillText: vi.fn((text: string) => labels.push(text)), measureText: (value: string) => ({ width: value.length * 8 }),
    };
    const canvas = { width: 0, height: 0, getContext: () => context, toBlob: (callback: BlobCallback) => callback(new Blob(['png'], { type: 'image/png' })) } as unknown as HTMLCanvasElement;
    await renderSharePng(content, () => canvas);
    expect(labels.join(' ')).toContain('Extra shift on Tue 10 Nov (Long List): hand back to medical staffing');
  });

  it('keeps a Fri to Sun rostered night block at three nights and hands back only an extra Monday in the leave', () => {
    const p = stage2Profile(['rowan', 'ellis'], ['Night List']);
    const s = blankSnapshot(['rowan', 'ellis']);
    const block = ['2026-11-06', '2026-11-07', '2026-11-08']; // Fri to Sun
    const extraMon = '2026-11-09';
    for (const date of block) { work(s, 'rowan', date, 'night', 'Night List'); off(s, 'ellis', date); }
    work(s, 'rowan', extraMon, 'night', 'Night List');
    s.days.rowan[extraMon].extra = true;
    off(s, 'ellis', extraMon);
    for (const date of ['2026-11-13', '2026-11-14', '2026-11-15']) { work(s, 'ellis', date, 'night', 'Night List'); off(s, 'rowan', date); }

    const midLeave = findSwaps(p, s, stage2Settings({ maxChain: 2 }), stage2Request('rowan', ['2026-11-07']));
    expect(midLeave.clashes).toHaveLength(1);
    expect(midLeave.clashes[0].dates).toEqual(block);
    expect(midLeave.extraShiftsToHandBack).toEqual([]);

    const withExtra = findSwaps(p, s, stage2Settings({ maxChain: 2 }), stage2Request('rowan', [extraMon]));
    expect(withExtra.extraShiftsToHandBack).toEqual([{ date: extraMon, activity: 'Night List' }]);
    expect(withExtra.clashes).toEqual([]);
  });

  it('never offers a colleague extra as a return, chain link or NWD swap, but still counts it as work and alerts', () => {
    const p = stage2Profile(['rowan', 'ellis'], ['Long List']);
    p.rules = [{ id: 'hours', name: 'Made-up 72-hour rule', type: 'maxHours', hard: true, who: {}, hours: 72, windowDays: 7 }];
    const s = blankSnapshot(['rowan', 'ellis']);
    const leave = STAGE2_MONDAY;
    work(s, 'rowan', leave, 'longDay', 'Long List');
    off(s, 'ellis', leave);
    for (const date of ['2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07']) {
      work(s, 'ellis', date, 'longDay', 'Long List');
    }
    const extraDate = '2026-11-10';
    work(s, 'ellis', extraDate, 'longDay', 'Long List');
    s.days.ellis[extraDate].extra = true;
    off(s, 'rowan', extraDate);
    work(s, 'ellis', '2026-11-17', 'longDay', 'Long List');
    off(s, 'rowan', '2026-11-17');

    const result = findSwaps(p, s, stage2Settings({ maxChain: 2, minDoctors: [0, 0, 0, 0, 0, 0, 0], minDoctorsBankHoliday: 0 }), stage2Request('rowan', [leave]));
    expect(result.plans.every(plan => plan.chains.every(chain => chain.links.every(link => !(link.staffId === 'ellis' && link.gives.dates.includes(extraDate)))))).toBe(true);
    expect(result.plans.every(plan => !plan.chains.some(chain => chain.sameDay && chain.links.some(link => link.staffId === 'ellis' && link.gives.dates.includes(extraDate))))).toBe(true);
    expect(isCountedWork(s.days.ellis[extraDate])).toBe(true);
    expect(workingCount(s, extraDate)).toBe(1);
    const ellisPlan = result.plans.find(plan => plan.chains.some(chain => chain.links.some(link => link.staffId === 'ellis')));
    expect(ellisPlan?.alerts?.some(alert => alert.staffId === 'ellis' && /72 hours/i.test(alert.message))).toBe(true);
  });

  it('rejects a day shift on a night receiver mandatory rest day that has an extra, and alerts for an adjacent extra night', () => {
    const p = stage2Profile(['rowan', 'ellis'], ['Night List', 'Long List']);
    const s = blankSnapshot(['rowan', 'ellis']);
    const requesterBlock = ['2026-11-06', '2026-11-07', '2026-11-08'];
    const receiverBlock = ['2026-11-13', '2026-11-14', '2026-11-15'];
    for (const date of requesterBlock) { work(s, 'rowan', date, 'night', 'Night List'); off(s, 'ellis', date); }
    for (const date of receiverBlock) { work(s, 'ellis', date, 'night', 'Night List'); off(s, 'rowan', date); }
    const restDay = '2026-11-09'; // Monday after Fri-Sun block: mandatory rest for receiver taking Fri-Sun
    work(s, 'ellis', restDay, 'longDay', 'Long List');
    s.days.ellis[restDay].extra = true;
    const withRestExtra = findSwaps(p, s, stage2Settings({ maxChain: 2 }), stage2Request('rowan', requesterBlock));
    expect(withRestExtra.plans.some(plan => plan.chains.some(chain => chain.links.some(link => link.staffId === 'ellis' && link.gives.dates.join() === receiverBlock.join())))).toBe(false);

    s.days.ellis[restDay] = { status: 'zero', activity: 'Zero Day', sessions: ['am'] };
    const adjacentExtraNight = '2026-11-05'; // Thursday before the Fri to Sun block being received
    work(s, 'ellis', adjacentExtraNight, 'night', 'Night List');
    s.days.ellis[adjacentExtraNight].extra = true;
    const withAdjacent = findSwaps(p, s, stage2Settings({ maxChain: 2 }), stage2Request('rowan', requesterBlock));
    const offered = withAdjacent.plans.find(plan => plan.chains.some(chain => chain.links.some(link => link.staffId === 'ellis')));
    expect(offered).toBeDefined();
    expect(offered!.alerts?.some(alert => alert.message === 'The night block runs into existing nights')).toBe(true);
  });

  it('never lists any locum in plans, chains, NWD swaps, Who to ask, leave-out lists or ruled-out rows, even on a Zero Day', () => {
    const people = [
      { id: 'rowan', name: 'Dr Rowan', groupIds: ['fy'], fte: 1 },
      { id: 'ellis', name: 'Dr Ellis', groupIds: ['fy'], fte: 1 },
      { id: 'regular', name: 'Dr Hart', groupIds: ['fy'], fte: 1, locum: true, regularLocum: true },
      { id: 'occasional', name: 'Dr Moss', groupIds: ['fy'], fte: 1, locum: true },
    ];
    expect(swapOptionPeople(people, 'rowan').map(person => person.id)).toEqual(['ellis']);
    expect(swapRequesterPeople(people).map(person => person.id)).toEqual(['rowan', 'ellis', 'regular']);

    const p = stage2Profile(['rowan', 'ellis', 'regular', 'occasional'], ['Long List', 'MAU CT']);
    p.staff[2].locum = true; p.staff[2].regularLocum = true; p.staff[2].name = 'Dr Hart';
    p.staff[3].locum = true; p.staff[3].name = 'Dr Moss';
    const s = blankSnapshot(['rowan', 'ellis', 'regular', 'occasional']);
    const leave = STAGE2_MONDAY;
    work(s, 'rowan', leave, 'longDay', 'Long List');
    off(s, 'ellis', leave);
    off(s, 'regular', leave); // Zero Day
    off(s, 'occasional', leave);
    work(s, 'ellis', '2026-11-17', 'longDay', 'Long List');
    work(s, 'regular', '2026-11-18', 'longDay', 'Long List');
    work(s, 'occasional', '2026-11-19', 'longDay', 'Long List');
    off(s, 'rowan', '2026-11-17');
    off(s, 'rowan', '2026-11-18');
    off(s, 'rowan', '2026-11-19');
    const result = findSwaps(p, s, stage2Settings({ maxChain: 3, minDoctors: [0, 0, 0, 0, 0, 0, 0], minDoctorsBankHoliday: 0 }), stage2Request('rowan', [leave]));
    const staffInPlans = result.plans.flatMap(plan => plan.chains.flatMap(chain => chain.links.map(link => link.staffId)));
    expect(staffInPlans.includes('regular')).toBe(false);
    expect(staffInPlans.includes('occasional')).toBe(false);
    expect(result.ruledOut.every(item => item.staffId !== 'regular' && item.staffId !== 'occasional')).toBe(true);
  });

  it('lets a regular locum be the requester but not an occasional locum', () => {
    const people = [
      { id: 'regular', name: 'Dr Vale', groupIds: ['fy'], fte: 1, locum: true, regularLocum: true },
      { id: 'occasional', name: 'Dr Quinn', groupIds: ['fy'], fte: 1, locum: true },
      { id: 'ellis', name: 'Dr Ellis', groupIds: ['fy'], fte: 1 },
    ];
    expect(swapRequesterPeople(people).map(person => person.id)).toEqual(['regular', 'ellis']);
    expect(swapRequesterPeople(people).some(person => person.id === 'occasional')).toBe(false);

    const p = stage2Profile(['regular', 'ellis'], ['Long List']);
    p.staff[0].locum = true; p.staff[0].regularLocum = true;
    const s = blankSnapshot(['regular', 'ellis']);
    work(s, 'regular', STAGE2_MONDAY, 'longDay', 'Long List');
    off(s, 'ellis', STAGE2_MONDAY);
    work(s, 'ellis', '2026-11-17', 'longDay', 'Long List');
    off(s, 'regular', '2026-11-17');
    const result = findSwaps(p, s, stage2Settings({ maxChain: 2, minDoctors: [0, 0, 0, 0, 0, 0, 0], minDoctorsBankHoliday: 0 }), stage2Request('regular', [STAGE2_MONDAY]));
    expect(result.clashes).toHaveLength(1);
    expect(result.plans.some(plan => plan.chains.some(chain => chain.links.some(link => link.staffId === 'ellis')))).toBe(true);
  });

  it('shows extras notice only for old rotas without extrasTagged, and not after a tagged import', () => {
    const old: RotaSnapshot = { days: { rowan: { '2026-11-02': { status: 'dayJob', activity: 'MAU CT' } } }, importedAt: { '2026-11-02': '2026-10-01T12:00:00Z' } };
    expect(!!old.importedAt && !old.extrasTagged).toBe(true);
    const ws = emptyWorkspace();
    applyImport(ws, planImport(ws, [week([person('rowan', 'Dr Rowan (ST2)', { '2026-11-02': sessions(['am', 'MAU CT']) })])], []));
    expect(ws.swapFinder!.snapshot.extrasTagged).toBe(true);
    expect(!!ws.swapFinder!.snapshot.importedAt && !ws.swapFinder!.snapshot.extrasTagged).toBe(false);
  });

  it('counts an occasional locum toward gaps and Working / minimum while hiding them from people rows', () => {
    const ws = emptyWorkspace();
    ws.profile.name = 'Made-up';
    ws.profile.groups = [{ id: 'fy2', name: 'FY2' }];
    ws.profile.shiftTypes = [{ id: 'day', name: 'Day', start: '08:00', end: '17:00' }];
    ws.profile.roles = [{ id: 'mau', name: 'MAU CT' }];
    ws.profile.demands = [{ id: 'mau-need', roleId: 'mau', shiftTypeId: 'day', days: {}, min: 1, max: 2 }];
    ws.profile.staff = [
      { id: 'rowan', name: 'Dr Rowan', groupIds: ['fy2'], fte: 1 },
      { id: 'occasional', name: 'Dr Moss', groupIds: ['fy2'], fte: 1, locum: true },
      { id: 'regular', name: 'Dr Hart', groupIds: ['fy2'], fte: 1, locum: true, regularLocum: true },
    ];
    const date = '2026-11-10';
    ws.swapFinder = {
      snapshot: {
        days: {
          rowan: { [date]: { status: 'leave', activity: 'Annual Leave' } },
          occasional: { [date]: { status: 'dayJob', activity: 'MAU CT', sessions: ['am', 'pm'] } },
          regular: { [date]: { status: 'blank' } },
        },
        importedAt: { '2026-11-09': '2026-11-01T12:00:00Z' },
        extrasTagged: true,
      },
      settings: {
        weekendDayActivities: [], hoursTolerance: 1, maxChain: 4, returnPattern: 'consecutive', returnDayType: 'noPreference',
        returnWindow: { kind: 'any' }, noAlertsOnly: false, includeNormalDays: false,
        minDoctors: [7, 7, 7, 7, 7, 3, 3], minDoctorsBankHoliday: 4, bankHolidays: [], regularDaysOff: {}, excluded: [],
      },
    };
    const snapshot = ws.swapFinder!.snapshot;
    const visible = ws.profile.staff.filter(person => !person.locum || person.regularLocum);
    expect(visible.map(person => person.id)).toEqual(['rowan', 'regular']);
    const gaps = overviewValidation(ws.profile, snapshot, date, date).gaps;
    expect(gaps).toEqual([]);
    expect(workingCount(snapshot, date)).toBe(1);
  });

  it('moves an occasional locum into the main People table when Regular is turned on, and keeps regularLocum through preset and import', () => {
    const occasional: Staff = { id: 'moss', name: 'Dr Moss', groupIds: ['fy'], fte: 1, locum: true };
    let sections = peopleTableSections([occasional], [{ id: 'fy', name: 'FY2' }]);
    expect(sections.occasionalLocums).toHaveLength(1);
    occasional.regularLocum = true;
    sections = peopleTableSections([occasional], [{ id: 'fy', name: 'FY2' }]);
    expect(sections.sections.flatMap(section => section.people.map(person => person.id))).toEqual(['moss']);
    expect(sections.occasionalLocums).toEqual([]);

    const ws = emptyWorkspace();
    ws.profile.staff = [{ id: 'rowan', name: 'Dr Rowan', groupIds: [], fte: 1, locum: true, regularLocum: true }];
    const preset: SetupPreset = {
      version: 1, id: 'made-up', name: 'Made-up', description: 'Test',
      setup: { profile: structuredClone(ws.profile), swapSettings: {
        weekendDayActivities: [], hoursTolerance: 1, maxChain: 4, returnPattern: 'consecutive', returnDayType: 'noPreference',
        returnWindow: { kind: 'any' }, noAlertsOnly: false, includeNormalDays: false,
        minDoctors: [7, 7, 7, 7, 7, 3, 3], minDoctorsBankHoliday: 4, bankHolidays: [],
      } },
      people: [{ name: 'Dr Rowan', locum: true, regularLocum: true }],
    };
    const empty = emptyWorkspace();
    empty.profile.staff = [{ id: 'rowan', name: 'Dr Rowan', groupIds: [], fte: 1 }];
    applyPresetToWorkspace(empty, preset);
    expect(empty.profile.staff[0].regularLocum).toBe(true);
    empty.profile.staff[0].regularLocum = false;
    markPresetPersonOverride(empty, 'Dr Rowan', 'regularLocum', false);
    applyImport(empty, planImport(empty, [week([person('1', 'Dr Rowan (ST2)', { '2026-11-02': sessions(['am', 'MAU CT']) })])], []));
    expect(empty.profile.staff.find(staff => staff.name === 'Dr Rowan')!.regularLocum).toBe(false);
    const saved = makePresetFromWorkspace(empty);
    expect(saved.people?.find(entry => entry.name === 'Dr Rowan')?.regularLocum).toBeUndefined();
  });
});
