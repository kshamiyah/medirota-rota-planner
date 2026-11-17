import { describe, expect, it } from 'vitest';
import { applyConsultantLists, guessPlace, importable, isEllipsisOnlyName, parseActivityWeek, parsePersonWeek, type ActivityWeek } from '../src/app/medirota';
import { countUnmatchedActivityJuniors } from '../src/app/mediImport';
import { emptyWorkspace } from '../src/app/store';
import { demandFor } from '../src/engine/semantics';

// A cut-down "By activity" week with made-up doctors and consultants.
const cell = (date: string, col: number, juniors: string[], tooltip?: string) => `<td id="n-1424-${date}-1-9"
    data-slot_date="${date}" data-column="${col}" data-tooltip="" class="rmap-rota__node rmap-table__column-${col}     setup  "><ul class="rmap-rota__assigned time-calcs__assigned">${juniors.map(j => `<li class=" " data-activity="9"><a href="#" class="rmap-mini-delete js-remove-activity hidden">&times;</a>
      ${j}
  </li>`).join('')}</ul>${tooltip ? `<div class="mapping" data-tooltip="
            <div class='mapping__rota-name__tooltip'>WS Cons:</div></br>
            ${tooltip}
            <br/>
            "><div class="mapping__rota-name">WS Cons</div><div class="mapping__name">x</div></div>` : ''}</td>`;
const html = `<html><table class="rmap-table rmap-table--grid rmap-rota weeks js-main-rota" data-num_defined_sessions="4" data-rota-date="2026-10-12"><tbody>
<div id ="activity-9" class="activity-container rota standard-type"><table><tbody><tr class="rmap-rota__rota-row"><td class="rmap-rota__detail"><div class="js-activity-name"><span class="rmap-rota__detail-name">
      Elective C-Sections
  </span>
  0800-1730. Fridays start at 0730.
</div></td><td class="rmap-rota__sessions-cell" colspan="8"><table class="rmap-rota__sessions-table rmap-table--grid"><tr empty="false" class="rmap-table__gridrow-1 session-row1 "><td class="rmap-rota__session-label">
      am
  </td>${cell('2026-10-12', 1, ['Dr Rowan (ST1)'], 'Vale, Mr (Cons Gyn)')}${cell('2026-10-13', 2, ['CT'], 'Quinn, Ms (Cons Obs)<br/>Moss, Mr (Cons Obs)<br/>Dr Vale (ST3-5)')}${cell('2026-10-14', 3, [])}</tr></table></td></tr></tbody></table></div>
</tbody></table></html>`;

