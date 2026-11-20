import { describe, expect, it } from 'vitest';
import type { Rule } from '../src/engine/types';
import { findSwaps } from '../src/engine/swaps';
import { nationalLimitRows, applyNationalLimitRows } from '../src/app/pages/SetupWizard';
import { limitDefs } from '../src/app/rules/grid';
import { placeName } from '../src/app/placeName';
import { sessionFor } from '../src/app/overview';
import { bookedShiftWarnings } from '../src/app/bookedShiftWarnings';
import { parseFetchedPersonWeek } from '../src/app/fetchedWeek';
import { applyImport, planImport } from '../src/app/mediImport';
import { defaultSessionsSettings } from '../src/app/sessions';
import { emptyProfile, emptyWorkspace } from '../src/app/store';
import { fairerRoleLabel } from '../src/app/fairerDisplay';
import { blankSnapshot, stage2Profile, stage2Request, stage2Settings, work, off } from './swaps-stage2-helpers';

describe('Stage 2 setup rules and renamed places', () => {
  it('uses longer than ten hours for national long-day rows; Settings → Rules still matches ten hours or more', () => {
    const profile = emptyProfile();
    profile.shiftTypes = [
      { id: 'night', name: 'Night', start: '20:00', end: '08:00' },
      { id: 'ten', name: 'Ten hours', start: '08:00', end: '18:00' },
      { id: 'long', name: 'Long day', start: '08:00', end: '18:30' },
    ];
    const rows = nationalLimitRows(profile);
    expect(rows.map(row => row.id)).toContain('national-nights');
    expect(rows.map(row => row.id)).toContain('national-long-days');
    expect(rows.find(row => row.id === 'national-long-days')?.rule).toMatchObject({ work: { shiftTypeIds: ['long'] } });
    expect(JSON.stringify(rows.find(row => row.id === 'national-long-days')?.rule)).not.toContain('ten');
    const defs = limitDefs(profile);
    // Settings → Rules (BASE): long day = 10 hours or more, so a saved rule on an exactly 10-hour shift still matches.
    expect(defs.find(row => row.id === 'longdays')?.make([4])).toMatchObject({ work: { shiftTypeIds: ['long', 'ten'] } });
    const savedTenHour: Rule = { id: 'saved-ten', name: '', type: 'maxConsecutive', hard: true, work: { shiftTypeIds: ['ten'] }, maxDays: 4 };
    const tenOnly = emptyProfile();
    tenOnly.shiftTypes = [{ id: 'ten', name: 'Ten hours', start: '08:00', end: '18:00' }, { id: 'day', name: 'Day', start: '08:00', end: '17:00' }];
    expect(limitDefs(tenOnly).find(row => row.id === 'longdays')?.matches({ ...savedTenHour, work: { shiftTypeIds: ['ten'] } })).toBe(true);
    expect(nationalLimitRows(tenOnly).map(row => row.id)).not.toContain('national-long-days');
    expect(nationalLimitRows(emptyProfile()).map(row => row.id)).not.toContain('national-nights');
    expect(nationalLimitRows(emptyProfile()).map(row => row.id)).not.toContain('national-long-days');
  });

  it('creates both separately editable weekend limits from the national-limits action', () => {
    const profile = emptyProfile();
    profile.shiftTypes = [{ id: 'night', name: 'Night', start: '20:00', end: '08:00' }];
    const rules = applyNationalLimitRows(profile, []);
    const weekends = rules.filter(rule => rule.type === 'weekendFrequency');
    expect(weekends).toHaveLength(2);
    expect(weekends.map(rule => rule.type === 'weekendFrequency' ? [rule.hard, rule.maxWeekends, rule.inWeekends] : [])).toEqual([[true, 1, 2], [false, 1, 3]]);
    expect(rules).toHaveLength(9);
  });

  it('counts only weeks accepted by the existing By person parser as populated', () => {
    const html = '<select><option value="person-11">Dr Rowan (ST2)</option></select><table class="rmap-table js-main-rota" data-person="11" data-rota-date="2026-11-16"><tbody><tr><td><span class="rmap-rota__detail-name">Rowan, Dr</span><div class="js-activity-name">Rowan, Dr Doctor</div></td><td id="n-11-2026-11-16-1" class="person-slot" data-date="2026-11-16" data-shift_id="1"><ul><li>Maple Ward</li></ul></td></tr></tbody></table>';
    expect(parseFetchedPersonWeek(200, html)?.people[0]?.id).toBe('11');
    expect(parseFetchedPersonWeek(200, '<html><h1>No rota published</h1></html>')).toBeUndefined();
    expect(parseFetchedPersonWeek(404, html)).toBeUndefined();
    expect(parseFetchedPersonWeek(200, '<table class="js-main-rota" data-person="11"></table>')).toBeUndefined();
  });

  it('keeps the canonical MediRota identity for import, Find swaps, Sessions and Overview after a display rename', () => {
    const profile = stage2Profile(['rowan', 'ellis'], ['Long cover']);
    const beforeSnapshot = blankSnapshot(['rowan', 'ellis']);
    work(beforeSnapshot, 'rowan', '2026-11-02', 'longDay', 'Long cover');
    off(beforeSnapshot, 'ellis', '2026-11-02');
    const settings = stage2Settings({ maxChain: 2 });
    const request = stage2Request('rowan', ['2026-11-02']);
    const before = findSwaps(profile, beforeSnapshot, settings, request);
    profile.roles[0]!.displayName = 'Cedar Theatre';
    expect(profile.roles[0]!.name).toBe('Long cover');
    expect(placeName(profile.roles[0])).toBe('Cedar Theatre');
    expect(fairerRoleLabel(profile.roles[0]!.id, { placeForRole: { [profile.roles[0]!.id]: profile.roles[0]!.id } } as never, new Map([[profile.roles[0]!.id, profile.roles[0]!]]))).toBe('Cedar Theatre');
    expect(findSwaps(profile, beforeSnapshot, settings, request)).toEqual(before);
    const sessions = defaultSessionsSettings(profile);
    sessions.types.push({ id: 'theatre', name: 'Theatre', colour: 1, kind: 'day', placeIds: [profile.roles[0]!.id] });
    expect(sessionFor('Long cover', profile, sessions)?.id).toBe('theatre');
    expect(sessionFor('Cedar Theatre', profile, sessions)).toBeUndefined();
    const snapshot = { days: { rowan: { '2026-11-02': { status: 'longDay' as const, activity: 'Long cover' } } }, importedAt: {} };
    expect(bookedShiftWarnings(profile, snapshot)).toEqual([{ placeId: profile.roles[0]!.id, activity: 'Long cover', kind: 'booked long day' }]);
  });

  it('reuses the original place ID when later import activity arrives under its MediRota name', () => {
    const workspace = emptyWorkspace();
    workspace.profile.roles = [{ id: 'place-long', name: 'Long cover', displayName: 'Cedar Theatre' }];
    workspace.mediRota = { activities: { 'Long cover': { treat: 'long', placeId: 'place-long' } }, skip: [] };
    const personWeek = { start: '2026-11-02', people: [{ id: '11', rowName: 'Rowan, Dr', label: 'Dr Rowan (ST2)', role: 'CT', days: { '2026-11-02': { am: ['Long cover'] } } }] };
    const plan = planImport(workspace, [personWeek], []);
    expect(plan.activities.find(activity => activity.name === 'Long cover')?.placeId).toBe('place-long');
    applyImport(workspace, plan);
    expect(workspace.profile.roles).toHaveLength(1);
    expect(workspace.profile.roles[0]).toMatchObject({ id: 'place-long', name: 'Long cover', displayName: 'Cedar Theatre' });
    expect(workspace.swapFinder?.snapshot.days[workspace.profile.staff[0]!.id]?.['2026-11-02']?.activity).toBe('Long cover');
  });
});
