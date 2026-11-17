import { describe, expect, it } from 'vitest';
import { addDays } from '../src/engine/calendar';
import { findSwaps, type RotaSnapshot, type SwapSettings } from '../src/engine/swaps';
import { blankSnapshot, off, stage2Profile, stage2Request, stage2Settings, work } from './swaps-stage2-helpers';

const activities = ['Night cover', 'Float', 'Long cover'];

function block(snapshot: RotaSnapshot, staffId: string, start: string, length = 2) {
  for (let day = 0; day < length; day++) work(snapshot, staffId, addDays(start, day), 'night', 'Night cover');
}

function baseDirect(length = 2) {
  const ids = ['a', 'b'];
  const snapshot = blankSnapshot(ids);
  const aStart = '2026-11-10';
  const bStart = length >= 4 ? '2026-12-01' : '2026-11-24';
  block(snapshot, 'a', aStart, length);
  block(snapshot, 'b', bStart, length);
  for (let day = 0; day < length; day++) {
    off(snapshot, 'b', addDays(aStart, day));
    off(snapshot, 'a', addDays(bStart, day));
  }
  return { snapshot, profile: stage2Profile(ids, activities), settings: stage2Settings(), request: stage2Request('a', [aStart]), aStart, bStart };
}

function plans(fixture: ReturnType<typeof baseDirect>, settings: SwapSettings = fixture.settings) {
  return findSwaps(fixture.profile, fixture.snapshot, settings, fixture.request).plans;
}

