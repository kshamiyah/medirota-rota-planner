import { describe, expect, it } from 'vitest';
import { applyImport, planImport, previewImport } from '../src/app/mediImport';
import { isPersonWeek, parsePersonWeek, type PersonRow, type PersonWeek } from '../src/app/medirota';
import { emptyWorkspace } from '../src/app/store';
import { quickLookItems } from '../src/app/setupReview';

// A cut-down "By person" week with MediRota's markup: one person, a night on Monday.
const slot = (date: string, shift: number, acts: string[]) =>
  `<td id="n-1-${date}-${shift}" class="rmap-rota__node person-slot" data-date="${date}" data-shift_id="${shift}"><ul>${acts.map(a => `<li class=""><a href="#" class="js-remove">&times;</a> ${a}</li>`).join('')}</ul></td>`;
const html = `<select><option value="person-77" >Ellis Rowan (ST2)</option></select>
<table class="rmap-table rmap-table--grid js-main-rota" data-person="77" data-rota-date="2026-11-02"><tr><td class="rmap-rota__detail"><div class="js-activity-name"><span class="rmap-rota__detail-name">Ellis, Rowan</span> ST 07700 900000</div></td>
${slot('2026-11-02', 1, [])}${slot('2026-11-02', 4, ['Nights CT'])}</tr></table>`;

describe('MediRota "By person" weeks', () => {
  it('reads people, grades and sessions, and ignores phone numbers', () => {
    expect(isPersonWeek(html)).toBe(true);
    const w = parsePersonWeek(html);
    expect(w.start).toBe('2026-11-02');
    expect(w.people).toEqual([{ id: '77', rowName: 'Ellis, Rowan', label: 'Ellis Rowan (ST2)', role: 'ST', days: { '2026-11-02': { night: ['Nights CT'] } } }]);
  });
});

const row = (id: string, label: string, days: PersonRow['days'], role = 'CT'): PersonRow => ({ id, rowName: label, label, role, days });
const week = (people: PersonRow[]): PersonWeek => ({ start: '2026-11-02', people });
const weekOf = (acts: Record<number, Partial<Record<'am' | 'pm' | 'eve' | 'night', string[]>>>) =>
  Object.fromEntries(Object.entries(acts).map(([d, s]) => [`2026-11-0${+d + 2}`, s]));

const sample = () => [week([
  row('1', 'Robin Vale (ST1)', weekOf({ 0: { night: ['Nights CT'] }, 1: { night: ['Nights CT'] }, 2: { am: ['Zero Day CT'] }, 3: { am: ['Elective C-Sections'], pm: ['Elective C-Sections'] }, 4: { am: ['[Away]'] } })),
  row('2', 'Ari Moss (GPVTS)', weekOf({ 0: { am: ['Delivery Suite'], eve: ['Delivery Suite'] }, 1: { am: ['PROMPT Training'] }, 2: { am: ['Elective C-Sections'] }, 3: { am: ['Elective C-Sections'] }, 4: { am: ['Elective C-Sections'] } })),
  row('3', 'Sam Lee', weekOf({ 0: { am: ['MAU CT [Extra]'] } }), 'Locum'),
  row('4', 'Nobody Here (FY2)', {}),
])];