describe('MediRota "By activity" import', () => {
  it('reads consultants and individual junior cells per session', () => {
    const w = parseActivityWeek(html);
    expect(w.start).toBe('2026-10-12');
    expect(w.activities.map(a => a.name)).toEqual(['Elective C-Sections']);
    const d = w.activities[0].days;
    expect(d['2026-10-12']).toMatchObject({ juniors: 1, consultants: ['Mr Vale'], cells: [{ date: '2026-10-12', session: 'am', juniors: [{ name: 'Dr Rowan (ST1)' }], consultants: ['Mr Vale'] }] });
    expect(d['2026-10-13']).toMatchObject({ juniors: 1, consultants: ['Ms Quinn', 'Mr Moss'], cells: [{ session: 'am', consultants: ['Ms Quinn', 'Mr Moss'] }] });
    expect(d['2026-10-14']).toMatchObject({ juniors: 0, consultants: [], cells: [{ date: '2026-10-14', session: 'am', juniors: [], consultants: [] }] });
  });

  it('turns them into consultant lists that replace the usual need on those days', () => {
    const ws = emptyWorkspace();
    ws.profile.shiftTypes = [{ id: 'D', name: 'Day', start: '08:00', end: '17:30' }];
    ws.profile.roles = [{ id: 'elcs', name: 'Elective C-Sections', category: 'Theatre' }];
    ws.profile.demands = [{ id: 'n', roleId: 'elcs', shiftTypeId: 'D', days: { weekdays: [0, 1, 2, 3, 4] }, min: 1, max: 1, importance: 3 }];
    const week = parseActivityWeek(html);
    expect(guessPlace(ws.profile.roles, 'Elective C-Sections')).toBe('elcs');
    const r = applyConsultantLists(ws, [week], { 'Elective C-Sections': 'elcs' });
    expect(r.consultantsAdded).toEqual(['Mr Vale', 'Ms Quinn', 'Mr Moss']);
    expect(r.listsCreated).toEqual(['Elective C-Sections – Mr Vale', 'Elective C-Sections – Mr Moss & Ms Quinn'].map(s => s.includes('&') ? expect.stringContaining('&') : s));
    const p = ws.profile;
    const valeList = p.roles.find(x => x.name.endsWith('Mr Vale'))!;
    expect(demandFor(p, 'elcs', 'D', '2026-10-12').max).toBe(0);
    expect(demandFor(p, valeList.id, 'D', '2026-10-12')).toMatchObject({ min: 1, max: 1, importance: 3 });
    expect(demandFor(p, 'elcs', 'D', '2026-10-14').min).toBe(1); // no consultant mapped: usual need stays
    // Importing the same week again doesn't double up.
    applyConsultantLists(ws, [week], { 'Elective C-Sections': 'elcs' });
    expect(demandFor(p, valeList.id, 'D', '2026-10-12').max).toBe(1);
    expect(p.roles.filter(x => x.parentId === 'elcs')).toHaveLength(2);
  });

  it('matches juniors by MediRota id or by name after removing the bracketed grade, and counts unmatched juniors', () => {
    const source = `<table class="rmap-table weeks js-main-rota" data-rota-date="2026-11-02"><div id="activity-7" class="activity-container rota"><tr><span class="rmap-rota__detail-name">Elective C-Sections</span><td class="rmap-rota__session-label">pm</td><td data-slot_date="2026-11-03"><ul class="rmap-rota__assigned"><li data-person-id="mr-1">Dr Rowan (ST1)</li></ul><div class="mapping" data-tooltip="Mr Vale (Cons Obs)">x</div></td></tr></div></table>`;
    const activity = parseActivityWeek(source);
    const person = (id: string, rowName: string, label: string) => ({ id, rowName, label, role: 'CT', days: {} });
    const people = [{ start: '2026-11-02', people: [person('mr-1', 'Rowan, Dr', 'Dr Rowan (ST1)'), person('mr-2', 'Ellis, Dr', 'Dr Ellis (ST2)')] }];
    expect(activity.activities[0]!.days['2026-11-03']!.cells).toEqual([{ date: '2026-11-03', session: 'pm', juniors: [{ mediRotaId: 'mr-1', name: 'Dr Rowan (ST1)' }], consultants: ['Mr Vale'] }]);
    const withoutId = {
      ...activity,
      activities: activity.activities.map(row => ({
        ...row,
        days: { ...row.days, '2026-11-03': {
          ...row.days['2026-11-03']!,
          cells: [{ ...row.days['2026-11-03']!.cells![0]!, juniors: [{ name: 'Dr Ellis (ST2)' }, { name: 'Dr Missing (ST1)' }] }],
        } },
      })),
    };
    expect(countUnmatchedActivityJuniors([activity], people)).toBe(0);
    expect(countUnmatchedActivityJuniors([withoutId], people)).toBe(1);
  });
});