describe('night block packages', () => {
  it('passes both doctors Monday day jobs in the correct directions', () => {
    const fixture = baseDirect();
    work(fixture.snapshot, 'b', '2026-11-09', 'dayJob', 'Float');
    off(fixture.snapshot, 'a', '2026-11-09');
    work(fixture.snapshot, 'a', '2026-11-23', 'dayJob', 'Float');
    off(fixture.snapshot, 'b', '2026-11-23');
    const plan = plans(fixture)[0];
    expect(plan).toBeDefined();
    expect(plan.alerts).toBeUndefined();
    expect(plan.movedShifts).toEqual(expect.arrayContaining([
      { fromStaffId: 'b', toStaffId: 'a', date: '2026-11-09', activity: 'Float', kind: 'dayJob' },
      { fromStaffId: 'a', toStaffId: 'b', date: '2026-11-23', activity: 'Float', kind: 'dayJob' },
    ]));
    expect(plan.shiftsMoved).toBe(6);
  });

  it('passes a long day on a rest day back to the block owner', () => {
    const fixture = baseDirect();
    work(fixture.snapshot, 'b', '2026-11-09', 'longDay', 'Long cover');
    off(fixture.snapshot, 'a', '2026-11-09');
    expect(plans(fixture)[0]?.movedShifts).toContainEqual({ fromStaffId: 'b', toStaffId: 'a', date: '2026-11-09', activity: 'Long cover', kind: 'longDay' });
  });

  it('rejects an unpassable mandatory shift but alerts for a recommended one', () => {
    const mandatory = baseDirect();
    work(mandatory.snapshot, 'b', '2026-11-09', 'dayJob', 'Float');
    work(mandatory.snapshot, 'a', '2026-11-09', 'dayJob', 'Float');
    expect(plans(mandatory)).toHaveLength(0);

    const recommended = baseDirect();
    work(recommended.snapshot, 'b', '2026-11-08', 'dayJob', 'Float');
    work(recommended.snapshot, 'a', '2026-11-08', 'dayJob', 'Float');
    const plan = plans(recommended)[0];
    expect(plan).toBeDefined();
    expect(plan.movedShifts).toBeUndefined();
    expect(plan.alerts).toEqual(expect.arrayContaining([expect.objectContaining({ staffId: 'b', date: '2026-11-08' })]));
  });

  it('needs nothing for leave on a rest day', () => {
    const fixture = baseDirect();
    work(fixture.snapshot, 'b', '2026-11-09', 'dayJob', 'Float');
    fixture.snapshot.days.b['2026-11-09'] = { status: 'leave', activity: 'Annual Leave' };
    const plan = plans(fixture)[0];
    expect(plan).toBeDefined();
    expect(plan.movedShifts).toBeUndefined();
    expect(plan.alerts).toBeUndefined();
  });

  it('returns a block running into existing nights with an alert', () => {
    const fixture = baseDirect();
    work(fixture.snapshot, 'b', '2026-11-09', 'night', 'Night cover');
    const plan = plans(fixture)[0];
    expect(plan).toBeDefined();
    expect(plan.alerts).toEqual(expect.arrayContaining([expect.objectContaining({ staffId: 'b', date: '2026-11-09', message: expect.stringContaining('existing nights') })]));
  });

  it('checks three days after a four-night block by default', () => {
    const fixture = baseDirect(4);
    const thirdAfter = addDays(fixture.aStart, 6);
    work(fixture.snapshot, 'b', thirdAfter, 'dayJob', 'Float');
    work(fixture.snapshot, 'a', thirdAfter, 'dayJob', 'Float');
    const plan = plans(fixture)[0];
    expect(plan).toBeDefined();
    expect(plan.alerts).toEqual(expect.arrayContaining([expect.objectContaining({ staffId: 'b', date: thirdAfter })]));
  });

  it('finds a clean 4-person chain beyond the old validation budget and passes shifts at every link', () => {
    const decoys = Array.from({ length: 11 }, (_, index) => `x${String(index).padStart(2, '0')}`);
    const ids = ['a', 'b', 'c', 'd', 'e', ...decoys];
    const snapshot = blankSnapshot(ids);
    block(snapshot, 'a', '2026-11-10');

    // A direct swap exists, but B's recommended rest runs into another night.
    block(snapshot, 'b', '2026-11-13');
    off(snapshot, 'b', '2026-11-10'); off(snapshot, 'b', '2026-11-11');
    off(snapshot, 'a', '2026-11-13'); off(snapshot, 'a', '2026-11-14');
    work(snapshot, 'b', '2026-11-08', 'night', 'Night cover');

    // The clean cycle is A -> C -> D -> E -> A.
    block(snapshot, 'c', '2026-11-17');
    block(snapshot, 'd', '2026-11-24');
    block(snapshot, 'e', '2026-12-01');
    off(snapshot, 'c', '2026-11-10'); off(snapshot, 'c', '2026-11-11');
    off(snapshot, 'd', '2026-11-17'); off(snapshot, 'd', '2026-11-18');
    off(snapshot, 'e', '2026-11-24'); off(snapshot, 'e', '2026-11-25');
    off(snapshot, 'a', '2026-12-01'); off(snapshot, 'a', '2026-12-02');

    // Mandatory rest-day jobs pass back to the owner of each received block.
    work(snapshot, 'c', '2026-11-09', 'dayJob', 'Float'); off(snapshot, 'a', '2026-11-09');
    work(snapshot, 'd', '2026-11-16', 'dayJob', 'Float'); off(snapshot, 'c', '2026-11-16');
    work(snapshot, 'e', '2026-11-23', 'dayJob', 'Float'); off(snapshot, 'd', '2026-11-23');
    work(snapshot, 'a', '2026-11-30', 'dayJob', 'Float'); off(snapshot, 'e', '2026-11-30');

    // Eleven closer four-person completions fail their mandatory rest check.
    for (const id of decoys) {
      block(snapshot, id, '2026-11-12');
      off(snapshot, id, '2026-11-24'); off(snapshot, id, '2026-11-25');
      snapshot.days[id]['2026-11-23'] = { status: 'training', activity: 'Teaching' };
    }
    off(snapshot, 'a', '2026-11-12'); off(snapshot, 'a', '2026-11-13');

    const result = findSwaps(stage2Profile(ids, activities), snapshot, stage2Settings({ maxChain: 4 }), stage2Request('a', ['2026-11-10']));
    const clean = result.plans.find(plan => plan.chains[0].links.map(link => link.staffId).join(',') === 'a,c,d,e');
    expect(clean).toBeDefined();
    expect(clean?.alerts).toBeUndefined();
    expect(clean?.movedShifts).toEqual(expect.arrayContaining([
      { fromStaffId: 'c', toStaffId: 'a', date: '2026-11-09', activity: 'Float', kind: 'dayJob' },
      { fromStaffId: 'd', toStaffId: 'c', date: '2026-11-16', activity: 'Float', kind: 'dayJob' },
      { fromStaffId: 'e', toStaffId: 'd', date: '2026-11-23', activity: 'Float', kind: 'dayJob' },
      { fromStaffId: 'a', toStaffId: 'e', date: '2026-11-30', activity: 'Float', kind: 'dayJob' },
    ]));
    const direct = result.plans.find(plan => plan.chains[0].links.map(link => link.staffId).join(',') === 'a,b');
    expect(direct?.alerts?.length).toBeGreaterThan(0);
    expect(result.plans[0]).toBe(direct);
    expect(result.truncated).toBe(false);
  });

  it('leaves long-day swap results unchanged when night rest settings change', () => {
    const ids = ['a', 'b'];
    const snapshot = blankSnapshot(ids);
    work(snapshot, 'a', '2026-11-10', 'longDay', 'Long cover');
    work(snapshot, 'b', '2026-11-24', 'longDay', 'Long cover');
    off(snapshot, 'b', '2026-11-10');
    off(snapshot, 'a', '2026-11-24');
    const profile = stage2Profile(ids, activities);
    const request = stage2Request('a', ['2026-11-10']);
    const normal = findSwaps(profile, snapshot, stage2Settings(), request);
    const changed = findSwaps(profile, snapshot, stage2Settings({ nightRestDaysBefore: 7, nightRestDaysAfter: 7 }), request);
    expect(changed).toEqual(normal);
  });
});