describe('Planning an import', () => {
  it('stores By activity consultant lists with unmatched juniors and replaces lists for re-imported dates', () => {
    const activity = (consultants: string[], juniors: { mediRotaId?: string; name: string }[]) => [{
      start: '2026-11-02',
      activities: [{
        name: 'Elective C-Sections',
        description: '',
        days: {
          '2026-11-03': {
            juniors: juniors.length,
            consultants,
            cells: [{ date: '2026-11-03', session: 'am', juniors, consultants }],
          },
        },
      }],
    }];
    const ws = emptyWorkspace();
    const first = planImport(ws, sample(), activity(['Mr Vale'], [{ mediRotaId: '1', name: 'Robin Vale (ST1)' }, { name: 'Dr Ghost (ST1)' }]));
    expect(first.unmatchedActivityJuniors).toBe(1);
    applyImport(ws, first);
    expect(ws.consultantLists).toEqual([{
      date: '2026-11-03',
      placeId: ws.profile.roles.find(role => role.name === 'Elective C-Sections')!.id,
      activity: 'Elective C-Sections',
      session: 'am',
      staffIds: [ws.profile.staff.find(person => person.mediRotaId === '1')!.id],
      consultants: ['Mr Vale'],
      unmatched: 1,
    }]);
    ws.consultantLists!.push({ date: '2026-10-20', placeId: 'old', activity: 'Elective C-Sections', session: 'am', staffIds: [], consultants: ['Ms Quinn'], unmatched: 0 });
    const second = planImport(ws, sample(), activity(['Ms Quinn'], [{ mediRotaId: '1', name: 'Robin Vale (ST1)' }]));
    applyImport(ws, second);
    expect(ws.consultantLists!.some(cell => cell.date === '2026-10-20' && cell.consultants[0] === 'Ms Quinn')).toBe(true);
    expect(ws.consultantLists!.filter(cell => cell.date === '2026-11-03')).toEqual([{
      date: '2026-11-03',
      placeId: ws.profile.roles.find(role => role.name === 'Elective C-Sections')!.id,
      activity: 'Elective C-Sections',
      session: 'am',
      staffIds: [ws.profile.staff.find(person => person.mediRotaId === '1')!.id],
      consultants: ['Ms Quinn'],
      unmatched: 0,
    }]);
  });

  it('sets up an empty department: people by grade, what each activity becomes, places and needs', () => {
    const ws = emptyWorkspace();
    const plan = planImport(ws, sample(), []);
    expect(plan.firstTime).toBe(true);
    expect(plan.dates[0]).toBe('2026-11-02');
    expect(plan.people.map(p => [p.name, p.grade, p.action, p.locum])).toEqual([
      ['Nobody Here', 'FY2', 'add', false],
      ['Ari Moss', 'GPVTS', 'add', false],
      ['Robin Vale', 'ST1', 'add', false],
      ['Sam Lee', undefined, 'add', true],
    ]);
    const treat = Object.fromEntries(plan.activities.map(a => [a.name, a.treat]));
    expect(treat).toEqual({ 'Nights CT': 'night', 'Delivery Suite': 'long', 'Elective C-Sections': 'dayjob', 'MAU CT': 'dayjob', '[Away]': 'leave', 'PROMPT Training': 'training', 'Zero Day CT': 'zero' });

    const r = applyImport(ws, plan);
    expect(r.people).toBe(4);
    expect(ws.profile.groups.map(g => g.name).sort()).toEqual(['FY2', 'GPVTS', 'ST1']);
    expect(ws.profile.roles.map(x => x.name).sort()).toEqual(['Delivery Suite', 'Elective C-Sections', 'MAU CT', 'Nights CT']);
    // Nights and long days are booked; day jobs are left for the app to plan.
    expect(ws.fixed.map(f => f.date)).toEqual(['2026-11-02', '2026-11-03', '2026-11-02']);
    expect(ws.unavailability.map(u => [u.date, u.kind]).sort()).toEqual([['2026-11-03', 'other'], ['2026-11-04', 'nonWorking'], ['2026-11-06', 'leave']]);
    expect(ws.profile.shiftTypes.map(s => s.name).sort()).toEqual(['Day job', 'Long Day', 'Night']);
    expect(ws.profile.demands.length).toBe(4);
    expect(ws.period.start).toBe('2026-11-02');
    expect(ws.profile.staff.find(s => s.name === 'Sam Lee')?.locum).toBe(true);
  });

  it('keeps an existing Normal working day shift name in a saved workspace', () => {
    const ws = emptyWorkspace();
    ws.profile.shiftTypes.push({ id: 'saved-day', name: 'Normal working day', start: '08:00', end: '17:00' });
    applyImport(ws, planImport(ws, sample(), []));
    expect(ws.profile.shiftTypes.find(shift => shift.id === 'saved-day')?.name).toBe('Normal working day');
  });

  it('a second import matches people, remembers choices and replaces only what it brought in', () => {
    const ws = emptyWorkspace();
    applyImport(ws, planImport(ws, sample(), []));
    const robin = ws.profile.staff.find(s => s.name === 'Robin Vale')!;
    ws.unavailability.push({ staffId: robin.id, date: '2026-11-07', kind: 'leave', reason: 'Wedding' });
    const counts = [ws.fixed.length, ws.unavailability.length, ws.profile.staff.length];

    const plan = planImport(ws, sample(), []);
    expect(plan.firstTime).toBe(false);
    expect(plan.people.filter(p => p.action === 'add')).toEqual([]);
    expect(plan.activities.every(a => a.remembered)).toBe(true);
    expect(plan.needs).toEqual([]);
    applyImport(ws, plan);
    expect([ws.fixed.length, ws.unavailability.length, ws.profile.staff.length]).toEqual(counts);
    expect(ws.unavailability.some(u => u.reason === 'Wedding')).toBe(true);
  });

  it('preserves MediRota [Extra] on the imported snapshot and marks the import as tagged', () => {
    const ws = emptyWorkspace();
    const people = [row('extra-person', 'Mia Rowan (ST2)', weekOf({ 0: { am: ['MAU CT [Extra]'] } }))];
    const plan = planImport(ws, [week(people)], []);
    applyImport(ws, plan);
    const staff = ws.profile.staff.find(person => person.name === 'Mia Rowan')!;
    const day = ws.swapFinder!.snapshot.days[staff.id]['2026-11-02'];
    expect(day).toMatchObject({ status: 'dayJob', activity: 'MAU CT', extra: true });
    expect(ws.swapFinder!.snapshot.extrasTagged).toBe(true);
  });

  it('first-time summary does not guess locum from extra-only shifts and surfaces those doctors for a quick look', () => {
    const plan = planImport(emptyWorkspace(), [week([row('99', 'Quinn Hart (ST1)', weekOf({ 0: { am: ['Maple Ward [Extra]'] } }))])], [], { firstTimeSummary: true });
    expect(plan.people[0]).toMatchObject({ mediRotaId: '99', locum: false, action: 'add' });
    expect(quickLookItems(plan).extraOnly).toEqual(['99']);
  });

  it('later imports pre-tick an extra-only doctor as locum (BASE)', () => {
    const plan = planImport(emptyWorkspace(), [week([row('99', 'Quinn Hart (ST1)', weekOf({ 0: { am: ['Maple Ward [Extra]'] } }))])], []);
    expect(plan.people[0]).toMatchObject({ mediRotaId: '99', locum: true, action: 'add' });
  });

  it('imports a cell with a MediRota slot heading then Training Day CT as training, not a day job', () => {
    const slotInner = (activity: string) =>
      `<li><span class="rmap-rota__slottitle">&hellip;</span></li><li class=""><a href="#" class="js-remove">&times;</a> ${activity}</li>`;
    const cell = (date: string, shift: number, activity: string) =>
      `<td id="n-1-${date}-${shift}" class="rmap-rota__node person-slot" data-date="${date}" data-shift_id="${shift}"><ul>${slotInner(activity)}</ul></td>`;
    const html = `<select><option value="person-7" >Dr Hart (ST1)</option></select>
<table class="rmap-table rmap-table--grid js-main-rota" data-person="7" data-rota-date="2026-11-02"><tr><td class="rmap-rota__detail"><div class="js-activity-name"><span class="rmap-rota__detail-name">Hart, Dr</span> ST1</div></td>
${cell('2026-11-02', 1, 'Training Day CT')}${cell('2026-11-03', 1, 'MAU CT')}</tr></table>`;
    const parsed = parsePersonWeek(html);
    const plan = planImport(emptyWorkspace(), [parsed], []);
    expect(plan.activities.map(a => a.name).sort()).toEqual(['MAU CT', 'Training Day CT']);
    expect(plan.activities.some(a => /hellip|…/.test(a.name))).toBe(false);
    expect(Object.fromEntries(plan.activities.map(a => [a.name, a.treat]))).toMatchObject({ 'Training Day CT': 'training', 'MAU CT': 'dayjob' });
    const ws = emptyWorkspace();
    applyImport(ws, plan);
    const staff = ws.profile.staff.find(person => person.name === 'Dr Hart')!;
    expect(ws.swapFinder!.snapshot.days[staff.id]['2026-11-02']).toMatchObject({ status: 'training', activity: 'Training Day CT' });
    expect(ws.swapFinder!.snapshot.days[staff.id]['2026-11-03']).toMatchObject({ status: 'dayJob', activity: 'MAU CT' });
    expect(JSON.stringify(ws.swapFinder!.snapshot.days)).not.toMatch(/hellip|…/);
  });

  it('removes a leftover ellipsis place, its staffing need and saved activity choice on the next import', () => {
    const ws = emptyWorkspace();
    ws.profile.shiftTypes = [{ id: 'day', name: 'Day', start: '08:00', end: '17:00' }];
    ws.profile.roles = [
      { id: 'ellipsis', name: '…' },
      { id: 'mau', name: 'MAU CT' },
    ];
    ws.profile.demands = [
      { id: 'ellipsis-need', roleId: 'ellipsis', shiftTypeId: 'day', days: { weekdays: [1] }, min: 1, max: 1 },
      { id: 'mau-need', roleId: 'mau', shiftTypeId: 'day', days: { weekdays: [0, 1, 2, 3, 4] }, min: 1, max: 2 },
    ];
    ws.mediRota = { activities: { '…': { treat: 'dayjob', placeId: 'ellipsis' }, 'MAU CT': { treat: 'dayjob', placeId: 'mau' } }, skip: [] };
    const plan = planImport(ws, [week([row('1', 'Dr Moss (ST2)', weekOf({ 0: { am: ['MAU CT'] } }))])], []);
    const result = applyImport(ws, plan);
    expect(result.removedHeadingPlace).toBe(true);
    expect(ws.profile.roles.map(role => role.name)).toEqual(['MAU CT']);
    expect(ws.profile.demands.every(demand => demand.roleId !== 'ellipsis')).toBe(true);
    expect(ws.mediRota?.activities['…']).toBeUndefined();
    expect(ws.mediRota?.activities['MAU CT']).toMatchObject({ treat: 'dayjob', placeId: 'mau' });
  });

  it('spots a close spelling, and people who are no longer on the rota', () => {
    const ws = emptyWorkspace();
    ws.profile.staff.push({ id: 'a', name: 'Robin Val', groupIds: [], fte: 1 }, { id: 'b', name: 'Old Friend', groupIds: [], fte: 1, mediRotaId: '99' });
    ws.profile.roles.push({ id: 'r', name: 'Somewhere' });
    const plan = planImport(ws, sample(), []);
    const robin = plan.people.find(p => p.mediRotaId === '1')!;
    expect(robin.possible?.name).toBe('Robin Val');
    expect(robin.action).toBe('match');
    expect(plan.leavers).toEqual([
      { staffId: 'a', name: 'Robin Val', markLeft: false, lastDay: '2026-11-01' },
      { staffId: 'b', name: 'Old Friend', markLeft: false, lastDay: '2026-11-01' },
    ].filter(l => l.staffId !== 'a'));
  });

  it('works out a changeover from four or more weeks missing at the start or end', () => {
    const wk = (start: string, people: PersonRow[]): PersonWeek => ({ start, people });
    const weeks = [
      wk('2026-11-02', [row('1', 'Robin Vale (ST1)', {}), row('2', 'Ari Moss (GPVTS)', {}), row('6', 'Short Gap (ST2)', {})]),
      wk('2026-11-09', [row('1', 'Robin Vale (ST1)', {})]),
      wk('2026-11-16', [row('1', 'Robin Vale (ST1)', {})]),
      wk('2026-11-23', [row('1', 'Robin Vale (ST1)', {}), row('6', 'Short Gap (ST2)', {})]),
      wk('2026-11-30', [row('1', 'Robin Vale (ST1)', {}), row('5', 'New Starter (FY2)', {})]),
    ];
    const plan = planImport(emptyWorkspace(), weeks, []);
    const by = Object.fromEntries(plan.people.map(p => [p.name, [p.from, p.until]]));
    expect(by['Robin Vale']).toEqual([undefined, undefined]);
    expect(by['Short Gap']).toEqual([undefined, undefined]); // one week missing at the end isn't leaving
    expect(by['Ari Moss']).toEqual([undefined, '2026-11-08']);
    expect(by['New Starter']).toEqual(['2026-11-30', undefined]);
    const ws = emptyWorkspace();
    applyImport(ws, plan);
    expect(ws.profile.staff.find(s => s.name === 'Ari Moss')?.endDate).toBe('2026-11-08');
    expect(ws.profile.staff.find(s => s.name === 'New Starter')?.startDate).toBe('2026-11-30');
    // A one-week import later doesn't assume people missing from it have left.
    const later = planImport(ws, [wk('2026-12-07', [row('1', 'Robin Vale (ST1)', {})])], []);
    expect(later.leavers.length).toBeGreaterThan(0);
    expect(later.leavers.every(l => !l.markLeft)).toBe(true);
  });

  it('matches names in either order, and replaces clashing bookings entered before', () => {
    const ws = emptyWorkspace();
    applyImport(ws, planImport(ws, sample(), []));
    // As if the department had been set up before imports were tagged: same people, untagged bookings.
    for (const s of ws.profile.staff) delete s.mediRotaId;
    ws.profile.staff.find(s => s.name === 'Robin Vale')!.name = 'Vale Robin';
    for (const f of ws.fixed) delete f.source;
    for (const u of ws.unavailability) delete u.source;
    const counts = [ws.fixed.length, ws.unavailability.length];
    const plan = planImport(ws, sample(), []);
    expect(plan.people.find(p => p.mediRotaId === '1')?.staffId).toBe(ws.profile.staff.find(s => s.name === 'Vale Robin')!.id);
    const r = applyImport(ws, plan);
    expect(r.replaced).toBe(3);
    expect([ws.fixed.length, ws.unavailability.length]).toEqual(counts);
  });

  it('leaves out a booking that was chosen to be left out', () => {
    const ws = emptyWorkspace();
    const plan = planImport(ws, sample(), []);
    applyImport(ws, { ...plan, skip: ['1|2026-11-03'] });
    const robin = ws.profile.staff.find(s => s.name === 'Robin Vale')!;
    expect(ws.fixed.filter(f => f.staffId === robin.id).map(f => f.date)).toEqual(['2026-11-02']);
    // Importing the same weeks again remembers it.
    expect(planImport(ws, sample(), []).skip).toEqual(['1|2026-11-03']);
  });

  it('previews without changing anything', () => {
    const ws = emptyWorkspace();
    const plan = planImport(ws, sample(), []);
    const pv = previewImport(ws, plan);
    expect(pv.booked).toEqual({ before: 0, after: 3 });
    expect(pv.newPeople).toBe(4);
    expect(pv.problems).toEqual([]);
    expect(ws.profile.staff).toEqual([]);
  });
});