describe('MediRota slot headings', () => {
  it('treats ellipsis-only names as heading residue', () => {
    expect(isEllipsisOnlyName('…')).toBe(true);
    expect(isEllipsisOnlyName('&hellip;')).toBe(true);
    expect(isEllipsisOnlyName('...')).toBe(true);
    expect(isEllipsisOnlyName('Training Day CT')).toBe(false);
  });

  it('skips rmap-rota__slottitle items in By person cells', () => {
    const slot = (date: string, shift: number, inner: string) =>
      `<td id="n-1-${date}-${shift}" class="rmap-rota__node person-slot" data-date="${date}" data-shift_id="${shift}"><ul>${inner}</ul></td>`;
    const titleThen = (activity: string) =>
      `<li><span class="rmap-rota__slottitle">&hellip;</span></li><li class=""><a href="#" class="js-remove">&times;</a> ${activity}</li>`;
    const html = `<select><option value="person-42" >Dr Rowan (ST2)</option></select>
<table class="rmap-table rmap-table--grid js-main-rota" data-person="42" data-rota-date="2026-11-02"><tr><td class="rmap-rota__detail"><div class="js-activity-name"><span class="rmap-rota__detail-name">Rowan, Dr</span> ST2</div></td>
${slot('2026-11-02', 1, titleThen('Training Day CT'))}
${slot('2026-11-03', 1, titleThen('MAU CT'))}
</tr></table>`;
    const week = parsePersonWeek(html);
    expect(week.people[0].days['2026-11-02']).toEqual({ am: ['Training Day CT'] });
    expect(week.people[0].days['2026-11-03']).toEqual({ am: ['MAU CT'] });
    expect(JSON.stringify(week)).not.toMatch(/hellip|…/);
  });

  it('skips rmap-rota__slottitle junior rows in By activity cells', () => {
    const cell = `<td id="n-1-2026-10-12-1-9" data-slot_date="2026-10-12" data-column="1" class="rmap-rota__node"><ul class="rmap-rota__assigned time-calcs__assigned"><li><span class="rmap-rota__slottitle">&hellip;</span></li><li class=" " data-activity="9"><a href="#" class="rmap-mini-delete js-remove-activity hidden">&times;</a>Dr Ellis (ST1)</li></ul></td>`;
    const html = `<html><table class="rmap-table rmap-table--grid rmap-rota weeks js-main-rota" data-num_defined_sessions="4" data-rota-date="2026-10-12"><tbody>
<div id ="activity-9" class="activity-container rota standard-type"><table><tbody><tr class="rmap-rota__rota-row"><td class="rmap-rota__detail"><div class="js-activity-name"><span class="rmap-rota__detail-name">Elective C-Sections</span></div></td><td class="rmap-rota__sessions-cell" colspan="8"><table class="rmap-rota__sessions-table rmap-table--grid"><tr empty="false" class="rmap-table__gridrow-1 session-row1 "><td class="rmap-rota__session-label">am</td>${cell}</tr></table></td></tr></tbody></table></div>
</tbody></table></html>`;
    expect(parseActivityWeek(html).activities[0].days['2026-10-12'].juniors).toBe(1);
  });
});

describe('importing several activities', () => {
  const week: ActivityWeek = { start: '2026-11-09', activities: [
    { name: 'WC Theatres', description: '', days: { '2026-11-10': { juniors: 1, consultants: ['Mr Vale'] } } },
    { name: 'Gynae Day Case', description: '', days: { '2026-11-10': { juniors: 1, consultants: ['Ms Quinn'] } } },
    { name: 'CH Theatres', description: '', days: { '2026-11-10': { juniors: 0, consultants: ['Mr Hart'] }, '2026-11-14': { juniors: 0, consultants: ['Ms Moss'] } } },
  ] };
  it('leaves out seniors-only activities', () => {
    expect(importable([week])).toEqual({ withJuniors: ['WC Theatres', 'Gynae Day Case'], seniorsOnly: ['CH Theatres'] });
  });
  it('adds lists from two activities on the same place instead of replacing one', () => {
    const ws = emptyWorkspace();
    ws.profile.shiftTypes = [{ id: 'D', name: 'Day', start: '08:00', end: '17:30' }];
    ws.profile.roles = [{ id: 'gth', name: 'WC Theatres' }];
    ws.profile.demands = [{ id: 'n', roleId: 'gth', shiftTypeId: 'D', days: { weekdays: [0, 1, 2, 3, 4] }, min: 1, max: 1 }];
    applyConsultantLists(ws, [week], { 'WC Theatres': 'gth', 'Gynae Day Case': 'gth', 'CH Theatres': 'gth' });
    const p = ws.profile;
    const lists = p.roles.filter(r => r.parentId === 'gth');
    expect(lists.map(l => l.name).sort()).toEqual(['WC Theatres – Mr Vale', 'WC Theatres – Ms Quinn']);
    expect(lists.map(l => demandFor(p, l.id, 'D', '2026-11-10').max)).toEqual([1, 1]);
    expect(demandFor(p, 'gth', 'D', '2026-11-14').max).toBe(0); // Saturday: no junior need created
  });
});
